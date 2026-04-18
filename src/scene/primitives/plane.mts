import { Node, CompileResult, fluent, decapitalize, DEFAULT_POS } from "../base.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl, vec3Wgsl } from "../scene-params.mjs"
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
    }

    #paramSlice(): Float32Array {
        const buf = new Float32Array(7)
        buf.set(this.pos.data, 0)
        buf.set(this.normal.data, 3)
        buf[6] = this.dist
        return buf
    }

    override build() {
        super.build()
        this.previewVec3Slot = this.scene.allocPreviewVec3(2)
        this.previewF32Slot = this.scene.allocPreviewF32(1)
        this.paramOffset = this.scene.allocSceneParamFloats(7)
        this.paramCount = 7
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = decapitalize(funcName)
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const nrm = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        const d = f32Wgsl(o + 6, this.previewF32Slot)
        return { funcName, varName, text: `fPlaneEx(p - ${pos}, ${nrm}, ${d}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const nrm = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        const d = f32Wgsl(o + 6, this.previewF32Slot)
        return { funcName, varName, text: `fPlaneFast(p - ${pos}, ${nrm}, ${d})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const o = this.paramOffset
        const pos = vec3Wgsl(o, this.previewVec3Slot)
        const nrm = vec3Wgsl(o + 3, this.previewVec3Slot + 1)
        const d = f32Wgsl(o + 6, this.previewF32Slot)
        return { funcName, varName, text: `sdfMidSetOwner(fPlaneMid(p - ${pos}, ${nrm}, ${d}), ${this.id}u)` }
    }

    @fluent withNormal(n: Vec3): this {
        this.normal = vec3(n).normalize()
        return this
    }
    @fluent withDist(d: number): this {
        this.dist = d
        return this
    }
    @fluent shift(v: Vec3): this {
        this.pos = vec3(v)
        return this
    }
}

function planeNormal(n: Vec3): PlaneNode {
    return new PlaneNode(DEFAULT_POS, { n: vec3(n) })
}

function planeDist(d: number): PlaneNode {
    return new PlaneNode(DEFAULT_POS, { n: vec3([0, 1, 0]), dist: d })
}

export const plane = { normal: planeNormal, dist: planeDist }
