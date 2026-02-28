import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Blob extends Node {
    pos = vec3([0, 0, 0])
    constructor(pos: Vec3) {
        super()
        this.pos = vec3(pos)
    }

    override getShapeType(): string { return "blob" }
    override getIndicatorSymbol(): string { return "◌" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="4" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `fBlobEx(p - ${this.pos.wgsl}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fBlobFast(p - ${this.pos.wgsl})` }
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

export function blob(): Blob {
    return new Blob(DEFAULT_POS)
}
