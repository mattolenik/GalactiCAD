import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbExpand, type AABB } from "../aabb.mjs"
import { spF32Wgsl } from "../scene-params.mjs"

export class Offset extends UnaryOperator {
    override getShapeType(): string { return "offset" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="3" fill="currentColor"/><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.amount
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = decapitalize(funcName)
        const amt = spF32Wgsl(this.paramOffset)

        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfOffsetEx(${accVar}, ${amt});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfOffsetEx(${childResult.text}, ${amt})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const amt = spF32Wgsl(this.paramOffset)

        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfOffsetFast(${accVar}, ${amt});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfOffsetFast(${childResult.text}, ${amt})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const amt = spF32Wgsl(this.paramOffset)
        return { funcName, varName, text: `sdfOffsetMid(${childResult.text}, ${amt})` }
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
