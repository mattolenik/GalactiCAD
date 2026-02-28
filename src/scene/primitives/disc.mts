import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"
import { asRadius } from "../geom.mjs"

export class Disc extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    constructor(pos: Vec3, { r, d }: { r?: number; d?: number }) {
        super()
        this.pos = vec3(pos)
        this.r = asRadius(r, d)
    }

    override getShapeType(): string { return "disc" }
    override getIndicatorSymbol(): string { return "◉" }
    override getIndicatorSvg(): string {
        return `<ellipse cx="6" cy="6" rx="5" ry="2.5" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Disc${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `fDiscEx(p - ${this.pos.wgsl}, ${this.r}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Disc${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fDiscFast(p - ${this.pos.wgsl}, ${this.r})` }
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function discRadius(r: number): Disc {
    return new Disc(DEFAULT_POS, { r })
}

export const disc = { radius: discRadius }
