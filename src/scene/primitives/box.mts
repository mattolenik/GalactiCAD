import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Box extends Node {
    pos = vec3([0, 0, 0])
    size = vec3([0, 0, 0])

    constructor(pos: Vec3, size: Vec3) {
        super()
        this.pos = vec3(pos)
        this.size = vec3(size)
    }

    override getShapeType(): string {
        return "box"
    }

    override getIndicatorSymbol(): string {
        return "■"
    }

    override getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="1" fill="currentColor"/>`
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
        b = (this.previewVec3Slot + 1) * 4
        out.vec3[b] = this.size.data[0]!
        out.vec3[b + 1] = this.size.data[1]!
        out.vec3[b + 2] = this.size.data[2]!
        out.vec3[b + 3] = 0
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(6)
        buf.set(this.pos.data, 0)
        buf.set(this.size.data, 3)
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(2)
        this.paramOffset = this.scene.allocSceneParamFloats(6)
        this.paramCount = 6
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const half = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        return {
            funcName,
            varName,
            text: `fBoxEx(p - ${pos}, ${half}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const half = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        return {
            funcName,
            varName,
            text: `fBoxFast(p - ${pos}, ${half})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const half = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        return {
            funcName,
            varName,
            text: `sdfMidSetOwner(fBoxMid(p - ${pos}, ${half}), ${this.id}u)`,
        }
    }

    protected override computeBoundsCore(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, this.size.x, this.size.y, this.size.z)
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

export function box(size: Vec3): Box
export function box(l: number, w: number, h: number): Box
export function box(sizeOrL: Vec3 | number, w?: number, h?: number): Box {
    if (typeof sizeOrL === "number" && typeof w === "number" && typeof h === "number") {
        return new Box(DEFAULT_POS, [sizeOrL, w, h])
    }
    return new Box(DEFAULT_POS, sizeOrL as Vec3)
}
