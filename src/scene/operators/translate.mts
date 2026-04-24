import { CompileResult, decapitalize, fluent, Node, UnaryOperator, BVH_MIN_COST } from "../base.mjs"
import { type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

/** Rigid translation: evaluate child at `p - delta` (same as primitives with `.shift`). */
export class Translate extends UnaryOperator {
    dx: number
    dy: number
    dz: number

    constructor(offset: Vec3, arg: Node) {
        super(arg)
        const v = vec3(offset)
        this.dx = v.x
        this.dy = v.y
        this.dz = v.z
    }

    override getShapeType(): string {
        return "translate"
    }
    override getIndicatorSvg(): string {
        return `<path d="M2 6 L6 2 M6 2 L6 4 M6 2 L4 2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="9" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override _computeCodegenCost(): number {
        return this.arg.codegenCost() + BVH_MIN_COST
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(3)
        this.paramCount = 3
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.dx
        view[1] = this.dy
        view[2] = this.dz
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.dx
        out.vec3[b + 1] = this.dy
        out.vec3[b + 2] = this.dz
        out.vec3[b + 3] = 0
    }

    private deltaWgsl(): string {
        return vec3Wgsl(this.paramOffset, this.previewVec3Slot)
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const d = this.deltaWgsl()
        const shifted = childText.replace(/\bp\b/g, `(p - ${d})`)
        const funcName = `Translate${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const shiftedPrelude = childResult.prelude.replace(/\bp\b/g, `(p - ${d})`)
            const accVar = childResult.varName!
            return { funcName, varName: accVar, text: accVar, prelude: shiftedPrelude }
        }

        return { funcName, varName, text: shifted }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const d = this.deltaWgsl()
        const shifted = childText.replace(/\bp\b/g, `(p - ${d})`)
        const funcName = `Translate${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const shiftedPrelude = childResult.prelude.replace(/\bp\b/g, `(p - ${d})`)
            const accVar = childResult.varName!
            return { funcName, varName: accVar, text: accVar, prelude: shiftedPrelude }
        }

        return { funcName, varName, text: shifted }
    }

    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const d = this.deltaWgsl()
        const shifted = childText.replace(/\bp\b/g, `(p - ${d})`)
        const funcName = `Translate${this.id}`
        const varName = `${decapitalize(funcName)}_m`

        if (childResult.prelude) {
            const shiftedPrelude = childResult.prelude.replace(/\bp\b/g, `(p - ${d})`)
            const accVar = childResult.varName!
            const prelude = shiftedPrelude + `${accVar} = sdfTranslateFeatureMid(${accVar}, p, ${d});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfTranslateFeatureMid(${shifted}, p, ${d})` }
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        return {
            cx: b.cx + this.dx,
            cy: b.cy + this.dy,
            cz: b.cz + this.dz,
            hx: b.hx,
            hy: b.hy,
            hz: b.hz,
        }
    }
}

export const translate = fluent(function translate(offset: Vec3, node: Node): Translate {
    return new Translate(offset, node)
})

/**
 * Default `Node.prototype.shift` — `node.shift(v)` is `translate(v, node)` (rigid move).
 * Primitives (sphere, box, …) install their own `shift` on the subclass to update `pos` in place.
 */
Node.prototype.shift = function (this: Node, v: Vec3): Translate {
    return translate(v, this)
}
