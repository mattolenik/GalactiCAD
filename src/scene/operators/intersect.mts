import { BinaryOperator, CompileResult, fluent, Node, type BlendMode, type IntersectionType } from "../base.mjs"

export class Intersect extends BinaryOperator {
    override getShapeType(): string {
        return "intersect"
    }

    override getIndicatorSymbol(): string {
        return "⊗"
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="1.5"/>`
    }

    private _interEx(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opIntersectionEx(${L}, ${R})`
        switch (this.mode) {
            case 'chamfer': return `fOpIntersectionChamferEx(${L}, ${R}, ${r})`
            case 'columns': return `fOpIntersectionColumnsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            case 'stairs': return `fOpIntersectionStairsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            default: return `fOpIntersectionRoundEx(${L}, ${R}, ${r})`
        }
    }

    private _interFast(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opIntersectionFast(${L}, ${R})`
        switch (this.mode) {
            case 'chamfer': return `fOpIntersectionChamferFast(${L}, ${R}, ${r})`
            case 'columns': return `fOpIntersectionColumnsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            case 'stairs': return `fOpIntersectionStairsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`
            default: return `fOpIntersectionRoundFast(${L}, ${R}, ${r})`
        }
    }

    override compile(indentLevel = 0): CompileResult {
        if (this.rh.aabbIndex >= 0) {
            return { text: `sdf_guard_${this.id}(p)`, varName: `guard_${this.id}` }
        }
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `i_${lhResult.varName}__${rhResult.varName}`
        return { text: this._interEx(lhResult.text!, rhResult.text!), varName }
    }

    override compileAux(): string {
        let code = ""
        if (this.rh.aabbIndex >= 0) {
            const L = this.lh.compile().text!
            const R = this.rh.compile().text!
            const idx = this.rh.aabbIndex
            code += `\nfn sdf_guard_${this.id}(p: vec3f) -> SDFResult {\n`
            code += `    let bbox_d = subtreeAABBDist(${idx}u, p);\n`
            code += `    let a = ${L};\n`
            code += `    if (bbox_d > 0.0) { return sdfTrue(max(a.d, bbox_d), a.id, a.n); }\n`
            code += `    let b = ${R};\n`
            code += `    return ${this._interEx("a", "b")};\n`
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
            code += `    let bbox_d = subtreeAABBDist(${idx}u, p);\n`
            code += `    let a = ${L};\n`
            code += `    if (bbox_d > 0.0) { return vec2f(max(a.x, bbox_d), a.y); }\n`
            code += `    let b = ${R};\n`
            code += `    return ${this._interFast("a", "b")};\n`
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
        const varName = `i_${lhResult.varName}__${rhResult.varName}`
        return { text: this._interFast(lhResult.text!, rhResult.text!), varName }
    }

    constructor(lh: Node, rh: Node, public radius = 0, public mode?: BlendMode, public n?: number) {
        super(lh, rh)
    }

    @fluent round(r: number): this {
        this.radius = r
        this.mode = 'round'
        return this
    }
    @fluent chamfer(r: number): this {
        this.radius = r
        this.mode = 'chamfer'
        return this
    }
    @fluent stairs(r: number, n?: number): this {
        this.radius = r
        this.mode = 'stairs'
        this.n = n ?? 4
        return this
    }
    @fluent columns(r: number, n?: number): this {
        this.radius = r
        this.mode = 'columns'
        this.n = n ?? 4
        return this
    }
    @fluent withMode(t: IntersectionType): this {
        this.mode = t
        return this
    }
}

export function intersect(lh: Node, rh: Node): Intersect {
    return new Intersect(lh, rh, 0)
}
