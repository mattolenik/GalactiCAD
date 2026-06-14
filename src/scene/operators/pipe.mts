import { BinaryOperator, binaryIsoCompileResult, CompileResult, fluent, Node } from "../base.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

export class Pipe extends BinaryOperator {
    pipeRadius = 0
    constructor(lh: Node, rh: Node, radius = 0) {
        super(lh, rh)
        this.pipeRadius = radius
    }
    override getShapeType(): string { return "pipe" }

    /** V1: conservative no-op — Pipe's feature-preservation semantics not yet analyzed. */
    override accumulateFeatureGraph(_builder: FeatureGraphBuilder): void {}

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="10" x2="10" y2="2" stroke="currentColor" stroke-width="1.5"/>`
    }

    protected override reserveBinarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
        this.previewF32Slot = this.scene.allocPreviewF32(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.pipeRadius
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.pipeRadius
    }

    @fluent radius(r: number): this {
        this.pipeRadius = r
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `pipe_${lhResult.varName}__${rhResult.varName}`
        const pr = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryIsoCompileResult(this, varName, lhResult, rhResult, (l, r) => `fOpPipeEx(${l}, ${r}, ${pr})`, "selectSDF")
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `pipe_${lhResult.varName}__${rhResult.varName}`
        const pr = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryIsoCompileResult(this, varName, lhResult, rhResult, (l, r) => `fOpPipeFast(${l}, ${r}, ${pr})`, "selectFast")
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const varName = `pipe_${lhResult.varName}__${rhResult.varName}`
        const pr = f32Wgsl(this.paramOffset, this.previewF32Slot)
        return binaryIsoCompileResult(this, varName, lhResult, rhResult, (l, r) => `fOpPipeMid(${l}, ${r}, ${pr})`, "selectMid")
    }
}

export function pipe(lh: Node, rh: Node): Pipe {
    return new Pipe(lh, rh, 0)
}
