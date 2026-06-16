import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D, polygon2dWindingSign } from "./polygon2d.mjs"
import {
    FG_FLAG_CREASE_ORIGINAL,
    type FeatureGraphBuilder,
} from "../feature-graph-buffer.mjs"

/**
 * Ring discretisation resolution for revolved feature rings (same as Cylinder's
 * `RING_SEGMENTS`). Exported so tests assert against this single source of truth.
 */
export const LATHE_FG_RING_SEGMENTS = 64

/** Profile-space ring radius below this is treated as an axis pole (corner), not a revolved ring. */
const LATHE_AXIS_RING_R = 1e-6
/** Adjacent profile edges with dot(dirPrev, dirNext) above this are treated as collinear — no contour. */
const LATHE_COLLINEAR_DOT = 0.995
/**
 * MDC feature constraints should only be emitted for real creases.
 * `LATHE_COLLINEAR_DOT` is deliberately loose for preview edge picking, but
 * using it for mesh export treats lightly polygonized smooth curves as ring
 * features and creates constrained trapezoid patches near shallow turns.
 */
const LATHE_MDC_FEATURE_DOT = 0.95
/** Minimum squared edge length (profile space) to treat as a real edge for corner tests. */
const LATHE_MIN_EDGE_LEN2 = 1e-20

export type LatheProfileEpsPack = {
    windSignStr: string
    charScale: string
    /** For MDC mid: references `uniforms.voxelSize` */
    sideEps: string
    /** For MDC mid: references `uniforms.voxelSize` */
    vtxEps: string
    /**
     * Profile-space distance cap for stamping MID_FEATURE_RING / CORNER on the mid path.
     * `vtxEps` also scales with model size (`charScale`); without a voxel-relative cap,
     * large lathes tag mantle samples far from the crease, and MDC feature constraints
     * snap those vertices to the ring — visible as flat bands above/below ring features.
     */
    featureVtxEps: string
    /** For preview edge hit: no `uniforms.voxelSize` reference */
    previewSideEps: string
    /** For preview edge hit: no `uniforms.voxelSize` reference */
    previewVtxEps: string
    edgeThreshold: string
    axisRingR: string
}

/** Shared epsilon / winding data for lathe contour WGSL (mid path + preview edge helpers). */
export function latheProfileEpsPack(child: Polygon2D): LatheProfileEpsPack {
    const windSign = polygon2dWindingSign(child.vertices)
    let maxR = 0
    let minY = 0
    let maxY = 0
    for (const [rx, y] of child.vertices) {
        maxR = Math.max(maxR, Math.abs(rx))
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
    }
    const hSpan = Math.max(maxY - minY, 1e-6)
    const char = Math.max(maxR, hSpan * 0.5, 1e-4)
    const charScale = char.toExponential(6)
    return {
        windSignStr: windSign.toFixed(1),
        charScale,
        sideEps: `max(max(SURF_DIST * 8.0, ${charScale} * 0.015), uniforms.voxelSize * 0.35)`,
        vtxEps: `max(max(SURF_DIST * 8.0, ${charScale} * 0.03), uniforms.voxelSize * 1.1)`,
        featureVtxEps: `min(max(max(SURF_DIST * 8.0, ${charScale} * 0.03), uniforms.voxelSize * 1.1), uniforms.voxelSize * 2.5)`,
        previewSideEps: `max(SURF_DIST * 8.0, ${charScale} * 0.015)`,
        previewVtxEps: `max(SURF_DIST * 8.0, ${charScale} * 0.03)`,
        edgeThreshold: `max(${charScale} * 0.12, 0.012)`,
        axisRingR: LATHE_AXIS_RING_R.toExponential(6),
    }
}

/** WGSL `switch` case: if hit is near a sharp lathe ring/pole, fill `out` and return true. */
export function compileLathePrimitiveEdgeHitCase(node: Lathe): string {
    const child = node.child
    const N = child.vertices.length
    const BASE = child.bufferOffset
    const combinedFunc = child.wgslCombinedFuncName
    const o = node.paramOffset
    const pv = node.previewVec3Slot
    const pos = vec3Wgsl(o, pv)
    const eps = latheProfileEpsPack(child)

    const caseBody = (() => {
        let inner = ""
        for (let k = 0; k < N; k++) {
            const idx = `${k}u`
            const ringAssign = `
                    let rAbs = abs(vK.x);
                    if (rAbs > ${eps.axisRingR}) {
                        let rUse = max(rAbs, ${eps.axisRingR});
                        let qRing = vec2f(rUse, vK.y);
                        let dRing = length(q - qRing);
                        if (dRing < ${eps.edgeThreshold}) {
                            (*out).kind = EDGE_KIND_PRIMITIVE;
                            (*out).primaryId = ${node.id}u;
                            (*out).featureA = ${idx};
                            (*out).objectId = hitId;
                            let feat = vec3f(radDir.x * rUse, vK.y, radDir.y * rUse);
                            (*out).seedPoint = vec4f(${pos} + feat, 0.0);
                            (*out).seedTangent = safeNormalize(vec3f(-radDir.y, 0.0, radDir.x), vec3f(0.0, 0.0, 1.0));
                            return true;
                        }
                    } else {
                        let dPole = length(vec3f(localP.x, localP.y - vK.y, localP.z));
                        if (dPole < ${eps.edgeThreshold}) {
                            (*out).kind = EDGE_KIND_PRIMITIVE;
                            (*out).primaryId = ${node.id}u;
                            (*out).featureA = ${idx};
                            (*out).objectId = hitId;
                            let feat = vec3f(0.0, vK.y, 0.0);
                            (*out).seedPoint = vec4f(${pos} + feat, 0.0);
                            (*out).seedTangent = safeNormalize(vec3f(-radDir.y, 0.0, radDir.x), vec3f(0.0, 0.0, 1.0));
                            return true;
                        }
                    }`
            inner += `
    {
        let vK = polygonVertices[${BASE}u + ${idx}];
        let vPrev = polygonVertices[${BASE}u + (${idx} + ${N}u - 1u) % ${N}u];
        let vNext = polygonVertices[${BASE}u + (${idx} + 1u) % ${N}u];
        let prevLeg = vK - vPrev;
        let nextLeg = vNext - vK;
        let prevLeg2 = dot(prevLeg, prevLeg);
        let nextLeg2 = dot(nextLeg, nextLeg);
        if (prevLeg2 >= ${LATHE_MIN_EDGE_LEN2.toExponential()} && nextLeg2 >= ${LATHE_MIN_EDGE_LEN2.toExponential()}) {
            let prevDir = prevLeg * inverseSqrt(prevLeg2);
            let nextDir = nextLeg * inverseSqrt(nextLeg2);
            if (dot(prevDir, nextDir) < ${LATHE_COLLINEAR_DOT}) {
                let qNear = vec2f(abs(vK.x), vK.y);
                if (length(q - qNear) < ${eps.previewVtxEps}) {${ringAssign}
                }
            }
        }
    }`
        }
        return inner
    })()

    return `case ${node.id}u: {
    let localP = hitWorld - ${pos};
    let combined = ${combinedFunc}(vec2f(length(localP.xz), localP.y));
    if (abs(combined.x) >= ${eps.previewSideEps}) { return false; }
    let r = length(localP.xz);
    var radDir = vec2f(1.0, 0.0);
    if (r > 1e-8) { radDir = localP.xz / r; }
    let q = vec2f(r, localP.y);
    ${caseBody}
    return false;
}`
}

/**
 * Distance in world/lathe space from hitWorld to the ring (or pole) at `profileVtx` for this lathe id.
 * Returns 1e30 if `latheId` does not match this node (caller switches on id).
 */
export function compileLathePrimitiveRingDistanceCase(node: Lathe): string {
    const child = node.child
    const BASE = child.bufferOffset
    const o = node.paramOffset
    const pv = node.previewVec3Slot
    const pos = vec3Wgsl(o, pv)
    const eps = latheProfileEpsPack(child)
    return `case ${node.id}u: {
    let localP = hitWorld - ${pos};
    let r = length(localP.xz);
    let q = vec2f(r, localP.y);
    let v = polygonVertices[${BASE}u + profileVtx];
    let rAbs = abs(v.x);
    if (rAbs > ${eps.axisRingR}) {
        let rUse = max(rAbs, ${eps.axisRingR});
        return length(q - vec2f(rUse, v.y));
    }
    return length(vec3f(localP.x, localP.y - v.y, localP.z));
}`
}

/**
 * Revolves a 2D SDF profile around the Y axis to create a solid of revolution.
 */
export class Lathe extends Node {
    pos = new Vec3f()
    child: Polygon2D

    constructor(child: Polygon2D)
    constructor(pos: Vec3, child: Polygon2D)
    constructor(...args: any[]) {
        super()
        if (args[0] instanceof Polygon2D) {
            this.pos = new Vec3f()
            this.child = args[0]
        } else {
            this.pos = vec3(args[0])
            this.child = args[1]
        }
    }

    override getShapeType(): string { return "lathe" }
    override getIndicatorSymbol(): string { return "◐" }

    protected override _computeCodegenCost(): number {
        return this.child.codegenCost() + BVH_MIN_COST
    }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/>`
    }
    override writeSceneParams(view: Float32Array): void {
        view.set(this.pos.data)
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.pos.data[0]!
        out.vec3[b + 1] = this.pos.data[1]!
        out.vec3[b + 2] = this.pos.data[2]!
        out.vec3[b + 3] = 0
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.paramOffset = this.scene.allocSceneParamFloats(3)
        this.paramCount = 3
        this.child.root = this.root
        this.child.build()
    }

    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}`)
        this.child.appendStructuralFingerprint(parts)
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.child.getAllDescendantIds()]
    }

    get wgslExFuncName(): string { return `fLathe_${this.id}_Ex` }
    get wgslFastFuncName(): string { return `fLathe_${this.id}_Fast` }
    get wgslMidFuncName(): string { return `fLathe_${this.id}_Mid` }

    override compileAux(): string {
        const combinedFunc = this.child.wgslCombinedFuncName

        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let r = length(p.xz);
    let q = vec2f(r, p.y);
    let combined = ${combinedFunc}(q);
    let d = combined.x;
    let g2d = combined.zw;
    var radDir = vec2f(1.0, 0.0);
    if (r > 1e-8) {
        radDir = p.xz / r;
    }
    let n = safeNormalize(vec3f(g2d.x * radDir.x, g2d.y, g2d.x * radDir.y), vec3f(0.0, 1.0, 0.0));
    return sdfTrue(d, id, n);
}
`
    }

    override compileAuxMid(): string {
        const combinedFunc = this.child.wgslCombinedFuncName
        const N = this.child.vertices.length
        const BASE = this.child.bufferOffset
        const eps = latheProfileEpsPack(this.child)

        // Shared corner-check body for a vertex vV (prevLeg = vV - vPrev,
        // nextLeg = vNext - vV). `vertexTagExpr` is a per-profile-vertex tag
        // (1-based) that we stamp into `featureIdB` so the mesh-viewer can
        // dedup all cells along the same circular ring into a single glyph
        // (paired with the lathe's own node id in `featureIdA`).
        const cornerBody = (vVName: string, vertexTagExpr: string) => `
                let prevLeg2 = dot(prevLeg, prevLeg);
                let nextLeg2 = dot(nextLeg, nextLeg);
                if (prevLeg2 >= ${LATHE_MIN_EDGE_LEN2.toExponential()} && nextLeg2 >= ${LATHE_MIN_EDGE_LEN2.toExponential()}) {
                    let prevDir = prevLeg * inverseSqrt(prevLeg2);
                    let nextDir = nextLeg * inverseSqrt(nextLeg2);
                    if (dot(prevDir, nextDir) < ${LATHE_MDC_FEATURE_DOT}) {
                        let prevOut2 = vec2f(prevDir.y, -prevDir.x) * ${eps.windSignStr};
                        let nextOut2 = vec2f(nextDir.y, -nextDir.x) * ${eps.windSignStr};
                        let n0m = safeNormalize(vec3f(prevOut2.x * radDir.x, prevOut2.y, prevOut2.x * radDir.y), vec3f(0.0, 1.0, 0.0));
                        let n1m = safeNormalize(vec3f(nextOut2.x * radDir.x, nextOut2.y, nextOut2.x * radDir.y), vec3f(0.0, 1.0, 0.0));
                        let rAbs = abs(${vVName}.x);
                        let vertexTag: u32 = ${vertexTagExpr};
                        if (rAbs > ${eps.axisRingR}) {
                            let rUse = max(rAbs, ${eps.axisRingR});
                            let feat = vec3f(radDir.x * rUse, ${vVName}.y, radDir.y * rUse);
                            let axisCenter = vec3f(0.0, ${vVName}.y, 0.0);
                            let ringTangent = safeNormalize(vec3f(-radDir.y, 0.0, radDir.x), vec3f(0.0, 0.0, 1.0));
                            var ring = sdfRMidRing(d, 1.0, n, feat, ringTangent, n1m, axisCenter, length(p - feat));
                            ring.featureIdB = vertexTag;
                            return ring;
                        }
                        let feat = vec3f(0.0, ${vVName}.y, 0.0);
                        var corner = sdfRMidCorner(d, 1.0, n, feat, n0m, n1m, length(p - feat));
                        corner.featureIdB = vertexTag;
                        return corner;
                    }
                }`

        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let r = length(p.xz);
    let q = vec2f(r, p.y);
    let combined = ${combinedFunc}(q);
    let d = combined.x;
    let g2d = combined.zw;
    var radDir = vec2f(1.0, 0.0);
    if (r > 1e-8) {
        radDir = p.xz / r;
    }
    let n = safeNormalize(vec3f(g2d.x * radDir.x, g2d.y, g2d.x * radDir.y), vec3f(0.0, 1.0, 0.0));
    let sideEps = ${eps.sideEps};
    let featureVtxEps = ${eps.featureVtxEps};
    if (abs(d) < sideEps) {
        // Only inspect the two vertices of the closest profile edge (O(1) vertex checks).
        let edgeIdx = u32(combined.y);
        let v0 = polygonVertices[${BASE}u + edgeIdx];
        let v1 = polygonVertices[${BASE}u + (edgeIdx + 1u) % ${N}u];

        // Check v0 (start of closest edge).
        if (length(q - vec2f(abs(v0.x), v0.y)) < featureVtxEps) {
            let vPrev = polygonVertices[${BASE}u + (edgeIdx + ${N}u - 1u) % ${N}u];
            let prevLeg = v0 - vPrev;
            let nextLeg = v1 - v0;
            ${cornerBody("v0", "edgeIdx + 1u")}
        }

        // Check v1 (end of closest edge).
        if (length(q - vec2f(abs(v1.x), v1.y)) < featureVtxEps) {
            let vNext = polygonVertices[${BASE}u + (edgeIdx + 2u) % ${N}u];
            let prevLeg = v1 - v0;
            let nextLeg = vNext - v1;
            ${cornerBody("v1", `((edgeIdx + 1u) % ${N}u) + 1u`)}
        }
    }
    return sdfRMidLatheMantle(d, 1.0, n);
}
`
    }

    override compileAuxFast(): string {
        const childFunc = this.child.wgslFuncName
        return `
fn ${this.wgslFastFuncName}(p: vec3f) -> FastSDFResult {
    let q = vec2f(length(p.xz), p.y);
    return sdfFast(${childFunc}(q), 1.0, 1.0);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${pos}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${pos})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `sdfMidSetOwner(sdfTranslateFeatureMid(${this.wgslMidFuncName}(p - ${pos}), p, ${pos}), ${this.id}u)`,
        }
    }

    protected override computeBoundsCore(): AABB {
        // Profile vertices are (r, y) in lathe space; revolve around Y
        let maxR = 0, minY = 0, maxY = 0
        for (const [r, y] of this.child.vertices) {
            maxR = Math.max(maxR, Math.abs(r))
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
        }
        const cy = (minY + maxY) * 0.5
        const hy = (maxY - minY) * 0.5
        return aabb(this.pos.x, this.pos.y + cy, this.pos.z, maxR, hy, maxR)
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }

    /**
     * Emit one revolved feature ring per sharp profile vertex.
     *
     * A lathe's surface is the revolution of its 2D profile around the Y
     * axis. Each profile edge becomes a ruled surface (cone/cylinder/disc
     * frustum) in 3D. Where two adjacent profile edges meet at a non-
     * collinear angle, their revolved surfaces meet at a circular crease
     * — a feature ring at `y = pos.y + vertex.y` with radius `|vertex.r|`,
     * centered on the Y axis through `pos`.
     *
     * Each ring is discretised into {@link LATHE_FG_RING_SEGMENTS} short
     * line segments (32 per circle by default). Per-vertex source-face
     * normals are the prev/next profile-edge outward normals revolved to
     * each angular position (the 2D profile-space outward `(dy, -dr)·windSign`
     * lifted into 3D at angle θ).
     *
     * Skipped cases:
     *  - Non-affine ancestor (warp gate).
     *  - Profile vertex on the Y axis (`r < LATHE_AXIS_RING_R`) — the ring
     *    collapses to a point and isn't visualised here. (Cone apex /
     *    sphere-pole 0D features could be added later as single-vertex
     *    corners; v1 just skips.)
     *  - Collinear / smooth profile turns — same `LATHE_MDC_FEATURE_DOT`
     *    predicate as the WGSL mid-feature pass.
     */
    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        if (builder.hasNonAffineAncestor()) return

        const verts = this.child.vertices
        const N = verts.length
        if (N < 3) return

        const windSign = polygon2dWindingSign(verts)
        const px = this.pos.x, py = this.pos.y, pz = this.pos.z

        // Per-edge outward in 2D profile (r, y) space. Same construction as
        // Polygon2D's outward: `(dy, -dr) * windSign`. Stored as a flat array
        // of `[n_r, n_y]` per profile edge (edge `i` runs from vertex `i` to
        // `(i + 1) % N`).
        const edgeOutR: number[] = new Array(N)
        const edgeOutY: number[] = new Array(N)
        for (let i = 0; i < N; i++) {
            const [r1, y1] = verts[i]!
            const [r2, y2] = verts[(i + 1) % N]!
            let dr = r2 - r1, dy = y2 - y1
            const len = Math.sqrt(dr * dr + dy * dy) || 1
            dr /= len; dy /= len
            edgeOutR[i] = dy * windSign
            edgeOutY[i] = -dr * windSign
        }

        builder.beginNode(this.id)

        for (let k = 0; k < N; k++) {
            const [r, y] = verts[k]!
            const rAbs = Math.abs(r)
            // Skip axis-pole vertices — they degenerate to a single point.
            if (rAbs < LATHE_AXIS_RING_R) continue

            const prev = (k - 1 + N) % N
            const next = k
            const prevR = edgeOutR[prev]!
            const prevY = edgeOutY[prev]!
            const nextR = edgeOutR[next]!
            const nextY = edgeOutY[next]!

            // Sharpness — 2D dot of the prev vs next outward normals.
            const dotN = prevR * nextR + prevY * nextY
            if (dotN >= LATHE_MDC_FEATURE_DOT) continue

            // Discretised ring around the Y axis at height `py + y`.
            const ringY = py + y
            const ringIdx: number[] = new Array(LATHE_FG_RING_SEGMENTS)
            for (let i = 0; i < LATHE_FG_RING_SEGMENTS; i++) {
                const theta = (i / LATHE_FG_RING_SEGMENTS) * 2 * Math.PI
                const ca = Math.cos(theta)
                const sa = Math.sin(theta)
                // 3D position: profile (r, y) revolved to angle θ.
                const x3 = px + r * ca
                const z3 = pz + r * sa
                // Revolve 2D outward (n_r, n_y) to 3D at angle θ:
                // x = n_r * cosθ, y = n_y, z = n_r * sinθ.
                const prevNormal3 = new Vec3f([prevR * ca, prevY, prevR * sa])
                const nextNormal3 = new Vec3f([nextR * ca, nextY, nextR * sa])
                ringIdx[i] = builder.emitVertex(
                    new Vec3f([x3, ringY, z3]),
                    FG_FLAG_CREASE_ORIGINAL,
                    [prevNormal3, nextNormal3],
                )
            }
            // Close the ring with edges.
            for (let i = 0; i < LATHE_FG_RING_SEGMENTS; i++) {
                const nextI = (i + 1) % LATHE_FG_RING_SEGMENTS
                builder.emitEdge(ringIdx[i]!, ringIdx[nextI]!, FG_FLAG_CREASE_ORIGINAL)
            }
            // No cap loop — a feature ring isn't a planar cap face. Downstream
            // meshers that want to know about ring-bounded regions can derive
            // them from the ring's neighborhood structure later.
        }

        builder.endNode()
    }
}

function latheProfile(profile: Polygon2D): Lathe {
    return new Lathe(DEFAULT_POS, profile)
}

export const lathe = { profile: latheProfile }
