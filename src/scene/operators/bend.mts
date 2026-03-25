import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST } from "../base.mjs"
import { aabbExpand, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

export class Bend extends UnaryOperator {
    override getShapeType(): string { return "bend" }
    override getIndicatorSvg(): string {
        return `<path d="M2,10 Q6,1 10,10" fill="none" stroke="currentColor" stroke-width="1.5"/>`
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
        view[0] = this.amount
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.amount
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const amt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${amt})`)
        const funcName = `Bend${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const bentPrelude = childResult.prelude.replace(/\bp\b/g, `bendPoint(p, ${amt})`)
            const accVar = childResult.varName!
            const prelude = bentPrelude + `${accVar} = sdfBendNormal(${accVar}, p, ${amt});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfBendNormal(${bentChild}, p, ${amt})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const amt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${amt})`)
        const funcName = `Bend${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const bentPrelude = childResult.prelude.replace(/\bp\b/g, `bendPoint(p, ${amt})`)
            const accVar = childResult.varName!
            const prelude = bentPrelude + `${accVar} = sdfBendFast(${accVar}, p, ${amt});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfBendFast(${bentChild}, p, ${amt})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const amt = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${amt})`)
        const funcName = `Bend${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `sdfBendNormalMid(${bentChild}, p, ${amt})` }
    }

    override computeBounds(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        const r = Math.sqrt(b.hx * b.hx + b.hy * b.hy)
        return aabbExpand(b, r - Math.min(b.hx, b.hy))
    }
    constructor(public amount: number, arg: Node) {
        super(arg)
    }
}

export const bend = fluent(function bend(amount: number, node: Node): Bend {
    return new Bend(amount, node)
})
