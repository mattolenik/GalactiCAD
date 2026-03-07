import { CompileResult, decapitalize, fluent, Node, UnaryOperator } from "../base.mjs"
import { aabbExpand, type AABB } from "../aabb.mjs"

export class Twist extends UnaryOperator {
    override getShapeType(): string { return "twist" }
    override getIndicatorSymbol(): string { return "⌀" }
    override getIndicatorSvg(): string {
        return `<path d="M3,2 C9,4 3,8 9,10" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
        const funcName = `Twist${this.id}`
        const varName = decapitalize(funcName)

        if (childResult.prelude) {
            const twistedPrelude = childResult.prelude.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
            const accVar = childResult.varName!
            const prelude = twistedPrelude + `${accVar} = sdfTwistNormal(${accVar}, p, ${this.rate});\n`
            return { funcName, varName: accVar, text: accVar, prelude }
        }

        return { funcName, varName, text: `sdfTwistNormal(${twistedChild}, p, ${this.rate})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
        const funcName = `Twist${this.id}`
        const varName = `${decapitalize(funcName)}_f`

        if (childResult.prelude) {
            const twistedPrelude = childResult.prelude.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
            return { funcName, varName: childResult.varName!, text: childResult.varName!, prelude: twistedPrelude }
        }

        return { funcName, varName, text: `sdfTwistFast(${twistedChild}, p, ${this.rate})` }
    }
    override compileMid(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileMid(indentLevel)
        const childText = childResult.text!
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
        const funcName = `Twist${this.id}`
        const varName = `${decapitalize(funcName)}_m`
        return { funcName, varName, text: `sdfTwistNormalMid(${twistedChild}, p, ${this.rate})` }
    }

    override computeBounds(): AABB | null {
        const b = this.arg.computeBounds()
        if (!b) return null
        // Twist rotates XZ; the bounding cylinder radius is max(hx, hz)
        // Use circumradius as conservative bound in XZ
        const r = Math.sqrt(b.hx * b.hx + b.hz * b.hz)
        return { cx: b.cx, cy: b.cy, cz: b.cz, hx: r, hy: b.hy, hz: r }
    }
    constructor(public rate: number, arg: Node) {
        super(arg)
    }
}

export const twist = fluent(function twist(rate: number, node: Node): Twist {
    return new Twist(rate, node)
})
