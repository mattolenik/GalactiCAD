import { BVH_MIN_COST, CompileResult, fluent, Node, type UnionType } from "../base.mjs"
import { aabbUnion, aabbExpand, type AABB } from "../aabb.mjs"
import type { PreviewParamsOut } from "../scene-params.mjs"
import { bvhCenterWgsl, bvhHalfWgsl, f32Wgsl } from "../scene-params.mjs"

type UnionVariant = "ex" | "fast" | "mid"

export class Union extends Node {
    readonly children: Node[]

    override getShapeType(): string {
        return "union"
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="3" x2="6" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }

    protected override _computePrimitiveCount(): number {
        return this.children.reduce((sum, child) => sum + child.primitiveCount(), 0)
    }

    protected override _computeCodegenCost(): number {
        return this.children.reduce((sum, child) => sum + child.codegenCost(), 0)
    }

    override writeSceneParams(view: Float32Array): void {
        if (this.paramCount >= 2) {
            view[0] = this.radius ?? 0
            view[1] = this.n ?? 4
        }
    }

    override writePreviewParams(out: PreviewParamsOut): void {
        if (this.paramCount >= 2) {
            out.f32[this.previewF32Slot] = this.radius ?? 0
            out.f32[this.previewF32Slot + 1] = this.n ?? 4
        }
    }

    override build() {
        super.build()
        if (this.radius) {
            this.paramOffset = this.scene.allocSceneParamFloats(2)
            this.paramCount = 2
            this.previewF32Slot = this.scene.allocPreviewF32(2)
        }
        for (const child of this.children) {
            child.root = this.root
            child.build()
        }
    }

    override appendStructuralFingerprint(parts: string[]): void {
        const blended = this.radius ? "1" : "0"
        const mode = this.radius ? (this.mode ?? "round") : "-"
        parts.push(
            `${this.getShapeType()}:${this.structuralBvhSlot()}:arity:${this.children.length}:blend:${blended}:mode:${mode}`,
        )
        for (const child of this.children) {
            child.appendStructuralFingerprint(parts)
        }
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.children.flatMap(child => child.getAllDescendantIds())]
    }

    private _blendEx(L: string, R: string): string {
        const r = this.radius
        if (!r) return `opUnionEx(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpUnionChamferEx(${L}, ${R}, ${rW})`
            case 'soft': return `fOpUnionSoftEx(${L}, ${R}, ${rW})`
            case 'columns': return `fOpUnionColumnsEx(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpUnionStairsEx(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpUnionRoundEx(${L}, ${R}, ${rW})`
        }
    }

    private _blendFast(L: string, R: string): string {
        const r = this.radius
        if (!r) return `opUnionFast(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpUnionChamferFast(${L}, ${R}, ${rW})`
            case 'soft': return `fOpUnionSoftFast(${L}, ${R}, ${rW})`
            case 'columns': return `fOpUnionColumnsFast(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpUnionStairsFast(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpUnionRoundFast(${L}, ${R}, ${rW})`
        }
    }

    private _blendMid(L: string, R: string): string {
        const r = this.radius
        if (!r) return `opUnionMid(${L}, ${R})`
        const rW = f32Wgsl(this.paramOffset, this.previewF32Slot)
        const nW = f32Wgsl(this.paramOffset + 1, this.previewF32Slot + 1)
        switch (this.mode) {
            case 'chamfer': return `fOpUnionChamferMid(${L}, ${R}, ${rW})`
            case 'soft': return `fOpUnionSoftMid(${L}, ${R}, ${rW})`
            case 'columns': return `fOpUnionColumnsMid(${L}, ${R}, ${rW}, ${nW})`
            case 'stairs': return `fOpUnionStairsMid(${L}, ${R}, ${rW}, ${nW})`
            default: return `fOpUnionRoundMid(${L}, ${R}, ${rW})`
        }
    }

    /**
     * Returns true if we should emit a BVH bound check for a child node.
     * Requires the child to have computable bounds and enough estimated cost to
     * make the check worth the overhead. Uses codegenCost() so expensive polygon-
     * derived and deformation nodes get guards even when primitiveCount is low.
     */
    private _shouldBound(child: Node): boolean {
        return this.scene.bvhEnabled &&
            child.codegenCost() >= BVH_MIN_COST &&
            child.computeBounds() !== null
    }

    private _resultInit(kind: UnionVariant): string {
        switch (kind) {
            case "fast":
                return "sdfFast(1e10, 1.0, 1.0)"
            case "mid":
                return "sdfRMid(1e10, 1.0, vec3f(0.0, 0.0, 1.0))"
            default:
                return "sdfTrue(1e10, 0u, vec3f(0.0))"
        }
    }

    private _distField(kind: UnionVariant): string {
        return "d"
    }

    private _blendExpr(kind: UnionVariant, left: string, right: string): string {
        switch (kind) {
            case "fast":
                return this._blendFast(left, right)
            case "mid":
                return this._blendMid(left, right)
            default:
                return this._blendEx(left, right)
        }
    }

    private _compileChildResults(kind: UnionVariant, indentLevel: number): CompileResult[] {
        switch (kind) {
            case "fast":
                return this.children.map(child => child.compileFast(indentLevel))
            case "mid":
                return this.children.map(child => child.compileMid(indentLevel))
            default:
                return this.children.map(child => child.compile(indentLevel))
        }
    }

    /**
     * Indents each line of a multi-line string by `spaces` spaces.
     */
    private _indent(code: string, spaces: number): string {
        const pad = " ".repeat(spaces)
        return code.split("\n").map(l => l.length > 0 ? pad + l : l).join("\n")
    }

    /**
     * Emit the body to evaluate a child under an optional BVH guard. The body
     * must reference the child's compiled expression via childResult.text.
     */
    private _emitChildBlock(
        child: Node,
        childResult: CompileResult,
        threshold: string,
        body: string,
    ): string {
        const childBounds = this._shouldBound(child) ? child.computeBounds() : null
        const block = (childResult.prelude ?? "") + body
        if (!childBounds || !childResult.text) {
            return block
        }
        const off = child.bvhBoundsOffset
        if (off < 0) {
            return block
        }
        const center = bvhCenterWgsl(off, child.previewBvhVec3Slot)
        const half = bvhHalfWgsl(off, child.previewBvhVec3Slot)
        const innerCode = this._indent(block, 4)
        return `if (sdBound(p, ${center}, ${half}) < ${threshold}) {\n${innerCode}}\n`
    }

    private _compileFold(kind: UnionVariant, indentLevel: number): CompileResult {
        const childResults = this._compileChildResults(kind, indentLevel)
        const accVar = `_u${this.id}_${kind}`
        const distField = this._distField(kind)
        const blendRadius = this.radius ?? 0
        const blendExtra = blendRadius > 0 ? f32Wgsl(this.paramOffset, this.previewF32Slot) : ""
        let prelude = `var ${accVar} = ${this._resultInit(kind)};\n`

        for (let i = 0; i < this.children.length; i++) {
            const childResult = childResults[i]!
            const threshold = blendRadius > 0 ? `${accVar}.${distField} + ${blendExtra}` : `${accVar}.${distField}`
            prelude += this._emitChildBlock(
                this.children[i]!,
                childResult,
                threshold,
                `${accVar} = ${this._blendExpr(kind, accVar, childResult.text!)};\n`,
            )
        }

        return { prelude, varName: accVar, text: accVar }
    }

    private _compileNearestPair(kind: UnionVariant, indentLevel: number): CompileResult {
        const childResults = this._compileChildResults(kind, indentLevel)
        const distField = this._distField(kind)
        const bestA = `_u${this.id}_${kind}_bestA`
        const bestB = `_u${this.id}_${kind}_bestB`
        const outVar = `_u${this.id}_${kind}`
        const blendRadius = this.radius ?? 0
        const blendExtra = blendRadius > 0 ? f32Wgsl(this.paramOffset, this.previewF32Slot) : ""
        let prelude =
            `var ${bestA} = ${this._resultInit(kind)};\n` +
            `var ${bestB} = ${this._resultInit(kind)};\n`

        for (let i = 0; i < this.children.length; i++) {
            const childResult = childResults[i]!
            const childVar = `_u${this.id}_${kind}_child${i}`
            const threshold = blendRadius > 0 ? `${bestB}.${distField} + ${blendExtra}` : `${bestB}.${distField}`
            prelude += `var ${childVar} = ${this._resultInit(kind)};\n`
            prelude += this._emitChildBlock(
                this.children[i]!,
                childResult,
                threshold,
                `${childVar} = ${childResult.text!};\n` +
                `if (${childVar}.${distField} < ${bestA}.${distField}) {\n` +
                `    ${bestB} = ${bestA};\n` +
                `    ${bestA} = ${childVar};\n` +
                `} else if (${childVar}.${distField} < ${bestB}.${distField}) {\n` +
                `    ${bestB} = ${childVar};\n` +
                `}\n`,
            )
        }

        prelude += `var ${outVar} = ${this._blendExpr(kind, bestA, bestB)};\n`
        return { prelude, varName: outVar, text: outVar }
    }

    private _compileVariant(kind: UnionVariant, indentLevel: number): CompileResult {
        const useNearestPair = !!this.radius && this.children.length > 2
        return useNearestPair ? this._compileNearestPair(kind, indentLevel) : this._compileFold(kind, indentLevel)
    }

    override compile(indentLevel = 0): CompileResult {
        return this._compileVariant("ex", indentLevel)
    }

    override compileFast(indentLevel = 0): CompileResult {
        return this._compileVariant("fast", indentLevel)
    }

    protected override computeBoundsCore(): AABB | null {
        let b: AABB | null = null
        for (const child of this.children) {
            const childBounds = child.computeBounds()
            if (!childBounds) continue
            b = b ? aabbUnion(b, childBounds) : childBounds
        }
        if (!b) return null
        // Inflate by blend radius so smooth union blend region is not skipped
        if (b && this.radius) b = aabbExpand(b, this.radius)
        return b
    }
    override compileMid(indentLevel = 0): CompileResult {
        return this._compileVariant("mid", indentLevel)
    }

    constructor(children: Node[], public radius?: number, public mode?: UnionType, public n?: number) {
        super()
        this.children = children
    }

    @fluent round(r: number): this {
        this.radius = r
        this.mode = 'round'
        for (const child of this.children) {
            if (child instanceof Union) child.round(r)
        }
        return this
    }
    @fluent chamfer(r: number): this {
        this.radius = r
        this.mode = 'chamfer'
        for (const child of this.children) {
            if (child instanceof Union) child.chamfer(r)
        }
        return this
    }
    @fluent soft(r: number): this {
        this.radius = r
        this.mode = 'soft'
        for (const child of this.children) {
            if (child instanceof Union) child.soft(r)
        }
        return this
    }
    @fluent stairs(r: number, n?: number): this {
        this.radius = r
        this.mode = 'stairs'
        this.n = n ?? 4
        for (const child of this.children) {
            if (child instanceof Union) child.stairs(r, this.n)
        }
        return this
    }
    @fluent columns(r: number, n?: number): this {
        this.radius = r
        this.mode = 'columns'
        this.n = n ?? 4
        for (const child of this.children) {
            if (child instanceof Union) child.columns(r, this.n)
        }
        return this
    }
    @fluent withMode(t: UnionType): this {
        this.mode = t
        for (const child of this.children) {
            if (child instanceof Union) child.withMode(t)
        }
        return this
    }
}

/**
 * Build a union node that preserves the full operand list from union(a, b, c, ...).
 * Smooth/blended unions with 3+ operands no longer left-fold through binary WGSL
 * operators; codegen can inspect all direct children at once and blend the
 * nearest contributors per sample.
 */
function unionImpl(parts: Node[], radius?: number, mode?: UnionType, n?: number): Union {
    if (parts.length < 2) {
        throw new Error("union requires at least two things to union together")
    }
    return new Union(parts, radius, mode, n)
}

export function union(...parts: Node[]): Union {
    return unionImpl(parts)
}
