import { Vec3, Vec3f, vec3 } from "../vecmat/vector.mjs"
import type { PreviewParamsOut } from "./scene-params.mjs"
import { compileParamMode, mat3x3Wgsl, packMat3ColumnMajorToPreviewOut } from "./scene-params.mjs"
import { composeEuler, eulerMatrices } from "./transform-math.mjs"
import type { AABB } from "./aabb.mjs"
import { aabbUnion } from "./aabb.mjs"
import type { ContourBuffer } from "./contour-buffer.mjs"
import type { FeatureGraphBuilder } from "./feature-graph-buffer.mjs"

export type CompileResult = {
    funcName?: string
    varName?: string
    text?: string
    /**
     * Optional WGSL statements that must precede the expression in `text`.
     * Used by BVH-guarded union code generation: the prelude declares an
     * accumulator variable and emits bounding-checked if-blocks for each
     * child, so the parent can use the accumulator varName as its expression.
     */
    prelude?: string
}

/** Style-related info for editor highlighting (fluent method names, etc.). */
export interface StyleInfo {
    FluentMethods: Set<string>
}

export const styleInfo: StyleInfo = {
    FluentMethods: new Set<string>(),
}

/** Marks a class method as a fluent API method for editor highlighting. */
export function fluent(_target: Function, _context: ClassMethodDecoratorContext): void
/** Wraps a standalone function and registers its name for editor highlighting. */
export function fluent<T extends (...args: any[]) => any>(fn: T): T
export function fluent<T extends (...args: any[]) => any>(
    targetOrFn: T | Function,
    context?: ClassMethodDecoratorContext
): T | void {
    if (context !== undefined) {
        styleInfo.FluentMethods.add(String(context.name))
        return
    }
    const fn = targetOrFn as T
    styleInfo.FluentMethods.add(fn.name)
    return fn
}

/** Minimal interface for SceneInfo to avoid circular imports. */
export interface ISceneInfo {
    add(node: Node): void
    get<T extends Node>(id: number): T
    getAllNodes(): Node[]
    /** Reserve `count` consecutive f32 slots in the packed scene param buffer; returns the start index. */
    allocSceneParamFloats(count: number): number
    /** Preview uniform bank: scalar slots (see `SceneInfo.allocPreviewF32`). */
    allocPreviewF32(count: number): number
    allocPreviewVec2(count: number): number
    /** vec3 stored as vec4; returns first slot index. */
    allocPreviewVec3(count: number): number
    allocPreviewMat3(count: number): number
    /** Total f32 slots reserved after `build()` (size of the packed CPU/GPU upload). */
    readonly sceneParamFloatCount: number
    /** Fingerprint fragment for preview bank sizes (param-only vs full rebuild). */
    readonly previewParamFingerprint: string
    allocPolygonVertices(count: number): number
    /** Whether to emit BVH bounding checks during code generation. */
    bvhEnabled: boolean
    /**
     * Per-SceneInfo memoization for `computeBounds()` (one result per node per scene build).
     * Implemented by `SceneInfo`; absent for standalone node tests.
     */
    getOrComputeBoundsForNode?(node: Node, compute: () => AABB | null): AABB | null
}

/** Cost of one cheap primitive (e.g. sphere, box) for BVH heuristics. */
export const COST_ONE_PRIMITIVE = 1

/** Minimum codegen cost for a subtree to warrant a BVH bounding check. */
export const BVH_MIN_COST = 8

let nodeCloneImpl: ((node: Node) => Node) | undefined

/** Wired by `node-clone.mjs` when the scene module loads. */
export function setNodeCloneImpl(impl: (node: Node) => Node): void {
    nodeCloneImpl = impl
}

export class Node {
    id!: number
    root: Node
    #scene!: ISceneInfo
    #primitiveCount = -1
    #codegenCost = -1
    /** Start index into `SceneInfo.packSceneParams()` (bounds + MDC storage uploads); valid when `paramCount > 0`. */
    paramOffset = 0
    /** Number of consecutive f32 slots owned by this node (`0` = none). */
    paramCount = 0
    /**
     * Base f32 index into `packSceneParams()` for this node's BVH AABB (center xyz, half xyz), or `-1` if unused.
     * Assigned after `build()` for nodes that qualify when `bvhEnabled` is on (see `SceneInfo`).
     */
    bvhBoundsOffset = -1
    /**
     * First logical vec3 slot in `previewParamsVec3` for this node's BVH AABB (center, then half extents), or `-1`.
     * Mirrors `bvhBoundsOffset` when BVH guards are active; used by preview/beam WGSL only.
     */
    previewBvhVec3Slot = -1
    /** First slot in preview `f32` uniform bank for this node's scalars; `-1` if none. */
    previewF32Slot = -1
    previewVec2Slot = -1
    previewVec3Slot = -1
    /** First index in `previewParamsMat3` for this node's matrices; `-1` if none. */
    previewMat3Slot = -1

    /**
     * Local rotation (Euler degrees) applied about this node's own origin BEFORE
     * `pos`, for primitives that opt in via {@link reservePrimitiveRot}. Identity
     * default. Always-present (slot reserved unconditionally) so the gizmo can
     * edit it param-only — no shader recompile, no node added.
     */
    rot: Vec3f = vec3(0, 0, 0)
    /** Preview `mat3` slot holding `rot`'s inverse matrix, or -1 if rot isn't supported. */
    rotPreviewMat3Slot = -1
    /** Scene-param (storage) f32 offset for `rot`'s inverse (9 floats), or -1. */
    rotParamOffset = -1
    /**
     * Set once `.shift` has been applied. Gates a rot-supporting primitive's
     * `.rotate`: pre-shift composes onto the local `rot` field (rotate about the
     * node's own center, param-only/live); post-shift falls back to a `Rotate`
     * operator (the shift becomes the pivot). Mirrors the chain-order semantics
     * `Box` established, shared by every primitive that opts into a `rot` field.
     */
    protected shifted = false

    /** Reserve always-present rotation slots (preview mat3 + 9 storage floats for
     * the inverse). Call from a primitive's `build()` AFTER its own
     * `allocSceneParamFloats`, so the rot floats are contiguous and covered by
     * `paramCount`. */
    protected reservePrimitiveRot(): void {
        this.rotParamOffset = this.scene.allocSceneParamFloats(9)
        this.paramCount += 9
        this.rotPreviewMat3Slot = this.scene.allocPreviewMat3(1)
    }

    /** Compose an additional body-frame rotation (Euler deg) onto this node's
     * local `rot` field — the shared pre-shift `.rotate` behavior for primitives
     * that opt into a `rot` field (matches `Box.rotate`'s composition). */
    protected composeLocalRot(r: Vec3f): void {
        const c = composeEuler([this.rot.x, this.rot.y, this.rot.z], [r.x, r.y, r.z])
        this.rot = vec3(c[0], c[1], c[2])
    }

    /** Write `rot`'s inverse matrix into the preview mat3 bank. */
    protected writeRotPreview(out: PreviewParamsOut): void {
        if (this.rotPreviewMat3Slot < 0) return
        const { inv } = eulerMatrices(this.rot.x, this.rot.y, this.rot.z)
        packMat3ColumnMajorToPreviewOut(out.mat3, this.rotPreviewMat3Slot, new Float32Array(inv))
    }

    /** Write `rot`'s inverse matrix (9 floats) into a scene-param slice at `offset`. */
    protected writeRotScene(view: Float32Array, offset: number): void {
        if (this.rotParamOffset < 0) return
        const { inv } = eulerMatrices(this.rot.x, this.rot.y, this.rot.z)
        view.set(inv, offset)
    }

    /** Wrap an emitted SDF expression so the sample point is rotated about `pos`
     * by `rot` before the primitive evaluates: `p → invRot·(p − pos) + pos`.
     * Unconditional (always emits the matrix read) so changing `rot` stays
     * param-only. No-op for nodes without rot support. */
    protected warpRot(text: string, posExpr: string): string {
        if (this.rotPreviewMat3Slot < 0) return text
        const invMat = mat3x3Wgsl(this.rotParamOffset, this.rotPreviewMat3Slot)
        return text.replace(/\bp\b/g, `(${invMat} * (p - ${posExpr}) + ${posExpr})`)
    }

    get scene() {
        return this.root.#scene
    }
    set scene(si: ISceneInfo) {
        this.root.#scene = si
    }

    constructor() {
        this.root = this
    }

    /**
     * Deep-clone this node and its entire subtree (new objects, no shared child refs).
     * Build-time fields (`id`, param offsets, polygon `bufferOffset`, …) are cleared; call under a fresh `SceneInfo` to assign them.
     * Requires the scene bundle to have loaded once (imports `node-clone.mjs`).
     */
    clone(): Node {
        if (!nodeCloneImpl) {
            throw new Error(
                "Node.clone() is unavailable until the scene module loads. Import \"./scene/scene.mjs\" (or the app entry that pulls it in) before calling clone().",
            )
        }
        return nodeCloneImpl(this)
    }

    primitiveCount(): number {
        if (this.#primitiveCount < 0) {
            this.#primitiveCount = this._computePrimitiveCount()
        }
        return this.#primitiveCount
    }

    protected _computePrimitiveCount(): number {
        return 1
    }

    /**
     * Estimated shader evaluation cost for codegen heuristics (e.g. BVH gating).
     * Separate from primitiveCount; expensive polygon-derived or deformation nodes
     * score higher so they get BVH guards even when primitiveCount is low.
     */
    codegenCost(): number {
        if (this.#codegenCost < 0) {
            this.#codegenCost = this._computeCodegenCost()
        }
        return this.#codegenCost
    }

    protected _computeCodegenCost(): number {
        return COST_ONE_PRIMITIVE
    }

    getShapeType(): string {
        return "node"
    }

    /**
     * Whether this node represents real 3D geometry that can stand alone as an
     * isolation root. Virtual / 2D nodes (polygon2d, extrude/rod caps) have no
     * standalone SDF, so they override this to `false`; isolating one resolves to
     * its nearest isolatable ancestor instead (see `SceneInfo.isolationRoot`).
     */
    get isIsolatable(): boolean {
        return true
    }

    getIndicatorSymbol(): string {
        return "●"
    }

    getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="3" fill="currentColor"/>`
    }

    getAllDescendantIds(): number[] {
        return [this.id]
    }

    compileAux(): string {
        return ""
    }

    compileAuxFast(): string {
        return ""
    }

    compileAuxMid(): string {
        return ""
    }

    /**
     * Compute a conservative axis-aligned bounding box for this node.
     * Returns null for unbounded primitives (e.g. Plane).
     * When the node is part of a `SceneInfo` graph, results are memoized once per build.
     */
    computeBounds(): AABB | null {
        const g = this.scene.getOrComputeBoundsForNode
        if (g) {
            return g.call(this.scene, this, () => this.computeBoundsCore())
        }
        return this.computeBoundsCore()
    }

    /** Uncached bounds body; use `computeBounds()` from outside the class. */
    protected computeBoundsCore(): AABB | null {
        return null
    }

    compile(_indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }

    compileFast(_indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }

    /**
     * MDC/export SDF variant. Implementations must mirror `compile()`'s spatial
     * warp, use the corresponding WGSL `*Mid` transform wrapper for normals and
     * feature payloads, and stamp leaf owners with `sdfMidSetOwner`.
     * Smooth/blended operators should only preserve feature payloads when the
     * feature remains geometrically meaningful for the generated surface.
     */
    compileMid(_indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }

    /** Write this node's `paramCount` floats into `view` (a subarray at `paramOffset` of the full pack). */
    writeSceneParams(_view: Float32Array): void { }

    /** Pack preview uniform banks (orthogonal to `writeSceneParams`, which feeds bounds/MDC storage). */
    writePreviewParams(_out: PreviewParamsOut): void { }

    build() {
        this.scene.add(this)
    }

    getBase(): Node {
        return this
    }

    /**
     * Whether this node receives a BVH `sdBound` slot when `scene.bvhEnabled` is on — must match
     * `SceneInfo` bounds assignment (`codegenCost` threshold and `computeBounds()` present).
     */
    protected structuralBvhSlot(): "0" | "1" {
        return this.scene.bvhEnabled && this.codegenCost() >= BVH_MIN_COST && this.computeBounds() !== null
            ? "1"
            : "0"
    }

    /**
     * DFS in the same order as `build()`: type, discretized shape selectors, then children.
     * Used for structural fingerprinting (param-only vs full shader rebuild).
     */
    appendStructuralFingerprint(parts: string[]): void {
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}`)
    }

    /**
     * Contribute this node's **explicit contour features** (corners, edges,
     * cap rings, etc.) into `builder`, in **world-space** coordinates.
     *
     * SHREC's MergeSharp pass uses these as snap targets to produce
     * crisp edges/corners that gradient-only QEF reconstruction cannot
     * achieve. The base implementation is a no-op:
     *
     *   - **Smooth primitives** (sphere, capsule, torus, smooth blends):
     *     no contours by definition; default no-op is correct.
     *   - **Operators that destroy sharp features** (`round`, `soft`,
     *     `chamfer`, smooth mixes): override to no-op (drops child
     *     contours intentionally).
     *   - **Hard CSG operators** (`union`, `intersection`, `difference`):
     *     recurse into children; **do not** synthesise CSG-seam contours
     *     here — those are handled by the SDF-driven path in MergeSharp.
     *   - **Transformations** (`translate`, `rotate`, `scale`): compose
     *     the transform into the recursion (TODO once Box ships and the
     *     wiring is exercised).
     *   - **Primitives with explicit features** (box, cylinder, extrude,
     *     etc.): `builder.beginNode(this.id)`, emit segments / points /
     *     rings, `builder.endNode()`.
     *
     * Per the indices-not-data design: nodes write into the shared
     * `builder` rather than constructing their own contour objects. The
     * shared buffer's per-node ranges keep each node's contributions
     * addressable by id.
     */
    accumulateContours(_builder: ContourBuffer): void {
        // Default: no contours. Overridden per-primitive and per-operator.
    }

    /**
     * Contribute this node's **explicit feature graph** (vertices, edges, cap
     * loops, with classifications and source-face normals) into `builder`, in
     * **local space**. The builder owns the transform stack: affine transforms
     * (`Translate`, `Rotate`, `Scale`) push their 4x4 onto the stack before
     * recursing; non-affine warps (`Twist`, `Bend`, `Taper`) push an
     * `nonAffine` marker so emitters can skip emission in that subtree.
     *
     * Stages 2–5 of the feature-aware meshing pipeline consume the resulting
     * snapshot (see [feature-graph-buffer.mts](./feature-graph-buffer.mts)).
     * Distinct from {@link accumulateContours} — that path is SHREC-specific,
     * world-space, and lossy in the dimensions a feature-aware mesher needs
     * (no normals, no caps, no transform chain).
     *
     * Default is a no-op. Override on primitives that carry explicit features
     * (Box, Extrude, etc.) and on operators that need to manage the transform
     * stack or drop child features on smooth blends.
     */
    accumulateFeatureGraph(_builder: FeatureGraphBuilder): void {
        // Default: nothing. Phase A leaves all primitives as no-op so the
        // plumbing can be exercised end-to-end before any extractor lands.
    }
}

export abstract class UnaryOperator extends Node {
    override getBase(): Node {
        return this.arg.getBase()
    }
    protected override _computePrimitiveCount(): number {
        return this.arg.primitiveCount()
    }
    protected override _computeCodegenCost(): number {
        return this.arg.codegenCost()
    }
    protected override computeBoundsCore(): AABB | null {
        return this.arg.computeBounds()
    }
    /** Reserve `paramOffset` / `paramCount` after this node is registered; runs before the child subtree `build()`. */
    protected reserveUnarySceneParams(): void { }
    override build() {
        super.build()
        this.reserveUnarySceneParams()
        this.arg.root = this.root
        this.arg.build()
    }
    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}`)
        this.arg.appendStructuralFingerprint(parts)
    }
    /**
     * Default: pass-through — child contours propagate unchanged. Operators
     * that destroy sharp features (`round`, `soft`, etc.) override this to
     * a no-op; transform operators override to apply their transform first.
     */
    override accumulateContours(builder: ContourBuffer): void {
        this.arg.accumulateContours(builder)
    }
    /**
     * Default: pass through to the child. Transform operators (`Translate`,
     * `Rotate`, `Scale`) override to push their 4x4 around the recurse; warps
     * override to push a non-affine frame; feature-destroying operators
     * (`Shell`, `Offset`, etc.) override to a no-op.
     */
    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        this.arg.accumulateFeatureGraph(builder)
    }
    constructor(public arg: Node) {
        super()
    }
}

export abstract class BinaryOperator extends Node {
    protected override _computePrimitiveCount(): number {
        return this.lh.primitiveCount() + this.rh.primitiveCount()
    }
    protected override _computeCodegenCost(): number {
        return this.lh.codegenCost() + this.rh.codegenCost()
    }
    protected override computeBoundsCore(): AABB | null {
        const lb = this.lh.computeBounds()
        const rb = this.rh.computeBounds()
        if (!lb && !rb) return null
        if (!lb) return rb
        if (!rb) return lb
        return aabbUnion(lb, rb)
    }
    /** Reserve `paramOffset` / `paramCount` after this node is registered; runs before left/right subtree `build()`. */
    protected reserveBinarySceneParams(): void { }
    override build() {
        super.build()
        this.reserveBinarySceneParams()
        this.lh.root = this.root
        this.rh.root = this.root
        this.lh.build()
        this.rh.build()
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.lh.getAllDescendantIds(), ...this.rh.getAllDescendantIds()]
    }
    override appendStructuralFingerprint(parts: string[]): void {
        parts.push(`${this.getShapeType()}:${this.structuralBvhSlot()}`)
        this.lh.appendStructuralFingerprint(parts)
        this.rh.appendStructuralFingerprint(parts)
    }
    /**
     * Default: hard-CSG passthrough — propagate both children's contours.
     * Per the design instruction, we do not synthesise CSG-seam contours
     * here; that path is handled SDF-side by MergeSharp's seam-tangent
     * solve. Smooth/blend operators (`smoothUnion`, `mix`, etc.) override
     * this to a no-op, dropping child contours.
     */
    override accumulateContours(builder: ContourBuffer): void {
        this.lh.accumulateContours(builder)
        this.rh.accumulateContours(builder)
    }
    /**
     * Default: hard-CSG passthrough — propagate both children's features.
     * Smooth/blend operators (`Subtract`, `Intersect` with `radius > 0`) drop
     * child features at the join; `Engrave`, `Groove`, etc. override to a
     * conservative no-op pending feature-preservation analysis.
     */
    override accumulateFeatureGraph(builder: FeatureGraphBuilder): void {
        this.lh.accumulateFeatureGraph(builder)
        this.rh.accumulateFeatureGraph(builder)
    }
    constructor(public lh: Node, public rh: Node) {
        super()
    }
}

/**
 * Merge the preludes of two child CompileResults and return the combined
 * prelude string along with each child's expression text. When a child has a
 * prelude, prefer `varName` (the accumulator or assigned result) over `text`.
 *
 * Usage in a binary operator that cannot emit its own prelude logic:
 *   const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
 *   return { text: `someOp(${lText}, ${rText})`, varName, prelude }
 */
export function mergeChildPreludes(
    lh: CompileResult,
    rh: CompileResult,
): { prelude: string | undefined; lText: string; rText: string } {
    const lText = (lh.prelude ? lh.varName ?? lh.text : lh.text)!
    const rText = (rh.prelude ? rh.varName ?? rh.text : rh.text)!
    const combined = [lh.prelude, rh.prelude].filter(Boolean).join("")
    return { prelude: combined || undefined, lText, rText }
}

/**
 * Binary ops evaluate to `expr`. When either child emitted a prelude, append
 * `var varName = expr` so `SceneInfo.compile*` can `return varName` and parents
 * (e.g. BVH unions) can reference a single identifier after the prelude runs.
 */
export function binaryOpCompileResult(
    varName: string,
    expr: string,
    mergedPrelude: string | undefined,
): CompileResult {
    if (mergedPrelude) {
        return {
            varName,
            text: varName,
            prelude: mergedPrelude + `var ${varName} = ${expr};\n`,
        }
    }
    return { varName, text: expr, prelude: undefined }
}

// ---------------------------------------------------------------------------
// Isolate-view ("View Isolated") operator result helpers.
//
// Isolation is implemented by RECOMPILING the preview SDF from the isolated
// subtree(s) as root (see `SceneInfo.isolationRoot` + the worker's
// `recompileIsolation`), NOT by carrying render-time pass-through scaffolding in
// the live SDF. So these helpers emit the plain combine/wrap — no `viewSettings`
// reads, no per-operator selects, nothing for the GPU to branch on. The `op` /
// `selectFn` params are retained only so the ~22 operator call sites stay
// unchanged; `IsoSelectFn` is likewise kept for those call sites' literal args.
// ---------------------------------------------------------------------------

export type IsoSelectFn = "selectSDF" | "selectFast" | "selectMid"

/**
 * Build the final CompileResult for a binary operator. `combine(l, r)` builds the
 * op expression from two child expression strings (`op`/`selectFn` are retained
 * for the call-site signature; isolation is handled by recompiling from root).
 */
export function binaryIsoCompileResult(
    op: BinaryOperator,
    varName: string,
    lhResult: CompileResult,
    rhResult: CompileResult,
    combine: (l: string, r: string) => string,
    selectFn: IsoSelectFn,
): CompileResult {
    const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
    return binaryOpCompileResult(varName, combine(lText, rText), prelude)
}

/**
 * Final CompileResult for a unary distance-modifier (shell/offset) that wraps
 * its child's distance via `wrap(childExpr)`.
 */
export function unaryDistanceIsoResult(
    op: UnaryOperator,
    funcName: string,
    varName: string,
    childResult: CompileResult,
    wrap: (childExpr: string) => string,
    selectFn: IsoSelectFn,
): CompileResult {
    if (childResult.prelude) {
        const accVar = childResult.varName!
        return { funcName, varName: accVar, text: accVar, prelude: childResult.prelude + `${accVar} = ${wrap(accVar)};\n` }
    }
    return { funcName, varName, text: wrap(childResult.text!) }
}

/**
 * Final CompileResult for a coordinate-warp unary operator: evaluate the child at
 * `warpedP` (substituted for the child's `p`) then apply `wrapResult` to the
 * child's result. `wrapResult` is the identity for translate/elongate.
 */
export function warpIsoResult(
    op: UnaryOperator,
    funcName: string,
    varName: string,
    childResult: CompileResult,
    warpedP: string,
    wrapResult: (childExpr: string) => string,
    selectFn: IsoSelectFn,
): CompileResult {
    const subP = `(${warpedP})`
    const sub = (s: string) => s.replace(/\bp\b/g, subP)
    if (childResult.prelude) {
        const accVar = childResult.varName!
        const childPre = sub(childResult.prelude)
        const wrapped = wrapResult(accVar)
        const tail = wrapped !== accVar ? `${accVar} = ${wrapped};\n` : ""
        return { funcName, varName: accVar, text: accVar, prelude: childPre + tail }
    }
    const childAt = sub(childResult.text!)
    return { funcName, varName, text: wrapResult(childAt) }
}

/** Default position when pos is omitted from primitive/operator options. */
export const DEFAULT_POS: Vec3 = [0, 0, 0]

export type BlendMode = 'round' | 'chamfer' | 'soft' | 'columns' | 'stairs'
export type IntersectionType = 'round' | 'chamfer' | 'columns' | 'stairs'
export type UnionType = IntersectionType | 'soft'

export function decapitalize(s: string) {
    return s[0].toLowerCase() + s.slice(1)
}

// Type-only merge: `Node.prototype.rotate` is set in `operators/rotate.mjs` when that module loads.
import "./node-rotate-augmentation.mjs"
