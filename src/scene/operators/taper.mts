import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"

export class Taper extends UnaryOperator {
    override getShapeType(): string { return "taper" }
    override getIndicatorSymbol(): string { return "△" }
    override getIndicatorSvg(): string {
        return `<polygon points="3,11 9,11 7,1 5,1" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
        const funcName = `Taper${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfTaperNormal(${taperedChild}, p, ${this.ratio}, ${this.height})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
        const funcName = `Taper${this.id}`
        const varName = `${decapitalize(funcName)}_f`
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
    constructor(public ratio: number, public height: number, arg: Node) {
        super(arg)
    }
}

export const taper = fluent(function taper(ratio: number, height: number, node: Node): Taper {
    return new Taper(ratio, height, node)
})
