import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { Vec3, vec3 } from "../../vecmat/vector.mjs"

export class Elongate extends UnaryOperator {
    hx: number
    hy: number
    hz: number

    override getShapeType(): string { return "elongate" }
    override getIndicatorSymbol(): string { return "⟷" }
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
        return { funcName, varName, text: elongatedChild }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const h = `vec3f(${this.hx}, ${this.hy}, ${this.hz})`
        const elongatedChild = childText.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
        const funcName = `Elongate${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: elongatedChild }
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
