import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import { aabb, aabbRotate, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { eulerMatrices } from "../transform-math.mjs"
import { rotate as rotateOp, type Rotate } from "../operators/rotate.mjs"
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

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.pos.data[0]!
        out.vec3[b + 1] = this.pos.data[1]!
        out.vec3[b + 2] = this.pos.data[2]!
        out.vec3[b + 3] = 0
        this.writeRotPreview(out)
    }

    #paramSlice(): Float32Array {
        // pos (3) + rot inverse (9, contiguous via reservePrimitiveRot).
        const buf = new Float32Array(12)
        buf.set(this.pos.data, 0)
        this.writeRotScene(buf, 3)
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
        this.paramOffset = this.scene.allocSceneParamFloats(3)
        this.paramCount = 3
        this.reservePrimitiveRot() // +9 storage floats (contiguous) + 1 preview mat3
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        return { funcName, varName, text: this.warpRot(`fBlobEx(p - ${pos}, ${this.id}u)`, pos) }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        return { funcName, varName, text: this.warpRot(`fBlobFast(p - ${pos})`, pos) }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        return { funcName, varName, text: this.warpRot(`sdfMidSetOwner(fBlobMid(p - ${pos}), ${this.id}u)`, pos) }
    }

    protected override computeBoundsCore(): AABB {
        // Expand the upright AABB for the local `rot` about the blob's center.
        const { fwd } = eulerMatrices(this.rot.x, this.rot.y, this.rot.z)
        const r = aabbRotate(aabb(0, 0, 0, 1.7, 1.7, 1.7), fwd)
        return aabb(this.pos.x, this.pos.y, this.pos.z, r.hx, r.hy, r.hz)
    }

    @fluent shift(v: Vec3 | number, y?: number, z?: number): this {
        this.pos = typeof v === "number" ? vec3(v, y!, z!) : vec3(v)
        this.shifted = true
        return this
    }

    /**
     * `.rotate` BEFORE any `.shift` composes onto the local `rot` field (rotates
     * the blob about its own center, param-only/live). AFTER a `.shift` it falls
     * back to a `Rotate` operator (the shift becomes the pivot).
     */
    @fluent override rotate(v: Vec3 | number, ry?: number, rz?: number): Rotate {
        const r = typeof v === "number" ? vec3(v, ry!, rz!) : vec3(v)
        if (this.shifted) return rotateOp(r, this)
        this.composeLocalRot(r)
        return this as unknown as Rotate
    }
}

export function blob(): Blob {
    return new Blob(DEFAULT_POS)
}
