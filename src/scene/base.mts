import { Vec3 } from "../vecmat/vector.mjs"

export type CompileResult = {
    funcName?: string
    varName?: string
    text?: string
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
    nextAABBIndex(): number
    allocPolygonVertices(count: number): number
}

export class Node {
    id!: number
    root: Node
    #scene!: ISceneInfo
    /** AABB slot index if this subtree is guarded, or -1. */
    aabbIndex = -1
    #primitiveCount = -1

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

    compile(_indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }

    compileFast(_indentLevel = 0): CompileResult {
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

/** Default position when pos is omitted from primitive/operator options. */
export const DEFAULT_POS: Vec3 = [0, 0, 0]

export type BlendMode = 'round' | 'chamfer' | 'soft' | 'columns' | 'stairs'
export type IntersectionType = 'round' | 'chamfer' | 'columns' | 'stairs'
export type UnionType = IntersectionType | 'soft'

export function decapitalize(s: string) {
    return s[0].toLowerCase() + s.slice(1)
}
