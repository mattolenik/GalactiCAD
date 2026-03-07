import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbExpand, type AABB } from "../aabb.mjs"

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

        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfOffsetEx(${accVar}, ${this.amount});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfOffsetEx(${childResult.text}, ${this.amount})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfOffsetFast(${accVar}, ${this.amount});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfOffsetFast(${childResult.text}, ${this.amount})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `sdfOffsetMid(${childResult.text}, ${this.amount})` }
    }

    override computeBounds(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        return aabbExpand(b, this.amount)
    }
    constructor(public amount: number, arg: Node) {
        super(arg)
    }
}

export const offset = fluent(function offset(amount: number, node: Node): Offset {
    return new Offset(amount, node)
})
