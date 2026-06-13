import { CompileResult, decapitalize, fluent, Node, UnaryOperator, unaryDistanceIsoResult } from "../base.mjs"
import { aabbExpand, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

export class Offset extends UnaryOperator {
    override getShapeType(): string { return "offset" }

    /** V1: conservative no-op — Offset's feature-preservation semantics not yet analyzed. */
    override accumulateFeatureGraph(_builder: FeatureGraphBuilder): void {}

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="3" fill="currentColor"/><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
        this.previewF32Slot = this.scene.allocPreviewF32(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.amount
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.amount
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = decapitalize(funcName)
        const amt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return unaryDistanceIsoResult(this, funcName, varName, childResult, c => `sdfOffsetEx(${c}, ${amt})`, "selectSDF")
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const amt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return unaryDistanceIsoResult(this, funcName, varName, childResult, c => `sdfOffsetFast(${c}, ${amt})`, "selectFast")
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const amt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return unaryDistanceIsoResult(this, funcName, varName, childResult, c => `sdfOffsetMid(${c}, p, ${amt})`, "selectMid")
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        return aabbExpand(b, this.amount)
    }
    constructor(public amount: number, arg: Node) {
        super(arg)
    }
}

export const offset = fluent(function offset(amount: number, node: Node): Offset {
    return new Offset(amount, node)
})
