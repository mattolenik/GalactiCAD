import { CompileResult, decapitalize, fluent, Node, UnaryOperator, warpIsoResult } from "../base.mjs"
import { aabbExpandVec, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

export class Elongate extends UnaryOperator {
    hx: number
    hy: number
    hz: number

    override getShapeType(): string { return "elongate" }

    /** V1: conservative no-op — Elongate's feature-preservation semantics not yet analyzed. */
    override accumulateFeatureGraph(_builder: FeatureGraphBuilder): void {}

    override getIndicatorSvg(): string {
        return `<line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.5"/><polygon points="0,6 3,4 3,8" fill="currentColor"/><polygon points="12,6 9,4 9,8" fill="currentColor"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(3)
        this.paramCount = 3
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.hx
        view[1] = this.hy
        view[2] = this.hz
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.hx
        out.vec3[b + 1] = this.hy
        out.vec3[b + 2] = this.hz
        out.vec3[b + 3] = 0
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const h = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        const funcName = `Elongate${this.id}`
        return warpIsoResult(this, funcName, decapitalize(funcName), childResult, `elongatePoint(p, ${h})`, c => c, "selectSDF")
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const h = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        const funcName = `Elongate${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_f`, childResult, `elongatePoint(p, ${h})`, c => c, "selectFast")
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const h = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        const funcName = `Elongate${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_m`, childResult, `elongatePoint(p, ${h})`, c => `sdfMidStripFeatures(${c})`, "selectMid")
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        return aabbExpandVec(b, this.hx, this.hy, this.hz)
    }
    constructor(h: Vec3, arg: Node) {
        super(arg)
        const v = vec3(h)
        this.hx = v.x
        this.hy = v.y
        this.hz = v.z
    }
}

export const elongate = fluent(function elongate(a: Vec3 | number, b: Node | number, c?: number, d?: Node): Elongate {
    return typeof a === "number" ? new Elongate([a, b as number, c as number], d as Node) : new Elongate(a, b as Node)
})
