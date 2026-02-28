import {
    BinaryOperator,
    CompileResult,
    fluent,
    Node,
    type UnionType,
} from "../base.mjs"

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

    private get _guardThreshold(): string {
        const r = this.radius
        return r ? `max(a.x, ${r})` : `a.x`
    }

    private get _guardThresholdEx(): string {
        const r = this.radius
        return r ? `max(a.d, ${r})` : `a.d`
    }

    override compile(indentLevel = 0): CompileResult {
        if (this.rh.aabbIndex >= 0) {
            return { text: `sdf_guard_${this.id}(p)`, varName: `guard_${this.id}` }
        }
        const lhResult = this.lh.compile()
        const rhResult = this.rh.compile()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`
        return { text: this._blendEx(lhResult.text!, rhResult.text!), varName }
    }

    override compileAux(): string {
        let code = ""
        if (this.rh.aabbIndex >= 0) {
            const L = this.lh.compile().text!
            const R = this.rh.compile().text!
            const idx = this.rh.aabbIndex
            code += `\nfn sdf_guard_${this.id}(p: vec3f) -> SDFResult {\n`
            code += `    let a = ${L};\n`
            code += `    let bbox_d = subtreeAABBDist(${idx}u, p);\n`
            code += `    if (bbox_d > ${this._guardThresholdEx}) { return a; }\n`
            code += `    let b = ${R};\n`
            code += `    return ${this._blendEx("a", "b")};\n`
            code += `}\n`
        }
        return code
    }

    override compileAuxFast(): string {
        let code = ""
        if (this.rh.aabbIndex >= 0) {
            const L = this.lh.compileFast().text!
            const R = this.rh.compileFast().text!
            const idx = this.rh.aabbIndex
            code += `\nfn sdf_fast_guard_${this.id}(p: vec3f) -> vec2f {\n`
            code += `    let a = ${L};\n`
            code += `    let bbox_d = subtreeAABBDist(${idx}u, p);\n`
            code += `    if (bbox_d > ${this._guardThreshold}) { return a; }\n`
            code += `    let b = ${R};\n`
            code += `    return ${this._blendFast("a", "b")};\n`
            code += `}\n`
        }
        return code
    }

    override compileFast(indentLevel = 0): CompileResult {
        if (this.rh.aabbIndex >= 0) {
            return { text: `sdf_fast_guard_${this.id}(p)`, varName: `guard_${this.id}_f` }
        }
        const lhResult = this.lh.compileFast()
        const rhResult = this.rh.compileFast()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`
        return { text: this._blendFast(lhResult.text!, rhResult.text!), varName }
    }

    constructor(lh: import("../base.mjs").Node, rh: import("../base.mjs").Node, public radius?: number, public mode?: UnionType, public n?: number) {
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
