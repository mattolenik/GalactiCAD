import { BinaryOperator, bindBinaryCompileResult, CompileResult, fluent, mergeChildPreludes, Node } from "../base.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

export class Groove extends BinaryOperator {
    ra: number
    rb: number
    constructor(lh: Node, rh: Node, ra = 0, rb = 0) {
        super(lh, rh)
        this.ra = ra
        this.rb = rb
    }
    override getShapeType(): string { return "groove" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }

    protected override reserveBinarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(2)
        this.paramCount = 2
        this.previewF32Slot = this.scene.allocPreviewF32(2)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.ra
        view[1] = this.rb
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.ra
        out.f32[this.previewF32Slot + 1] = this.rb
    }

    @fluent radii(ra: number, rb: number): this {
        this.ra = ra
        this.rb = rb
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `groove_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = f32Wgsl(o, this.previewF32Slot)
        const rb = f32Wgsl(o + 1, this.previewF32Slot + 1)
        return bindBinaryCompileResult(prelude, varName, `fOpGrooveEx(${lText}, ${rText}, ${ra}, ${rb})`)
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `groove_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = f32Wgsl(o, this.previewF32Slot)
        const rb = f32Wgsl(o + 1, this.previewF32Slot + 1)
        return bindBinaryCompileResult(prelude, varName, `fOpGrooveFast(${lText}, ${rText}, ${ra}, ${rb})`)
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `groove_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = f32Wgsl(o, this.previewF32Slot)
        const rb = f32Wgsl(o + 1, this.previewF32Slot + 1)
        return bindBinaryCompileResult(prelude, varName, `fOpGrooveMid(${lText}, ${rText}, ${ra}, ${rb})`)
    }
}

function grooveBase(base: Node) {
    return {
        pattern(pattern: Node): Groove {
            return new Groove(base, pattern, 0, 0)
        },
    }
}

export const groove = grooveBase
