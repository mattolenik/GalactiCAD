import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spF32Wgsl, spVec3Wgsl } from "../scene-params.mjs"
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

    override writeSceneParams(view: Float32Array): void {
        view.set(this.#paramSlice())
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(5)
        buf.set(this.pos.data, 0)
        buf[3] = this.r
        buf[4] = this.h
        return buf
    }

    override build() {
        super.build()
        this.paramOffset = this.scene.allocSceneParamFloats(5)
        this.paramCount = 5
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        const h = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fConeEx(p - ${pos}, ${r}, ${h}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        const h = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fConeFast(p - ${pos}, ${r}, ${h})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        const h = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fConeMid(p - ${pos}, ${r}, ${h})` }
    }

    override computeBounds(): AABB {
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
