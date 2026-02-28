import { BinaryOperator, CompileResult, fluent, Node } from "../base.mjs"

export class Pipe extends BinaryOperator {
    #pipeRadius = 0
    constructor(lh: import("../base.mjs").Node, rh: import("../base.mjs").Node, radius = 0) {
        super(lh, rh)
        this.#pipeRadius = radius
    }
    override getShapeType(): string { return "pipe" }
    override getIndicatorSymbol(): string { return "⊘" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="10" x2="10" y2="2" stroke="currentColor" stroke-width="1.5"/>`
    }
    @fluent radius(r: number): this {
        this.#pipeRadius = r
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `pipe_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpPipeEx(${lhResult.text}, ${rhResult.text}, ${this.#pipeRadius})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `pipe_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpPipeFast(${lhResult.text}, ${rhResult.text}, ${this.#pipeRadius})`, varName }
    }
}

export function pipe(lh: Node, rh: Node): Pipe {
    return new Pipe(lh, rh, 0)
}
