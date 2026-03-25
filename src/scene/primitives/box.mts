import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spVec3Wgsl } from "../scene-params.mjs"
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

    #paramSlice(): Float32Array {
        const buf = new Float32Array(6)
        buf.set(this.pos.data, 0)
        buf.set(this.size.data, 3)
        return buf
    }

    override build() {
        super.build()
        this.paramOffset = this.scene.allocSceneParamFloats(6)
        this.paramCount = 6
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const half = spVec3Wgsl(o + 3)
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
        const pos = spVec3Wgsl(o)
        const half = spVec3Wgsl(o + 3)
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
        const pos = spVec3Wgsl(o)
        const half = spVec3Wgsl(o + 3)
        return {
            funcName,
            varName,
            text: `fBoxMid(p - ${pos}, ${half})`,
        }
    }

    override computeBounds(): AABB {
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
