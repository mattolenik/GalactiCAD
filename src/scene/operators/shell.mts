import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbExpand, type AABB } from "../aabb.mjs"

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

        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfShellEx(${accVar}, ${this.thickness});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfShellEx(${childResult.text}, ${this.thickness})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfShellFast(${accVar}, ${this.thickness});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfShellFast(${childResult.text}, ${this.thickness})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `sdfShellMid(${childResult.text}, ${this.thickness})` }
    }

    override computeBounds(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        // Shell hollows out the interior but the outer surface is child bounds + thickness/2
        return aabbExpand(b, this.thickness * 0.5)
    }
    constructor(public thickness: number, arg: Node) {
        super(arg)
    }
}

export const shell = fluent(function shell(t: number, node: Node): Shell {
    return new Shell(t, node)
})
