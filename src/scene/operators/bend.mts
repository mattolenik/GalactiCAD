import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"

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
        return { funcName, varName, text: `sdfBendNormal(${bentChild}, p, ${this.amount})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${this.amount})`)
        const funcName = `Bend${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfBendFast(${bentChild}, p, ${this.amount})` }
    }
    constructor(public amount: number, arg: Node) {
        super(arg)
    }
}

export const bend = fluent(function bend(amount: number, node: Node): Bend {
    return new Bend(amount, node)
})
