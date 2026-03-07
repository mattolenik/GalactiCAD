import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbExpand, type AABB } from "../aabb.mjs"

export class Bend extends UnaryOperator {
    override getShapeType(): string { return "bend" }
    override getIndicatorSymbol(): string { return "⌒" }
    override getIndicatorSvg(): string {
        return `<path d="M2,10 Q6,1 10,10" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${this.amount})`)
        const funcName = `Bend${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const bentPrelude = childResult.prelude.replace(/\bp\b/g, `bendPoint(p, ${this.amount})`)
            const accVar = childResult.varName!
            const prelude = bentPrelude + `${accVar} = sdfBendNormal(${accVar}, p, ${this.amount});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfBendNormal(${bentChild}, p, ${this.amount})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${this.amount})`)
        const funcName = `Bend${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const bentPrelude = childResult.prelude.replace(/\bp\b/g, `bendPoint(p, ${this.amount})`)
            return { funcName, varName: childResult.varName!, text: childResult.varName!, prelude: bentPrelude }
        }

        return { funcName, varName, text: `sdfBendFast(${bentChild}, p, ${this.amount})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${this.amount})`)
        const funcName = `Bend${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `sdfBendNormalMid(${bentChild}, p, ${this.amount})` }
    }

    override computeBounds(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        // Bend deforms along XY; use circumradius of hx,hy as conservative bound
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
