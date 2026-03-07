import { BinaryOperator, CompileResult, fluent, Node, type UnionType } from "../base.mjs"
import { aabbUnion, aabbExpand, aabbCenterWgsl, aabbHalfWgsl, type AABB } from "../aabb.mjs"

// Minimum primitive count for a child to get a BVH bounding check.
// The sdBound() call + branch overhead costs roughly as much as evaluating
// ~8 cheap primitives, so only guard subtrees larger than this threshold.
const BVH_MIN_PRIMITIVES = 8

export class Union extends BinaryOperator {
    override getShapeType(): string {
        return "union"
    }

    override getIndicatorSymbol(): string {
        return "⊕"
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="3" x2="6" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }

    private _blendEx(L: string, R: string): string {
        const r = this.radius
        if (!r) return `opUnionEx(${L}, ${R})`
        switch (this.mode) {
            case 'chamfer': return `fOpUnionChamferEx(${L}, ${R}, ${r})`
            case 'soft': return `fOpUnionSoftEx(${L}, ${R}, ${r})`
            case 'columns': return `fOpUnionColumnsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            case 'stairs': return `fOpUnionStairsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            default: return `fOpUnionRoundEx(${L}, ${R}, ${r})`
        }
    }

    private _blendFast(L: string, R: string): string {
        const r = this.radius
        if (!r) return `opUnionFast(${L}, ${R})`
        switch (this.mode) {
            case 'chamfer': return `fOpUnionChamferFast(${L}, ${R}, ${r})`
            case 'soft': return `fOpUnionSoftFast(${L}, ${R}, ${r})`
            case 'columns': return `fOpUnionColumnsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            case 'stairs': return `fOpUnionStairsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            default: return `fOpUnionRoundFast(${L}, ${R}, ${r})`
        }
    }

    private _blendMid(L: string, R: string): string {
        const r = this.radius
        if (!r) return `opUnionMid(${L}, ${R})`
        switch (this.mode) {
            case 'chamfer': return `fOpUnionChamferMid(${L}, ${R}, ${r})`
            case 'soft': return `fOpUnionSoftMid(${L}, ${R}, ${r})`
            case 'columns': return `fOpUnionColumnsMid(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            case 'stairs': return `fOpUnionStairsMid(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            default: return `fOpUnionRoundMid(${L}, ${R}, ${r})`
        }
    }

    /**
     * Returns true if we should emit a BVH bound check for a child node.
     * Requires the child to have computable bounds and enough primitives to
     * make the check worth the overhead. Also requires BVH to be enabled globally.
     */
    private _shouldBound(child: Node): boolean {
        return this.scene.bvhEnabled &&
            child.primitiveCount() >= BVH_MIN_PRIMITIVES &&
            child.computeBounds() !== null
    }

    /**
     * Indents each line of a multi-line string by `spaces` spaces.
     */
    private _indent(code: string, spaces: number): string {
        const pad = " ".repeat(spaces)
        return code.split("\n").map(l => l.length > 0 ? pad + l : l).join("\n")
    }

    /**
     * Emit the body to evaluate a child and union it into the accumulator `accVar`.
     * If the child has a prelude (is itself a BVH union), we embed it.
     * `mergeExpr(acc, child)` is the WGSL merge expression (opUnionFast or opUnionEx).
     */
    private _emitChildContrib(
        childResult: CompileResult,
        accVar: string,
        accDistField: string,
        mergeExprFn: (acc: string, child: string) => string,
        childBounds: AABB | null,
    ): string {
        if (!childBounds || !childResult.text) {
            // No bounds or no expression: always evaluate
            if (childResult.prelude) {
                return childResult.prelude + `${accVar} = ${mergeExprFn(accVar, childResult.text!)};\n`
            }
            return `${accVar} = ${mergeExprFn(accVar, childResult.text!)};\n`
        }

        const center = aabbCenterWgsl(childBounds)
        const half = aabbHalfWgsl(childBounds)
        if (childResult.prelude) {
            // Child has its own prelude; embed inside our bound check
            const innerCode = this._indent(
                childResult.prelude + `${accVar} = ${mergeExprFn(accVar, childResult.text!)};\n`,
                4
            )
            return `if (sdBound(p, ${center}, ${half}) < ${accVar}.${accDistField}) {\n${innerCode}}\n`
        } else {
            return `if (sdBound(p, ${center}, ${half}) < ${accVar}.${accDistField}) { ${accVar} = ${mergeExprFn(accVar, childResult.text!)}; }\n`
        }
    }

    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile()
        const rhResult = this.rh.compile()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`

        const lhBounds = this._shouldBound(this.lh) ? this.lh.computeBounds() : null
        const rhBounds = this._shouldBound(this.rh) ? this.rh.computeBounds() : null

        // Only emit BVH accumulator if at least one direct child gets a bound check.
        // If neither child qualifies but one has a prelude, pass the prelude through
        // without wrapping in an unnecessary accumulator.
        if (!lhBounds && !rhBounds) {
            const prelude = [lhResult.prelude, rhResult.prelude].filter(Boolean).join("") || undefined
            return { text: this._blendEx(lhResult.text!, rhResult.text!), varName, prelude }
        }

        const accVar = `_u${this.id}ex`
        let prelude = `var ${accVar} = sdfTrue(1e10, 0u, vec3f(0.0));\n`

        prelude += this._emitChildContrib(lhResult, accVar, "d",
            (acc, child) => this._blendEx(acc, child), lhBounds)
        prelude += this._emitChildContrib(rhResult, accVar, "d",
            (acc, child) => this._blendEx(acc, child), rhBounds)

        return { prelude, varName: accVar, text: accVar }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast()
        const rhResult = this.rh.compileFast()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`

        const lhBounds = this._shouldBound(this.lh) ? this.lh.computeBounds() : null
        const rhBounds = this._shouldBound(this.rh) ? this.rh.computeBounds() : null

        // Only emit BVH accumulator if at least one direct child gets a bound check.
        if (!lhBounds && !rhBounds) {
            const prelude = [lhResult.prelude, rhResult.prelude].filter(Boolean).join("") || undefined
            return { text: this._blendFast(lhResult.text!, rhResult.text!), varName, prelude }
        }

        const accVar = `_u${this.id}`
        let prelude = `var ${accVar} = vec2f(1e10, 1.0);\n`

        prelude += this._emitChildContrib(lhResult, accVar, "x",
            (acc, child) => this._blendFast(acc, child), lhBounds)
        prelude += this._emitChildContrib(rhResult, accVar, "x",
            (acc, child) => this._blendFast(acc, child), rhBounds)

        return { prelude, varName: accVar, text: accVar }
    }

    override computeBounds(): AABB | null {
        const lb = this.lh.computeBounds()
        const rb = this.rh.computeBounds()
        let b: AABB | null = null
        if (!lb && !rb) return null
        if (!lb) b = rb
        else if (!rb) b = lb
        else b = aabbUnion(lb, rb)
        // Inflate by blend radius so smooth union blend region is not skipped
        if (b && this.radius) b = aabbExpand(b, this.radius)
        return b
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid()
        const rhResult = this.rh.compileMid()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`
        return { text: this._blendMid(lhResult.text!, rhResult.text!), varName }
    }

    constructor(lh: Node, rh: Node, public radius?: number, public mode?: UnionType, public n?: number) {
        super(lh, rh)
    }

    @fluent round(r: number): this {
        this.radius = r
        this.mode = 'round'
        if (this.lh instanceof Union) this.lh.round(r)
        if (this.rh instanceof Union) this.rh.round(r)
        return this
    }
    @fluent chamfer(r: number): this {
        this.radius = r
        this.mode = 'chamfer'
        if (this.lh instanceof Union) this.lh.chamfer(r)
        if (this.rh instanceof Union) this.rh.chamfer(r)
        return this
    }
    @fluent soft(r: number): this {
        this.radius = r
        this.mode = 'soft'
        if (this.lh instanceof Union) this.lh.soft(r)
        if (this.rh instanceof Union) this.rh.soft(r)
        return this
    }
    @fluent stairs(r: number, n?: number): this {
        this.radius = r
        this.mode = 'stairs'
        this.n = n ?? 4
        if (this.lh instanceof Union) this.lh.stairs(r, this.n)
        if (this.rh instanceof Union) this.rh.stairs(r, this.n)
        return this
    }
    @fluent columns(r: number, n?: number): this {
        this.radius = r
        this.mode = 'columns'
        this.n = n ?? 4
        if (this.lh instanceof Union) this.lh.columns(r, this.n)
        if (this.rh instanceof Union) this.rh.columns(r, this.n)
        return this
    }
    @fluent withMode(t: UnionType): this {
        this.mode = t
        if (this.lh instanceof Union) this.lh.withMode(t)
        if (this.rh instanceof Union) this.rh.withMode(t)
        return this
    }
}

function unionImpl(parts: Node[], radius?: number, mode?: UnionType, n?: number): Union {
    if (parts.length < 2) {
        throw new Error("union requires at least two things to union together")
    }
    const args = [...parts]
    while (args.length > 1) {
        args.push(new Union(args.pop()!, args.pop()!, radius, mode, n))
    }
    const result = args[0] as Union
    if (!(result instanceof Union)) throw new Error("unexpected type during union stacking")
    return result
}

export function union(...parts: Node[]): Union {
    return unionImpl(parts)
}
