import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbExpandVec, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { vec3Wgsl } from "../scene-params.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Elongate extends UnaryOperator {
    hx: number
    hy: number
    hz: number

    override getShapeType(): string { return "elongate" }
    override getIndicatorSvg(): string {
        return `<line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.5"/><polygon points="0,6 3,4 3,8" fill="currentColor"/><polygon points="12,6 9,4 9,8" fill="currentColor"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    protected override reserveUnarySceneParams(): void {
        this.paramOffset = this.scene.allocSceneParamFloats(3)
        this.paramCount = 3
        this.previewVec3Slot = this.scene.allocPreviewVec3(1)
    }

    override writeSceneParams(view: Float32Array): void {
        view[0] = this.hx
        view[1] = this.hy
        view[2] = this.hz
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        const b = this.previewVec3Slot * 4
        out.vec3[b] = this.hx
        out.vec3[b + 1] = this.hy
        out.vec3[b + 2] = this.hz
        out.vec3[b + 3] = 0
    }

    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const h = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        const elongatedChild = childText.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
        const funcName = `Elongate${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const elongatedPrelude = childResult.prelude.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
            return { funcName, varName: childResult.varName!, text: childResult.varName!, prelude: elongatedPrelude }
        }

        return { funcName, varName, text: elongatedChild }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const h = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        const elongatedChild = childText.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
        const funcName = `Elongate${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const elongatedPrelude = childResult.prelude.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
            return { funcName, varName: childResult.varName!, text: childResult.varName!, prelude: elongatedPrelude }
        }

        return { funcName, varName, text: elongatedChild }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const h = vec3Wgsl(this.paramOffset, this.previewVec3Slot)
        const funcName = `Elongate${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        // Mirror compileFast: rewrite `p` everywhere (text + prelude) so `var _u<id>_mid`
        // declarations evaluated at the elongated coords remain consistent with the inline
        // expression. Without the prelude propagation we get "unresolved value" errors.
        if (childResult.prelude) {
            const elongatedPrelude = childResult.prelude.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
            return { funcName, varName: childResult.varName!, text: childResult.varName!, prelude: elongatedPrelude }
        }
        return { funcName, varName, text: childText.replace(/\bp\b/g, `elongatePoint(p, ${h})`) }
    }

    protected override computeBoundsCore(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        return aabbExpandVec(b, this.hx, this.hy, this.hz)
    }
    constructor(h: Vec3, arg: Node) {
        super(arg)
        const v = vec3(h)
        this.hx = v.x
        this.hy = v.y
        this.hz = v.z
    }
}

export const elongate = fluent(function elongate(h: Vec3, node: Node): Elongate {
    return new Elongate(h, node)
})
