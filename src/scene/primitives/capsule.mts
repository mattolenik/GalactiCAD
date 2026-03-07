import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Capsule extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    c: number

    constructor(pos: Vec3, { r, c }: { r: number; c: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
        this.c = c
    }

    override getShapeType(): string { return "capsule" }
    override getIndicatorSymbol(): string { return "⬮" }
    override getIndicatorSvg(): string {
        return `<rect x="2" y="1" width="8" height="10" rx="4" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Capsule${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `fCapsuleEx(p - ${this.pos.wgsl}, ${this.r}, ${this.c}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Capsule${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fCapsuleFast(p - ${this.pos.wgsl}, ${this.r}, ${this.c})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Capsule${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `fCapsuleMid(p - ${this.pos.wgsl}, ${this.r}, ${this.c})` }
    }

    override computeBounds(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, this.r, this.c + this.r, this.r)
    }

    @fluent radius(r: number): this {
        this.r = r
        return this
    }
    @fluent cylinderLength(c: number): this {
        this.c = c
        return this
    }
    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function capsuleRadius(r: number): Capsule {
    return new Capsule(DEFAULT_POS, { r, c: 1 })
}

function capsuleCylinderLength(c: number): Capsule {
    return new Capsule(DEFAULT_POS, { r: 0.5, c })
}

export const capsule = { radius: capsuleRadius, cylinderLength: capsuleCylinderLength }
