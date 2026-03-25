import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spF32Wgsl, spVec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Disc extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    constructor(pos: Vec3, { r }: { r: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
    }

    override getShapeType(): string { return "disc" }
    override getIndicatorSymbol(): string { return "◉" }
    override getIndicatorSvg(): string {
        return `<ellipse cx="6" cy="6" rx="5" ry="2.5" fill="currentColor"/>`
    }

    override writeSceneParams(view: Float32Array): void {
        view.set(this.#paramSlice())
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(4)
        buf.set(this.pos.data, 0)
        buf[3] = this.r
        return buf
    }

    override build() {
        super.build()
        this.paramOffset = this.scene.allocSceneParamFloats(4)
        this.paramCount = 4
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Disc${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        return { funcName, varName, text: `fDiscEx(p - ${pos}, ${r}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Disc${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        return { funcName, varName, text: `fDiscFast(p - ${pos}, ${r})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Disc${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        return { funcName, varName, text: `fDiscMid(p - ${pos}, ${r})` }
    }

    override computeBounds(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, this.r, 0.001, this.r)
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function discRadius(r: number): Disc {
    return new Disc(DEFAULT_POS, { r })
}

export const disc = { radius: discRadius }
