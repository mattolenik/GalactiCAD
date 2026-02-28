import { Node, CompileResult, decapitalize, fluent, DEFAULT_POS } from "../base.mjs"
import { Vec3, vec3, Vec3f } from "../../vecmat/vector.mjs"
import { Polygon2D } from "./polygon2d.mjs"

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
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/>`
    }
    override updateScene(): void { }

    override build() {
        super.build()
        this.child.root = this.root
        this.child.build()
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.child.getAllDescendantIds()]
    }

    get wgslExFuncName(): string { return `fLathe_${this.id}_Ex` }
    get wgslFastFuncName(): string { return `fLathe_${this.id}_Fast` }

    override compileAux(): string {
        const childFunc = this.child.wgslFuncName

        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let r = length(p.xz);
    let q = vec2f(r, p.y);
    let d = ${childFunc}(q);
    let eps = 0.001;
    let gr = ${childFunc}(q + vec2f(eps, 0.0)) - ${childFunc}(q - vec2f(eps, 0.0));
    let gy = ${childFunc}(q + vec2f(0.0, eps)) - ${childFunc}(q - vec2f(0.0, eps));
    var radDir = vec2f(1.0, 0.0);
    if (r > 1e-8) {
        radDir = p.xz / r;
    }
    let n = safeNormalize(vec3f(gr * radDir.x, gy, gr * radDir.y), vec3f(0.0, 1.0, 0.0));
    return sdfTrue(d, id, n);
}
`
    }

    override compileAuxFast(): string {
        const childFunc = this.child.wgslFuncName
        return `
fn ${this.wgslFastFuncName}(p: vec3f) -> vec2f {
    let q = vec2f(length(p.xz), p.y);
    return vec2f(${childFunc}(q), 1.0);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${this.pos.wgsl}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${this.pos.wgsl})`,
        }
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
