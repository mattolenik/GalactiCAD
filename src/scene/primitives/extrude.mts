import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { capDragOrF32Wgsl, f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D } from "./polygon2d.mjs"
import { VirtualCapNode } from "./virtual-cap.mjs"

/**
 * Extrudes a 2D SDF child along the Y axis to produce a 3D solid.
 * h is the half-height (extends h above and h below the center, consistent with Cylinder).
 */
export class Extrude extends Node {
    pos = new Vec3f()
    h: number
    twistDegrees: number
    child: Polygon2D
    readonly capTop: VirtualCapNode
    readonly capBottom: VirtualCapNode

    constructor(child: Polygon2D, opts: { h: number; t?: number })
    constructor(pos: Vec3, child: Polygon2D, opts: { h: number; t?: number })
    constructor(...args: any[]) {
        super()
        this.capTop = new VirtualCapNode(true)
        this.capBottom = new VirtualCapNode(false)
        if (args[0] instanceof Polygon2D) {
            this.pos = new Vec3f()
            this.child = args[0]
            this.h = args[1].h
            this.twistDegrees = args[1].t ?? 0
        } else {
            this.pos = vec3(args[0])
            this.child = args[1]
            this.h = args[2].h
            this.twistDegrees = args[2].t ?? 0
        }
    }

    override getShapeType(): string { return "extrude" }
    override getIndicatorSymbol(): string { return "⬒" }

    protected override _computeCodegenCost(): number {
        return this.child.codegenCost() + BVH_MIN_COST
    }
    override getIndicatorSvg(): string {
        return `<rect x="2" y="1" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1"/>`
    }
    override writeSceneParams(view: Float32Array): void {
        view.set(this.pos.data, 0)
        view[3] = this.h
        view[4] = 0
        // Total twist in radians (runtime); twist WGSL path reads this so param-only rebuilds see angle changes.
        view[5] = (this.twistDegrees * Math.PI) / 180
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.pos.data[0]!
        out.vec3[b + 1] = this.pos.data[1]!
        out.vec3[b + 2] = this.pos.data[2]!
        out.vec3[b + 3] = 0
        out.f32[this.previewF32Slot + 0] = this.h
        out.f32[this.previewF32Slot + 1] = 0
        out.f32[this.previewF32Slot + 2] = (this.twistDegrees * Math.PI) / 180
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.previewF32Slot = this.scene.allocPreviewF32(3)
        this.paramOffset = this.scene.allocSceneParamFloats(6)
        this.paramCount = 6
        this.child.root = this.root
        this.child.build()
        this.capTop.root = this.root
        this.capTop.build()
        this.capBottom.root = this.root
        this.capBottom.build()
    }

    override appendStructuralFingerprint(parts: string[]): void {
        const twist = this.twistDegrees !== 0 ? "1" : "0"
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}:twist:${twist}:p:${this.paramCount}`)
        this.child.appendStructuralFingerprint(parts)
        this.capTop.appendStructuralFingerprint(parts)
        this.capBottom.appendStructuralFingerprint(parts)
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.child.getAllDescendantIds(), this.capTop.id, this.capBottom.id]
    }

    get wgslFieldFuncName(): string { return `fExtrude_${this.id}_field` }
    get wgslExFuncName(): string { return `fExtrude_${this.id}_Ex` }
    get wgslFastFuncName(): string { return `fExtrude_${this.id}_Fast` }
    get wgslMidFuncName(): string { return `fExtrude_${this.id}_Mid` }

    override compileAux(): string {
        const childFunc = this.child.wgslFuncName
        const combinedFunc = this.child.wgslCombinedFuncName
        const capTopId = this.capTop.id
        const capBottomId = this.capBottom.id
        const N = this.child.vertices.length
        const BASE = this.child.bufferOffset
        const hasTwist = this.twistDegrees !== 0

        const windSign = (() => {
            let area = 0
            const verts = this.child.vertices
            for (let i = 0; i < verts.length; i++) {
                const [ax, ay] = verts[i]
                const [bx, by] = verts[(i + 1) % verts.length]
                area += (ax + bx) * (ay - by)
            }
            return area < 0 ? -1.0 : 1.0
        })()
        const windSignStr = windSign.toFixed(1)
        const capH = capDragOrF32Wgsl(this.paramOffset + 3, this.previewF32Slot + 0)
        const capYOff = capDragOrF32Wgsl(this.paramOffset + 4, this.previewF32Slot + 1)
        const twistRad = f32Wgsl(this.paramOffset + 5, this.previewF32Slot + 2)

        if (!hasTwist) {
            return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let combined = ${combinedFunc}(p.xz);
    var d2d = combined.x;

    if (faceSelection.mode == 1u && faceSelection.nodeId == id && faceSelection.extrudeOffset != 0.0) {
        let fi = faceSelection.faceIndex;
        let v0 = polygonVertices[${BASE}u + fi];
        let v1 = polygonVertices[${BASE}u + (fi + 1u) % ${N}u];
        let edgeDir = v1 - v0;
        let edgeLen = length(edgeDir);
        let eTan = edgeDir / edgeLen;
        let eNorm = vec2f(eTan.y, -eTan.x);
        let outNorm = eNorm * ${windSignStr};
        let off = faceSelection.extrudeOffset;
        let edgeMid = (v0 + v1) * 0.5;
        let rectCenter = edgeMid + outNorm * off * 0.5;
        let rel = p.xz - rectCenter;
        let localX = dot(rel, eTan);
        let localY = dot(rel, outNorm);
        let halfW = edgeLen * 0.5;
        let halfH = abs(off) * 0.5;
        let dd = vec2f(abs(localX) - halfW, abs(localY) - halfH);
        let bumpDist = length(max(dd, vec2f(0.0))) + min(max(dd.x, dd.y), 0.0);
        d2d = min(d2d, bumpDist);
    }

    let capH = ${capH};
    let capY = p.y - ${capYOff};
    let dCap = abs(capY) - capH;
    let d = max(d2d, dCap);
    let onSide = d2d > dCap;
    var gx = combined.z;
    var gz = combined.w;

    if (faceSelection.mode == 1u && faceSelection.nodeId == id && faceSelection.extrudeOffset != 0.0) {
        let fi = faceSelection.faceIndex;
        let v0 = polygonVertices[${BASE}u + fi];
        let v1 = polygonVertices[${BASE}u + (fi + 1u) % ${N}u];
        let edgeDir = v1 - v0;
        let edgeLen = length(edgeDir);
        let eTan = edgeDir / edgeLen;
        let eNorm = vec2f(eTan.y, -eTan.x);
        let outNorm = eNorm * ${windSignStr};
        let off = faceSelection.extrudeOffset;
        let edgeMid = (v0 + v1) * 0.5;
        let rectCenter = edgeMid + outNorm * off * 0.5;
        let halfW = edgeLen * 0.5;
        let halfH = abs(off) * 0.5;
        let eps = 0.001;
        let gx_pos = ${childFunc}(p.xz + vec2f(eps, 0.0));
        let gx_neg = ${childFunc}(p.xz - vec2f(eps, 0.0));
        let gz_pos = ${childFunc}(p.xz + vec2f(0.0, eps));
        let gz_neg = ${childFunc}(p.xz - vec2f(0.0, eps));
        let sample_xp = p.xz + vec2f(eps, 0.0);
        let sample_xn = p.xz - vec2f(eps, 0.0);
        let sample_zp = p.xz + vec2f(0.0, eps);
        let sample_zn = p.xz - vec2f(0.0, eps);
        gx = min(gx_pos, rectSDF2D(sample_xp, rectCenter, eTan, outNorm, halfW, halfH))
           - min(gx_neg, rectSDF2D(sample_xn, rectCenter, eTan, outNorm, halfW, halfH));
        gz = min(gz_pos, rectSDF2D(sample_zp, rectCenter, eTan, outNorm, halfW, halfH))
           - min(gz_neg, rectSDF2D(sample_zn, rectCenter, eTan, outNorm, halfW, halfH));
    }

    let nSide = safeNormalize(vec3f(gx, 0.0, gz), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    let capId = select(${capBottomId}u, ${capTopId}u, capY > 0.0);
    var resultId = select(capId, id, onSide);
    if (faceSelection.nodeId == id) {
        if (onSide && faceSelection.mode == 0u) {
            let edge = u32(combined.y);
            if (edge == faceSelection.faceIndex) {
                resultId = FACE_HIGHLIGHT_ID;
            }
        } else if (onSide && faceSelection.mode == 1u) {
            let fi = faceSelection.faceIndex;
            let v0 = polygonVertices[${BASE}u + fi];
            let v1 = polygonVertices[${BASE}u + (fi + 1u) % ${N}u];
            let edgeDir = v1 - v0;
            let edgeLen = length(edgeDir);
            let eTan = edgeDir / edgeLen;
            let eNorm = vec2f(eTan.y, -eTan.x);
            let outNorm2 = eNorm * ${windSignStr};
            let off2 = faceSelection.extrudeOffset;
            let edgeMid2 = (v0 + v1) * 0.5;
            let faceMid = edgeMid2 + outNorm2 * off2;
            let rel2 = p.xz - faceMid;
            let projAlong = abs(dot(rel2, eTan));
            let projNorm = abs(dot(rel2, outNorm2));
            if (projAlong < edgeLen * 0.5 + 0.01 && projNorm < 0.01) {
                resultId = FACE_HIGHLIGHT_ID;
            }
        } else if (!onSide && faceSelection.mode >= 2u) {
            let isTopFace = capY > 0.0;
            if (faceSelection.mode == 2u && isTopFace) {
                resultId = FACE_HIGHLIGHT_TOP;
            } else if (faceSelection.mode == 3u && !isTopFace) {
                resultId = FACE_HIGHLIGHT_BOTTOM;
            }
        }
    }
    return sdfTrue(d, resultId, n);
}
`
        }

        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let h = ${capH};
    let capY = p.y - ${capYOff};
    let twist = ${twistRad};
    let t = clamp((capY + h) / (2.0 * h), 0.0, 1.0);
    let angle = twist * t;
    let ca = cos(angle);
    let sa = sin(angle);
    let twisted = vec2f(ca * p.x + sa * p.z, -sa * p.x + ca * p.z);
    let combined = ${combinedFunc}(twisted);
    let d2d = combined.x;
    let dCap = abs(capY) - h;
    let d = max(d2d, dCap);
    let onSide = (d - dCap) > 0.01;
    let gx_tw = combined.z;
    let gz_tw = combined.w;
    let nSide = safeNormalize(vec3f(ca * gx_tw - sa * gz_tw, 0.0, sa * gx_tw + ca * gz_tw), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    let capId = select(${capBottomId}u, ${capTopId}u, capY > 0.0);
    var resultId = select(capId, id, onSide);
    if (!onSide && faceSelection.nodeId == id && faceSelection.mode >= 2u) {
        let isTopFace = capY > 0.0;
        if (faceSelection.mode == 2u && isTopFace) {
            resultId = FACE_HIGHLIGHT_TOP;
        } else if (faceSelection.mode == 3u && !isTopFace) {
            resultId = FACE_HIGHLIGHT_BOTTOM;
        }
    }
    return sdfR(d, 0.8, resultId, n);
}
`
    }

    override compileAuxFast(): string {
        const childFunc = this.child.wgslFuncName
        const hasTwist = this.twistDegrees !== 0
        const capH = capDragOrF32Wgsl(this.paramOffset + 3, this.previewF32Slot + 0)
        const capYOff = capDragOrF32Wgsl(this.paramOffset + 4, this.previewF32Slot + 1)
        const twistRad = f32Wgsl(this.paramOffset + 5, this.previewF32Slot + 2)

        if (!hasTwist) {
            return `
fn ${this.wgslFastFuncName}(p: vec3f) -> FastSDFResult {
    let d2d = ${childFunc}(p.xz);
    let dCap = abs(p.y - ${capYOff}) - ${capH};
    return sdfFast(max(d2d, dCap), 1.0, 1.0);
}
`
        }

        return `
fn ${this.wgslFieldFuncName}(p: vec3f) -> f32 {
    let h = ${capH};
    let capY = p.y - ${capYOff};
    let twist = ${twistRad};
    let t = clamp((capY + h) / (2.0 * h), 0.0, 1.0);
    let angle = twist * t;
    let ca = cos(angle);
    let sa = sin(angle);
    let twisted = vec2f(ca * p.x + sa * p.z, -sa * p.x + ca * p.z);
    let d2d = ${childFunc}(twisted);
    let dCap = abs(capY) - h;
    return max(d2d, dCap);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> FastSDFResult {
    return sdfFast(${this.wgslFieldFuncName}(p), 0.8, 0.8);
}
`
    }

    override compileAuxMid(): string {
        const combinedFunc = this.child.wgslCombinedFuncName
        const hasTwist = this.twistDegrees !== 0
        const capH = capDragOrF32Wgsl(this.paramOffset + 3, this.previewF32Slot + 0)
        const capYOff = capDragOrF32Wgsl(this.paramOffset + 4, this.previewF32Slot + 1)
        const twistRad = f32Wgsl(this.paramOffset + 5, this.previewF32Slot + 2)

        if (!hasTwist) {
            return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let combined = ${combinedFunc}(p.xz);
    let d2d = combined.x;
    let capH = ${capH};
    let capY = p.y - ${capYOff};
    let dCap = abs(capY) - capH;
    let d = max(d2d, dCap);
    let onSide = d2d > dCap;
    let gx = combined.z;
    let gz = combined.w;
    let nSide = safeNormalize(vec3f(gx, 0.0, gz), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    return sdfRMid(d, 1.0, n);
}
`
        }

        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let h = ${capH};
    let capY = p.y - ${capYOff};
    let twist = ${twistRad};
    let t = clamp((capY + h) / (2.0 * h), 0.0, 1.0);
    let angle = twist * t;
    let ca = cos(angle);
    let sa = sin(angle);
    let twisted = vec2f(ca * p.x + sa * p.z, -sa * p.x + ca * p.z);
    let combined = ${combinedFunc}(twisted);
    let d2d = combined.x;
    let dCap = abs(capY) - h;
    let d = max(d2d, dCap);
    let onSide = (d - dCap) > 0.01;
    let gx_tw = combined.z;
    let gz_tw = combined.w;
    let nSide = safeNormalize(vec3f(ca * gx_tw - sa * gz_tw, 0.0, sa * gx_tw + ca * gz_tw), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    return sdfRMid(d, 0.8, n);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Extrude${this.id}`
        const varName = decapitalize(funcName)
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${pos}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Extrude${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${pos})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Extrude${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: `${this.wgslMidFuncName}(p - ${pos})`,
        }
    }

    protected override computeBoundsCore(): AABB {
        // Compute 2D extents of polygon profile, then add extrusion height
        let maxX = 0, maxZ = 0
        for (const [x, z] of this.child.vertices) {
            maxX = Math.max(maxX, Math.abs(x))
            maxZ = Math.max(maxZ, Math.abs(z))
        }
        // When twisted, the profile sweeps out a wider area; use circumradius as conservative bound
        if (this.twistDegrees !== 0) {
            const circ = Math.sqrt(maxX * maxX + maxZ * maxZ)
            maxX = circ
            maxZ = circ
        }
        return aabb(this.pos.x, this.pos.y, this.pos.z, maxX, this.h, maxZ)
    }

    @fluent height(n: number): this {
        this.h = n
        return this
    }

    @fluent twist(degrees: number): this {
        this.twistDegrees = degrees
        return this
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function extrudeProfile(profile: Polygon2D): Extrude {
    return new Extrude(DEFAULT_POS, profile, { h: 1, t: 0 })
}

export const extrude = { profile: extrudeProfile }
