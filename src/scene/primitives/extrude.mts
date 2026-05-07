import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { capDragOrF32Wgsl, f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D } from "./polygon2d.mjs"
import { VirtualCapNode } from "./virtual-cap.mjs"

/**
 * MDC feature constraints should only be emitted for meaningful polygon turns.
 * A looser threshold treats lightly polygonized smooth outlines as hard vertical
 * creases and gives feature snapping too much authority over otherwise smooth sides.
 */
const EXTRUDE_MDC_FEATURE_DOT = 0.95

/**
 * Minimum turn at a polygon vertex (|cross(prevDir, nextDir)| with unit edge dirs in xz)
 * to emit an MDC crease. Vertices that only subdivide a straight side have ~0 cross and
 * would otherwise look "infinitely sharp" because outward normals oppose (dot ≈ -1).
 */
const EXTRUDE_MDC_VERTEX_TURN_MIN = 1e-6

/**
 * Max distance of edge parameter tt from 0 or 1 (along the closest polygon edge) to treat a
 * stamp as lying on a polygon vertex for rim vs corner. Dimensionless; wide bands fought MDC
 * with ambiguous rim/corner labels on caps (jagged outline).
 */
const EXTRUDE_MDC_VERTEX_EDGE_T = 1e-4

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
    let onSide = d2d > dCap;
    let gx_tw = combined.z;
    let gz_tw = combined.w;
    let twistRate = select(0.0, twist / (2.0 * h), abs(h) > 1e-6);
    let gySide = twistRate * (gx_tw * twisted.y - gz_tw * twisted.x);
    let nSide = safeNormalize(vec3f(ca * gx_tw - sa * gz_tw, gySide, sa * gx_tw + ca * gz_tw), vec3f(1.0, 0.0, 0.0));
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
        const capH = capDragOrF32Wgsl(this.paramOffset + 3, this.previewF32Slot + 0)
        const capYOff = capDragOrF32Wgsl(this.paramOffset + 4, this.previewF32Slot + 1)
        const twistRad = f32Wgsl(this.paramOffset + 5, this.previewF32Slot + 2)
        const N = this.child.vertices.length
        const BASE = this.child.bufferOffset
        const windSign = (() => {
            let area = 0
            const verts = this.child.vertices
            for (let i = 0; i < verts.length; i++) {
                const [ax, ay] = verts[i]!
                const [bx, by] = verts[(i + 1) % verts.length]!
                area += (ax + bx) * (ay - by)
            }
            return area < 0 ? -1.0 : 1.0
        })()
        const windSignStr = windSign.toFixed(1)

        // Single path for all twists (twist=0 ⇒ angle=0, twisted=p.xz). Previously twist≠0 used a
        // different body than twist=0; tiny twist changed caps/sides because it switched WGSL, not
        // because of rotation magnitude.
        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
    let h = ${capH};
    let capY = p.y - ${capYOff};
    let twist = ${twistRad};
    let tTw = clamp((capY + h) / (2.0 * h), 0.0, 1.0);
    let angle = twist * tTw;
    let ca = cos(angle);
    let sa = sin(angle);
    let twisted = vec2f(ca * p.x + sa * p.z, -sa * p.x + ca * p.z);
    let combined = ${combinedFunc}(twisted);
    let d2d = combined.x;
    let dCap = abs(capY) - h;
    let d = max(d2d, dCap);
    let onSide = d2d > dCap;
    let gx_tw = combined.z;
    let gz_tw = combined.w;
    let twistRate = select(0.0, twist / (2.0 * h), abs(h) > 1e-6);
    let gySide = twistRate * (gx_tw * twisted.y - gz_tw * twisted.x);
    let nSide = safeNormalize(vec3f(ca * gx_tw - sa * gz_tw, gySide, sa * gx_tw + ca * gz_tw), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    let n = select(nCap, nSide, onSide);
    let capPlaneY = ${capYOff} + sgn(capY) * h;
    let qProf = twisted;
    // Topological bands — model-relative + SURF_DIST; tt tolerance is dimensionless (edge fraction).
    let vertexTTol = ${EXTRUDE_MDC_VERTEX_EDGE_T};
    let featBand = max(SURF_DIST * 8.0, h * 0.02);
    let extrudeMidId = ${this.id}u;

    var bestPd = 1e30;
    var bestKe = 0u;
    var bestTt = 0.0;
    for (var ke = 0u; ke < ${N}u; ke = ke + 1u) {
        let vk = polygonVertices[${BASE}u + ke];
        let vk1 = polygonVertices[${BASE}u + (ke + 1u) % ${N}u];
        let seg = vk1 - vk;
        let sl2 = max(dot(seg, seg), 1e-12);
        let tt = clamp(dot(qProf - vk, seg) / sl2, 0.0, 1.0);
        let proj = vk + seg * tt;
        let pd = length(qProf - proj);
        if (pd < bestPd) {
            bestPd = pd;
            bestKe = ke;
            bestTt = tt;
        }
    }

    if (!onSide && bestPd < featBand) {
        let vk = polygonVertices[${BASE}u + bestKe];
        let vk1 = polygonVertices[${BASE}u + (bestKe + 1u) % ${N}u];
        let seg = vk1 - vk;
        let sl2 = max(dot(seg, seg), 1e-12);
        let edgeLen = sqrt(sl2);
        let edgeTan2 = seg / edgeLen;
        let edgeOut2 = vec2f(edgeTan2.y, -edgeTan2.x) * ${windSignStr};
        let tt = bestTt;
        let rim = vk + seg * tt;
        var cornerKv = ${N}u;
        if (tt <= vertexTTol) {
            cornerKv = bestKe;
        } else if (tt >= 1.0 - vertexTTol) {
            cornerKv = (bestKe + 1u) % ${N}u;
        }
        if (cornerKv < ${N}u) {
            let cv = polygonVertices[${BASE}u + cornerKv];
            let cvPrev = polygonVertices[${BASE}u + (cornerKv + ${N}u - 1u) % ${N}u];
            let cvNext = polygonVertices[${BASE}u + (cornerKv + 1u) % ${N}u];
            let prevDir = normalize(cv - cvPrev);
            let nextDir = normalize(cvNext - cv);
            let vertexTurn = abs(prevDir.x * nextDir.y - prevDir.y * nextDir.x);
            let prevOut2 = vec2f(prevDir.y, -prevDir.x) * ${windSignStr};
            let nextOut2 = vec2f(nextDir.y, -nextDir.x) * ${windSignStr};
            let n0 = safeNormalize(vec3f(ca * prevOut2.x - sa * prevOut2.y, 0.0, sa * prevOut2.x + ca * prevOut2.y), vec3f(1.0, 0.0, 0.0));
            let n1 = safeNormalize(vec3f(ca * nextOut2.x - sa * nextOut2.y, 0.0, sa * nextOut2.x + ca * nextOut2.y), vec3f(1.0, 0.0, 0.0));
            if (vertexTurn >= ${EXTRUDE_MDC_VERTEX_TURN_MIN} && dot(n0, n1) < ${EXTRUDE_MDC_FEATURE_DOT}) {
                let featurePoint = vec3f(ca * cv.x - sa * cv.y, capPlaneY, sa * cv.x + ca * cv.y);
                var cr = sdfRMidCorner(d, 1.0, n, featurePoint, n0, n1, length(p - featurePoint));
                cr.featureIdA = extrudeMidId;
                cr.featureIdB = cornerKv + 1u;
                return cr;
            }
        }
        let tangent = safeNormalize(vec3f(ca * edgeTan2.x - sa * edgeTan2.y, 0.0, sa * edgeTan2.x + ca * edgeTan2.y), vec3f(1.0, 0.0, 0.0));
        let edgeOut = safeNormalize(vec3f(ca * edgeOut2.x - sa * edgeOut2.y, 0.0, sa * edgeOut2.x + ca * edgeOut2.y), vec3f(1.0, 0.0, 0.0));
        let featurePoint = vec3f(ca * rim.x - sa * rim.y, capPlaneY, sa * rim.x + ca * rim.y);
        var ln = sdfRMidLine(d, 1.0, n, featurePoint, tangent, edgeOut, length(p - featurePoint));
        ln.featureIdA = extrudeMidId;
        ln.featureIdB = bestKe + 1u;
        return ln;
    }

    if (onSide && bestPd < featBand) {
        let nearCap = abs(abs(capY) - h) < featBand;
        let tt = bestTt;
        var creaseKv = ${N}u;
        if (tt <= vertexTTol) {
            creaseKv = bestKe;
        } else if (tt >= 1.0 - vertexTTol) {
            creaseKv = (bestKe + 1u) % ${N}u;
        }
        if (creaseKv < ${N}u) {
            let sv = polygonVertices[${BASE}u + creaseKv];
            let svPrev = polygonVertices[${BASE}u + (creaseKv + ${N}u - 1u) % ${N}u];
            let svNext = polygonVertices[${BASE}u + (creaseKv + 1u) % ${N}u];
            let prevDir = normalize(sv - svPrev);
            let nextDir = normalize(svNext - sv);
            let vertexTurn = abs(prevDir.x * nextDir.y - prevDir.y * nextDir.x);
            let prevOut2 = vec2f(prevDir.y, -prevDir.x) * ${windSignStr};
            let nextOut2 = vec2f(nextDir.y, -nextDir.x) * ${windSignStr};
            let n0gy = twistRate * (prevOut2.x * twisted.y - prevOut2.y * twisted.x);
            let n1gy = twistRate * (nextOut2.x * twisted.y - nextOut2.y * twisted.x);
            let n0 = safeNormalize(vec3f(ca * prevOut2.x - sa * prevOut2.y, n0gy, sa * prevOut2.x + ca * prevOut2.y), vec3f(1.0, 0.0, 0.0));
            let n1 = safeNormalize(vec3f(ca * nextOut2.x - sa * nextOut2.y, n1gy, sa * nextOut2.x + ca * nextOut2.y), vec3f(1.0, 0.0, 0.0));
            if (vertexTurn >= ${EXTRUDE_MDC_VERTEX_TURN_MIN} && dot(n0, n1) < ${EXTRUDE_MDC_FEATURE_DOT}) {
                let sideOtherN = select(n1, n0, dot(nSide, n1) > dot(nSide, n0));
                if (nearCap) {
                    let capSign = sgn(capY);
                    let featurePoint = vec3f(ca * sv.x - sa * sv.y, ${capYOff} + capSign * h, sa * sv.x + ca * sv.y);
                    var cr = sdfRMidCorner(d, 1.0, n, featurePoint, vec3f(0.0, capSign, 0.0), sideOtherN, length(p - featurePoint));
                    cr.featureIdA = extrudeMidId;
                    cr.featureIdB = creaseKv + 1u;
                    return cr;
                }
                let featurePoint = vec3f(ca * sv.x - sa * sv.y, p.y, sa * sv.x + ca * sv.y);
                let tanHel = safeNormalize(vec3f(-twistRate * featurePoint.z, 1.0, twistRate * featurePoint.x), vec3f(0.0, 1.0, 0.0));
                var ln = sdfRMidLine(d, 1.0, n, featurePoint, tanHel, sideOtherN, length(p - featurePoint));
                ln.featureIdA = extrudeMidId;
                ln.featureIdB = creaseKv + 1u;
                return ln;
            }
        }
    }
    return sdfRMid(d, 1.0, n);
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
            text: `sdfMidSetOwner(sdfTranslateFeatureMid(${this.wgslMidFuncName}(p - ${pos}), p, ${pos}), ${this.id}u)`,
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
