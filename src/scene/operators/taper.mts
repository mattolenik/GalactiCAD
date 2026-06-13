import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST, warpIsoResult } from "../base.mjs"
import type { AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

export class Taper extends UnaryOperator {
    override getShapeType(): string { return "taper" }
    override getIndicatorSvg(): string {
        return `<polygon points="3,11 9,11 7,1 5,1" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override _computeCodegenCost(): number {
        return this.arg.codegenCost() + BVH_MIN_COST
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(2)
        this.paramCount = 2
        this.previewF32Slot = this.scene.allocPreviewF32(2)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.ratio
        view[1] = this.height
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot + 0] = this.ratio
        out.f32[this.previewF32Slot + 1] = this.height
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const o = this.paramOffset
        const ratio = f32Wgsl(o, this.previewF32Slot)
        const height = f32Wgsl(o + 1, this.previewF32Slot + 1)
        const funcName = `Taper${this.id}`
        return warpIsoResult(this, funcName, decapitalize(funcName), childResult, `taperPoint(p, ${ratio}, ${height})`, c => `sdfTaperNormal(${c}, p, ${ratio}, ${height})`, "selectSDF")
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const o = this.paramOffset
        const ratio = f32Wgsl(o, this.previewF32Slot)
        const height = f32Wgsl(o + 1, this.previewF32Slot + 1)
        const funcName = `Taper${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_f`, childResult, `taperPoint(p, ${ratio}, ${height})`, c => `sdfTaperFast(${c}, p, ${ratio}, ${height})`, "selectFast")
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const o = this.paramOffset
        const ratio = f32Wgsl(o, this.previewF32Slot)
        const height = f32Wgsl(o + 1, this.previewF32Slot + 1)
        const funcName = `Taper${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_m`, childResult, `taperPoint(p, ${ratio}, ${height})`, c => `sdfTaperNormalMid(${c}, p, ${ratio}, ${height})`, "selectMid")
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        const maxScale = Math.max(1.0, Math.abs(this.ratio))
        return { cx: b.cx, cy: b.cy, cz: b.cz, hx: b.hx * maxScale, hy: b.hy, hz: b.hz * maxScale }
    }

    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        builder.pushNonAffine()
        try {
            this.arg.accumulateFeatureGraph(builder)
        } finally {
            builder.pop()
        }
    }

    constructor(public ratio: number, public height: number, arg: Node) {
        super(arg)
    }
}

export const taper = fluent(function taper(ratio: number, height: number, node: Node): Taper {
    return new Taper(ratio, height, node)
})
