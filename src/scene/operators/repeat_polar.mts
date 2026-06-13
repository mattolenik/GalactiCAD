import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST, warpIsoResult } from "../base.mjs"
import type { AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

/** Polar domain repeat in the XZ plane around +Y (same convention as `pModPolar` in hg_sdf.wgsl). */
export class RepeatPolar extends UnaryOperator {
    override getShapeType(): string {
        return "repeatPolar"
    }

    /**
     * V1: domain repetition is out of scope — a single local-space vertex maps
     * to N world-space instances and we don't enumerate them yet. Drop child
     * features under any repeat operator.
     */
    override accumulateFeatureGraph(_builder: FeatureGraphBuilder): void {}

    override getIndicatorSymbol(): string {
        return "↻"
    }
    /** Polar tiling around +Y: ring + radial spokes (editor pill icon). */
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 1.5 L6 10.5 M1.5 6 L10.5 6 M2.9 2.9 L9.1 9.1 M9.1 2.9 L2.9 9.1" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/>`
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
        view[0] = this.repetitions
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.repetitions
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const rep = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const funcName = `RepeatPolar${this.id}`
        return warpIsoResult(this, funcName, decapitalize(funcName), childResult, `repeatPolarXZPoint(p, ${rep})`, c => `sdfRepeatPolarXZNormal(${c}, p, ${rep})`, "selectSDF")
    }

    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const rep = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const funcName = `RepeatPolar${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_f`, childResult, `repeatPolarXZPoint(p, ${rep})`, c => `sdfRepeatPolarXZFast(${c}, p, ${rep})`, "selectFast")
    }

    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const rep = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const funcName = `RepeatPolar${this.id}`
        return warpIsoResult(this, funcName, `${decapitalize(funcName)}_m`, childResult, `repeatPolarXZPoint(p, ${rep})`, c => `sdfRepeatPolarXZNormalMid(${c}, p, ${rep})`, "selectMid")
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        let rMax = 0
        for (const sx of [-1, 1] as const) {
            for (const sz of [-1, 1] as const) {
                const x = b.cx + sx * b.hx
                const z = b.cz + sz * b.hz
                rMax = Math.max(rMax, Math.hypot(x, z))
            }
        }
        return { cx: 0, cy: b.cy, cz: 0, hx: rMax, hy: b.hy, hz: rMax }
    }

    constructor(
        /** Number of identical wedges around +Y (e.g. knurl tooth count). */
        public repetitions: number,
        arg: Node,
    ) {
        super(arg)
        if (!Number.isFinite(repetitions) || repetitions < 2) {
            throw new Error(`repeatPolar: repetitions must be a finite number >= 2 (got ${repetitions})`)
        }
    }
}

export const repeatPolar = fluent(function repeatPolar(repetitions: number, node: Node): RepeatPolar {
    return new RepeatPolar(repetitions, node)
})
