import { BinaryOperator, CompileResult, fluent, mergeChildPreludes, Node } from "../base.mjs"
import { spF32Wgsl } from "../scene-params.mjs"

export class Morph extends BinaryOperator {
    #morphT = 0
    constructor(t: number, lh: Node, rh: Node) {
        super(lh, rh)
        this.#morphT = t
    }
    override getShapeType(): string { return "morph" }
    override getIndicatorSvg(): string {
        return `<circle cx="3" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1"/><rect x="7" y="4" width="4" height="4" rx="0.5" fill="none" stroke="currentColor" stroke-width="1"/><line x1="5" y1="6" x2="7" y2="6" stroke="currentColor" stroke-width="1" stroke-dasharray="1,0.5"/>`
    }

    protected override reserveBinarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.#morphT
    }

    @fluent t(t: number): this {
        this.#morphT = t
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `morph_${lhResult.varName}__${rhResult.varName}`
        const mt = spF32Wgsl(this.paramOffset)
        return { text: `sdfMorphEx(${lText}, ${rText}, ${mt})`, varName, prelude }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `morph_${lhResult.varName}__${rhResult.varName}`
        const mt = spF32Wgsl(this.paramOffset)
        return { text: `sdfMorphFast(${lText}, ${rText}, ${mt})`, varName, prelude }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const varName = `morph_${lhResult.varName}__${rhResult.varName}`
        const mt = spF32Wgsl(this.paramOffset)
        return { text: `sdfMorphMid(${lhResult.text}, ${rhResult.text}, ${mt})`, varName }
    }
}

export function morph(lh: Node, rh: Node): Morph {
    return new Morph(0, lh, rh)
}
