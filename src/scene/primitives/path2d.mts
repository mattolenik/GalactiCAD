import { Polygon2D, normalizePolygonVertices } from "./polygon2d.mjs"

/** A 2D coordinate. */
export type Vec2 = [number, number]

/**
 * One authored element of a {@link path2d}:
 *  - a bare vertex `[x, y]` (connected to its neighbours by straight lines), or
 *  - a bezier control polygon `[[x,y], …]` of 2/3/4 points (linear / quadratic /
 *    cubic), *including its own start and end points*.
 *
 * The parser distinguishes the two by the first child: a number → vertex, an
 * array → control polygon.
 */
export type PathElement = Vec2 | Vec2[]

/**
 * Absolute chord-tolerance floor (max world-space deviation between a curve and
 * its chord approximation); the adaptive tessellator subdivides until every span
 * is within the *effective* tolerance. Smaller = denser = slower to render
 * (the extrude SDF is O(vertices) per pixel). Tunable via {@link setPath2DChordTol}.
 */
let path2DChordTol = 0.01
/**
 * Relative chord tolerance as a fraction of the profile's bounding extent. The
 * effective tolerance is `max(absolute floor, relFrac × extent)`, so a large
 * profile is tessellated to a *bounded* vertex count instead of hundreds of
 * points — capping the dominant per-pixel cost of the extrude SDF. A small
 * profile stays governed by the absolute floor (unchanged). Set to 0 to disable.
 */
let path2DChordRelFrac = 0.0015

/** Tune the bezier tessellation density: `absolute` world-space floor, optional
 *  `relFrac` size-relative fraction. Lower density (larger values) = fewer
 *  polygon vertices = faster extrude rendering, at the cost of curve fidelity. */
export function setPath2DChordTol(absolute: number, relFrac?: number): void {
    path2DChordTol = Math.max(1e-5, absolute)
    if (relFrac !== undefined) path2DChordRelFrac = Math.max(0, relFrac)
}

/** Effective per-build chord tolerance for `elements`: the larger of the
 *  absolute floor and the size-relative term (bounds vertex count for big
 *  profiles). Computed from the authored control points (a superset of the
 *  curve's true extent — a safe, cheap over-estimate). */
function effectiveChordTol(elements: PathElement[]): number {
    if (path2DChordRelFrac <= 0) return path2DChordTol
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const el of elements) {
        for (const [x, y] of elementPoints(el)) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
    }
    if (!isFinite(minX)) return path2DChordTol
    const extent = Math.max(maxX - minX, maxY - minY)
    return Math.max(path2DChordTol, extent * path2DChordRelFrac)
}

/** Subdivision-depth cap per curve, bounding worst-case vertex count to 2^depth. */
const PATH2D_MAX_DEPTH = 8

function isVertexElement(el: PathElement): el is Vec2 {
    return typeof el[0] === "number"
}

/** The point list of an element: a singleton for a vertex, the control polygon otherwise. */
function elementPoints(el: PathElement): Vec2[] {
    return isVertexElement(el) ? [[el[0], el[1]]] : (el as Vec2[]).map(p => [p[0], p[1]])
}

function cloneElement(el: PathElement): PathElement {
    return isVertexElement(el) ? [el[0], el[1]] : (el as Vec2[]).map(p => [p[0], p[1]] as Vec2)
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

function mid(a: Vec2, b: Vec2): Vec2 {
    return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]
}

/** Degree-elevate a 2/3/4-point control polygon to a cubic [P0, c1, c2, P3]. */
function toCubic(pts: Vec2[]): [Vec2, Vec2, Vec2, Vec2] {
    if (pts.length === 2) {
        const [a, b] = pts as [Vec2, Vec2]
        return [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b]
    }
    if (pts.length === 3) {
        // quadratic → cubic: c1 = P0 + ⅔(P1−P0), c2 = P2 + ⅔(P1−P2)
        const [a, b, c] = pts as [Vec2, Vec2, Vec2]
        return [a, lerp(a, b, 2 / 3), lerp(c, b, 2 / 3), c]
    }
    const [a, b, c, d] = pts as [Vec2, Vec2, Vec2, Vec2]
    return [a, b, c, d]
}

/**
 * Classic cubic flatness test: true when control points P1,P2 deviate from the
 * P0→P3 chord by less than `tol`. A linear cubic (controls on the chord) passes
 * immediately, so straight segments tessellate to just their endpoints.
 */
function flatEnough(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol: number): boolean {
    const ux = 3 * p1[0] - 2 * p0[0] - p3[0]
    const uy = 3 * p1[1] - 2 * p0[1] - p3[1]
    const vx = 3 * p2[0] - p0[0] - 2 * p3[0]
    const vy = 3 * p2[1] - p0[1] - 2 * p3[1]
    const d = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy)
    return d <= 16 * tol * tol
}

/** Adaptive de Casteljau subdivision; returns the points *after* P0 up to and including P3. */
function tessellateCubic(cubic: [Vec2, Vec2, Vec2, Vec2], tol: number): Vec2[] {
    const out: Vec2[] = []
    const rec = (a: Vec2, b: Vec2, c: Vec2, d: Vec2, depth: number) => {
        if (depth >= PATH2D_MAX_DEPTH || flatEnough(a, b, c, d, tol)) {
            out.push(d)
            return
        }
        const ab = mid(a, b), bc = mid(b, c), cd = mid(c, d)
        const abc = mid(ab, bc), bcd = mid(bc, cd)
        const m = mid(abc, bcd)
        rec(a, ab, abc, m, depth + 1)
        rec(m, bcd, cd, d, depth + 1)
    }
    rec(cubic[0], cubic[1], cubic[2], cubic[3], 0)
    return out
}

/** Output of {@link tessellatePath}: the polyline plus per-point provenance. */
export interface TessellatedPath {
    vertices: Vec2[]
    /**
     * `isAnchor[i]` — `vertices[i]` is an authored on-curve node (a bare vertex
     * element, or a curve's start/end anchor), as opposed to an interior sample
     * the adaptive tessellator inserted along a curve. The extrusion uses this to
     * place selectable vertical edges and wall-surface boundaries only at real
     * nodes.
     */
    isAnchor: boolean[]
}

/**
 * Flatten authored path elements into a tessellated polyline. Vertices and curve
 * endpoints connect via implicit straight lines; coincident boundaries are not
 * duplicated. The result is a (still open) point list; {@link Polygon2D} closes
 * and de-dups it. The parallel `isAnchor` flags mark which output points are
 * authored nodes vs. interior tessellation samples.
 */
export function tessellatePath(elements: PathElement[]): TessellatedPath {
    const tol = effectiveChordTol(elements)
    const out: Vec2[] = []
    const anchor: boolean[] = []
    let current: Vec2 | null = null
    const push = (p: Vec2, isAnchor: boolean) => {
        // Drop a point coincident with the running cursor — coincident element
        // boundaries (the common case) add no vertex; a gap leaves an implicit
        // straight edge to the new point. A dropped anchor still upgrades the kept
        // point: a shared boundary is an anchor if either side considers it one.
        if (current && current[0] === p[0] && current[1] === p[1]) {
            if (isAnchor && anchor.length > 0) anchor[anchor.length - 1] = true
            return
        }
        out.push(p)
        anchor.push(isAnchor)
        current = p
    }
    for (const el of elements) {
        const pts = elementPoints(el)
        if (pts.length === 1) {
            push(pts[0]!, true)                          // a bare vertex is always an anchor
            continue
        }
        const cubic = toCubic(pts)
        push(cubic[0], true)                             // start anchor (implicit connector if not coincident)
        const seg = tessellateCubic(cubic, tol)
        for (let i = 0; i < seg.length; i++) {
            // tessellateCubic returns points after P0 up to and including P3; only
            // the last (P3) is an authored anchor, the rest are interior samples.
            push(seg[i]!, i === seg.length - 1)
        }
    }
    return { vertices: out, isAnchor: anchor }
}

/** {@link tessellatePath} followed by the same normalization {@link Polygon2D} applies,
 *  so the result equals a constructed node's `vertices` (used for source↔node matching). */
export function tessellatePathNormalized(elements: PathElement[]): Vec2[] {
    return normalizePolygonVertices(tessellatePath(elements).vertices) as Vec2[]
}

/**
 * A 2D profile authored as a bezier path. Tessellates its curve/vertex elements
 * into a polyline at construction, so it *is* a {@link Polygon2D} downstream —
 * the GPU buffer, SDF codegen, extrude/loft/lathe, and exporters are unchanged.
 * The authored {@link elements} are retained for source round-trip and the
 * (future) curve-aware polygon editor.
 */
export class Path2DNode extends Polygon2D {
    readonly elements: PathElement[]

    constructor(elements: PathElement[]) {
        const { vertices, isAnchor } = tessellatePath(elements)
        super(vertices, isAnchor)
        this.elements = elements.map(cloneElement)
    }

    override getShapeType(): string { return "path2d" }
}

/** Author a 2D profile from a varargs list of vertices and/or bezier control polygons. */
export function path2d(...elements: PathElement[]): Path2DNode {
    return new Path2DNode(elements)
}
