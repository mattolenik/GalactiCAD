import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
import { rotate as rotateOp, type Rotate } from "../operators/rotate.mjs"
import { Vec3, vec3, type Vec3f } from "../../vecmat/vector.mjs"

export class PlaneNode extends Node {
    pos = vec3([0, 0, 0])
    normal: Vec3f
    dist: number

    constructor(pos: Vec3, { n, dist = 0 }: { n: Vec3; dist?: number }) {
        super()
        this.pos = vec3(pos)
        this.normal = vec3(n).normalize()
        this.dist = dist
    }

    override getShapeType(): string { return "plane" }
    override getIndicatorSymbol(): string { return "▬" }
    override getIndicatorSvg(): string {
        return `<line x1="0" y1="6" x2="12" y2="6" stroke="currentColor" stroke-width="2"/>`
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
        out.vec3[b] = this.normal.data[0]!
        out.vec3[b + 1] = this.normal.data[1]!
        out.vec3[b + 2] = this.normal.data[2]!
        out.vec3[b + 3] = 0
        out.f32[this.previewF32Slot] = this.dist
        this.writeRotPreview(out)
    }

    #paramSlice(): Float32Array {
        // pos (3) + normal (3) + dist (1) + rot inverse (9, contiguous via reservePrimitiveRot).
        const buf = new Float32Array(16)
        buf.set(this.pos.data, 0)
        buf.set(this.normal.data, 3)
        buf[6] = this.dist
        this.writeRotScene(buf, 7)
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(2)
        this.previewF32Slot = this.scene.allocPreviewF32(1)
        this.paramOffset = this.scene.allocSceneParamFloats(7)
        this.paramCount = 7
        this.reservePrimitiveRot() // +9 storage floats (contiguous) + 1 preview mat3
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const nrm = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        const d = f32Wgsl(o + 6, this.previewF32Slot)
        return { funcName, varName, text: this.warpRot(`fPlaneEx(p - ${pos}, ${nrm}, ${d}, ${this.id}u)`, pos) }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const nrm = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        const d = f32Wgsl(o + 6, this.previewF32Slot)
        return { funcName, varName, text: this.warpRot(`fPlaneFast(p - ${pos}, ${nrm}, ${d})`, pos) }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const nrm = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        const d = f32Wgsl(o + 6, this.previewF32Slot)
        return { funcName, varName, text: this.warpRot(`sdfMidSetOwner(fPlaneMid(p - ${pos}, ${nrm}, ${d}), ${this.id}u)`, pos) }
    }

    @fluent withNormal(n: Vec3 | number, ny?: number, nz?: number): this {
        this.normal = (typeof n === "number" ? vec3(n, ny!, nz!) : vec3(n)).normalize()
        return this
    }
    @fluent withDist(d: number): this {
        this.dist = d
        return this
    }
    @fluent shift(v: Vec3 | number, y?: number, z?: number): this {
        this.pos = typeof v === "number" ? vec3(v, y!, z!) : vec3(v)
        this.shifted = true
        return this
    }

    /**
     * `.rotate` BEFORE any `.shift` composes onto the local `rot` field (rotates
     * the plane about its own center, param-only/live). AFTER a `.shift` it falls
     * back to a `Rotate` operator (the shift becomes the pivot).
     */
    @fluent override rotate(v: Vec3 | number, ry?: number, rz?: number): Rotate {
        const r = typeof v === "number" ? vec3(v, ry!, rz!) : vec3(v)
        if (this.shifted) return rotateOp(r, this)
        this.composeLocalRot(r)
        return this as unknown as Rotate
    }
}

function planeNormal(n: Vec3 | number, ny?: number, nz?: number): PlaneNode {
    return new PlaneNode(DEFAULT_POS, { n: typeof n === "number" ? vec3(n, ny!, nz!) : vec3(n) })
}

function planeDist(d: number): PlaneNode {
    return new PlaneNode(DEFAULT_POS, { n: vec3([0, 1, 0]), dist: d })
}

export const plane = { normal: planeNormal, dist: planeDist }
