import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D, polygon2dWindingSign } from "./polygon2d.mjs"

/** Profile-space ring radius below this is treated as an axis pole (corner), not a revolved ring. */
const LATHE_AXIS_RING_R = 1e-6
/** Adjacent profile edges with dot(dirPrev, dirNext) above this are treated as collinear — no contour. */
const LATHE_COLLINEAR_DOT = 0.995
/** Minimum squared edge length (profile space) to treat as a real edge for corner tests. */
const LATHE_MIN_EDGE_LEN2 = 1e-20

export type LatheProfileEpsPack = {
    windSignStr: string
    charScale: string
    /** For MDC mid: references `uniforms.voxelSize` */
    sideEps: string
    /** For MDC mid: references `uniforms.voxelSize` */
    vtxEps: string
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
                    if (dot(prevDir, nextDir) < ${LATHE_COLLINEAR_DOT}) {
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
                            var ring = sdfRMidRing(d, 1.0, n0m, feat, ringTangent, n1m, axisCenter, length(p - feat));
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
    let vtxEps = ${eps.vtxEps};
    if (abs(d) < sideEps) {
        // Only inspect the two vertices of the closest profile edge (O(1) vertex checks).
        let edgeIdx = u32(combined.y);
        let v0 = polygonVertices[${BASE}u + edgeIdx];
        let v1 = polygonVertices[${BASE}u + (edgeIdx + 1u) % ${N}u];

        // Check v0 (start of closest edge).
        if (length(q - vec2f(abs(v0.x), v0.y)) < vtxEps) {
            let vPrev = polygonVertices[${BASE}u + (edgeIdx + ${N}u - 1u) % ${N}u];
            let prevLeg = v0 - vPrev;
            let nextLeg = v1 - v0;
            ${cornerBody("v0", "edgeIdx + 1u")}
        }

        // Check v1 (end of closest edge).
        if (length(q - vec2f(abs(v1.x), v1.y)) < vtxEps) {
            let vNext = polygonVertices[${BASE}u + (edgeIdx + 2u) % ${N}u];
            let prevLeg = v1 - v0;
            let nextLeg = vNext - v1;
            ${cornerBody("v1", `((edgeIdx + 1u) % ${N}u) + 1u`)}
        }
    }
    return sdfRMid(d, 1.0, n);
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
}

function latheProfile(profile: Polygon2D): Lathe {
    return new Lathe(DEFAULT_POS, profile)
}

export const lathe = { profile: latheProfile }
