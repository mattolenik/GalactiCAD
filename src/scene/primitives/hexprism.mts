import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"
import { asRadius } from "../geom.mjs"

export class HexPrism extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    h: number

    constructor(pos: Vec3, { r, d, h }: { r?: number; d?: number; h: number }) {
        super()
        this.pos = vec3(pos)
        this.r = asRadius(r, d)
        this.h = h
    }

    override getShapeType(): string { return "hexprism" }
    override getIndicatorSymbol(): string { return "⬡" }
    override getIndicatorSvg(): string {
        return `<polygon points="6,1 10.5,3.5 10.5,8.5 6,11 1.5,8.5 1.5,3.5" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `HexPrism${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `fHexagonCircumcircleEx(p - ${this.pos.wgsl}, vec2f(${this.r}, ${this.h}), ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `HexPrism${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fHexagonCircumcircleFast(p - ${this.pos.wgsl}, vec2f(${this.r}, ${this.h}))` }
    }

    @fluent radius(r: number): this {
        this.r = r
        return this
    }
    @fluent height(h: number): this {
        this.h = h
        return this
    }
    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function hexprismRadius(r: number): HexPrism {
    return new HexPrism(DEFAULT_POS, { r, h: 1 })
}

function hexprismHeight(h: number): HexPrism {
    return new HexPrism(DEFAULT_POS, { r: 1, h })
}

export const hexprism = { radius: hexprismRadius, height: hexprismHeight }
