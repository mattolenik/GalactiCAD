import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST } from "../base.mjs"
import type { AABB } from "../aabb.mjs"

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

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
        const funcName = `Taper${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const taperedPrelude = childResult.prelude.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
            const accVar = childResult.varName!
            const prelude = taperedPrelude + `${accVar} = sdfTaperNormal(${accVar}, p, ${this.ratio}, ${this.height});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfTaperNormal(${taperedChild}, p, ${this.ratio}, ${this.height})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
        const funcName = `Taper${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const taperedPrelude = childResult.prelude.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
            const accVar = childResult.varName!
            const prelude = taperedPrelude + `${accVar} = sdfTaperFast(${accVar}, p, ${this.ratio}, ${this.height});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfTaperFast(${taperedChild}, p, ${this.ratio}, ${this.height})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
        const funcName = `Taper${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `sdfTaperNormalMid(${taperedChild}, p, ${this.ratio}, ${this.height})` }
    }

    override computeBounds(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        // Taper scales XZ by ratio at y=height; use max scale for conservative bound
        const maxScale = Math.max(1.0, Math.abs(this.ratio))
        return { cx: b.cx, cy: b.cy, cz: b.cz, hx: b.hx * maxScale, hy: b.hy, hz: b.hz * maxScale }
    }
    constructor(public ratio: number, public height: number, arg: Node) {
        super(arg)
    }
}

export const taper = fluent(function taper(ratio: number, height: number, node: Node): Taper {
    return new Taper(ratio, height, node)
})
