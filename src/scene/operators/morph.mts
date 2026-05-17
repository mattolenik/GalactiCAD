import { BinaryOperator, CompileResult, binaryOpCompileResult, fluent, mergeChildPreludes, Node } from "../base.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

export class Morph extends BinaryOperator {
    morphT = 0
    constructor(t: number, lh: Node, rh: Node) {
        super(lh, rh)
        this.morphT = t
    }
    override getShapeType(): string { return "morph" }

    /** V1: conservative no-op — Morph blends two SDFs, destroying sharp features mid-interpolation. */
    override accumulateFeatureGraph(_builder: FeatureGraphBuilder): void {}

    override getIndicatorSvg(): string {
        return `<circle cx="3" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1"/><rect x="7" y="4" width="4" height="4" rx="0.5" fill="none" stroke="currentColor" stroke-width="1"/><line x1="5" y1="6" x2="7" y2="6" stroke="currentColor" stroke-width="1" stroke-dasharray="1,0.5"/>`
    }

    protected override reserveBinarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
        this.previewF32Slot = this.scene.allocPreviewF32(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.morphT
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.morphT
    }

    @fluent t(t: number): this {
        this.morphT = t
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `morph_${lhResult.varName}__${rhResult.varName}`
        const mt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryOpCompileResult(varName, `sdfMorphEx(${lText}, ${rText}, ${mt})`, prelude)
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `morph_${lhResult.varName}__${rhResult.varName}`
        const mt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryOpCompileResult(varName, `sdfMorphFast(${lText}, ${rText}, ${mt})`, prelude)
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `morph_${lhResult.varName}__${rhResult.varName}`
        const mt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryOpCompileResult(varName, `sdfMorphMid(${lText}, ${rText}, ${mt})`, prelude)
    }
}

export function morph(lh: Node, rh: Node): Morph {
    return new Morph(0, lh, rh)
}
