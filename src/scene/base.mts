import { Vec3 } from "../vecmat/vector.mjs"
import type { AABB } from "./aabb.mjs"
import { aabbUnion } from "./aabb.mjs"

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
    nextArgIndex(): number
    allocPolygonVertices(count: number): number
    /** Whether to emit BVH bounding checks during code generation. */
    bvhEnabled: boolean
}

/** Cost of one cheap primitive (e.g. sphere, box) for BVH heuristics. */
export const COST_ONE_PRIMITIVE = 1

/** Minimum codegen cost for a subtree to warrant a BVH bounding check. */
export const BVH_MIN_COST = 8

export class Node {
    id!: number
    root: Node
    #scene!: ISceneInfo
    #primitiveCount = -1
    #codegenCost = -1

    get scene() {
        return this.root.#scene
    }
    set scene(si: ISceneInfo) {
        this.root.#scene = si
    }

    constructor() {
        this.root = this
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
     */
    computeBounds(): AABB | null {
        return null
    }

    compile(_indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }

    compileFast(_indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }

    compileMid(_indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }

    updateScene(_writeBuffer: (index: number, data: Float32Array) => void): void {
        throw new Error("Method not implemented.")
    }

    build() {
        this.scene.add(this)
    }

    getBase(): Node {
        return this
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
    override computeBounds(): AABB | null {
        return this.arg.computeBounds()
    }
    override updateScene(writeBuffer: (index: number, data: Float32Array) => void): void {
        this.arg.updateScene(writeBuffer)
    }
    override build() {
        super.build()
        this.arg.root = this.root
        this.arg.build()
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
    override computeBounds(): AABB | null {
        const lb = this.lh.computeBounds()
        const rb = this.rh.computeBounds()
        if (!lb && !rb) return null
        if (!lb) return rb
        if (!rb) return lb
        return aabbUnion(lb, rb)
    }
    override updateScene(writeBuffer: (index: number, data: Float32Array) => void): void {
        this.lh.updateScene(writeBuffer)
        this.rh.updateScene(writeBuffer)
    }
    override build() {
        super.build()
        this.lh.root = this.root
        this.rh.root = this.root
        this.lh.build()
        this.rh.build()
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.lh.getAllDescendantIds(), ...this.rh.getAllDescendantIds()]
    }
    constructor(public lh: Node, public rh: Node) {
        super()
    }
}

/**
 * Merge the preludes of two child CompileResults and return the combined
 * prelude string along with each child's expression text. When a child has a
 * prelude, its `varName` (the accumulator) is the correct expression to use
 * rather than `text`, which is just an alias for `varName`.
 *
 * Usage in a binary operator that cannot emit its own prelude logic:
 *   const { prelude, lText, rText } = mergeChildPreludes(lhResult, rhResult)
 *   return { text: `someOp(${lText}, ${rText})`, varName, prelude }
 */
export function mergeChildPreludes(
    lh: CompileResult,
    rh: CompileResult,
): { prelude: string | undefined; lText: string; rText: string } {
    const lText = lh.text!
    const rText = rh.text!
    const combined = [lh.prelude, rh.prelude].filter(Boolean).join("")
    return { prelude: combined || undefined, lText, rText }
}

/** Default position when pos is omitted from primitive/operator options. */
export const DEFAULT_POS: Vec3 = [0, 0, 0]

export type BlendMode = 'round' | 'chamfer' | 'soft' | 'columns' | 'stairs'
export type IntersectionType = 'round' | 'chamfer' | 'columns' | 'stairs'
export type UnionType = IntersectionType | 'soft'

export function decapitalize(s: string) {
    return s[0].toLowerCase() + s.slice(1)
}
