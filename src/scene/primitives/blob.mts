import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spVec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Blob extends Node {
    pos = vec3([0, 0, 0])
    constructor(pos: Vec3) {
        super()
        this.pos = vec3(pos)
    }

    override getShapeType(): string { return "blob" }
    override getIndicatorSymbol(): string { return "◌" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="4" fill="currentColor"/>`
    }

    override writeSceneParams(view: Float32Array): void {
        view.set(this.#paramSlice())
    }

    #paramSlice(): Float32Array {
        return Float32Array.from(this.pos.data)
    }

    override build() {
        super.build()
        this.paramOffset = this.scene.allocSceneParamFloats(3)
        this.paramCount = 3
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = decapitalize(funcName)
        const pos = spVec3Wgsl(this.paramOffset)
        return { funcName, varName, text: `fBlobEx(p - ${pos}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const pos = spVec3Wgsl(this.paramOffset)
        return { funcName, varName, text: `fBlobFast(p - ${pos})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const pos = spVec3Wgsl(this.paramOffset)
        return { funcName, varName, text: `fBlobMid(p - ${pos})` }
    }

    override computeBounds(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, 1.7, 1.7, 1.7)
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

export function blob(): Blob {
    return new Blob(DEFAULT_POS)
}
