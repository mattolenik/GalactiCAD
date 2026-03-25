import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spF32Wgsl, spVec3Wgsl } from "../scene-params.mjs"
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

    override writeSceneParams(view: Float32Array): void {
        view.set(this.#paramSlice())
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(5)
        buf.set(this.pos.data, 0)
        buf[3] = this.sr
        buf[4] = this.lr
        return buf
    }

    override build() {
        super.build()
        this.paramOffset = this.scene.allocSceneParamFloats(5)
        this.paramCount = 5
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const sr = spF32Wgsl(o + 3)
        const lr = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fTorusEx(p - ${pos}, ${sr}, ${lr}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const sr = spF32Wgsl(o + 3)
        const lr = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fTorusFast(p - ${pos}, ${sr}, ${lr})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const sr = spF32Wgsl(o + 3)
        const lr = spF32Wgsl(o + 4)
        return { funcName, varName, text: `fTorusMid(p - ${pos}, ${sr}, ${lr})` }
    }

    override computeBounds(): AABB {
        const r = this.lr + this.sr
        return aabb(this.pos.x, this.pos.y, this.pos.z, r, this.sr, r)
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
