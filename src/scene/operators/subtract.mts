import { BinaryOperator, CompileResult, fluent, Node, type BlendMode, type IntersectionType } from "../base.mjs"

export class Subtract extends BinaryOperator {
    override getShapeType(): string {
        return "subtract"
    }

    override getIndicatorSymbol(): string {
        return "⊖"
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }

    private _diffEx(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opDifferenceEx(${L}, ${R})`
        switch (this.mode) {
            case 'chamfer': return `fOpDifferenceChamferEx(${L}, ${R}, ${r})`
            case 'columns': return `fOpDifferenceColumnsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            case 'stairs': return `fOpDifferenceStairsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            default: return `fOpDifferenceRoundEx(${L}, ${R}, ${r})`
        }
    }

    private _diffFast(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opDifferenceFast(${L}, ${R})`
        switch (this.mode) {
            case 'chamfer': return `fOpDifferenceChamferFast(${L}, ${R}, ${r})`
            case 'columns': return `fOpDifferenceColumnsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            case 'stairs': return `fOpDifferenceStairsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            default: return `fOpDifferenceRoundFast(${L}, ${R}, ${r})`
        }
    }

    private get _guardThresholdFast(): string {
        const r = this.radius
        return r && r > 0 ? `${r}` : `0.0`
    }
    private get _guardThresholdEx(): string {
        return this._guardThresholdFast
    }

    override compile(indentLevel = 0): CompileResult {
        if (this.rh.aabbIndex >= 0) {
            return { text: `sdf_guard_${this.id}(p)`, varName: `guard_${this.id}` }
        }
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        return { text: this._diffEx(lhResult.text!, rhResult.text!), varName }
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
            code += `    return ${this._diffEx("a", "b")};\n`
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
            code += `    if (bbox_d > ${this._guardThresholdFast}) { return a; }\n`
            code += `    let b = ${R};\n`
            code += `    return ${this._diffFast("a", "b")};\n`
            code += `}\n`
        }
        return code
    }

    override compileFast(indentLevel = 0): CompileResult {
        if (this.rh.aabbIndex >= 0) {
            return { text: `sdf_fast_guard_${this.id}(p)`, varName: `guard_${this.id}_f` }
        }
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        return { text: this._diffFast(lhResult.text!, rhResult.text!), varName }
    }

    constructor(lh: Node, rh: Node, public radius: number = 0, public mode?: BlendMode, public n?: number) {
        super(lh, rh)
    }

    @fluent round(r: number): this {
        this.radius = r
        this.mode = 'round'
        if (this.lh instanceof Subtract) this.lh.round(r)
        return this
    }
    @fluent chamfer(r: number): this {
        this.radius = r
        this.mode = 'chamfer'
        if (this.lh instanceof Subtract) this.lh.chamfer(r)
        return this
    }
    @fluent stairs(r: number, n?: number): this {
        this.radius = r
        this.mode = 'stairs'
        this.n = n ?? 4
        if (this.lh instanceof Subtract) this.lh.stairs(r, this.n)
        return this
    }
    @fluent columns(r: number, n?: number): this {
        this.radius = r
        this.mode = 'columns'
        this.n = n ?? 4
        if (this.lh instanceof Subtract) this.lh.columns(r, this.n)
        return this
    }
    @fluent withMode(t: IntersectionType): this {
        this.mode = t
        if (this.lh instanceof Subtract) this.lh.withMode(t)
        return this
    }
}

function subtractImpl(base: Node, parts: Node[], radius?: number, mode?: BlendMode, n?: number): Subtract {
    if (parts.length < 1) {
        throw new Error("subtract requires at least one shape to subtract")
    }
    let result: Node = base
    for (const p of parts) {
        result = new Subtract(result, p, radius, mode, n)
    }
    return result as Subtract
}

export function subtract(base: Node, ...parts: Node[]): Subtract {
    return subtractImpl(base, parts)
}
