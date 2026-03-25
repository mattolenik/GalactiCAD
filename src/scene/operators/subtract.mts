import { BinaryOperator, CompileResult, fluent, mergeChildPreludes, Node, type BlendMode, type IntersectionType } from "../base.mjs"
import type { AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

export class Subtract extends BinaryOperator {
    override getShapeType(): string {
        return "subtract"
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }

    protected override reserveBinarySceneParams(): void {
        if (this.radius > 0) {
            this.paramOffset = this.scene.allocSceneParamFloats(2)
            this.paramCount = 2
            this.previewF32Slot = this.scene.allocPreviewF32(2)
        }
    }

    override writeSceneParams(view: Float32Array): void {
        if (this.paramCount >= 2) {
            view[0] = this.radius
            view[1] = this.n ?? 4
        }
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        if (this.paramCount >= 2) {
            out.f32[this.previewF32Slot] = this.radius
            out.f32[this.previewF32Slot + 1] = this.n ?? 4
        }
    }

    private _diffEx(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opDifferenceEx(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpDifferenceChamferEx(${L}, ${R}, ${rW})`
            case 'columns': return `fOpDifferenceColumnsEx(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpDifferenceStairsEx(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpDifferenceRoundEx(${L}, ${R}, ${rW})`
        }
    }

    private _diffFast(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opDifferenceFast(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpDifferenceChamferFast(${L}, ${R}, ${rW})`
            case 'columns': return `fOpDifferenceColumnsFast(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpDifferenceStairsFast(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpDifferenceRoundFast(${L}, ${R}, ${rW})`
        }
    }

    private _diffMid(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opDifferenceMid(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpDifferenceChamferMid(${L}, ${R}, ${rW})`
            case 'columns': return `fOpDifferenceColumnsMid(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpDifferenceStairsMid(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpDifferenceRoundMid(${L}, ${R}, ${rW})`
        }
    }

    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        return { text: this._diffEx(lText, rText), varName, prelude }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        return { text: this._diffFast(lText, rText), varName, prelude }
    }

    override computeBounds(): AABB | null {
        return this.lh.computeBounds()
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        return { text: this._diffMid(lhResult.text!, rhResult.text!), varName }
    }

    override appendStructuralFingerprint(parts: string[]): void {
        const rPos = this.radius > 0 ? "1" : "0"
        const mode = this.radius > 0 ? (this.mode ?? "round") : "-"
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}:blend:${rPos}:mode:${mode}`)
        this.lh.appendStructuralFingerprint(parts)
        this.rh.appendStructuralFingerprint(parts)
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
