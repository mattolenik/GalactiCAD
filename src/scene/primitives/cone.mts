import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, aabbRotate, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { eulerMatrices } from "../transform-math.mjs"
import { rotate as rotateOp, type Rotate } from "../operators/rotate.mjs"
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
        this.writeRotPreview(out)
    }

    #paramSlice(): Float32Array {
        // pos (3) + r,h (2) + rot inverse (9, contiguous via reservePrimitiveRot).
        const buf = new Float32Array(14)
        buf.set(this.pos.data, 0)
        buf[3] = this.r
        buf[4] = this.h
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
        const funcName = `Cone${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const h = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`fConeEx(p - ${pos}, ${r}, ${h}, ${this.id}u)`, pos) }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const h = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`fConeFast(p - ${pos}, ${r}, ${h})`, pos) }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const h = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`sdfMidSetOwner(fConeMid(p - ${pos}, ${r}, ${h}), ${this.id}u)`, pos) }
    }

    protected override computeBoundsCore(): AABB {
        // Expand for the local `rot`, which warps the sample point about `pos`
        // (the base center) — NOT the geometric center. The upright cone spans
        // local y ∈ [0, h], so its box is centered at (0, h/2, 0) in pos-relative
        // coords; rotate that off-center box about the pivot (origin) and then
        // re-anchor at `pos`. Identity `rot` ⇒ original upright bounds.
        const { fwd } = eulerMatrices(this.rot.x, this.rot.y, this.rot.z)
        const r = aabbRotate(aabb(0, this.h * 0.5, 0, this.r, this.h * 0.5, this.r), fwd)
        return aabb(this.pos.x + r.cx, this.pos.y + r.cy, this.pos.z + r.cz, r.hx, r.hy, r.hz)
    }

    @fluent height(h: number): this {
        this.h = h
        return this
    }
    @fluent shift(v: Vec3 | number, y?: number, z?: number): this {
        this.pos = typeof v === "number" ? vec3(v, y!, z!) : vec3(v)
        this.shifted = true
        return this
    }

    /**
     * `.rotate` BEFORE any `.shift` composes onto the local `rot` field (rotates
     * the cone about its own base center, param-only/live). AFTER a `.shift` it
     * falls back to a `Rotate` operator (the shift becomes the pivot).
     */
    @fluent override rotate(v: Vec3 | number, ry?: number, rz?: number): Rotate {
        const r = typeof v === "number" ? vec3(v, ry!, rz!) : vec3(v)
        if (this.shifted) return rotateOp(r, this)
        this.composeLocalRot(r)
        return this as unknown as Rotate
    }
}

function coneRadius(r: number): Cone {
    return new Cone(DEFAULT_POS, { r, h: 1 })
}

export const cone = { radius: coneRadius }
