import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Cone extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    h: number

    constructor(pos: Vec3, { r, h }: { r: number; h: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
        this.h = h
    }

    override getShapeType(): string { return "cone" }
    override getIndicatorSymbol(): string { return "▲" }
    override getIndicatorSvg(): string {
        return `<polygon points="6,1 11,11 1,11" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `fConeEx(p - ${this.pos.wgsl}, ${this.r}, ${this.h}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fConeFast(p - ${this.pos.wgsl}, ${this.r}, ${this.h})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `fConeMid(p - ${this.pos.wgsl}, ${this.r}, ${this.h})` }
    }

    override computeBounds(): AABB {
        // Cone base at pos.y, tip at pos.y + h
        return aabb(this.pos.x, this.pos.y + this.h * 0.5, this.pos.z, this.r, this.h * 0.5, this.r)
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

function coneRadius(r: number): Cone {
    return new Cone(DEFAULT_POS, { r, h: 1 })
}

export const cone = { radius: coneRadius }
