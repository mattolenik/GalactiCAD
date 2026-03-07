import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Cylinder extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    h: number

    constructor(pos: Vec3, { r, h }: { r: number; h: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
        this.h = h
    }

    override getShapeType(): string { return "cylinder" }
    override getIndicatorSymbol(): string { return "⬭" }
    override getIndicatorSvg(): string {
        return `<rect x="1" y="2" width="10" height="8" rx="3" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `fCylinderEx(p - ${this.pos.wgsl}, ${this.r}, ${this.h}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fCylinderFast(p - ${this.pos.wgsl}, ${this.r}, ${this.h})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `fCylinderMid(p - ${this.pos.wgsl}, ${this.r}, ${this.h})` }
    }

    override computeBounds(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, this.r, this.h, this.r)
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

function cylinderRadius(r: number): Cylinder {
    return new Cylinder(DEFAULT_POS, { r, h: 1 })
}

export const cylinder = { radius: cylinderRadius }
