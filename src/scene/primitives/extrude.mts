import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, aabbRotate, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { capDragOrF32Wgsl, f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { eulerMatrices } from "../transform-math.mjs"
import { rotate as rotateOp, type Rotate } from "../operators/rotate.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D, polygon2dWindingSign } from "./polygon2d.mjs"
import { VirtualCapNode } from "./virtual-cap.mjs"
import {
    FG_FLAG_CORNER,
    FG_FLAG_CREASE_ORIGINAL,
    type FeatureGraphBuilder,
} from "../feature-graph-buffer.mjs"

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
        // rot inverse (9, contiguous via reservePrimitiveRot).
        this.writeRotScene(view, 6)
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
        this.writeRotPreview(out)
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.previewF32Slot = this.scene.allocPreviewF32(3)
        this.paramOffset = this.scene.allocSceneParamFloats(6)
        this.paramCount = 6
        this.reservePrimitiveRot() // +9 storage floats (contiguous) + 1 preview mat3
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

    /**
     * WGSL that replaces the flat per-edge side normal (`combined.zw`) with a
     * Phong blend across the closest edge — so a tessellated path2d profile shades
     * round in the SDF preview while genuine corners stay sharp. The per-vertex
     * outward normals are **precomputed at build time** (see
     * {@link computePolygonVertexNormals}) and stored in the appended normal region
     * of the shared polygon buffer (base `NORMBASE`); this just reads the two edge
     * endpoints and interpolates. A zero-sentinel normal marks a corner endpoint —
     * there it falls back to the flat per-edge normal (sign-aligned to the reliable
     * SDF gradient `combined.zw`) so the corner stays sharp. Purely visual and
     * density-independent: the build tessellation and feature graph are untouched,
     * so the shading is smooth at every zoom with whatever fixed tessellation the
     * scene was built at. Preview-only (`Ex`); never used by `Mid`/mesh extraction,
     * so the exported mesh stays faithfully faceted. Gated by
     * `viewSettings.flatShading` (the toolbar flat toggle and every agent render
     * force flat → identical to the mesh).
     * @param query 2D sample point in profile space (`"p.xz"` or `"twisted"`).
     * @param outX/outZ gradient lvalues to overwrite (`"gx"`/`"gz"` or the twist pair).
     * @param NORMBASE base index of the appended per-vertex normal region.
     */
    #sideNormalSmoothWgsl(query: string, outX: string, outZ: string, N: number, BASE: number, NORMBASE: number): string {
        return `
    if (sdfFlatShadingFlag() == 0u && onSide) {
        let smEi = u32(combined.y);
        let smI0 = ${BASE}u + smEi;
        let smI1 = ${BASE}u + (smEi + 1u) % ${N}u;
        let smV0 = polygonVertices[smI0];
        let smV1 = polygonVertices[smI1];
        let smSeg = smV1 - smV0;
        // Precomputed (already-outward) per-vertex normals of the closest edge's
        // two endpoints. A zero sentinel marks a corner endpoint.
        let smNb = polygonVertices[${NORMBASE}u + smI0];
        let smNc = polygonVertices[${NORMBASE}u + smI1];
        let smT = clamp(dot((${query}) - smV0, smSeg) / max(dot(smSeg, smSeg), 1e-12), 0.0, 1.0);
        let smBCorner = dot(smNb, smNb) <= 0.25;
        let smCCorner = dot(smNc, smNc) <= 0.25;
        var smNrm: vec2f;
        if (smBCorner || smCCorner) {
            // Facet touches a real corner: keep the crisp linear blend, with the
            // corner endpoint falling back to this edge's flat normal (oriented
            // outward via the reliable SDF gradient) so the crease stays sharp.
            let smRef = vec2f(combined.z, combined.w);
            let smFlatPerp = vec2f(smSeg.y, -smSeg.x);
            let smFlat = normalize(smFlatPerp) * select(-1.0, 1.0, dot(smFlatPerp, smRef) >= 0.0);
            let smB = select(smNb, smFlat, smBCorner);
            let smC = select(smNc, smFlat, smCCorner);
            smNrm = normalize(mix2f(smB, smC, smT));
        } else {
            // Chord-length (C1 in world arc-length) Catmull-Rom across the four
            // surrounding vertex normals. Linear (C0) interpolation leaves a slope
            // kink at every facet boundary, so a coarsely-tessellated curve shades
            // as "a gradient per face"; a C1 spline makes the normal flow unbroken
            // so the gradient stretches across the whole curve. Uniform parameter
            // would still kink in world space because facets have unequal lengths
            // (the steep specular amplifies that), so the spline is parameterized
            // by chord length. Outer controls clamp to the facet endpoints at
            // corners so smoothing never crosses a crease.
            let smIa = ${BASE}u + (smEi + ${N}u - 1u) % ${N}u;
            let smId = ${BASE}u + (smEi + 2u) % ${N}u;
            var smNa = polygonVertices[${NORMBASE}u + smIa];
            var smNd = polygonVertices[${NORMBASE}u + smId];
            let smVa = polygonVertices[smIa];
            let smVd = polygonVertices[smId];
            let smD12 = max(length(smSeg), 1e-6);
            var smD01 = length(smV0 - smVa);
            var smD23 = length(smVd - smV1);
            if (dot(smNa, smNa) <= 0.25) { smNa = smNb; smD01 = smD12; }
            if (dot(smNd, smNd) <= 0.25) { smNd = smNc; smD23 = smD12; }
            smD01 = max(smD01, 1e-6);
            smD23 = max(smD23, 1e-6);
            // Non-uniform Catmull-Rom endpoint tangents (knots = cumulative chord length).
            let smM1 = (smNb - smNa) / smD01 - (smNc - smNa) / (smD01 + smD12) + (smNc - smNb) / smD12;
            let smM2 = (smNc - smNb) / smD12 - (smNd - smNb) / (smD12 + smD23) + (smNd - smNc) / smD23;
            let smU2 = smT * smT;
            let smU3 = smU2 * smT;
            let smH00 = 2.0 * smU3 - 3.0 * smU2 + 1.0;
            let smH10 = smU3 - 2.0 * smU2 + smT;
            let smH01 = -2.0 * smU3 + 3.0 * smU2;
            let smH11 = smU3 - smU2;
            let smHerm = smH00 * smNb + smH10 * smD12 * smM1 + smH01 * smNc + smH11 * smD12 * smM2;
            smNrm = normalize(smHerm);
        }
        ${outX} = smNrm.x;
        ${outZ} = smNrm.y;
    }`
    }

    /**
     * Debug-only WGSL (preview): paints a bright marker at each path2d
     * tessellation vertex on the extrude side so the on-screen tessellation
     * density is directly visible. Gated by `sdfDebugTessEdgesFlag()` — preview
     * reads the live `viewSettings` flag; mesh/FG/bounds shaders define it as 0,
     * so this is inert there. Overrides the side normal `n` (a `var` at the call
     * site) within a small edge-fraction band of each closest-edge endpoint.
     * @param query 2D profile-space sample point (`"p.xz"` or `"twisted"`).
     */
    #debugTessEdgesWgsl(query: string, N: number, BASE: number): string {
        return `
    if (sdfDebugTessEdgesFlag() == 1u && onSide) {
        let dEi = u32(combined.y);
        let dV0 = polygonVertices[${BASE}u + dEi];
        let dV1 = polygonVertices[${BASE}u + (dEi + 1u) % ${N}u];
        let dSeg = dV1 - dV0;
        let dT = clamp(dot((${query}) - dV0, dSeg) / max(dot(dSeg, dSeg), 1e-12), 0.0, 1.0);
        if (min(dT, 1.0 - dT) < 0.03) { n = vec3f(0.0, 1.0, 0.0); }
    }`
    }

    override compileAux(): string {
        const childFunc = this.child.wgslFuncName
        const combinedFunc = this.child.wgslCombinedFuncName
        const capTopId = this.capTop.id
        const capBottomId = this.capBottom.id
        const N = this.child.vertices.length
        const BASE = this.child.bufferOffset
        // Base of the appended per-vertex normal region in the shared polygon
        // buffer (vertices in [0, total), normals in [total, 2·total)). Finalized
        // after build(), which runs before codegen.
        const NORMBASE = this.scene.totalPolygonVertices
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
${this.#sideNormalSmoothWgsl("p.xz", "gx", "gz", N, BASE, NORMBASE)}

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
    var n = select(nCap, nSide, onSide);
${this.#debugTessEdgesWgsl("p.xz", N, BASE)}
    let capId = select(${capBottomId}u, ${capTopId}u, capY > 0.0);
    var resultId = select(capId, id, onSide);
    if (faceSelection.nodeId == id) {
        if (onSide && faceSelection.mode == 0u) {
            let edge = u32(combined.y);
            // Highlight the whole wall-surface segment [segStart, segEnd) (one
            // path2d element). The range wraps when segEnd <= segStart. Plain
            // polygons pass a single-edge range, so this reduces to edge == faceIndex.
            let segS = faceSelection.segStart;
            let segE = faceSelection.segEnd;
            var inSeg = edge >= segS && edge < segE;
            if (segE <= segS) {
                inSeg = edge >= segS || edge < segE;
            }
            if (inSeg) {
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
    var gx_tw = combined.z;
    var gz_tw = combined.w;
${this.#sideNormalSmoothWgsl("twisted", "gx_tw", "gz_tw", N, BASE, NORMBASE)}
    let twistRate = select(0.0, twist / (2.0 * h), abs(h) > 1e-6);
    let gySide = twistRate * (gx_tw * twisted.y - gz_tw * twisted.x);
    let nSide = safeNormalize(vec3f(ca * gx_tw - sa * gz_tw, gySide, sa * gx_tw + ca * gz_tw), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(capY), 0.0);
    var n = select(nCap, nSide, onSide);
${this.#debugTessEdgesWgsl("twisted", N, BASE)}
    let capId = select(${capBottomId}u, ${capTopId}u, capY > 0.0);
    var resultId = select(capId, id, onSide);
    if (faceSelection.nodeId == id) {
        if (onSide && faceSelection.mode == 0u) {
            // Side-face highlight under twist. combined.y is the closest
            // polygon-edge index evaluated in PROFILE space (the twisted
            // coordinate), so it matches faceSelection.faceIndex: the CPU
            // picker un-twists the world hit into the same profile space at
            // the hit's height, so both agree on which edge was grabbed. The
            // highlight then sweeps that edge up the full helical side strip.
            // (Live push/pull slide keeps mode 0 on the GPU and re-extrudes
            // the edited polygon through twist; the mode-1 extrude-bump preview
            // is not rendered under twist.)
            let edge = u32(combined.y);
            // Highlight the whole wall-surface segment [segStart, segEnd) (one
            // path2d element). The range wraps when segEnd <= segStart. Plain
            // polygons pass a single-edge range, so this reduces to edge == faceIndex.
            let segS = faceSelection.segStart;
            let segE = faceSelection.segEnd;
            var inSeg = edge >= segS && edge < segE;
            if (segE <= segS) {
                inSeg = edge >= segS || edge < segE;
            }
            if (inSeg) {
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

        // Conservative profile bounds (baked, in the same XZ frame as childFunc):
        // a cheap lower bound on the polygon distance so empty-space ray-march
        // steps skip the O(N) polygon SDF entirely — the dominant cost for a
        // finely-tessellated bezier profile. AABB for the untwisted case; a
        // twist-invariant bounding circle (the profile rotates about the XZ
        // origin) for the twisted case.
        const verts = this.child.vertices
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxR2 = 0
        for (const [x, z] of verts) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (z < minZ) minZ = z
            if (z > maxZ) maxZ = z
            const r2 = x * x + z * z
            if (r2 > maxR2) maxR2 = r2
        }
        const f = (n: number): string => {
            if (!isFinite(n)) return "0.0"
            const s = n.toString()
            return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0"
        }
        const cx = f((minX + maxX) / 2), cz = f((minZ + maxZ) / 2)
        const hx = f((maxX - minX) / 2), hz = f((maxZ - minZ) / 2)
        const maxR = f(Math.sqrt(maxR2))

        if (!hasTwist) {
            return `
fn ${this.wgslFastFuncName}(p: vec3f) -> FastSDFResult {
    let dCap = abs(p.y - ${capYOff}) - ${capH};
    // Distance to the profile AABB underestimates the true polygon distance,
    // so the sphere-trace step never overshoots when we take the cheap path.
    let q = abs(p.xz - vec2f(${cx}, ${cz})) - vec2f(${hx}, ${hz});
    let dAabb = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
    let lo = max(dAabb, dCap);
    // Only take the cheap path when the bound is safely above the marcher's
    // surface hit threshold (SURF_DIST = 0.001). At the AABB/slab shell, lo
    // drops toward 0; returning it there would read as a false surface (the
    // box outline shading the empty space). The thin shell falls through to
    // the exact polygon, which gives the true (large) distance — no false hit.
    if (lo > 0.004) { return sdfFast(lo, 1.0, 1.0); }
    let d2d = ${childFunc}(p.xz);
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
    let h = ${capH};
    let twist = ${twistRad};
    let twistRate = select(0.0, twist / (2.0 * h), abs(h) > 1e-6);
    let rho = length(p.xz);
    let stretch = sqrt(1.0 + twistRate * twistRate * rho * rho);
    // length(p.xz) - maxR is a twist-invariant lower bound on the polygon
    // distance: take the cheap path in empty space, keep the exact field func
    // (untouched) for steps that land near the surface.
    let dCapHint = abs(p.y - ${capYOff}) - h;
    let lo = max(rho - ${maxR}, dCapHint);
    // Margin above SURF_DIST (0.001): at the bounding shell lo -> 0 would read
    // as a false surface. The thin shell falls through to the exact field func.
    if (lo > 0.004) { return sdfFast(lo, 0.8, 1.0 / stretch); }
    // Match the operator-level sdfTwistFast for ray marching: the effective
    // step is d * safeStepMul = d / stretch. We keep d raw and g = 0.8 (the
    // historical placeholder) so MDC's voxel sampling, bisection trigger
    // (g < 0.95), and post-bisection projection all behave exactly as they
    // did before, avoiding any change to mesh extraction along twisted edges.
    return sdfFast(${this.wgslFieldFuncName}(p), 0.8, 1.0 / stretch);
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
            text: this.warpRot(`${this.wgslExFuncName}(p - ${pos}, ${this.id}u)`, pos),
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Extrude${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: this.warpRot(`${this.wgslFastFuncName}(p - ${pos})`, pos),
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Extrude${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const pos = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        return {
            funcName,
            varName,
            text: this.warpRot(`sdfMidSetOwner(sdfTranslateFeatureMid(${this.wgslMidFuncName}(p - ${pos}), p, ${pos}), ${this.id}u)`, pos),
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
        // Expand the upright AABB for the local `rot` about the extrude's center.
        const { fwd } = eulerMatrices(this.rot.x, this.rot.y, this.rot.z)
        const r = aabbRotate(aabb(0, 0, 0, maxX, this.h, maxZ), fwd)
        return aabb(this.pos.x, this.pos.y, this.pos.z, r.hx, r.hy, r.hz)
    }

    @fluent height(n: number): this {
        this.h = n
        return this
    }

    @fluent twist(degrees: number): this {
        this.twistDegrees = degrees
        return this
    }

    @fluent shift(v: Vec3 | number, y?: number, z?: number): this {
        this.pos = typeof v === "number" ? vec3(v, y!, z!) : vec3(v)
        this.shifted = true
        return this
    }

    /**
     * `.rotate` BEFORE any `.shift` composes onto the local `rot` field (rotates
     * the extrude about its own center, param-only/live). AFTER a `.shift` it
     * falls back to a `Rotate` operator (the shift becomes the pivot).
     */
    @fluent override rotate(v: Vec3 | number, ry?: number, rz?: number): Rotate {
        const r = typeof v === "number" ? vec3(v, ry!, rz!) : vec3(v)
        if (this.shifted) return rotateOp(r, this)
        this.composeLocalRot(r)
        return this as unknown as Rotate
    }

    /**
     * Emit feature-graph features for this extruded polygon:
     *  - **Top/bottom corner vertices** at each polygon vertex (local position
     *    bakes in `this.pos`). Marked {@link FG_FLAG_CORNER} at every vertex
     *    with a real turn — any nonzero turn angle, with NO dihedral/sharpness
     *    floor; only perfectly-collinear vertices (a midpoint on a straight
     *    side) stay un-flagged. Collinear vertices are still emitted so cap
     *    edges have valid endpoints, just without the corner flag. Each vertex
     *    carries three source-face normals: cap (±Y) and the two adjacent side
     *    faces.
     *  - **Vertical side edges** at every vertex with a real turn — each such
     *    vertex casts a feature line no matter how gentle the turn (no sharpness
     *    threshold); collinear vertices cast none. Under twist, these become
     *    helices and are pre-subdivided into a chain at extraction time so the
     *    visualised overlay traces the helix instead of cutting a chord through it.
     *  - **Cap edges** along each polygon segment, top and bottom — always
     *    emitted. With twist, the top cap is the polygon rotated by the full
     *    twist angle; its edges are still straight in 3D (it's a planar
     *    polygon at `y = +h`).
     *  - **Cap loops** for top (`+Y` normal) and bottom (`-Y`, reversed
     *    winding).
     *
     * Skipped when under a non-affine ancestor (Twist/Bend/Taper operator) —
     * those are deferred to a later pass that applies `warpPoint` per
     * vertex. This extrude's own `.twist(deg)` is handled here directly via
     * per-Y rotation.
     */
    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        if (builder.hasNonAffineAncestor()) return

        const verts = this.child.vertices
        const N = verts.length
        // `Polygon2D` enforces N ≥ 3 at construction; this guard is just
        // defensive in case the field is mutated post-construction.
        if (N < 3) return

        // Authored-node provenance (path2d): when present, a vertex casts a
        // selectable vertical crease + 0D corner iff it's a real authored node
        // (control point / vertex), NOT an interior curve-tessellation sample —
        // so the dense rasterization of a smooth curve doesn't spam selectable
        // edges. Plain hand-specified polygons carry no mask (`null`) and fall
        // back to the geometric turn test below (unchanged behavior).
        const anchorMask = this.child.vertexIsAnchor

        const windSign = polygon2dWindingSign(verts)
        const px = this.pos.x, py = this.pos.y, pz = this.pos.z
        const h = this.h
        const twistRad = (this.twistDegrees * Math.PI) / 180
        const hasTwist = this.twistDegrees !== 0

        // Per-edge outward 3D normal in untwisted polygon space (side face
        // `i` runs from polygon vertex `i` to `i+1`). For twisted extrudes
        // these get rotated per height to produce the side normal at that
        // y level.
        const edgeOutwardLocal: Vec3f[] = []
        for (let i = 0; i < N; i++) {
            const [ax, az] = verts[i]!
            const [bx, bz] = verts[(i + 1) % N]!
            let dx = bx - ax, dz = bz - az
            const len = Math.sqrt(dx * dx + dz * dz) || 1
            dx /= len; dz /= len
            edgeOutwardLocal.push(new Vec3f([dz * windSign, 0, -dx * windSign]))
        }

        const topNormal = new Vec3f([0, 1, 0])
        const botNormal = new Vec3f([0, -1, 0])

        /** Rotate a polygon (x, z) by `angle` around the extrude's Y axis. */
        const rotXZ = (x: number, z: number, ca: number, sa: number): [number, number] => {
            return [x * ca - z * sa, x * sa + z * ca]
        }

        /** Rotate a vec3 around Y by the (cos, sin) pair. */
        const rotNormalY = (n: Vec3f, ca: number, sa: number): Vec3f => {
            if (!hasTwist) return n
            const [nx2, nz2] = rotXZ(n.x, n.z, ca, sa)
            return new Vec3f([nx2, n.y, nz2])
        }

        /**
         * Twist angle at a given y *offset from the extrude center* (i.e.
         * `y_local` ∈ [-h, +h]). Linear ramp from 0 at the bottom to the
         * full `twistRad` at the top, matching the WGSL `compileAuxMid`
         * formula `angle = twist * (capY + h) / (2h)`.
         */
        const angleAt = (yLocal: number): number => {
            if (!hasTwist || h <= 0) return 0
            const t = (yLocal + h) / (2 * h)
            return twistRad * t
        }

        builder.beginNode(this.id)

        // Pass 1: emit top + bottom corner per polygon vertex, decide sharpness.
        const topIdx: number[] = new Array(N)
        const botIdx: number[] = new Array(N)
        const sharpAt: boolean[] = new Array(N)

        // Cached top-angle trig (constant across all top corners).
        const caTop = Math.cos(angleAt(+h))
        const saTop = Math.sin(angleAt(+h))

        for (let k = 0; k < N; k++) {
            const [vx, vz] = verts[k]!
            const prevOutL = edgeOutwardLocal[(k - 1 + N) % N]!
            const nextOutL = edgeOutwardLocal[k]!

            // Turn angle at this polygon vertex (invariant to twist — twist
            // rotates all side surfaces together, so the dihedral between
            // adjacent sides doesn't change). A vertex casts a feature
            // (vertical crease line + 0D corner) iff it has a REAL turn: any
            // nonzero turn angle, with no sharpness/dihedral floor. Perfectly-
            // collinear vertices (turn ≈ 0, e.g. a midpoint on a straight side)
            // are flat and cast nothing. The dot-based EXTRUDE_MDC_FEATURE_DOT
            // threshold still gates the separate MDC mid-feature WGSL path
            // (compileAux), not this FeatureGraph path.
            const [pvx, pvz] = verts[(k - 1 + N) % N]!
            const [nvx, nvz] = verts[(k + 1) % N]!
            let pdx = vx - pvx, pdz = vz - pvz
            const pLen = Math.sqrt(pdx * pdx + pdz * pdz) || 1
            pdx /= pLen; pdz /= pLen
            let ndx = nvx - vx, ndz = nvz - vz
            const nLen = Math.sqrt(ndx * ndx + ndz * ndz) || 1
            ndx /= nLen; ndz /= nLen
            const turn = Math.abs(pdx * ndz - pdz * ndx)
            const hasTurn = turn >= EXTRUDE_MDC_VERTEX_TURN_MIN
            // Real authored node (path2d) takes precedence over the turn test:
            // every anchor casts a crease/corner (even a smooth or collinear
            // join — the user authored a node there), interior samples never do.
            const isRealNode = anchorMask ? (anchorMask[k] ?? false) : hasTurn
            sharpAt[k] = isRealNode

            // Bottom corner: untwisted (angle = 0).
            const lxBot = vx + px, lzBot = vz + pz
            // Top corner: polygon vertex rotated by the full twist angle.
            const [twx, twz] = rotXZ(vx, vz, caTop, saTop)
            const lxTop = twx + px, lzTop = twz + pz

            const baseFlags = FG_FLAG_CREASE_ORIGINAL | (isRealNode ? FG_FLAG_CORNER : 0)
            const prevOutTop = rotNormalY(prevOutL, caTop, saTop)
            const nextOutTop = rotNormalY(nextOutL, caTop, saTop)

            topIdx[k] = builder.emitVertex(
                new Vec3f([lxTop, h + py, lzTop]),
                baseFlags,
                [topNormal, prevOutTop, nextOutTop],
            )
            botIdx[k] = builder.emitVertex(
                new Vec3f([lxBot, -h + py, lzBot]),
                baseFlags,
                [botNormal, prevOutL, nextOutL],
            )
        }

        // Pass 2: emit edges.
        // Helical side-edge resolution: ~1 segment per 10° of twist (min 1
        // = straight edge when untwisted). Cheap visual approximation that
        // keeps twisted side-creases smooth in the FeatureGraph overlay; the
        // stage-3 subdivision pass refines further by chord length.
        const helixSegments = hasTwist ? Math.max(1, Math.ceil(Math.abs(this.twistDegrees) / 10)) : 1

        for (let k = 0; k < N; k++) {
            const kNext = (k + 1) % N
            // Cap edges — straight in 3D space (each cap is a planar polygon
            // at constant y; twist just rotates the top polygon as a whole).
            builder.emitEdge(topIdx[k]!, topIdx[kNext]!, FG_FLAG_CREASE_ORIGINAL)
            builder.emitEdge(botIdx[k]!, botIdx[kNext]!, FG_FLAG_CREASE_ORIGINAL)

            // Side edge — only at vertices with a real turn (`sharpAt[k]`);
            // collinear vertices are flat and cast no vertical crease.
            if (!sharpAt[k]) continue

            if (helixSegments === 1) {
                // Straight vertical edge (no twist).
                builder.emitEdge(botIdx[k]!, topIdx[k]!, FG_FLAG_CREASE_ORIGINAL)
                continue
            }

            // Helical chain: insert (helixSegments - 1) intermediate vertices
            // along the helix, then connect them in sequence.
            const [vxk, vzk] = verts[k]!
            const prevOutL = edgeOutwardLocal[(k - 1 + N) % N]!
            const nextOutL = edgeOutwardLocal[k]!
            let prev = botIdx[k]!
            for (let s = 1; s < helixSegments; s++) {
                const tLocal = s / helixSegments
                const yLocal = -h + tLocal * (2 * h)
                const angle = angleAt(yLocal)
                const ca = Math.cos(angle)
                const sa = Math.sin(angle)
                const [wx, wz] = rotXZ(vxk, vzk, ca, sa)
                const midPos = new Vec3f([wx + px, yLocal + py, wz + pz])
                const prevOutMid = rotNormalY(prevOutL, ca, sa)
                const nextOutMid = rotNormalY(nextOutL, ca, sa)
                // Intermediate samples along a crease — NOT corners.
                const midIdx = builder.emitVertex(
                    midPos,
                    FG_FLAG_CREASE_ORIGINAL,
                    [prevOutMid, nextOutMid],
                )
                builder.emitEdge(prev, midIdx, FG_FLAG_CREASE_ORIGINAL)
                prev = midIdx
            }
            builder.emitEdge(prev, topIdx[k]!, FG_FLAG_CREASE_ORIGINAL)
        }

        // Cap loops — top winds CCW seen from +Y, bottom reversed so its
        // winding agrees with the -Y outward normal.
        builder.emitLoop(topIdx, topNormal, FG_FLAG_CREASE_ORIGINAL)
        const botReversed: number[] = new Array(N)
        for (let k = 0; k < N; k++) botReversed[k] = botIdx[N - 1 - k]!
        builder.emitLoop(botReversed, botNormal, FG_FLAG_CREASE_ORIGINAL)

        builder.endNode()
    }
}

function extrudeProfile(profile: Polygon2D): Extrude {
    return new Extrude(DEFAULT_POS, profile, { h: 1, t: 0 })
}

export const extrude = { profile: extrudeProfile }
