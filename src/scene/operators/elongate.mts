import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbExpandVec, type AABB } from "../aabb.mjs"
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
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const h = `vec3f(${this.hx}, ${this.hy}, ${this.hz})`
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
        const h = `vec3f(${this.hx}, ${this.hy}, ${this.hz})`
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
        const h = `vec3f(${this.hx}, ${this.hy}, ${this.hz})`
        const elongatedChild = childText.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
        const funcName = `Elongate${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: elongatedChild }
    }

    override computeBounds(): AABB | null {
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
