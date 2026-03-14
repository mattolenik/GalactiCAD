import { BinaryOperator, CompileResult, fluent, Node } from "../base.mjs"

export class Seam extends BinaryOperator {
    #seamRadius = 0
    constructor(lh: Node, rh: Node, radius = 0) {
        super(lh, rh)
        this.#seamRadius = radius
    }
    override getShapeType(): string { return "seam" }
    override getIndicatorSymbol(): string { return "⊕" }
    override getIndicatorSvg(): string {
        return `<circle cx="4" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="8" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="6" cy="6" r="1" fill="currentColor"/>`
    }
    @fluent radius(r: number): this {
        this.#seamRadius = r
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `seam_${lhResult.varName}__${rhResult.varName}`
        return { text: `sdfSeamEx(${lhResult.text}, ${rhResult.text}, ${this.#seamRadius})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `seam_${lhResult.varName}__${rhResult.varName}`
        return { text: `sdfSeamFast(${lhResult.text}, ${rhResult.text}, ${this.#seamRadius})`, varName }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const varName = `seam_${lhResult.varName}__${rhResult.varName}`
        return { text: `sdfSeamMid(${lhResult.text}, ${rhResult.text}, ${this.#seamRadius})`, varName }
    }
}

export function seam(lh: Node, rh: Node): Seam {
    return new Seam(lh, rh, 0)
}
