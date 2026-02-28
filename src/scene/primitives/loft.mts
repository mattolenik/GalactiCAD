import { Node, CompileResult, decapitalize, fluent, DEFAULT_POS } from "../base.mjs"
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
    override getIndicatorSvg(): string {
        return `<polygon points="3,1 9,1 11,11 1,11" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override updateScene(): void { }

    override build() {
        super.build()
        for (const profile of this.profiles) {
            profile.root = this.root
            profile.build()
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
        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let d = ${this.wgslFieldFuncName}(p);
    let capH = nodeParams[id].x;
    let capY = p.y - nodeParams[id].y;
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
        if ((faceSelection.mode == 2u && isTopFace) || (faceSelection.mode == 3u && !isTopFace)) {
            resultId = FACE_HIGHLIGHT_ID;
        }
    }
    return sdfTrue(d, resultId, n);
}
`
    }

    override compileAuxFast(): string {
        const h = this.h.toFixed(6)
        const fieldBody = this.generateFieldBody(h)

        return `
fn ${this.wgslFieldFuncName}(p: vec3f) -> f32 {
    let h = nodeParams[${this.id}].x;
    let capY = p.y - nodeParams[${this.id}].y;
    let t = clamp((capY + h) / (2.0 * h), 0.0, 1.0);
${fieldBody}
    let dCap = abs(capY) - h;
    return max(d_profile, dCap);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> vec2f {
    return vec2f(${this.wgslFieldFuncName}(p), 0.8);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${this.pos.wgsl}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${this.pos.wgsl})`,
        }
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
