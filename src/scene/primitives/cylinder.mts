import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spF32Wgsl, spVec3Wgsl } from "../scene-params.mjs"
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
        const funcName = `Cylinder${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        const h = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fCylinderEx(p - ${pos}, ${r}, ${h}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        const h = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fCylinderFast(p - ${pos}, ${r}, ${h})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        const h = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fCylinderMid(p - ${pos}, ${r}, ${h})` }
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
