import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST } from "../base.mjs"
import { type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

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
        const childText = childResult.text!
        const rate = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${rate})`)
        const funcName = `Twist${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const twistedPrelude = childResult.prelude.replace(/\bp\b/g, `twistPoint(p, ${rate})`)
            const accVar = childResult.varName!
            const prelude = twistedPrelude + `${accVar} = sdfTwistNormal(${accVar}, p, ${rate});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfTwistNormal(${twistedChild}, p, ${rate})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const rate = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${rate})`)
        const funcName = `Twist${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const twistedPrelude = childResult.prelude.replace(/\bp\b/g, `twistPoint(p, ${rate})`)
            const accVar = childResult.varName!
            const prelude = twistedPrelude + `${accVar} = sdfTwistFast(${accVar}, p, ${rate});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfTwistFast(${twistedChild}, p, ${rate})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const rate = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const funcName = `Twist${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        if (childResult.prelude) {
            const twistedPrelude = childResult.prelude.replace(/\bp\b/g, `twistPoint(p, ${rate})`)
            const accVar = childResult.varName!
            const prelude = twistedPrelude + `${accVar} = sdfTwistNormalMid(${accVar}, p, ${rate});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${rate})`)
        return { funcName, varName, text: `sdfTwistNormalMid(${twistedChild}, p, ${rate})` }
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        const r = Math.sqrt(b.hx * b.hx + b.hz * b.hz)
        return { cx: b.cx, cy: b.cy, cz: b.cz, hx: r, hy: b.hy, hz: r }
    }
    constructor(public rate: number, arg: Node) {
        super(arg)
    }
}

export const twist = fluent(function twist(rate: number, node: Node): Twist {
    return new Twist(rate, node)
})
