import type { PathElement, Vec2 } from "../scene/primitives/path2d.mjs"

/**
 * DOM-free geometry + index core for the curve editor's node-type ("handle
 * mode") system. Everything here is a pure function over the authored
 * {@link PathElement}[] so it can be unit-tested without a browser; the editor
 * ({@link Path2DEditor}) only wires pointer/keyboard events to these.
 *
 * The hard part it abstracts away: a cubic's two handles meeting at a shared
 * anchor live in *adjacent* `PathElement` arrays (the outgoing handle of an
 * anchor is `el[i][1]`, its incoming handle is the previous element's
 * `el[i-1][len-2]`). {@link partnerHandle} crosses that boundary; the path is
 * treated as a closed ring so the seam between the last and first element is
 * just another join.
 *
 * Node-type taxonomy (the cross-editor invariant — Inkscape/Figma/Affinity):
 *  - `cusp`      handles fully independent (corner, C⁰)
 *  - `smooth`    handles colinear through the anchor, lengths independent (G¹)
 *  - `symmetric` colinear AND equal length (C¹, reflection across the anchor)
 *  - `smart`     auto-managed smooth: lengths derived from neighbour distances
 *                (Affinity "Smart" / Inkscape "Auto"); inferred-as-smooth.
 */
export type NodeType = "cusp" | "smooth" | "symmetric" | "smart"

/** A reference to one stored point: element index + point index within it. */
export interface PointRef { ei: number; pi: number }

/** Default coincidence epsilon for "do these endpoints share an anchor". */
export const COINCIDENT_EPS = 1e-6
/** Default `|sin θ|` tolerance for treating two handle vectors as colinear (~3°). */
export const COLINEAR_EPS = 0.05
/** Default relative tolerance for treating two handle lengths as equal (2%). */
export const EQUAL_LEN_EPS = 0.02
/** Default Catmull-Rom handle-length fraction for `smart`/auto nodes. */
export const AUTO_K = 1 / 3

const TINY = 1e-12

// ── Vector helpers (plain tuples, matching path2d.mts) ─────────────────

function sub(a: Vec2, b: Vec2): Vec2 { return [a[0] - b[0], a[1] - b[1]] }
function len(a: Vec2): number { return Math.hypot(a[0], a[1]) }
function dist(a: Vec2, b: Vec2): number { return Math.hypot(a[0] - b[0], a[1] - b[1]) }
function dot(a: Vec2, b: Vec2): number { return a[0] * b[0] + a[1] * b[1] }
function cross(a: Vec2, b: Vec2): number { return a[0] * b[1] - a[1] * b[0] }
function normalize(a: Vec2): Vec2 {
    const l = len(a)
    return l < TINY ? [0, 0] : [a[0] / l, a[1] / l]
}
function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** Degree-elevate a 2/3/4-point control polygon to a cubic (mirrors path2d.mts). */
function toCubic(pts: Vec2[]): [Vec2, Vec2, Vec2, Vec2] {
    if (pts.length === 2) {
        const [a, b] = pts as [Vec2, Vec2]
        return [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b]
    }
    if (pts.length === 3) {
        const [a, b, c] = pts as [Vec2, Vec2, Vec2]
        return [a, lerp(a, b, 2 / 3), lerp(c, b, 2 / 3), c]
    }
    const [a, b, c, d] = pts as [Vec2, Vec2, Vec2, Vec2]
    return [a, b, c, d]
}

// ── Element helpers ────────────────────────────────────────────────────

/** True for a bare vertex element `[x, y]` (first child is a number). */
export function isVertex(el: PathElement): boolean {
    return typeof el[0] === "number"
}

/** Number of control points in an element: 1 for a vertex, else 2/3/4. */
export function pointCount(el: PathElement): number {
    return isVertex(el) ? 1 : (el as Vec2[]).length
}

/** The point at `pi` within an element (a vertex exposes its single point at 0). */
export function elPoint(el: PathElement, pi: number): Vec2 {
    return isVertex(el) ? (el as Vec2) : (el as Vec2[])[pi]!
}

/** Whether two points coincide within `eps` (i.e. form a shared anchor join). */
export function samePt(a: Vec2, b: Vec2, eps: number = COINCIDENT_EPS): boolean {
    return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps
}

/** Previous element index in the closed ring. */
export function prevElementIndex(els: PathElement[], ei: number): number {
    return (ei - 1 + els.length) % els.length
}
/** Next element index in the closed ring. */
export function nextElementIndex(els: PathElement[], ei: number): number {
    return (ei + 1) % els.length
}

/** True when `ref` points at an interior control handle (curve element, not an endpoint). */
export function isControlHandle(els: PathElement[], ref: PointRef): boolean {
    const el = els[ref.ei]
    if (!el || isVertex(el)) return false
    const n = pointCount(el)
    return n >= 3 && ref.pi > 0 && ref.pi < n - 1
}

/** True when `ref` points at an element endpoint (an anchor), including a vertex. */
export function isAnchorEndpoint(els: PathElement[], ref: PointRef): boolean {
    const el = els[ref.ei]
    if (!el) return false
    const n = pointCount(el)
    return ref.pi === 0 || ref.pi === n - 1
}

// ── Partner-handle lookup (the element-boundary crossing) ──────────────

/**
 * For a dragged *cubic* control handle, find the partner handle across the
 * shared anchor (in the neighbouring element) plus the anchor position, so the
 * caller can keep them colinear/symmetric.
 *
 * Returns `null` when there is no linkable partner: the ref is not a cubic
 * handle, the neighbouring element is a line/vertex (no handle), the join is a
 * gap (endpoints don't coincide — a corner, not a smooth anchor), or the
 * neighbour is a quadratic (v1 links only cubic↔cubic).
 */
export function partnerHandle(
    els: PathElement[],
    ref: PointRef,
    eps: number = COINCIDENT_EPS,
): { partner: PointRef; anchor: Vec2 } | null {
    const el = els[ref.ei]
    if (!el || isVertex(el)) return null
    const n = pointCount(el)
    if (n !== 4) return null                       // v1: only cubic handles link
    if (ref.pi !== 1 && ref.pi !== 2) return null  // not an interior handle

    if (ref.pi === 1) {
        // Outgoing handle of this element's START anchor; partner = incoming
        // handle of the same anchor, owned by the previous element.
        const anchor = elPoint(el, 0)
        const pe = prevElementIndex(els, ref.ei)
        const pel = els[pe]!
        if (pe === ref.ei) return null
        if (!samePt(elPoint(pel, pointCount(pel) - 1), anchor, eps)) return null
        if (pointCount(pel) !== 4) return null
        return { partner: { ei: pe, pi: 2 }, anchor }
    }
    // ref.pi === 2: incoming handle of this element's END anchor; partner =
    // outgoing handle of the same anchor, owned by the next element.
    const anchor = elPoint(el, 3)
    const ne = nextElementIndex(els, ref.ei)
    const nel = els[ne]!
    if (ne === ref.ei) return null
    if (!samePt(elPoint(nel, 0), anchor, eps)) return null
    if (pointCount(nel) !== 4) return null
    return { partner: { ei: ne, pi: 1 }, anchor }
}

// ── Anchor-centric view (for type-set, glyphs, anchor drag) ────────────

/** One logical anchor (curve join) with its coincident endpoint copies and handles. */
export interface Anchor {
    /** Anchor world position. */
    pos: Vec2
    /** Whether the two adjoining element endpoints coincide (a real shared join). */
    shared: boolean
    /** Every stored endpoint that sits at this anchor (1 for a gap/open seam, else 2). */
    endpointRefs: PointRef[]
    /** Handle on the incoming side (previous element's last interior point), if a curve. */
    inHandle: PointRef | null
    /** Handle on the outgoing side (this element's first interior point), if a curve. */
    outHandle: PointRef | null
    /** Neighbour anchor positions along the path (for `smart`/auto handle lengths). */
    prevPos: Vec2
    nextPos: Vec2
}

/**
 * Ordered anchors of the path, one per element boundary in the closed ring.
 * Anchor `i` sits at the end of element `i` (== start of element `i+1` when
 * they coincide). Used for type assignment, neighbour lookup, and rendering.
 */
export function getAnchors(els: PathElement[], eps: number = COINCIDENT_EPS): Anchor[] {
    const n = els.length
    const anchors: Anchor[] = []
    for (let i = 0; i < n; i++) {
        const el = els[i]!
        const ni = nextElementIndex(els, i)
        const pi = prevElementIndex(els, i)
        const nel = els[ni]!
        const pel = els[pi]!
        const endIdx = pointCount(el) - 1
        const pos = elPoint(el, endIdx)
        const startNext = elPoint(nel, 0)
        const shared = n > 1 && samePt(pos, startNext, eps)

        const endpointRefs: PointRef[] = [{ ei: i, pi: endIdx }]
        if (shared && ni !== i) endpointRefs.push({ ei: ni, pi: 0 })

        const inHandle: PointRef | null =
            pointCount(el) >= 3 ? { ei: i, pi: pointCount(el) - 2 } : null
        const outHandle: PointRef | null =
            shared && pointCount(nel) >= 3 ? { ei: ni, pi: 1 } : null

        anchors.push({
            pos, shared, endpointRefs, inHandle, outHandle,
            // The neighbouring anchors along the ring (each anchor sits at its
            // element's end), so these are correct for vertices and gaps too —
            // not the element's own start, which collapses onto a bare vertex.
            prevPos: elPoint(pel, pointCount(pel) - 1),
            nextPos: elPoint(nel, pointCount(nel) - 1),
        })
    }
    return anchors
}

/**
 * The index into {@link getAnchors} that a point reference belongs to — whether
 * it is one of the anchor's coincident endpoints or one of its two handles.
 * `null` if the ref matches no anchor (e.g. a quadratic's shared control).
 */
export function anchorIndexOfRef(
    els: PathElement[],
    ref: PointRef,
    eps: number = COINCIDENT_EPS,
): number | null {
    const anchors = getAnchors(els, eps)
    const hit = (r: PointRef | null) => r != null && r.ei === ref.ei && r.pi === ref.pi
    for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]!
        if (a.endpointRefs.some(hit) || hit(a.inHandle) || hit(a.outHandle)) return i
    }
    return null
}

/**
 * For a dragged anchor endpoint, the full set of stored points that must move
 * rigidly with it: every coincident endpoint copy plus the handles attached to
 * those endpoints (so a cubic's tangents follow the anchor). The position is the
 * anchor's current location.
 */
export function anchorEndpoints(
    els: PathElement[],
    ref: PointRef,
    eps: number = COINCIDENT_EPS,
): { pos: Vec2; pointRefs: PointRef[] } {
    const el = els[ref.ei]!
    const pos = elPoint(el, ref.pi)
    const pointRefs: PointRef[] = []
    const seen = new Set<string>()
    const add = (r: PointRef) => {
        const k = `${r.ei}:${r.pi}`
        if (!seen.has(k)) { seen.add(k); pointRefs.push(r) }
    }

    // The dragged endpoint + its own attached handle.
    add(ref)
    addAttachedHandle(els, ref, add)

    // The coincident endpoint in the adjoining element(s), + their handles.
    // A start endpoint (pi 0) joins the previous element's end; an end endpoint
    // joins the next element's start; a vertex (single point) can join both.
    const n = pointCount(el)
    if (ref.pi === 0 || n === 1) {
        const pe = prevElementIndex(els, ref.ei)
        if (pe !== ref.ei) {
            const pel = els[pe]!
            const peEnd = pointCount(pel) - 1
            if (samePt(elPoint(pel, peEnd), pos, eps)) {
                const r = { ei: pe, pi: peEnd }
                add(r); addAttachedHandle(els, r, add)
            }
        }
    }
    if (ref.pi === n - 1 || n === 1) {
        const ne = nextElementIndex(els, ref.ei)
        if (ne !== ref.ei) {
            const nel = els[ne]!
            if (samePt(elPoint(nel, 0), pos, eps)) {
                const r = { ei: ne, pi: 0 }
                add(r); addAttachedHandle(els, r, add)
            }
        }
    }
    return { pos, pointRefs }
}

/** Add the interior handle immediately adjacent to an endpoint within its own element. */
function addAttachedHandle(els: PathElement[], ep: PointRef, add: (r: PointRef) => void) {
    const el = els[ep.ei]!
    const n = pointCount(el)
    if (n < 3) return                    // vertex or line: no handle
    if (ep.pi === 0) add({ ei: ep.ei, pi: 1 })
    else if (ep.pi === n - 1) add({ ei: ep.ei, pi: n - 2 })
}

// ── Classification + per-mode drag math ────────────────────────────────

/**
 * Infer a node's type from its handle geometry. Needs both handles to be
 * colinear-and-opposite to be smooth; equal length within tolerance → symmetric.
 * `smart` is never inferred (it looks like smooth) — only set explicitly.
 */
export function inferNodeType(
    anchor: Vec2,
    inH: Vec2 | null,
    outH: Vec2 | null,
    colinearEps: number = COLINEAR_EPS,
    equalLenEps: number = EQUAL_LEN_EPS,
): NodeType {
    if (!inH || !outH) return "cusp"
    const vIn = sub(inH, anchor)
    const vOut = sub(outH, anchor)
    const lIn = len(vIn)
    const lOut = len(vOut)
    if (lIn < TINY || lOut < TINY) return "cusp"
    const nIn = normalize(vIn)
    const nOut = normalize(vOut)
    const colinearOpposite = Math.abs(cross(nIn, nOut)) <= colinearEps && dot(nIn, nOut) < 0
    if (!colinearOpposite) return "cusp"
    return Math.abs(lIn - lOut) <= equalLenEps * Math.max(lIn, lOut) ? "symmetric" : "smooth"
}

/**
 * New partner-handle position when `handlePos` is dragged on a node of `mode`.
 * `null` means "leave the partner where it is" (cusp, or a degenerate drag).
 *  - smooth/smart: rotate the partner to stay colinear, preserving its length
 *    (extending it to equal length if it was retracted — Inkscape's rule).
 *  - symmetric: reflect the dragged handle across the anchor.
 */
export function partnerUpdate(
    mode: NodeType,
    anchor: Vec2,
    handlePos: Vec2,
    partnerPos: Vec2,
): Vec2 | null {
    if (mode === "cusp") return null
    if (mode === "symmetric") {
        return [2 * anchor[0] - handlePos[0], 2 * anchor[1] - handlePos[1]]
    }
    // smooth / smart
    const v = sub(handlePos, anchor)
    const lv = len(v)
    if (lv < TINY) return null
    let L = dist(partnerPos, anchor)
    if (L < TINY) L = lv
    const dir = [v[0] / lv, v[1] / lv] as Vec2
    return [anchor[0] - dir[0] * L, anchor[1] - dir[1] * L]
}

/**
 * Catmull-Rom handle positions for a `smart`/auto node: tangent parallel to the
 * chord between the neighbour anchors, lengths a fraction `k` of the distance to
 * each neighbour.
 */
export function autoSmoothHandles(
    prevAnchor: Vec2,
    anchor: Vec2,
    nextAnchor: Vec2,
    k: number = AUTO_K,
): { inH: Vec2; outH: Vec2 } {
    const dir = normalize(sub(nextAnchor, prevAnchor))
    const inLen = k * dist(anchor, prevAnchor)
    const outLen = k * dist(anchor, nextAnchor)
    return {
        inH: [anchor[0] - dir[0] * inLen, anchor[1] - dir[1] * inLen],
        outH: [anchor[0] + dir[0] * outLen, anchor[1] + dir[1] * outLen],
    }
}

/** Snap a handle so its vector from the anchor lies on a multiple of `stepDeg`. */
export function angleSnap(anchor: Vec2, handlePos: Vec2, stepDeg: number): Vec2 {
    const v = sub(handlePos, anchor)
    const r = len(v)
    if (r < TINY || stepDeg <= 0) return handlePos
    const step = stepDeg * Math.PI / 180
    const a = Math.round(Math.atan2(v[1], v[0]) / step) * step
    return [anchor[0] + Math.cos(a) * r, anchor[1] + Math.sin(a) * r]
}

/** Constrain a handle to the nearest 0/45/90° axis from the anchor (Shift drag). */
export function axisConstrain(anchor: Vec2, handlePos: Vec2): Vec2 {
    return angleSnap(anchor, handlePos, 45)
}

/**
 * Re-position a node's handles to satisfy a newly-assigned type (used by the
 * 1/2/3/4 hotkeys). Returns the new in/out handle positions to write, omitting a
 * side that has no handle. `cusp` leaves geometry untouched.
 */
export function normalizeToType(
    type: NodeType,
    anchor: Vec2,
    inH: Vec2 | null,
    outH: Vec2 | null,
    prevPos: Vec2,
    nextPos: Vec2,
    k: number = AUTO_K,
): { inH?: Vec2; outH?: Vec2 } {
    if (type === "smart") {
        return autoSmoothHandles(prevPos, anchor, nextPos, k)
    }
    if (type === "cusp") return {}
    if (!inH || !outH) return {}                 // need both handle slots to align

    let lIn = dist(inH, anchor)
    let lOut = dist(outH, anchor)
    // Direction of the single tangent line: from the incoming handle toward the
    // outgoing one (falls back to a single handle's own direction).
    let dir = normalize(sub(outH, inH))
    if (len(dir) < TINY) dir = normalize(sub(outH, anchor))
    if (len(dir) < TINY) dir = normalize(sub(anchor, inH))

    // A handle retracted onto the anchor (e.g. one just promoted from a vertex)
    // has no direction or length to preserve — seed it from the neighbour chord
    // so the freshly-typed node still gets a real handle on that side.
    if (len(dir) < TINY || lIn < TINY || lOut < TINY) {
        const auto = autoSmoothHandles(prevPos, anchor, nextPos, k)
        if (len(dir) < TINY) dir = normalize(sub(auto.outH, anchor))
        if (lIn < TINY) lIn = dist(auto.inH, anchor)
        if (lOut < TINY) lOut = dist(auto.outH, anchor)
    }
    if (len(dir) < TINY) return {}               // neighbours coincide — nothing to do

    if (type === "symmetric") {
        const L = (lIn + lOut) / 2
        return {
            inH: [anchor[0] - dir[0] * L, anchor[1] - dir[1] * L],
            outH: [anchor[0] + dir[0] * L, anchor[1] + dir[1] * L],
        }
    }
    // smooth: keep each handle's own length, just align directions.
    return {
        inH: [anchor[0] - dir[0] * lIn, anchor[1] - dir[1] * lIn],
        outH: [anchor[0] + dir[0] * lOut, anchor[1] + dir[1] * lOut],
    }
}

// ── Handle creation: vertex/line/quad → cubic (vertex↔control) ──────────

/**
 * Promote an element to a 4-point cubic so its endpoints can carry handles. A
 * bare vertex has no span of its own, so it is elevated as the straight segment
 * `[startPos, endPos]`; line/quad elements are degree-elevated from their own
 * points; an existing cubic is returned unchanged. Geometry is preserved.
 */
export function promoteToCubic(el: PathElement, startPos: Vec2, endPos: Vec2): Vec2[] {
    if (isVertex(el)) return toCubic([startPos, endPos])
    const pts = (el as Vec2[]).map(p => [p[0], p[1]] as Vec2)
    return pts.length >= 4 ? pts : toCubic(pts)
}

/**
 * Ensure anchor `ai` has both an incoming and an outgoing handle by promoting
 * its two adjacent elements (the one ending at the anchor and the one starting
 * there) to cubics. Returns a new element array; the element count is unchanged
 * so anchor indices stay stable, and the curve is preserved (degree elevation).
 */
export function ensureAnchorHandles(els: PathElement[], ai: number): PathElement[] {
    const n = els.length
    if (n === 0) return els
    const anchors = getAnchors(els)
    if (!anchors[ai]) return els
    const anchorPos = anchors[ai]!.pos
    const prevPos = anchors[(ai - 1 + n) % n]!.pos
    const nextPos = anchors[(ai + 1) % n]!.pos

    const out = els.slice()

    // Incoming side (the element ending at the anchor): promote so the anchor
    // gets an in-handle, but retract the FAR (start) handle onto the previous
    // anchor so that neighbour stays a plain corner instead of sprouting a
    // stray half-handle. Elements that are already cubic keep their handles.
    if (pointCount(out[ai]!) < 4) {
        const c = promoteToCubic(out[ai]!, prevPos, anchorPos)
        c[1] = [c[0]![0], c[0]![1]]
        out[ai] = c
    }

    const ni = (ai + 1) % n
    if (ni !== ai && pointCount(out[ni]!) < 4) {
        // Outgoing side: retract the FAR (end) handle onto the next anchor.
        const c = promoteToCubic(out[ni]!, anchorPos, nextPos)
        c[2] = [c[3]![0], c[3]![1]]
        out[ni] = c
    }
    return out
}

// ── Node-type tag (de)serialization for .gcad source round-trip ────────

const NODE_TYPES: readonly NodeType[] = ["cusp", "smooth", "symmetric", "smart"]

/** Validate a persisted node-type tag string, or null if absent/unrecognized. */
export function parseNodeType(s: string | null | undefined): NodeType | null {
    return s != null && (NODE_TYPES as readonly string[]).includes(s) ? (s as NodeType) : null
}
