import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec2Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class HexPrism extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    h: number

    constructor(pos: Vec3, { r, h }: { r: number; h: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
        this.h = h
    }

    override getShapeType(): string { return "hexprism" }
    override getIndicatorSymbol(): string { return "⬡" }
    override getIndicatorSvg(): string {
        return `<polygon points="6,1 10.5,3.5 10.5,8.5 6,11 1.5,8.5 1.5,3.5" fill="currentColor"/>`
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
        const b2 = this.previewVec2Slot * 2
        out.vec2[b2] = this.r
        out.vec2[b2 + 1] = this.h
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
        this.previewVec2Slot = this.scene.allocPreviewVec2(1)
        this.paramOffset = this.scene.allocSceneParamFloats(5)
        this.paramCount = 5
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `HexPrism${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const rh = vec2Wgsl(o + 3, this.previewVec2Slot)
        return { funcName, varName, text: `fHexagonCircumcircleEx(p - ${pos}, ${rh}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `HexPrism${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const rh = vec2Wgsl(o + 3, this.previewVec2Slot)
        return { funcName, varName, text: `fHexagonCircumcircleFast(p - ${pos}, ${rh})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `HexPrism${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const rh = vec2Wgsl(o + 3, this.previewVec2Slot)
        return { funcName, varName, text: `fHexagonCircumcircleMid(p - ${pos}, ${rh})` }
    }

    protected override computeBoundsCore(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, this.r, this.h, this.r)
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
