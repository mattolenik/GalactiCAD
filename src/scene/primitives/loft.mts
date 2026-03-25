import { Node, CompileResult, decapitalize, fluent, BVH_MIN_COST, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spF32Wgsl, spVec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D } from "./polygon2d.mjs"

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

    override build() {
        super.build()
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
        const capH = spF32Wgsl(this.paramOffset + 3)
        const capYOff = spF32Wgsl(this.paramOffset + 4)
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
        const h = this.h.toFixed(6)
        const fieldBody = this.generateFieldBody(h)
        const capH = spF32Wgsl(this.paramOffset + 3)
        const capYOff = spF32Wgsl(this.paramOffset + 4)
        return `
fn ${this.wgslMidFuncName}(p: vec3f) -> SDFResultMid {
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
    return sdfRMid(d, 0.8, n);
}
`
    }

    override compileAuxFast(): string {
        const h = this.h.toFixed(6)
        const fieldBody = this.generateFieldBody(h)
        const capH = spF32Wgsl(this.paramOffset + 3)
        const capYOff = spF32Wgsl(this.paramOffset + 4)

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
        const pos = spVec3Wgsl(this.paramOffset)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${pos}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const pos = spVec3Wgsl(this.paramOffset)
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${pos})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const pos = spVec3Wgsl(this.paramOffset)
        return {
            funcName,
            varName,
            text: `${this.wgslMidFuncName}(p - ${pos})`,
        }
    }

    override computeBounds(): AABB {
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
