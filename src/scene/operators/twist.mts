import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST, warpIsoResult } from "../base.mjs"
import { type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

export class Twist extends UnaryOperator {
    override getShapeType(): string { return "twist" }
    override getIndicatorSvg(): string {
        return `<path d="M3,2 C9,4 3,8 9,10" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override _computeCodegenCost(): number {
        return this.arg.codegenCost() + BVH_MIN_COST
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
        this.previewF32Slot = this.scene.allocPreviewF32(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.rate
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.rate
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const rate = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const funcName = `Twist${this.id}`
        return warpIsoResult(this, funcName, decapitalize(funcName), childResult, `twistPoint(p, ${rate})`, c => `sdfTwistNormal(${c}, p, ${rate})`, "selectSDF")
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const rate = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const funcName = `Twist${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_f`, childResult, `twistPoint(p, ${rate})`, c => `sdfTwistFast(${c}, p, ${rate})`, "selectFast")
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const rate = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const funcName = `Twist${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_m`, childResult, `twistPoint(p, ${rate})`, c => `sdfTwistNormalMid(${c}, p, ${rate})`, "selectMid")
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        const r = Math.sqrt(b.hx * b.hx + b.hz * b.hz)
        return { cx: b.cx, cy: b.cy, cz: b.cz, hx: r, hy: b.hy, hz: r }
    }

    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        // V1: warps don't push a real affine — we just mark the subtree so
        // emitters can skip emission. Revisit when per-warp `warpPoint`
        // application lands and we can map local→world correctly under twist.
        builder.pushNonAffine()
        try {
            this.arg.accumulateFeatureGraph(builder)
        } finally {
            builder.pop()
        }
    }

    constructor(public rate: number, arg: Node) {
        super(arg)
    }
}

export const twist = fluent(function twist(rate: number, node: Node): Twist {
    return new Twist(rate, node)
})
