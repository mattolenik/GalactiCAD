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

function sameVertex(a: [number, number], b: [number, number]): boolean {
    return Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9
}

function normalizePolygonVertices(vertices: [number, number][]): [number, number][] {
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
 * A 2D SDF primitive defined by a closed polygon of vertices.
 * Cannot be used directly in a 3D scene — must be wrapped in Extrude or Loft.
 */
export class Polygon2D extends Node {
    vertices: [number, number][]
    /** Base offset into the shared polygon vertex storage buffer, assigned during build(). */
    bufferOffset = -1

    constructor(vertices: [number, number][]) {
        super()
        const normalized = normalizePolygonVertices(vertices)
        if (normalized.length < 3) {
            throw new Error("polygon2d requires at least 3 vertices")
        }
        this.vertices = normalized
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
    var v: array<vec2f, ${N}>;
    for (var k = 0u; k < N; k++) {
        v[k] = polygonVertices[BASE + k];
    }
    var d = dot(p - v[0], p - v[0]);
    var s = 1.0;
    var j = N - 1u;
    for (var i = 0u; i < N; i++) {
        let e = v[j] - v[i];
        let w = p - v[i];
        let eLen2 = max(dot(e, e), 1e-12);
        let b = w - e * clamp(dot(w, e) / eLen2, 0.0, 1.0);
        d = min(d, dot(b, b));
        let c0 = p.y >= v[i].y;
        let c1 = p.y < v[j].y;
        let c2 = e.x * w.y > e.y * w.x;
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
        j = i;
    }
    return s * sqrt(d);
}

fn ${this.wgslClosestEdgeFuncName}(p: vec2f) -> u32 {
    const N = ${N}u;
    const BASE = ${BASE}u;
    var v: array<vec2f, ${N}>;
    for (var k = 0u; k < N; k++) {
        v[k] = polygonVertices[BASE + k];
    }
    var minDist = 1e30;
    var closest = 0u;
    var j = N - 1u;
    for (var i = 0u; i < N; i++) {
        let e = v[j] - v[i];
        let w = p - v[i];
        let eLen2 = max(dot(e, e), 1e-12);
        let b = w - e * clamp(dot(w, e) / eLen2, 0.0, 1.0);
        let dd = dot(b, b);
        if (dd < minDist) { minDist = dd; closest = j; }
        j = i;
    }
    return closest;
}

fn ${this.wgslCombinedFuncName}(p: vec2f) -> vec4f {
    const N = ${N}u;
    const BASE = ${BASE}u;
    var v: array<vec2f, ${N}>;
    for (var k = 0u; k < N; k++) {
        v[k] = polygonVertices[BASE + k];
    }
    var d = dot(p - v[0], p - v[0]);
    var s = 1.0;
    var minDist = 1e30;
    var closest = 0u;
    var closestB = vec2f(0.0);
    var j = N - 1u;
    for (var i = 0u; i < N; i++) {
        let e = v[j] - v[i];
        let w = p - v[i];
        let eLen2 = max(dot(e, e), 1e-12);
        let b = w - e * clamp(dot(w, e) / eLen2, 0.0, 1.0);
        let dd = dot(b, b);
        d = min(d, dd);
        if (dd < minDist) { minDist = dd; closest = j; closestB = b; }
        let c0 = p.y >= v[i].y;
        let c1 = p.y < v[j].y;
        let c2 = e.x * w.y > e.y * w.x;
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
        j = i;
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
