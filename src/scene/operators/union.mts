import { BinaryOperator, CompileResult, fluent, Node, type UnionType } from "../base.mjs"

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

    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile()
        const rhResult = this.rh.compile()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`
        return { text: this._blendEx(lhResult.text!, rhResult.text!), varName }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast()
        const rhResult = this.rh.compileFast()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`
        return { text: this._blendFast(lhResult.text!, rhResult.text!), varName }
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
