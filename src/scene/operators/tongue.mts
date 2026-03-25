import { BinaryOperator, CompileResult, fluent, mergeChildPreludes, Node } from "../base.mjs"
import { spF32Wgsl } from "../scene-params.mjs"

export class Tongue extends BinaryOperator {
    ra: number
    rb: number
    constructor(lh: Node, rh: Node, ra = 0, rb = 0) {
        super(lh, rh)
        this.ra = ra
        this.rb = rb
    }
    override getShapeType(): string { return "tongue" }
    override getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="3" x2="6" y2="9" stroke="currentColor" stroke-width="1"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1"/>`
    }

    protected override reserveBinarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(2)
        this.paramCount = 2
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.ra
        view[1] = this.rb
    }

    @fluent radii(ra: number, rb: number): this {
        this.ra = ra
        this.rb = rb
        return this
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = spF32Wgsl(o)
        const rb = spF32Wgsl(o + 1)
        return { text: `fOpTongueEx(${lText}, ${rText}, ${ra}, ${rb})`, varName, prelude }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = spF32Wgsl(o)
        const rb = spF32Wgsl(o + 1)
        return { text: `fOpTongueFast(${lText}, ${rText}, ${ra}, ${rb})`, varName, prelude }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        const o = this.paramOffset
        const ra = spF32Wgsl(o)
        const rb = spF32Wgsl(o + 1)
        return { text: `fOpTongueMid(${lhResult.text}, ${rhResult.text}, ${ra}, ${rb})`, varName }
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
