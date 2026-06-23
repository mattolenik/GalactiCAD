import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, aabbRotate, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { eulerMatrices } from "../transform-math.mjs"
import { rotate as rotateOp, type Rotate } from "../operators/rotate.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Capsule extends Node {
    pos = vec3([0, 0, 0])
    r = 0
    c: number

    constructor(pos: Vec3, { r, c }: { r: number; c: number }) {
        super()
        this.pos = vec3(pos)
        this.r = r
        this.c = c
    }

    override getShapeType(): string { return "capsule" }
    override getIndicatorSymbol(): string { return "⬮" }
    override getIndicatorSvg(): string {
        return `<rect x="2" y="1" width="8" height="10" rx="4" fill="currentColor"/>`
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
        out.f32[this.previewF32Slot + 1] = this.c
        this.writeRotPreview(out)
    }

    #paramSlice(): Float32Array {
        // pos (3) + r,c (2) + rot inverse (9, contiguous via reservePrimitiveRot).
        const buf = new Float32Array(14)
        buf.set(this.pos.data, 0)
        buf[3] = this.r
        buf[4] = this.c
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
        const funcName = `Capsule${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const c = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`fCapsuleEx(p - ${pos}, ${r}, ${c}, ${this.id}u)`, pos) }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Capsule${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const c = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`fCapsuleFast(p - ${pos}, ${r}, ${c})`, pos) }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Capsule${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const r = f32Wgsl(o + 3, this.previewF32Slot + 0)
        const c = f32Wgsl(o + 4, this.previewF32Slot + 1)
        return { funcName, varName, text: this.warpRot(`sdfMidSetOwner(fCapsuleMid(p - ${pos}, ${r}, ${c}), ${this.id}u)`, pos) }
    }

    protected override computeBoundsCore(): AABB {
        // Expand the upright AABB for the local `rot` about the capsule's center.
        const { fwd } = eulerMatrices(this.rot.x, this.rot.y, this.rot.z)
        const r = aabbRotate(aabb(0, 0, 0, this.r, this.c + this.r, this.r), fwd)
        return aabb(this.pos.x, this.pos.y, this.pos.z, r.hx, r.hy, r.hz)
    }

    @fluent radius(r: number): this {
        this.r = r
        return this
    }
    @fluent cylinderLength(c: number): this {
        this.c = c
        return this
    }
    @fluent shift(v: Vec3 | number, y?: number, z?: number): this {
        this.pos = typeof v === "number" ? vec3(v, y!, z!) : vec3(v)
        this.shifted = true
        return this
    }

    /**
     * `.rotate` BEFORE any `.shift` composes onto the local `rot` field (rotates
     * the capsule about its own center, param-only/live). AFTER a `.shift` it
     * falls back to a `Rotate` operator (the shift becomes the pivot).
     */
    @fluent override rotate(v: Vec3 | number, ry?: number, rz?: number): Rotate {
        const r = typeof v === "number" ? vec3(v, ry!, rz!) : vec3(v)
        if (this.shifted) return rotateOp(r, this)
        this.composeLocalRot(r)
        return this as unknown as Rotate
    }
}

function capsuleRadius(r: number): Capsule {
    return new Capsule(DEFAULT_POS, { r, c: 1 })
}

function capsuleCylinderLength(c: number): Capsule {
    return new Capsule(DEFAULT_POS, { r: 0.5, c })
}

export const capsule = { radius: capsuleRadius, cylinderLength: capsuleCylinderLength }
