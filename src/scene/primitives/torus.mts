import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, aabbRotate, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { eulerMatrices } from "../transform-math.mjs"
import { rotate as rotateOp, type Rotate } from "../operators/rotate.mjs"
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

    override writePreviewParams(out: PreviewParamsOut): void {
        let b = this.previewVec3Slot * 4
        out.vec3[b] = this.pos.data[0]!
        out.vec3[b + 1] = this.pos.data[1]!
        out.vec3[b + 2] = this.pos.data[2]!
        out.vec3[b + 3] = 0
        out.f32[this.previewF32Slot + 0] = this.sr
        out.f32[this.previewF32Slot + 1] = this.lr
        this.writeRotPreview(out)
    }

    #paramSlice(): Float32Array {
        // pos (3) + sr,lr (2) + rot inverse (9, contiguous via reservePrimitiveRot).
        const buf = new Float32Array(14)
        buf.set(this.pos.data, 0)
        buf[3] = this.sr
        buf[4] = this.lr
        this.writeRotScene(buf, 5)
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.previewF32Slot = this.scene.allocPreviewF32(2)
        this.paramOffset = this.scene.allocSceneParamFloats(5)
        this.paramCount = 5
        this.reservePrimitiveRot() // +9 storage floats (contiguous) + 1 preview mat3
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const sr = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const lr = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`fTorusEx(p - ${pos}, ${sr}, ${lr}, ${this.id}u)`, pos) }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const sr = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const lr = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`fTorusFast(p - ${pos}, ${sr}, ${lr})`, pos) }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const sr = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const lr = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`sdfMidSetOwner(fTorusMid(p - ${pos}, ${sr}, ${lr}), ${this.id}u)`, pos) }
    }

    protected override computeBoundsCore(): AABB {
        // Expand the upright AABB for the local `rot` about the torus's center.
        const rr = this.lr + this.sr
        const { fwd } = eulerMatrices(this.rot.x, this.rot.y, this.rot.z)
        const r = aabbRotate(aabb(0, 0, 0, rr, this.sr, rr), fwd)
        return aabb(this.pos.x, this.pos.y, this.pos.z, r.hx, r.hy, r.hz)
    }

    @fluent smallRadius(sr: number): this {
        this.sr = sr
        return this
    }
    @fluent largeRadius(lr: number): this {
        this.lr = lr
        return this
    }
    @fluent shift(v: Vec3 | number, y?: number, z?: number): this {
        this.pos = typeof v === "number" ? vec3(v, y!, z!) : vec3(v)
        this.shifted = true
        return this
    }

    /**
     * `.rotate` BEFORE any `.shift` composes onto the local `rot` field (rotates
     * the torus about its own center, param-only/live). AFTER a `.shift` it
     * falls back to a `Rotate` operator (the shift becomes the pivot).
     */
    @fluent override rotate(v: Vec3 | number, ry?: number, rz?: number): Rotate {
        const r = typeof v === "number" ? vec3(v, ry!, rz!) : vec3(v)
        if (this.shifted) return rotateOp(r, this)
        this.composeLocalRot(r)
        return this as unknown as Rotate
    }
}

function torusSmallRadius(sr: number): Torus {
    return new Torus(DEFAULT_POS, { sr, lr: 1 })
}

function torusLargeRadius(lr: number): Torus {
    return new Torus(DEFAULT_POS, { sr: 0.25, lr })
}

export const torus = { smallRadius: torusSmallRadius, largeRadius: torusLargeRadius }
