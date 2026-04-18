import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { capDragOrF32Wgsl, f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D, polygon2dWindingSign } from "./polygon2d.mjs"

/**
 * Lofts between two or more 2D SDF profiles along the Y axis.
 * h is the half-height. Profiles are evenly spaced from -h (first) to +h (last).
 */
export class Loft extends Node {
    pos = new Vec3f()
    h: number
    profiles: Polygon2D[]

    constructor(profiles: Polygon2D[], opts: { h: number })
    constructor(pos: Vec3, profiles: Polygon2D[], opts: { h: number })
    constructor(...args: any[]) {
        super()
        if (Array.isArray(args[0]) && args[0][0] instanceof Polygon2D) {
            this.pos = new Vec3f()
            this.profiles = args[0]
            this.h = args[1].h
        } else {
            this.pos = vec3(args[0])
            this.profiles = args[1]
            this.h = args[2].h
        }
        if (this.profiles.length < 2) {
            throw new Error("loft requires at least 2 profiles")
        }
    }

    override getShapeType(): string { return "loft" }
    override getIndicatorSymbol(): string { return "⏥" }

    protected override _computeCodegenCost(): number {
        const profileCost = this.profiles.reduce((sum, p) => sum + p.codegenCost(), 0)
        return profileCost + BVH_MIN_COST * this.profiles.length
    }
    override getIndicatorSvg(): string {
        return `<polygon points="3,1 9,1 11,11 1,11" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override writeSceneParams(view: Float32Array): void {
        view.set(this.pos.data, 0)
        view[3] = this.h
        view[4] = 0
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.pos.data[0]!
        out.vec3[b + 1] = this.pos.data[1]!
        out.vec3[b + 2] = this.pos.data[2]!
        out.vec3[b + 3] = 0
        out.f32[this.previewF32Slot + 0] = this.h
        out.f32[this.previewF32Slot + 1] = 0
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.previewF32Slot = this.scene.allocPreviewF32(2)
        this.paramOffset = this.scene.allocSceneParamFloats(5)
        this.paramCount = 5
        for (const profile of this.profiles) {
            profile.root = this.root
            profile.build()
        }
    }

    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}:profiles:${this.profiles.length}`)
        for (const profile of this.profiles) {
            profile.appendStructuralFingerprint(parts)
        }
    }

    override getAllDescendantIds(): number[] {
        const ids = [this.id]
        for (const profile of this.profiles) {
            ids.push(...profile.getAllDescendantIds())
        }
        return ids
    }

    get wgslFieldFuncName(): string { return `fLoft_${this.id}_field` }
    get wgslExFuncName(): string { return `fLoft_${this.id}_Ex` }
    get wgslFastFuncName(): string { return `fLoft_${this.id}_Fast` }
    get wgslMidFuncName(): string { return `fLoft_${this.id}_Mid` }

    private generateFieldBody(_h: string): string {
        const N = this.profiles.length

        if (N === 2) {
            const f0 = this.profiles[0].wgslFuncName
            const f1 = this.profiles[1].wgslFuncName
            return `    let d_profile = mix(${f0}(p.xz), ${f1}(p.xz), t);`
        }

        const numSegments = N - 1
        let code = `    let seg = t * ${numSegments.toFixed(1)};\n`
        code += `    let si = min(u32(seg), ${(numSegments - 1)}u);\n`
        code += `    let localT = seg - f32(si);\n`
        code += `    var dA: f32; var dB: f32;\n`
        for (let i = 0; i < numSegments; i++) {
            const fA = this.profiles[i].wgslFuncName
            const fB = this.profiles[i + 1].wgslFuncName
            if (i === 0) {
                code += `    if (si == 0u) { dA = ${fA}(p.xz); dB = ${fB}(p.xz); }\n`
            } else if (i === numSegments - 1) {
                code += `    else { dA = ${fA}(p.xz); dB = ${fB}(p.xz); }\n`
            } else {
                code += `    else if (si == ${i}u) { dA = ${fA}(p.xz); dB = ${fB}(p.xz); }\n`
            }
        }
        code += `    let d_profile = mix(dA, dB, localT);`
        return code
    }

    override compileAux(): string {
        const capH = capDragOrF32Wgsl(this.paramOffset + 3, this.previewF32Slot + 0)
        const capYOff = capDragOrF32Wgsl(this.paramOffset + 4, this.previewF32Slot + 1)
        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let d = ${this.wgslFieldFuncName}(p);
    let capH = ${capH};
    let capY = p.y - ${capYOff};
    let dCap = abs(capY) - capH;
    let onSide = (d - dCap) > 0.01;
    let eps = 0.001;
    let gx = ${this.wgslFieldFuncName}(p + vec3f(eps, 0.0, 0.0)) - ${this.wgslFieldFuncName}(p - vec3f(eps, 0.0, 0.0));
    let gz = ${this.wgslFieldFuncName}(p + vec3f(0.0, 0.0, eps)) - ${this.wgslFieldFuncName}(p - vec3f(0.0, 0.0, eps));
    let nSide = safeNormalize(vec3f(gx, 0.0, gz), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    let bottomCap = capY < 0.0;
    let capId = select(${this.profiles[this.profiles.length - 1].id}u, ${this.profiles[0].id}u, bottomCap);
    var resultId = select(capId, id, onSide);
    if (!onSide && faceSelection.nodeId == id && faceSelection.mode >= 2u) {
        let isTopFace = capY > 0.0;
        if (faceSelection.mode == 2u && isTopFace) {
            resultId = FACE_HIGHLIGHT_TOP;
        } else if (faceSelection.mode == 3u && !isTopFace) {
            resultId = FACE_HIGHLIGHT_BOTTOM;
        }
    }
    return sdfTrue(d, resultId, n);
}
`
    }

    override compileAuxMid(): string {
        const capH = capDragOrF32Wgsl(this.paramOffset + 3, this.previewF32Slot + 0)
        const capYOff = capDragOrF32Wgsl(this.paramOffset + 4, this.previewF32Slot + 1)
        const bottomProfile = this.profiles[0]
        const topProfile = this.profiles[this.profiles.length - 1]
        const bottomWind = polygon2dWindingSign(bottomProfile.vertices).toFixed(1)
        const topWind = polygon2dWindingSign(topProfile.vertices).toFixed(1)
        const sameTopology = this.profiles.every(profile => profile.vertices.length === bottomProfile.vertices.length)
        const segmentCount = this.profiles.length - 1
        const segmentHeight = ((2 * this.h) / segmentCount).toFixed(6)
        const segmentInfo = (() => {
            if (this.profiles.length === 2) {
                return `
    let localT = t;
    let combinedA = ${this.profiles[0].wgslCombinedFuncName}(p.xz);
    let combinedB = ${this.profiles[1].wgslCombinedFuncName}(p.xz);
    let edgeIdxA = u32(combinedA.y);
    let edgeIdxB = u32(combinedB.y);
    let dProfile = mix(combinedA.x, combinedB.x, localT);
    let baseA = ${this.profiles[0].bufferOffset}u;
    let baseB = ${this.profiles[1].bufferOffset}u;
    let windA = ${polygon2dWindingSign(this.profiles[0].vertices).toFixed(1)};
    let windB = ${polygon2dWindingSign(this.profiles[1].vertices).toFixed(1)};`
            }
            let code = `
    let seg = t * ${segmentCount.toFixed(1)};
    let si = min(u32(seg), ${(segmentCount - 1)}u);
    let localT = seg - f32(si);
    var combinedA: vec4f;
    var combinedB: vec4f;
    var baseA: u32;
    var baseB: u32;
    var windA: f32;
    var windB: f32;
`
            for (let i = 0; i < segmentCount; i++) {
                const a = this.profiles[i]!
                const b = this.profiles[i + 1]!
                const branch = i === 0 ? "if" : i === segmentCount - 1 ? "else" : `else if`
                const cond = i === segmentCount - 1 ? "" : ` (si == ${i}u)`
                code += `    ${branch}${cond} {
        combinedA = ${a.wgslCombinedFuncName}(p.xz);
        combinedB = ${b.wgslCombinedFuncName}(p.xz);
        baseA = ${a.bufferOffset}u;
        baseB = ${b.bufferOffset}u;
        windA = ${polygon2dWindingSign(a.vertices).toFixed(1)};
        windB = ${polygon2dWindingSign(b.vertices).toFixed(1)};
    }
`
            }
            code += `    let edgeIdxA = u32(combinedA.y);
    let edgeIdxB = u32(combinedB.y);
    let dProfile = mix(combinedA.x, combinedB.x, localT);`
            return code
        })()
        const sideFeatureBlock = sameTopology ? `
    if (onSide && abs(dProfile) < sideEps && edgeIdxA == edgeIdxB) {
        let edgeIdx = edgeIdxA;
        let count = ${bottomProfile.vertices.length}u;
        let v0A = polygonVertices[baseA + edgeIdx];
        let v1A = polygonVertices[baseA + (edgeIdx + 1u) % count];
        let v0B = polygonVertices[baseB + edgeIdx];
        let v1B = polygonVertices[baseB + (edgeIdx + 1u) % count];
        let v0 = mix2f(v0A, v0B, localT);
        let v1 = mix2f(v1A, v1B, localT);
        let nearCapBottom = abs(capY + h) < capCornerEps;
        let nearCapTop = abs(capY - h) < capCornerEps;
        let nearCap = nearCapBottom || nearCapTop;
        let activeSideVtxEps = select(sideLineVtxEps, vtxEps, nearCap);

        if (length(p.xz - v0) < activeSideVtxEps) {
            let vPrevA = polygonVertices[baseA + (edgeIdx + count - 1u) % count];
            let vPrevB = polygonVertices[baseB + (edgeIdx + count - 1u) % count];
            let prevDirA = normalize(v0A - vPrevA);
            let nextDirA = normalize(v1A - v0A);
            let prevDirB = normalize(v0B - vPrevB);
            let nextDirB = normalize(v1B - v0B);
            let prevOutA = vec2f(prevDirA.y, -prevDirA.x) * windA;
            let nextOutA = vec2f(nextDirA.y, -nextDirA.x) * windA;
            let prevOutB = vec2f(prevDirB.y, -prevDirB.x) * windB;
            let nextOutB = vec2f(nextDirB.y, -nextDirB.x) * windB;
            let prevOut = normalize(mix2f(prevOutA, prevOutB, localT));
            let nextOut = normalize(mix2f(nextOutA, nextOutB, localT));
            let n0 = safeNormalize(vec3f(prevOut.x, 0.0, prevOut.y), vec3f(1.0, 0.0, 0.0));
            let n1 = safeNormalize(vec3f(nextOut.x, 0.0, nextOut.y), vec3f(1.0, 0.0, 0.0));
            if (dot(n0, n1) < 0.995) {
                if (abs(capY + h) < capCornerEps) {
                    let n0Cap = safeNormalize(vec3f(prevOutA.x, 0.0, prevOutA.y), vec3f(1.0, 0.0, 0.0));
                    let n1Cap = safeNormalize(vec3f(nextOutA.x, 0.0, nextOutA.y), vec3f(1.0, 0.0, 0.0));
                    let featurePoint = vec3f(v0A.x, ${capYOff} - h, v0A.y);
                    return sdfRMidCorner(d, 1.0, vec3f(0.0, -1.0, 0.0), featurePoint, n0Cap, n1Cap, length(p - featurePoint));
                }
                if (abs(capY - h) < capCornerEps) {
                    let n0Cap = safeNormalize(vec3f(prevOutB.x, 0.0, prevOutB.y), vec3f(1.0, 0.0, 0.0));
                    let n1Cap = safeNormalize(vec3f(nextOutB.x, 0.0, nextOutB.y), vec3f(1.0, 0.0, 0.0));
                    let featurePoint = vec3f(v0B.x, ${capYOff} + h, v0B.y);
                    return sdfRMidCorner(d, 1.0, vec3f(0.0, 1.0, 0.0), featurePoint, n0Cap, n1Cap, length(p - featurePoint));
                }
                let featurePoint = vec3f(v0.x, p.y, v0.y);
                let tangent = safeNormalize(vec3f(v0B.x - v0A.x, ${segmentHeight}, v0B.y - v0A.y), vec3f(0.0, 1.0, 0.0));
                return sdfRMidLine(d, 1.0, n0, featurePoint, tangent, n1, length(p - featurePoint));
            }
        }
        if (length(p.xz - v1) < activeSideVtxEps) {
            let vNextA = polygonVertices[baseA + (edgeIdx + 2u) % count];
            let vNextB = polygonVertices[baseB + (edgeIdx + 2u) % count];
            let prevDirA = normalize(v1A - v0A);
            let nextDirA = normalize(vNextA - v1A);
            let prevDirB = normalize(v1B - v0B);
            let nextDirB = normalize(vNextB - v1B);
            let prevOutA = vec2f(prevDirA.y, -prevDirA.x) * windA;
            let nextOutA = vec2f(nextDirA.y, -nextDirA.x) * windA;
            let prevOutB = vec2f(prevDirB.y, -prevDirB.x) * windB;
            let nextOutB = vec2f(nextDirB.y, -nextDirB.x) * windB;
            let prevOut = normalize(mix2f(prevOutA, prevOutB, localT));
            let nextOut = normalize(mix2f(nextOutA, nextOutB, localT));
            let n0 = safeNormalize(vec3f(prevOut.x, 0.0, prevOut.y), vec3f(1.0, 0.0, 0.0));
            let n1 = safeNormalize(vec3f(nextOut.x, 0.0, nextOut.y), vec3f(1.0, 0.0, 0.0));
            if (dot(n0, n1) < 0.995) {
                if (abs(capY + h) < capCornerEps) {
                    let n0Cap = safeNormalize(vec3f(prevOutA.x, 0.0, prevOutA.y), vec3f(1.0, 0.0, 0.0));
                    let n1Cap = safeNormalize(vec3f(nextOutA.x, 0.0, nextOutA.y), vec3f(1.0, 0.0, 0.0));
                    let featurePoint = vec3f(v1A.x, ${capYOff} - h, v1A.y);
                    return sdfRMidCorner(d, 1.0, vec3f(0.0, -1.0, 0.0), featurePoint, n0Cap, n1Cap, length(p - featurePoint));
                }
                if (abs(capY - h) < capCornerEps) {
                    let n0Cap = safeNormalize(vec3f(prevOutB.x, 0.0, prevOutB.y), vec3f(1.0, 0.0, 0.0));
                    let n1Cap = safeNormalize(vec3f(nextOutB.x, 0.0, nextOutB.y), vec3f(1.0, 0.0, 0.0));
                    let featurePoint = vec3f(v1B.x, ${capYOff} + h, v1B.y);
                    return sdfRMidCorner(d, 1.0, vec3f(0.0, 1.0, 0.0), featurePoint, n0Cap, n1Cap, length(p - featurePoint));
                }
                let featurePoint = vec3f(v1.x, p.y, v1.y);
                let tangent = safeNormalize(vec3f(v1B.x - v1A.x, ${segmentHeight}, v1B.y - v1A.y), vec3f(0.0, 1.0, 0.0));
                return sdfRMidLine(d, 1.0, n0, featurePoint, tangent, n1, length(p - featurePoint));
            }
        }
    }` : ""
        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let h = ${capH};
    let capY = p.y - ${capYOff};
    let t = clamp((capY + h) / (2.0 * h), 0.0, 1.0);
    let d = ${this.wgslFieldFuncName}(p);
    let dCap = abs(capY) - h;
    let onSide = (d - dCap) > 0.01;
    let eps = 0.001;
    let gx = ${this.wgslFieldFuncName}(p + vec3f(eps, 0.0, 0.0)) - ${this.wgslFieldFuncName}(p - vec3f(eps, 0.0, 0.0));
    let gz = ${this.wgslFieldFuncName}(p + vec3f(0.0, 0.0, eps)) - ${this.wgslFieldFuncName}(p - vec3f(0.0, 0.0, eps));
    let nSide = safeNormalize(vec3f(gx, 0.0, gz), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    let rimEps = max(max(SURF_DIST * 8.0, h * 0.02), uniforms.voxelSize * 0.6);
    let sideEps = max(max(SURF_DIST * 8.0, h * 0.015), uniforms.voxelSize * 0.35);
    let vtxEps = max(max(SURF_DIST * 8.0, h * 0.03), uniforms.voxelSize * 1.1);
    // Side-line vertex window must be strictly tight: a sample on the side
    // surface only sits *on* the (possibly tilted) profile-vertex column when its
    // 2D distance to that column is sub-voxel. A wider window catches samples on
    // the adjacent flat profile edge near v0, which then snap MDC vertices onto
    // the column and produce spurious creases / degenerate quads.
    let sideLineVtxEps = max(SURF_DIST * 4.0, uniforms.voxelSize * 0.18);
    let capCornerEps = max(rimEps, uniforms.voxelSize * 0.75);
    let capPlaneY = ${capYOff} + sgn(capY) * h;
    let bottomCombined = ${bottomProfile.wgslCombinedFuncName}(p.xz);
    let topCombined = ${topProfile.wgslCombinedFuncName}(p.xz);
${segmentInfo}

    if (!onSide && abs(dCap) < rimEps) {
        if (capY < 0.0 && abs(bottomCombined.x) < rimEps) {
            let edgeIdx = u32(bottomCombined.y);
            let count = ${bottomProfile.vertices.length}u;
            let v0 = polygonVertices[${bottomProfile.bufferOffset}u + edgeIdx];
            let v1 = polygonVertices[${bottomProfile.bufferOffset}u + (edgeIdx + 1u) % count];
            if (length(p.xz - v0) < vtxEps) {
                let vPrev = polygonVertices[${bottomProfile.bufferOffset}u + (edgeIdx + count - 1u) % count];
                let prevDir = normalize(v0 - vPrev);
                let nextDir = normalize(v1 - v0);
                let prevOut2 = vec2f(prevDir.y, -prevDir.x) * ${bottomWind};
                let nextOut2 = vec2f(nextDir.y, -nextDir.x) * ${bottomWind};
                let n0 = safeNormalize(vec3f(prevOut2.x, 0.0, prevOut2.y), vec3f(1.0, 0.0, 0.0));
                let n1 = safeNormalize(vec3f(nextOut2.x, 0.0, nextOut2.y), vec3f(1.0, 0.0, 0.0));
                if (dot(n0, n1) < 0.995) {
                    let featurePoint = vec3f(v0.x, capPlaneY, v0.y);
                    return sdfRMidCorner(d, 1.0, nCap, featurePoint, n0, n1, length(p - featurePoint));
                }
            }
            if (length(p.xz - v1) < vtxEps) {
                let vNext = polygonVertices[${bottomProfile.bufferOffset}u + (edgeIdx + 2u) % count];
                let prevDir = normalize(v1 - v0);
                let nextDir = normalize(vNext - v1);
                let prevOut2 = vec2f(prevDir.y, -prevDir.x) * ${bottomWind};
                let nextOut2 = vec2f(nextDir.y, -nextDir.x) * ${bottomWind};
                let n0 = safeNormalize(vec3f(prevOut2.x, 0.0, prevOut2.y), vec3f(1.0, 0.0, 0.0));
                let n1 = safeNormalize(vec3f(nextOut2.x, 0.0, nextOut2.y), vec3f(1.0, 0.0, 0.0));
                if (dot(n0, n1) < 0.995) {
                    let featurePoint = vec3f(v1.x, capPlaneY, v1.y);
                    return sdfRMidCorner(d, 1.0, nCap, featurePoint, n0, n1, length(p - featurePoint));
                }
            }
            let edge = v1 - v0;
            let edgeLen2 = max(dot(edge, edge), 1e-12);
            let edgeTan2 = edge / sqrt(edgeLen2);
            let edgeOut2 = vec2f(edgeTan2.y, -edgeTan2.x) * ${bottomWind};
            let tEdge = clamp(dot(p.xz - v0, edge) / edgeLen2, 0.0, 1.0);
            let rim = v0 + edge * tEdge;
            let featurePoint = vec3f(rim.x, capPlaneY, rim.y);
            return sdfRMidLine(
                d, 1.0, nCap,
                featurePoint,
                safeNormalize(vec3f(edgeTan2.x, 0.0, edgeTan2.y), vec3f(1.0, 0.0, 0.0)),
                safeNormalize(vec3f(edgeOut2.x, 0.0, edgeOut2.y), vec3f(1.0, 0.0, 0.0)),
                length(p - featurePoint),
            );
        }
        if (capY >= 0.0 && abs(topCombined.x) < rimEps) {
            let edgeIdx = u32(topCombined.y);
            let count = ${topProfile.vertices.length}u;
            let v0 = polygonVertices[${topProfile.bufferOffset}u + edgeIdx];
            let v1 = polygonVertices[${topProfile.bufferOffset}u + (edgeIdx + 1u) % count];
            if (length(p.xz - v0) < vtxEps) {
                let vPrev = polygonVertices[${topProfile.bufferOffset}u + (edgeIdx + count - 1u) % count];
                let prevDir = normalize(v0 - vPrev);
                let nextDir = normalize(v1 - v0);
                let prevOut2 = vec2f(prevDir.y, -prevDir.x) * ${topWind};
                let nextOut2 = vec2f(nextDir.y, -nextDir.x) * ${topWind};
                let n0 = safeNormalize(vec3f(prevOut2.x, 0.0, prevOut2.y), vec3f(1.0, 0.0, 0.0));
                let n1 = safeNormalize(vec3f(nextOut2.x, 0.0, nextOut2.y), vec3f(1.0, 0.0, 0.0));
                if (dot(n0, n1) < 0.995) {
                    let featurePoint = vec3f(v0.x, capPlaneY, v0.y);
                    return sdfRMidCorner(d, 1.0, nCap, featurePoint, n0, n1, length(p - featurePoint));
                }
            }
            if (length(p.xz - v1) < vtxEps) {
                let vNext = polygonVertices[${topProfile.bufferOffset}u + (edgeIdx + 2u) % count];
                let prevDir = normalize(v1 - v0);
                let nextDir = normalize(vNext - v1);
                let prevOut2 = vec2f(prevDir.y, -prevDir.x) * ${topWind};
                let nextOut2 = vec2f(nextDir.y, -nextDir.x) * ${topWind};
                let n0 = safeNormalize(vec3f(prevOut2.x, 0.0, prevOut2.y), vec3f(1.0, 0.0, 0.0));
                let n1 = safeNormalize(vec3f(nextOut2.x, 0.0, nextOut2.y), vec3f(1.0, 0.0, 0.0));
                if (dot(n0, n1) < 0.995) {
                    let featurePoint = vec3f(v1.x, capPlaneY, v1.y);
                    return sdfRMidCorner(d, 1.0, nCap, featurePoint, n0, n1, length(p - featurePoint));
                }
            }
            let edge = v1 - v0;
            let edgeLen2 = max(dot(edge, edge), 1e-12);
            let edgeTan2 = edge / sqrt(edgeLen2);
            let edgeOut2 = vec2f(edgeTan2.y, -edgeTan2.x) * ${topWind};
            let tEdge = clamp(dot(p.xz - v0, edge) / edgeLen2, 0.0, 1.0);
            let rim = v0 + edge * tEdge;
            let featurePoint = vec3f(rim.x, capPlaneY, rim.y);
            return sdfRMidLine(
                d, 1.0, nCap,
                featurePoint,
                safeNormalize(vec3f(edgeTan2.x, 0.0, edgeTan2.y), vec3f(1.0, 0.0, 0.0)),
                safeNormalize(vec3f(edgeOut2.x, 0.0, edgeOut2.y), vec3f(1.0, 0.0, 0.0)),
                length(p - featurePoint),
            );
        }
    }
${sideFeatureBlock}
    return sdfRMid(d, 0.8, n);
}
`
    }

    override compileAuxFast(): string {
        const h = this.h.toFixed(6)
        const fieldBody = this.generateFieldBody(h)
        const capH = capDragOrF32Wgsl(this.paramOffset + 3, this.previewF32Slot + 0)
        const capYOff = capDragOrF32Wgsl(this.paramOffset + 4, this.previewF32Slot + 1)

        return `
fn ${this.wgslFieldFuncName}(p: vec3f) -> f32 {
    let h = ${capH};
    let capY = p.y - ${capYOff};
    let t = clamp((capY + h) / (2.0 * h), 0.0, 1.0);
${fieldBody}
    let dCap = abs(capY) - h;
    return max(d_profile, dCap);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> FastSDFResult {
    return sdfFast(${this.wgslFieldFuncName}(p), 0.8, 0.8);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = decapitalize(funcName)
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${pos}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${pos})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `sdfMidSetOwner(sdfTranslateFeatureMid(${this.wgslMidFuncName}(p - ${pos}), p, ${pos}), ${this.id}u)`,
        }
    }

    protected override computeBoundsCore(): AABB {
        // Union of extents across all profile vertices in XZ, plus half-height
        let maxX = 0, maxZ = 0
        for (const profile of this.profiles) {
            for (const [x, z] of profile.vertices) {
                maxX = Math.max(maxX, Math.abs(x))
                maxZ = Math.max(maxZ, Math.abs(z))
            }
        }
        return aabb(this.pos.x, this.pos.y, this.pos.z, maxX, this.h, maxZ)
    }

    @fluent height(n: number): this {
        this.h = n
        return this
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function loftSections(sections: Polygon2D[]): Loft {
    if (sections.length < 2) {
        throw new Error("loft requires at least 2 profiles in sections")
    }
    for (const p of sections) {
        if (!(p instanceof Polygon2D)) {
            throw new Error("loft sections must be polygon2d() instances")
        }
    }
    return new Loft(DEFAULT_POS, sections, { h: 1 })
}

export const loft = { sections: loftSections }
