import { BinaryOperator, CompileResult, fluent, Node } from "../base.mjs"

export class Tongue extends BinaryOperator {
    ra: number
    rb: number
    constructor(lh: Node, rh: Node, ra = 0, rb = 0) {
        super(lh, rh)
        this.ra = ra
        this.rb = rb
    }
    override getShapeType(): string { return "tongue" }
    override getIndicatorSymbol(): string { return "⊞" }
    override getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="3" x2="6" y2="9" stroke="currentColor" stroke-width="1"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1"/>`
    }
    @fluent radii(ra: number, rb: number): this {
        this.ra = ra
        this.rb = rb
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpTongueEx(${lhResult.text}, ${rhResult.text}, ${this.ra}, ${this.rb})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpTongueFast(${lhResult.text}, ${rhResult.text}, ${this.ra}, ${this.rb})`, varName }
    }
}

function tongueBase(base: Node) {
    return {
        pattern(pattern: Node): Tongue {
            return new Tongue(base, pattern, 0, 0)
        },
    }
}

export const tongue = tongueBase
