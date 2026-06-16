import {
    BinaryOperator,
    binaryIsoCompileResult,
    CompileResult,
    fluent,
    Node,
    type BlendMode,
    type IntersectionType,
    type IsoSelectFn,
} from "../base.mjs"
import type { AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { bvhCenterWgsl, bvhHalfWgsl, f32Wgsl } from "../scene-params.mjs"
import type { ContourBuffer } from "../contour-buffer.mjs"
import type { FeatureGraphBuilder } from "../feature-graph-buffer.mjs"

/** Indent every non-empty line by `spaces` (cf. Union._indent). */
function indentLines(code: string, spaces: number): string {
    const pad = " ".repeat(spaces)
    return code.split("\n").map(l => (l.length > 0 ? pad + l : l)).join("\n")
}

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

    /**
     * Sharp `subtract` (lh − rh) is a hard CSG cut. Both children's contour
     * features can survive in the result:
     *
     *   - lh (the body): its contours stay on the result's outer surface
     *     except where the cutter has carved them away (SDF rejects).
     *   - rh (the cutter): its contours become the **walls of the cut**
     *     — exposed inside the body. The portion of rh outside lh has no
     *     surface in the result and is SDF-rejected.
     *
     * The default `BinaryOperator` propagation already does this; we only
     * override here to **drop** child contours when the operator is a
     * smooth blend (`radius > 0`), since the rounding destroys the sharp
     * features at the rim of the cut.
     */
    override accumulateContours(builder: ContourBuffer): void {
        if (this.radius > 0) return
        super.accumulateContours(builder)
    }

    /**
     * Sharp subtract recurses — lh contours survive on the result's outer
     * surface, rh contours become the walls of the cut. Stage 4 (survival
     * test) discards whichever portions ended up enclosed by the other
     * operand. Smooth blend rounds the rim — drop both children's features.
     */
    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        if (this.radius > 0) return
        super.accumulateFeatureGraph(builder)
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

    /**
     * The cutter (`rh`) gets an AABB skip-guard iff it was assigned a BVH bounds
     * slot. `#assignBvhBoundsSlots` only does that when `bvhEnabled` and the
     * cutter is expensive (codegenCost >= BVH_MIN_COST) and bounded — the exact
     * predicate captured in the structural fingerprint via `rh`'s own
     * `structuralBvhSlot()` — so a flipped offset always forces a full rebuild.
     */
    private _shouldBoundRh(): boolean {
        return this.rh.bvhBoundsOffset >= 0
    }

    /**
     * Emit the difference, wrapping the cutter in an AABB skip-guard when `rh`
     * qualifies. The cutter only changes the result near its surface: `sdBound`
     * is the exact AABB SDF and the cutter's shape is contained in that AABB, so
     * `sdBound(p) <= rh.d` everywhere. Hence wherever
     * `sdBound(p) >= -body.d (+ blendRadius)` we have `-rh.d <= body.d (- r)` and
     * `max(body, -rh)` (rounded by `r`) equals `body` exactly. We therefore
     * evaluate the cutter — and its own prelude — only inside that band. This is
     * provably result-identical to the un-guarded form (same contract Union
     * relies on); it just skips the per-sample cutter eval far from the cut.
     * Sibling implementation: `Union._emitChildBlock` (operators/union.mts).
     */
    private _compileGuarded(
        lhResult: CompileResult,
        rhResult: CompileResult,
        diff: (l: string, r: string) => string,
        selectFn: IsoSelectFn,
    ): CompileResult {
        if (!this._shouldBoundRh()) {
            const varName = `d_${lhResult.varName}__${rhResult.varName}`
            return binaryIsoCompileResult(this, varName, lhResult, rhResult, diff, selectFn)
        }
        const center = bvhCenterWgsl(this.rh.bvhBoundsOffset, this.rh.previewBvhVec3Slot)
        const half = bvhHalfWgsl(this.rh.bvhBoundsOffset, this.rh.previewBvhVec3Slot)
        const rText = (rhResult.prelude ? rhResult.varName ?? rhResult.text : rhResult.text)!
        const r = this.radius ?? 0
        // Distance field is `d` on every result variant (FastSDFResult / SDFResult
        // / SDFResultMid), matching Union's distField.
        const guard = (acc: string): string => {
            const threshold =
                r > 0 ? `-${acc}.d + ${f32Wgsl(this.paramOffset, this.previewF32Slot)}` : `-${acc}.d`
            const body = indentLines((rhResult.prelude ?? "") + `${acc} = ${diff(acc, rText)};\n`, 4)
            return `if (sdBound(p, ${center}, ${half}) < (${threshold})) {\n${body}}\n`
        }
        if (lhResult.prelude) {
            // The body already materialised an accumulator var — mutate it in
            // place rather than copying (cf. warpIsoResult / chained subtracts).
            const acc = lhResult.varName!
            return { varName: acc, text: acc, prelude: lhResult.prelude + guard(acc) }
        }
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        return { varName, text: varName, prelude: `var ${varName} = ${lhResult.text!};\n` + guard(varName) }
    }

    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        return this._compileGuarded(lhResult, rhResult, (l, r) => this._diffEx(l, r), "selectSDF")
    }

    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        return this._compileGuarded(lhResult, rhResult, (l, r) => this._diffFast(l, r), "selectFast")
    }

    protected override computeBoundsCore(): AABB | null {
        return this.lh.computeBounds()
    }
    override compileMid(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileMid(indentLevel)
        const rhResult = this.rh.compileMid(indentLevel)
        return this._compileGuarded(lhResult, rhResult, (l, r) => this._diffMid(l, r), "selectMid")
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
