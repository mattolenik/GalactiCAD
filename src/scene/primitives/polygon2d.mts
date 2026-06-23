import { Node, CompileResult, BVH_MIN_COST } from "../base.mjs"

/** Winding sign consistent with extrude WGSL `windSignStr` (shoelace sum on polygon vertices). */
export function polygon2dWindingSign(vertices: [number, number][]): 1 | -1 {
    let area = 0
    for (let i = 0; i < vertices.length; i++) {
        const [ax, ay] = vertices[i]!
        const [bx, by] = vertices[(i + 1) % vertices.length]!
        area += (ax + bx) * (ay - by)
    }
    return area < 0 ? -1 : 1
}

/** Index of the polygon edge (start-vertex index) closest to profile-space point (px, pz). */
export function closestPolygonEdge(verts: ReadonlyArray<readonly [number, number]>, px: number, pz: number): number {
    const N = verts.length
    let minDist = Infinity
    let closestEdge = 0
    for (let j = N - 1, i = 0; i < N; j = i, i++) {
        const ex = verts[i]![0] - verts[j]![0]
        const ey = verts[i]![1] - verts[j]![1]
        const wx = px - verts[j]![0]
        const wy = pz - verts[j]![1]
        const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)))
        const bx = wx - ex * t
        const by = wy - ey * t
        const dd = bx * bx + by * by
        if (dd < minDist) {
            minDist = dd
            closestEdge = j
        }
    }
    return closestEdge
}

/**
 * The polygon-edge index range `[start, end)` of the "wall surface segment"
 * containing `edgeIndex` — the contiguous run of edges bounded by the two nearest
 * authored anchors (`isAnchor`, a per-vertex mask). Edge `e` connects vertex `e`
 * to vertex `(e+1) % n`, so a segment runs from the anchor vertex it leaves
 * (`start`) up to (but not including) the next anchor vertex (`end`). The range
 * wraps modulo n when `end <= start`. Used to highlight a whole tessellated wall
 * (e.g. one bezier element of a path2d) as a single selectable surface, instead
 * of the one tiny tessellation segment under the cursor.
 */
export function surfaceSegmentEdgeRange(
    isAnchor: ReadonlyArray<boolean>,
    edgeIndex: number,
    n: number,
): { start: number; end: number } {
    // Walk back to the anchor vertex this segment leaves.
    let start = edgeIndex
    for (let guard = 0; !isAnchor[start] && guard < n; guard++) start = (start - 1 + n) % n
    // Walk forward to the next anchor vertex (the segment's far boundary).
    let end = (edgeIndex + 1) % n
    for (let guard = 0; !isAnchor[end] && guard < n; guard++) end = (end + 1) % n
    return { start, end }
}

/**
 * Signed distance to the polygon (true segment distance, even-odd inside test)
 * and the unit gradient (outward, i.e. the direction of increasing signed
 * distance) at profile-space point (px, pz). Negative inside. This is the
 * CPU mirror of the polygon SDF the loft field blends; used to Newton-project
 * analytic crease samples back onto the true blended surface.
 */
export function polygon2dSignedDistance(
    verts: ReadonlyArray<readonly [number, number]>,
    px: number,
    pz: number,
): { d: number; gx: number; gz: number } {
    const n = verts.length
    let bestD2 = Infinity
    let fx = px
    let fz = pz
    let inside = false
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const vix = verts[i]![0]
        const viz = verts[i]![1]
        const vjx = verts[j]![0]
        const vjz = verts[j]![1]
        if (viz > pz !== vjz > pz && px < ((vjx - vix) * (pz - viz)) / (vjz - viz) + vix) inside = !inside
        const ex = vix - vjx
        const ez = viz - vjz
        const t = Math.max(0, Math.min(1, ((px - vjx) * ex + (pz - vjz) * ez) / (ex * ex + ez * ez || 1)))
        const cx = vjx + ex * t
        const cz = vjz + ez * t
        const dd = (px - cx) * (px - cx) + (pz - cz) * (pz - cz)
        if (dd < bestD2) {
            bestD2 = dd
            fx = cx
            fz = cz
        }
    }
    const d = Math.sqrt(bestD2)
    let gx = px - fx
    let gz = pz - fz
    const gl = Math.hypot(gx, gz) || 1
    gx /= gl
    gz /= gl
    return inside ? { d: -d, gx: -gx, gz: -gz } : { d, gx, gz }
}

/**
 * Cosine threshold (≈18°) above which two adjacent polygon edges are treated as
 * a smooth join for side-wall shading; below it the shared vertex is a genuine
 * corner. Matches the extrude MDC feature-dot so shading creases agree with the
 * feature-graph's selectable vertical edges.
 */
const POLYGON_SMOOTH_NORMAL_DOT = 0.95

/**
 * Per-vertex outward unit normal for smooth (Phong) side-wall shading of an
 * extruded profile — parallel to {@link Polygon2D.vertices}. A vertex whose two
 * adjacent edges turn by more than ~18° is a genuine corner and stores the zero
 * sentinel `[0, 0]`; the extrude preview shader falls back to the flat per-edge
 * normal there so corners stay sharp. Every other vertex stores the unit normal
 * of the averaged adjacent-edge tangent, oriented **outward via the polygon SDF
 * sign** (the same outward convention the GPU gradient `combined.zw` uses). This
 * precomputes the per-vertex normal once, with full CPU precision and a robust
 * orientation probe, instead of the old per-pixel in-shader blend whose single
 * winding-derived sign distorted the shading even at fine tessellation.
 */
export function computePolygonVertexNormals(
    verts: ReadonlyArray<readonly [number, number]>,
): [number, number][] {
    const n = verts.length
    const out: [number, number][] = new Array(n)
    // Probe step for the outward-orientation test: small vs the profile extent
    // (a vertex sits on the boundary, so stepping along the candidate normal
    // lands just outside iff the candidate points outward).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of verts) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
    }
    const eps = (Math.max(maxX - minX, maxY - minY) || 1) * 1e-3
    for (let i = 0; i < n; i++) {
        const prev = verts[(i - 1 + n) % n]!
        const cur = verts[i]!
        const next = verts[(i + 1) % n]!
        let tpx = cur[0] - prev[0], tpy = cur[1] - prev[1]
        let tnx = next[0] - cur[0], tny = next[1] - cur[1]
        const lp = Math.hypot(tpx, tpy) || 1
        const ln = Math.hypot(tnx, tny) || 1
        tpx /= lp; tpy /= lp; tnx /= ln; tny /= ln
        if (tpx * tnx + tpy * tny < POLYGON_SMOOTH_NORMAL_DOT) {
            out[i] = [0, 0] // corner sentinel
            continue
        }
        let ax = tpx + tnx, ay = tpy + tny
        const la = Math.hypot(ax, ay)
        if (la < 1e-9) {
            out[i] = [0, 0] // ~180° reversal — degenerate, treat as corner
            continue
        }
        ax /= la; ay /= la
        let nx = ay, ny = -ax // perpendicular of the averaged tangent
        if (polygon2dSignedDistance(verts, cur[0] + nx * eps, cur[1] + ny * eps).d < 0) {
            nx = -nx; ny = -ny // flip to point outward (increasing signed distance)
        }
        out[i] = [nx, ny]
    }
    return out
}

function sameVertex(a: [number, number], b: [number, number]): boolean {
    return Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9
}

export function normalizePolygonVertices(vertices: [number, number][]): [number, number][] {
    const out: [number, number][] = []
    for (const [x, y] of vertices) {
        const next: [number, number] = [x, y]
        if (out.length === 0 || !sameVertex(out[out.length - 1]!, next)) {
            out.push(next)
        }
    }
    if (out.length >= 2 && sameVertex(out[0]!, out[out.length - 1]!)) {
        out.pop()
    }
    return out
}

/**
 * {@link normalizePolygonVertices} that also carries a parallel boolean flag per
 * vertex (e.g. "is an authored anchor"), kept in lockstep with the deduplication.
 * When a coincident vertex is dropped (a shared element boundary, or the closing
 * duplicate), its flag is OR-merged onto the kept vertex — a boundary counts as
 * an anchor if *either* side considers it one.
 */
export function normalizePolygonVerticesWithFlags(
    vertices: [number, number][],
    flags: boolean[],
): { vertices: [number, number][]; flags: boolean[] } {
    const outV: [number, number][] = []
    const outF: boolean[] = []
    for (let i = 0; i < vertices.length; i++) {
        const [x, y] = vertices[i]!
        const f = flags[i] ?? false
        if (outV.length === 0 || !sameVertex(outV[outV.length - 1]!, [x, y])) {
            outV.push([x, y])
            outF.push(f)
        } else if (f) {
            outF[outF.length - 1] = true
        }
    }
    if (outV.length >= 2 && sameVertex(outV[0]!, outV[outV.length - 1]!)) {
        if (outF[outF.length - 1]!) outF[0] = true
        outV.pop()
        outF.pop()
    }
    return { vertices: outV, flags: outF }
}

/**
 * A 2D SDF primitive defined by a closed polygon of vertices.
 * Cannot be used directly in a 3D scene — must be wrapped in Extrude or Loft.
 */
export class Polygon2D extends Node {
    vertices: [number, number][]
    /**
     * Per-vertex "is an authored anchor" mask, parallel to {@link vertices}, or
     * `null` when the polygon carries no authored-node provenance (a plain
     * hand-specified polygon — every vertex is treated by geometry). Set by
     * {@link Path2DNode} so the extrusion can distinguish a real on-curve node
     * (control point / vertex) from an interior tessellation sample: real nodes
     * cast selectable vertical edges and bound independently-selectable wall
     * surfaces, tessellation samples do not.
     */
    vertexIsAnchor: boolean[] | null = null
    /** Base offset into the shared polygon vertex storage buffer, assigned during build(). */
    bufferOffset = -1
    /** Cached per-vertex outward shading normals (see {@link computePolygonVertexNormals}). */
    #vertexNormals: [number, number][] | null = null

    constructor(vertices: [number, number][], vertexIsAnchor?: boolean[]) {
        super()
        if (vertexIsAnchor) {
            const norm = normalizePolygonVerticesWithFlags(vertices, vertexIsAnchor)
            if (norm.vertices.length < 3) {
                throw new Error("polygon2d requires at least 3 vertices")
            }
            this.vertices = norm.vertices
            this.vertexIsAnchor = norm.flags
        } else {
            const normalized = normalizePolygonVertices(vertices)
            if (normalized.length < 3) {
                throw new Error("polygon2d requires at least 3 vertices")
            }
            this.vertices = normalized
        }
    }

    override getShapeType(): string { return "polygon2d" }
    // 2D profile — no standalone 3D SDF; isolation walks up to its extrude/loft consumer.
    override get isIsolatable(): boolean { return false }
    override getIndicatorSymbol(): string { return "⬠" }

    protected override _computeCodegenCost(): number {
        return Math.max(BVH_MIN_COST, this.vertices.length)
    }
    override getIndicatorSvg(): string {
        // The indicator IS the actual polygon: fit the real outline into the 12×12
        // indicator viewBox (uniform scale, 1u padding, Y flipped for screen space).
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const [x, y] of this.vertices) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
        const PAD = 1
        const inner = 12 - 2 * PAD
        const span = Math.max(maxX - minX, maxY - minY) || 1
        const scale = inner / span
        const offX = PAD + (inner - (maxX - minX) * scale) / 2
        const offY = PAD + (inner - (maxY - minY) * scale) / 2
        const points = this.vertices
            .map(([x, y]) => `${(offX + (x - minX) * scale).toFixed(2)},${(offY + (maxY - y) * scale).toFixed(2)}`)
            .join(" ")
        return `<polygon points="${points}" fill="currentColor"/>`
    }

    override build() {
        super.build()
        this.bufferOffset = this.scene.allocPolygonVertices(this.vertices.length)
    }

    /** Per-vertex outward shading normals (computed once; `vertices` is immutable
     *  after construction). Uploaded into the appended normal region of the shared
     *  polygon buffer for the extrude preview's smooth side shading. */
    getVertexNormals(): [number, number][] {
        if (!this.#vertexNormals) this.#vertexNormals = computePolygonVertexNormals(this.vertices)
        return this.#vertexNormals
    }

    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(
            `${this.getShapeType()}:${this.structuralBvhSlot()}:n:${this.vertices.length}:wind:${polygon2dWindingSign(this.vertices)}`,
        )
    }

    /** Generate a unique WGSL function name for this polygon instance */
    get wgslFuncName(): string {
        return `fPolygon2D_${this.id}`
    }

    /** WGSL function name for the closest-edge helper (used by face selection). */
    get wgslClosestEdgeFuncName(): string {
        return `fPolygon2D_${this.id}_closestEdge`
    }

    /** WGSL function name for combined SDF + closest-edge (single-pass). */
    get wgslCombinedFuncName(): string {
        return `fPolygon2D_${this.id}_combined`
    }

    override compileAux(): string { return "" }

    override compileAuxFast(): string {
        const N = this.vertices.length
        const BASE = this.bufferOffset

        return `
fn ${this.wgslFuncName}(p: vec2f) -> f32 {
    const N = ${N}u;
    const BASE = ${BASE}u;
    // Stream vertices straight from storage with a carry (vj = previous vi)
    // instead of copying the whole polygon into a local array first — the
    // array's per-invocation register footprint (N x vec2f) throttles
    // occupancy. One read per iteration; the loop visits every edge, so the
    // start distance only needs to be a safe upper bound.
    var d = 1e30;
    var s = 1.0;
    var vj = polygonVertices[BASE + N - 1u];
    for (var i = 0u; i < N; i++) {
        let vi = polygonVertices[BASE + i];
        let e = vj - vi;
        let w = p - vi;
        let eLen2 = max(dot(e, e), 1e-12);
        let b = w - e * clamp(dot(w, e) / eLen2, 0.0, 1.0);
        d = min(d, dot(b, b));
        let c0 = p.y >= vi.y;
        let c1 = p.y < vj.y;
        let c2 = e.x * w.y > e.y * w.x;
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
        vj = vi;
    }
    return s * sqrt(d);
}

fn ${this.wgslClosestEdgeFuncName}(p: vec2f) -> u32 {
    const N = ${N}u;
    const BASE = ${BASE}u;
    // Carry-streamed like ${this.wgslFuncName} (no local vertex array).
    var minDist = 1e30;
    var closest = 0u;
    var jIdx = N - 1u;
    var vj = polygonVertices[BASE + N - 1u];
    for (var i = 0u; i < N; i++) {
        let vi = polygonVertices[BASE + i];
        let e = vj - vi;
        let w = p - vi;
        let eLen2 = max(dot(e, e), 1e-12);
        let b = w - e * clamp(dot(w, e) / eLen2, 0.0, 1.0);
        let dd = dot(b, b);
        if (dd < minDist) { minDist = dd; closest = jIdx; }
        jIdx = i;
        vj = vi;
    }
    return closest;
}

fn ${this.wgslCombinedFuncName}(p: vec2f) -> vec4f {
    const N = ${N}u;
    const BASE = ${BASE}u;
    // Carry-streamed like ${this.wgslFuncName} (no local vertex array).
    var d = 1e30;
    var s = 1.0;
    var minDist = 1e30;
    var closest = 0u;
    var closestB = vec2f(0.0);
    var jIdx = N - 1u;
    var vj = polygonVertices[BASE + N - 1u];
    for (var i = 0u; i < N; i++) {
        let vi = polygonVertices[BASE + i];
        let e = vj - vi;
        let w = p - vi;
        let eLen2 = max(dot(e, e), 1e-12);
        let b = w - e * clamp(dot(w, e) / eLen2, 0.0, 1.0);
        let dd = dot(b, b);
        d = min(d, dd);
        if (dd < minDist) { minDist = dd; closest = jIdx; closestB = b; }
        let c0 = p.y >= vi.y;
        let c1 = p.y < vj.y;
        let c2 = e.x * w.y > e.y * w.x;
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
        jIdx = i;
        vj = vi;
    }
    let bLen = length(closestB);
    let g2d = select(s * (closestB / bLen), vec2f(1.0, 0.0), bLen < 1e-6);
    return vec4f(s * sqrt(d), f32(closest), g2d.x, g2d.y);
}
`
    }

    override compile(_indentLevel = 0): CompileResult {
        throw new Error("Polygon2D cannot be used directly in a 3D scene. Wrap it in extrude() or loft().")
    }
    override compileFast(_indentLevel = 0): CompileResult {
        throw new Error("Polygon2D cannot be used directly in a 3D scene. Wrap it in extrude() or loft().")
    }
    override compileMid(_indentLevel = 0): CompileResult {
        throw new Error("Polygon2D cannot be used directly in a 3D scene. Wrap it in extrude() or loft().")
    }
}

export function polygon2d(...vertices: [number, number][]): Polygon2D {
    return new Polygon2D(vertices)
}
