import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, type AABB } from "../aabb.mjs"
import { spF32Wgsl, spVec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Sphere extends Node {
    pos = vec3([0, 0, 0])
    r = 0

    constructor(pos: Vec3, { r }: { r: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
    }

    override getShapeType(): string {
        return "sphere"
    }

    override getIndicatorSymbol(): string {
        return "●"
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="currentColor"/>`
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
        const funcName = `Sphere${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        return {
            funcName,
            varName,
            text: `fSphereEx(p - ${pos}, ${r}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Sphere${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        return {
            funcName,
            varName,
            text: `fSphereFast(p - ${pos}, ${r})`,
        }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Sphere${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = spVec3Wgsl(o)
        const r = spF32Wgsl(o + 3)
        return {
            funcName,
            varName,
            text: `fSphereMid(p - ${pos}, ${r})`,
        }
    }

    override computeBounds(): AABB {
        return aabb(this.pos.x, this.pos.y, this.pos.z, this.r, this.r, this.r)
    }

    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function sphereRadius(r: number): Sphere {
    return new Sphere(DEFAULT_POS, { r })
}

export const sphere = { radius: sphereRadius }
