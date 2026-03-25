import { BinaryOperator, CompileResult, fluent, mergeChildPreludes, Node } from "../base.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

export class Seam extends BinaryOperator {
    #seamRadius = 0
    constructor(lh: Node, rh: Node, radius = 0) {
        super(lh, rh)
        this.#seamRadius = radius
    }
    override getShapeType(): string { return "seam" }
    override getIndicatorSvg(): string {
        return `<circle cx="4" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="8" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="6" cy="6" r="1" fill="currentColor"/>`
    }

    protected override reserveBinarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
        this.previewF32Slot = this.scene.allocPreviewF32(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.#seamRadius
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.#seamRadius
    }

    @fluent radius(r: number): this {
        this.#seamRadius = r
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `seam_${lhResult.varName}__${rhResult.varName}`
        const sr = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return { text: `sdfSeamEx(${lText}, ${rText}, ${sr})`, varName, prelude }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `seam_${lhResult.varName}__${rhResult.varName}`
        const sr = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return { text: `sdfSeamFast(${lText}, ${rText}, ${sr})`, varName, prelude }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const varName = `seam_${lhResult.varName}__${rhResult.varName}`
        const sr = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return { text: `sdfSeamMid(${lhResult.text}, ${rhResult.text}, ${sr})`, varName }
    }
}

export function seam(lh: Node, rh: Node): Seam {
    return new Seam(lh, rh, 0)
}
