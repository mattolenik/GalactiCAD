import { Node, CompileResult, BVH_MIN_COST } from "../base.mjs"

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
        if (vertices.length < 3) {
            throw new Error("polygon2d requires at least 3 vertices")
        }
        this.vertices = vertices
    }

    override getShapeType(): string { return "polygon2d" }
    override getIndicatorSymbol(): string { return "⬠" }

    protected override _computeCodegenCost(): number {
        return Math.max(BVH_MIN_COST, this.vertices.length)
    }
    override getIndicatorSvg(): string {
        return `<polygon points="6,1 11,5 9,11 3,11 1,5" fill="currentColor"/>`
    }
    override updateScene(): void { }

    override build() {
        super.build()
        this.bufferOffset = this.scene.allocPolygonVertices(this.vertices.length)
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
        let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
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
        let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
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
        let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
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

export function polygon2d(vertices: [number, number][]): Polygon2D {
    return new Polygon2D(vertices)
}
