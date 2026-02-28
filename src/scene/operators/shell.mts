import { UnaryOperator, CompileResult, decapitalize } from "../base.mjs"

export class Shell extends UnaryOperator {
    override getShapeType(): string { return "shell" }
    override getIndicatorSymbol(): string { return "◯" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="1,1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfShellEx(${childResult.text}, ${this.thickness})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfShellFast(${childResult.text}, ${this.thickness})` }
    }
    constructor(public thickness: number, arg: import("../base.mjs").Node) {
        super(arg)
    }
}
