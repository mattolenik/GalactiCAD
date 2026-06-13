import { BinaryOperator, binaryIsoCompileResult, CompileResult, fluent, Node } from "../base.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

export class Tongue extends BinaryOperator {
    ra: number
    rb: number
    constructor(lh: Node, rh: Node, ra = 0, rb = 0) {
        super(lh, rh)
        this.ra = ra
        this.rb = rb
    }
    override getShapeType(): string { return "tongue" }

    /** V1: conservative no-op — Tongue's feature-preservation semantics not yet analyzed. */
    override accumulateFeatureGraph(_builder: FeatureGraphBuilder): void {}

    override getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="3" x2="6" y2="9" stroke="currentColor" stroke-width="1"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1"/>`
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
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = f32Wgsl(o, this.previewF32Slot)
        const rb = f32Wgsl(o + 1, this.previewF32Slot + 1)
        return binaryIsoCompileResult(this, varName, lhResult, rhResult, (l, r) => `fOpTongueEx(${l}, ${r}, ${ra}, ${rb})`, "selectSDF")
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = f32Wgsl(o, this.previewF32Slot)
        const rb = f32Wgsl(o + 1, this.previewF32Slot + 1)
        return binaryIsoCompileResult(this, varName, lhResult, rhResult, (l, r) => `fOpTongueFast(${l}, ${r}, ${ra}, ${rb})`, "selectFast")
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = f32Wgsl(o, this.previewF32Slot)
        const rb = f32Wgsl(o + 1, this.previewF32Slot + 1)
        return binaryIsoCompileResult(this, varName, lhResult, rhResult, (l, r) => `fOpTongueMid(${l}, ${r}, ${ra}, ${rb})`, "selectMid")
    }
}

function tongueBase(base: Node) {
    return {
        pattern(pattern: Node): Tongue {
            return new Tongue(base, pattern, 0, 0)
        },
    }
}

export const tongue = tongueBase
