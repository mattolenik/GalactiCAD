import { BinaryOperator, CompileResult, binaryOpCompileResult, fluent, mergeChildPreludes, Node } from "../base.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

export class Engrave extends BinaryOperator {
    engraveRadius = 0
    constructor(lh: Node, rh: Node, radius = 0) {
        super(lh, rh)
        this.engraveRadius = radius
    }
    override getShapeType(): string { return "engrave" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1"/>`
    }

    protected override reserveBinarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
        this.previewF32Slot = this.scene.allocPreviewF32(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.engraveRadius
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.engraveRadius
    }

    @fluent radius(r: number): this {
        this.engraveRadius = r
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `engrave_${lhResult.varName}__${rhResult.varName}`
        const er = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryOpCompileResult(varName, `fOpEngraveEx(${lText}, ${rText}, ${er})`, prelude)
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `engrave_${lhResult.varName}__${rhResult.varName}`
        const er = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryOpCompileResult(varName, `fOpEngraveFast(${lText}, ${rText}, ${er})`, prelude)
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `engrave_${lhResult.varName}__${rhResult.varName}`
        const er = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryOpCompileResult(varName, `fOpEngraveMid(${lText}, ${rText}, ${er})`, prelude)
    }
}

function engraveBase(base: Node) {
    return {
        pattern(pattern: Node): Engrave {
            return new Engrave(base, pattern, 0)
        },
    }
}

export const engrave = engraveBase
