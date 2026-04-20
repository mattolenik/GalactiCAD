import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbExpand, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

export class Shell extends UnaryOperator {
    override getShapeType(): string { return "shell" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="1,1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(1)
        this.paramCount = 1
        this.previewF32Slot = this.scene.allocPreviewF32(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.thickness
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        out.f32[this.previewF32Slot] = this.thickness
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = decapitalize(funcName)
        const t = f32Wgsl(this.paramOffset, this.previewF32Slot)

        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfShellEx(${accVar}, ${t});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfShellEx(${childResult.text}, ${t})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        const t = f32Wgsl(this.paramOffset, this.previewF32Slot)

        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfShellFast(${accVar}, ${t});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfShellFast(${childResult.text}, ${t})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        const t = f32Wgsl(this.paramOffset, this.previewF32Slot)
        // Propagate child prelude (no `p` rewrite — shell doesn't transform coords) so
        // intermediate `var _u<id>_mid` declarations remain visible to the inline text.
        if (childResult.prelude) {
            const accVar = childResult.varName!
            const prelude = childResult.prelude + `${accVar} = sdfShellMid(${accVar}, ${t});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }
        return { funcName, varName, text: `sdfShellMid(${childResult.text}, ${t})` }
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        return aabbExpand(b, this.thickness * 0.5)
    }
    constructor(public thickness: number, arg: Node) {
        super(arg)
    }
}

export const shell = fluent(function shell(t: number, node: Node): Shell {
    return new Shell(t, node)
})
