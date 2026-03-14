import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Torus extends Node {
    pos = vec3([0, 0, 0])
    sr: number
    lr: number

    constructor(pos: Vec3, { sr, lr }: { sr: number; lr: number }) {
        super()
        this.pos = vec3(pos)
        this.sr = sr
        this.lr = lr
    }

    override getShapeType(): string { return "torus" }
    override getIndicatorSymbol(): string { return "◎" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `fTorusEx(p - ${this.pos.wgsl}, ${this.sr}, ${this.lr}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fTorusFast(p - ${this.pos.wgsl}, ${this.sr}, ${this.lr})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `fTorusMid(p - ${this.pos.wgsl}, ${this.sr}, ${this.lr})` }
    }

    @fluent smallRadius(sr: number): this {
        this.sr = sr
        return this
    }
    @fluent largeRadius(lr: number): this {
        this.lr = lr
        return this
    }
    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function torusSmallRadius(sr: number): Torus {
    return new Torus(DEFAULT_POS, { sr, lr: 1 })
}

function torusLargeRadius(lr: number): Torus {
    return new Torus(DEFAULT_POS, { sr: 0.25, lr })
}

export const torus = { smallRadius: torusSmallRadius, largeRadius: torusLargeRadius }
