import { Node, UnaryOperator, CompileResult, decapitalize, FLUENT_METHODS } from "../base.mjs"

export class Offset extends UnaryOperator {
    override getShapeType(): string { return "offset" }
    override getIndicatorSymbol(): string { return "⊕" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="3" fill="currentColor"/><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfOffsetEx(${childResult.text}, ${this.amount})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfOffsetFast(${childResult.text}, ${this.amount})` }
    }
    constructor(public amount: number, arg: import("../base.mjs").Node) {
        super(arg)
    }
}

Node.prototype.offset = function (this: Node, amount: number) { return new Offset(amount, this) }
FLUENT_METHODS.add("offset")
