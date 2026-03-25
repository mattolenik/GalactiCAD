import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
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

    override writePreviewParams(out: PreviewParamsOut): void {
        let b = this.previewVec3Slot * 4
        out.vec3[b] = this.pos.data[0]!
        out.vec3[b + 1] = this.pos.data[1]!
        out.vec3[b + 2] = this.pos.data[2]!
        out.vec3[b + 3] = 0
        out.f32[this.previewF32Slot + 0] = this.r
        out.f32[this.previewF32Slot + 1] = this.h
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
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.previewF32Slot = this.scene.allocPreviewF32(2)
        this.paramOffset = this.scene.allocSceneParamFloats(5)
        this.paramCount = 5
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const h = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: `fConeEx(p - ${pos}, ${r}, ${h}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const h = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: `fConeFast(p - ${pos}, ${r}, ${h})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const h = f32Wgsl(o + 4, this.previewF32Slot + 1)
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
