import { BinaryOperator, CompileResult, fluent, Node } from "../base.mjs"

export class Engrave extends BinaryOperator {
    #engraveRadius = 0
    constructor(lh: import("../base.mjs").Node, rh: import("../base.mjs").Node, radius = 0) {
        super(lh, rh)
        this.#engraveRadius = radius
    }
    override getShapeType(): string { return "engrave" }
    override getIndicatorSymbol(): string { return "⊜" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1"/>`
    }
    @fluent radius(r: number): this {
        this.#engraveRadius = r
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `engrave_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpEngraveEx(${lhResult.text}, ${rhResult.text}, ${this.#engraveRadius})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `engrave_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpEngraveFast(${lhResult.text}, ${rhResult.text}, ${this.#engraveRadius})`, varName }
    }
}

function engraveBase(base: Node) {
    return {
        pattern(pattern: Node): Engrave {
            return new Engrave(base, pattern, 0)
        },
    }
}

export const engrave = engraveBase
