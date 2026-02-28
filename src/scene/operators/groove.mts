import { BinaryOperator, CompileResult, fluent, Node } from "../base.mjs"

export class Groove extends BinaryOperator {
    ra: number
    rb: number
    constructor(lh: Node, rh: Node, ra = 0, rb = 0) {
        super(lh, rh)
        this.ra = ra
        this.rb = rb
    }
    override getShapeType(): string { return "groove" }
    override getIndicatorSymbol(): string { return "⊝" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }
    @fluent radii(ra: number, rb: number): this {
        this.ra = ra
        this.rb = rb
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `groove_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpGrooveEx(${lhResult.text}, ${rhResult.text}, ${this.ra}, ${this.rb})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `groove_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpGrooveFast(${lhResult.text}, ${rhResult.text}, ${this.ra}, ${this.rb})`, varName }
    }
}

function grooveBase(base: Node) {
    return {
        pattern(pattern: Node): Groove {
            return new Groove(base, pattern, 0, 0)
        },
    }
}

export const groove = grooveBase
