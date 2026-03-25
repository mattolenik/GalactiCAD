import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST } from "../base.mjs"
import type { AABB } from "../aabb.mjs"
import { spF32Wgsl } from "../scene-params.mjs"

export class Taper extends UnaryOperator {
    override getShapeType(): string { return "taper" }
    override getIndicatorSvg(): string {
        return `<polygon points="3,11 9,11 7,1 5,1" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override _computeCodegenCost(): number {
        return this.arg.codegenCost() + BVH_MIN_COST
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(2)
        this.paramCount = 2
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.ratio
        view[1] = this.height
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const o = this.paramOffset
        const ratio = spF32Wgsl(o)
        const height = spF32Wgsl(o + 1)
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${ratio}, ${height})`)
        const funcName = `Taper${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const taperedPrelude = childResult.prelude.replace(/\bp\b/g, `taperPoint(p, ${ratio}, ${height})`)
            const accVar = childResult.varName!
            const prelude = taperedPrelude + `${accVar} = sdfTaperNormal(${accVar}, p, ${ratio}, ${height});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfTaperNormal(${taperedChild}, p, ${ratio}, ${height})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const o = this.paramOffset
        const ratio = spF32Wgsl(o)
        const height = spF32Wgsl(o + 1)
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${ratio}, ${height})`)
        const funcName = `Taper${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const taperedPrelude = childResult.prelude.replace(/\bp\b/g, `taperPoint(p, ${ratio}, ${height})`)
            const accVar = childResult.varName!
            const prelude = taperedPrelude + `${accVar} = sdfTaperFast(${accVar}, p, ${ratio}, ${height});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfTaperFast(${taperedChild}, p, ${ratio}, ${height})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const o = this.paramOffset
        const ratio = spF32Wgsl(o)
        const height = spF32Wgsl(o + 1)
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${ratio}, ${height})`)
        const funcName = `Taper${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `sdfTaperNormalMid(${taperedChild}, p, ${ratio}, ${height})` }
    }

    override computeBounds(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        const maxScale = Math.max(1.0, Math.abs(this.ratio))
        return { cx: b.cx, cy: b.cy, cz: b.cz, hx: b.hx * maxScale, hy: b.hy, hz: b.hz * maxScale }
    }
    constructor(public ratio: number, public height: number, arg: Node) {
        super(arg)
    }
}

export const taper = fluent(function taper(ratio: number, height: number, node: Node): Taper {
    return new Taper(ratio, height, node)
})
