import { BinaryOperator, CompileResult, fluent, mergeChildPreludes, Node, type BlendMode, type IntersectionType } from "../base.mjs"
import { aabbIntersect, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { f32Wgsl } from "../scene-params.mjs"

export class Intersect extends BinaryOperator {
    override getShapeType(): string {
        return "intersect"
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="1.5"/>`
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

    private _interEx(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opIntersectionEx(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpIntersectionChamferEx(${L}, ${R}, ${rW})`
            case 'columns': return `fOpIntersectionColumnsEx(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpIntersectionStairsEx(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpIntersectionRoundEx(${L}, ${R}, ${rW})`
        }
    }

    private _interFast(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opIntersectionFast(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpIntersectionChamferFast(${L}, ${R}, ${rW})`
            case 'columns': return `fOpIntersectionColumnsFast(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpIntersectionStairsFast(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpIntersectionRoundFast(${L}, ${R}, ${rW})`
        }
    }

    private _interMid(L: string, R: string): string {
        const r = this.radius
        if (!r || r <= 0) return `opIntersectionMid(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpIntersectionChamferMid(${L}, ${R}, ${rW})`
            case 'columns': return `fOpIntersectionColumnsMid(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpIntersectionStairsMid(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpIntersectionRoundMid(${L}, ${R}, ${rW})`
        }
    }

    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `i_${lhResult.varName}__${rhResult.varName}`
        return { text: this._interEx(lText, rText), varName, prelude }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
        const varName = `i_${lhResult.varName}__${rhResult.varName}`
        return { text: this._interFast(lText, rText), varName, prelude }
    }

    protected override computeBoundsCore(): AABB | null {
        const lb = this.lh.computeBounds()
        const rb = this.rh.computeBounds()
        if (!lb) return rb
        if (!rb) return lb
        const intersection = aabbIntersect(lb, rb)
        return intersection ?? lb
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        const varName = `i_${lhResult.varName}__${rhResult.varName}`
        return { text: this._interMid(lhResult.text!, rhResult.text!), varName }
    }

    override appendStructuralFingerprint(parts: string[]): void {
        const rPos = this.radius > 0 ? "1" : "0"
        const mode = this.radius > 0 ? (this.mode ?? "round") : "-"
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}:blend:${rPos}:mode:${mode}`)
        this.lh.appendStructuralFingerprint(parts)
        this.rh.appendStructuralFingerprint(parts)
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
