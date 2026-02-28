import { UnaryOperator, CompileResult, decapitalize } from "../base.mjs"

export class Twist extends UnaryOperator {
    override getShapeType(): string { return "twist" }
    override getIndicatorSymbol(): string { return "⌀" }
    override getIndicatorSvg(): string {
        return `<path d="M3,2 C9,4 3,8 9,10" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
        const funcName = `Twist${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfTwistNormal(${twistedChild}, p, ${this.rate})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
        const funcName = `Twist${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfTwistFast(${twistedChild}, p, ${this.rate})` }
    }
    constructor(public rate: number, arg: import("../base.mjs").Node) {
        super(arg)
    }
}
