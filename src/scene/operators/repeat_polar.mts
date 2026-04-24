import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST } from "../base.mjs"
import type { AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

/** Polar domain repeat in the XZ plane around +Y (same convention as `pModPolar` in hg_sdf.wgsl). */
export class RepeatPolar extends UnaryOperator {
    override getShapeType(): string {
        return "repeat_polar"
    }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6,2 L6,6 L9,6" fill="none" stroke="currentColor" stroke-width="1.5"/>`
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
        const childText = childResult.text!
        const rep = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const warped = childText.replace(/\bp\b/g, `repeatPolarXZPoint(p, ${rep})`)
        const funcName = `RepeatPolar${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const warpedPrelude = childResult.prelude.replace(/\bp\b/g, `repeatPolarXZPoint(p, ${rep})`)
            const accVar = childResult.varName!
            const prelude = warpedPrelude + `${accVar} = sdfRepeatPolarXZNormal(${accVar}, p, ${rep});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfRepeatPolarXZNormal(${warped}, p, ${rep})` }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const rep = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const warped = childText.replace(/\bp\b/g, `repeatPolarXZPoint(p, ${rep})`)
        const funcName = `RepeatPolar${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const warpedPrelude = childResult.prelude.replace(/\bp\b/g, `repeatPolarXZPoint(p, ${rep})`)
            const accVar = childResult.varName!
            const prelude = warpedPrelude + `${accVar} = sdfRepeatPolarXZFast(${accVar}, p, ${rep});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfRepeatPolarXZFast(${warped}, p, ${rep})` }
    }

    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const rep = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const warped = childText.replace(/\bp\b/g, `repeatPolarXZPoint(p, ${rep})`)
        const funcName = `RepeatPolar${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        if (childResult.prelude) {
            const warpedPrelude = childResult.prelude.replace(/\bp\b/g, `repeatPolarXZPoint(p, ${rep})`)
            const accVar = childResult.varName!
            const prelude = warpedPrelude + `${accVar} = sdfRepeatPolarXZNormalMid(${accVar}, p, ${rep});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }
        return { funcName, varName, text: `sdfRepeatPolarXZNormalMid(${warped}, p, ${rep})` }
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
