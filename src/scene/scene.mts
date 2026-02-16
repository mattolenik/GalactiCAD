import { BijectiveMap } from "../collections/bijectiveMap.mjs"
import { Vec3, vec3, Vec3f } from "../vecmat/vector.mjs"
import { asRadius } from "./geom.mjs"

export type CompileResult = {
    funcName?: string
    varName?: string
    text?: string
}

export class SceneInfo {
    readonly root: Node
    numArgs = 0
    #nodes = new BijectiveMap<number, Node>()

    nextArgIndex(): number {
        return this.numArgs++
    }

    add(node: Node) {
        if (this.#nodes.hasValue(node)) return
        node.id = this.#nodes.size
        this.#nodes.set(node.id, node)
    }

    get<T extends Node>(id: number): T {
        return this.#nodes.get(id) as T
    }

    /**
     * Get all nodes in the scene
     */
    getAllNodes(): Node[] {
        return Array.from(this.#nodes.values())
    }

    constructor(src: string) {
        // Create a function that defines scene() and then calls it
        // This allows users to write: function scene() { return sphere(...) }
        const wrappedSrc = src + "\nreturn scene()"
        this.root = new Function("box", "group", "sphere", "subtract", "union", "cylinder", "cone", "torus", "capsule", "plane", "hexprism", "disc", "blob", "rotate", "intersect", "pipe", "engrave", "groove", "tongue", "polygon2d", "extrude", "loft", "lathe", "shell", "offset", "elongate", "twist", "bend", "taper", "morph", "seam", wrappedSrc)(box, group, sphere, subtract, union, cylinder, cone, torus, capsule, plane, hexprism, disc, blob, rotate, intersect, pipe, engrave, groove, tongue, shell, offset, elongate, twist, bend, taper, morph, seam, polygon2d, extrude, loft, lathe)
        this.root.scene = this
        this.root.build()
    }

    /**
     * Compile the scene to WGSL code (SDFResult only).
     */
    compile(): string {
        const compiledResult = this.root.compile(1)
        return `\nreturn ${compiledResult.text};\n`
    }

    /**
     * Compile the scene to fast WGSL code (vec2f: d, g only).
     * Used for ray marching steps where normals/IDs are not needed.
     */
    compileFast(): string {
        const compiledResult = this.root.compileFast(1)
        return `\nreturn ${compiledResult.text};\n`
    }

    /**
     * Compile auxiliary WGSL functions from all nodes in the scene.
     * These are placed before sceneSDF in the shader (e.g., per-polygon SDF evaluators).
     */
    compileAux(): string {
        let code = ""
        for (const node of this.#nodes.values()) {
            code += node.compileAux()
        }
        return code
    }

    /**
     * Compile helper WGSL for edge picking/highlighting.
     * Currently emits a box-parameter lookup keyed by node ID.
     */
    compileEdgeHelpers(): string {
        const boxes = Array.from(this.#nodes.values()).filter((node): node is Box => node instanceof Box)
        let code = ""
        for (const boxNode of boxes) {
            code += `case ${boxNode.id}u: {\n`
            code += `    (*posOut) = ${boxNode.pos.wgsl};\n`
            code += `    (*halfOut) = ${boxNode.size.wgsl};\n`
            code += "    return true;\n"
            code += "}\n"
        }
        return code
    }
}

export class Node {
    id!: number
    root: Node
    #scene!: SceneInfo

    get scene() {
        return this.root.#scene
    }
    set scene(si: SceneInfo) {
        this.root.#scene = si
    }

    constructor() {
        this.root = this
    }

    /**
     * Get the shape type name for this node (e.g., "sphere", "box", "union")
     */
    getShapeType(): string {
        return "node"
    }

    /**
     * Get the indicator symbol for this node type in the editor.
     * Default is a squircle (●). Override in subclasses for shape-specific symbols.
     */
    getIndicatorSymbol(): string {
        return "●"  // Squircle/default - rendered with moderate border-radius
    }

    /**
     * Get the SVG content for this node type's indicator in the editor.
     * Returns SVG elements (not full SVG tag) using currentColor for dynamic coloring.
     * Default is a squircle (rounded square). Override in subclasses for shape-specific SVGs.
     */
    getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="3" fill="currentColor"/>`
    }

    /**
     * Get all descendant node IDs (including this node).
     * Used for multi-selection when clicking CSG operators.
     */
    getAllDescendantIds(): number[] {
        return [this.id]
    }
    /**
     * Emit auxiliary WGSL function definitions needed by this node.
     * These are placed before sceneSDF in the shader (e.g., per-polygon SDF evaluators).
     * Default returns empty string. Override in nodes that need helper functions.
     */
    compileAux(): string {
        return ""
    }
    compile(indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }
    compileFast(indentLevel = 0): CompileResult {
        throw new Error("Method not implemented.")
    }
    updateScene(writeBuffer: (index: number, data: Float32Array) => void): void {
        throw new Error("Method not implemented.")
    }
    build() {
        this.scene.add(this)
    }
}

function WithChildren<TBase extends Constructor>(base: TBase) {
    return class extends base {
        children: Node[] = []
    }
}

function WithPos<TBase extends Constructor>(base: TBase) {
    return class extends base {
        pos: Vec3f = new Vec3f()
    }
}

function WithOpRadii<TBase extends Constructor>(base: TBase) {
    return class extends base {
        opRadius = {
            union: 2,
            subtract: 2,
        }
    }
}

function WithRaD<TBase extends Constructor>(base: TBase) {
    return class extends base {
        /**
         * radius
         */
        accessor r: number = -1
        /**
         * diameter
         */
        get d(): number {
            return this.r * 2
        }
        /**
         * diameter
         */
        set d(val: number) {
            this.r = val / 2
        }
    }
}

function WithSize<TBase extends Constructor>(base: TBase) {
    return class extends base {
        /**
         * size
         */
        accessor size: Vec3f = new Vec3f()

        /**
         * length
         */
        get l(): number {
            return this.size.x
        }
        set l(length: number) {
            this.size.x = length
        }

        /**
         * width
         */
        get w(): number {
            return this.size.y
        }
        set w(length: number) {
            this.size.y = length
        }

        /**
         * height
         */
        get h(): number {
            return this.size.z
        }
        set h(length: number) {
            this.size.z = length
        }
    }
}

export class Group extends WithChildren(Node) {
    override getShapeType(): string {
        return "group"
    }

    override getIndicatorSymbol(): string {
        return "▢"  // Empty square - represents a container/group
    }

    override getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }

    override getAllDescendantIds(): number[] {
        const ids = [this.id]
        for (const child of this.children) {
            ids.push(...child.getAllDescendantIds())
        }
        return ids
    }

    override updateScene(writeBuffer: (index: number, data: Float32Array) => void): void {
        for (let child of this.children) {
            child.updateScene(writeBuffer)
        }
    }
    override build() {
        super.build()
        for (let child of this.children) {
            child.root = this.root
            child.build()
        }
    }
    override compile(): CompileResult {
        const res = this.children[0].compile()
        return {
            text: res.text,
            varName: res.varName,
        }
    }
    override compileFast(): CompileResult {
        const res = this.children[0].compileFast()
        return {
            text: res.text,
            varName: res.varName,
        }
    }
    constructor(...children: Node[]) {
        super()
        this.children = children
    }
}

export abstract class UnaryOperator extends Node {
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

export type BlendMode = 'round' | 'chamfer' | 'soft' | 'columns' | 'stairs'

export class Union extends BinaryOperator {
    override getShapeType(): string {
        return "union"
    }

    override getIndicatorSymbol(): string {
        return "⊕"  // Circled plus - represents combining shapes
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="3" x2="6" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }

    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile()
        const rhResult = this.rh.compile()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`
        const L = lhResult.text, R = rhResult.text, r = this.radius
        let text: string
        if (!r) {
            text = `opUnionEx(${L}, ${R})`
        } else {
            switch (this.mode) {
                case 'chamfer': text = `fOpUnionChamferEx(${L}, ${R}, ${r})`; break
                case 'soft': text = `fOpUnionSoftEx(${L}, ${R}, ${r})`; break
                case 'columns': text = `fOpUnionColumnsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                case 'stairs': text = `fOpUnionStairsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                default: text = `fOpUnionRoundEx(${L}, ${R}, ${r})`; break
            }
        }
        return { text, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast()
        const rhResult = this.rh.compileFast()
        const varName = `u_${lhResult.varName}__${rhResult.varName}`
        const L = lhResult.text, R = rhResult.text, r = this.radius
        let text: string
        if (!r) {
            text = `opUnionFast(${L}, ${R})`
        } else {
            switch (this.mode) {
                case 'chamfer': text = `fOpUnionChamferFast(${L}, ${R}, ${r})`; break
                case 'soft': text = `fOpUnionSoftFast(${L}, ${R}, ${r})`; break
                case 'columns': text = `fOpUnionColumnsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                case 'stairs': text = `fOpUnionStairsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                default: text = `fOpUnionRoundFast(${L}, ${R}, ${r})`; break
            }
        }
        return { text, varName }
    }
    constructor(lh: Node, rh: Node, public radius?: number, public mode?: BlendMode, public n?: number) {
        super(lh, rh)
    }
}

export class Subtract extends BinaryOperator {
    override getShapeType(): string {
        return "subtract"
    }

    override getIndicatorSymbol(): string {
        return "⊖"  // Circled minus - represents subtracting shapes
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }

    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        const L = lhResult.text, R = rhResult.text, r = this.radius
        let text: string
        if (!r || r <= 0) {
            text = `opDifferenceEx(${L}, ${R})`
        } else {
            switch (this.mode) {
                case 'chamfer': text = `fOpDifferenceChamferEx(${L}, ${R}, ${r})`; break
                case 'columns': text = `fOpDifferenceColumnsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                case 'stairs': text = `fOpDifferenceStairsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                default: text = `fOpDifferenceRoundEx(${L}, ${R}, ${r})`; break
            }
        }
        return { text, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        const L = lhResult.text, R = rhResult.text, r = this.radius
        let text: string
        if (!r || r <= 0) {
            text = `opDifferenceFast(${L}, ${R})`
        } else {
            switch (this.mode) {
                case 'chamfer': text = `fOpDifferenceChamferFast(${L}, ${R}, ${r})`; break
                case 'columns': text = `fOpDifferenceColumnsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                case 'stairs': text = `fOpDifferenceStairsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                default: text = `fOpDifferenceRoundFast(${L}, ${R}, ${r})`; break
            }
        }
        return { text, varName }
    }
    constructor(lh: Node, rh: Node, public radius: number = 0, public mode?: BlendMode, public n?: number) {
        super(lh, rh)
    }
}

export class Intersect extends BinaryOperator {
    override getShapeType(): string {
        return "intersect"
    }

    override getIndicatorSymbol(): string {
        return "⊗"  // Circled times - represents intersection
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="1.5"/>`
    }

    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `i_${lhResult.varName}__${rhResult.varName}`
        const L = lhResult.text, R = rhResult.text, r = this.radius
        let text: string
        if (!r || r <= 0) {
            text = `opIntersectionEx(${L}, ${R})`
        } else {
            switch (this.mode) {
                case 'chamfer': text = `fOpIntersectionChamferEx(${L}, ${R}, ${r})`; break
                case 'columns': text = `fOpIntersectionColumnsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                case 'stairs': text = `fOpIntersectionStairsEx(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                default: text = `fOpIntersectionRoundEx(${L}, ${R}, ${r})`; break
            }
        }
        return { text, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `i_${lhResult.varName}__${rhResult.varName}`
        const L = lhResult.text, R = rhResult.text, r = this.radius
        let text: string
        if (!r || r <= 0) {
            text = `opIntersectionFast(${L}, ${R})`
        } else {
            switch (this.mode) {
                case 'chamfer': text = `fOpIntersectionChamferFast(${L}, ${R}, ${r})`; break
                case 'columns': text = `fOpIntersectionColumnsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                case 'stairs': text = `fOpIntersectionStairsFast(${L}, ${R}, ${r}, ${this.n ?? 4.0})`; break
                default: text = `fOpIntersectionRoundFast(${L}, ${R}, ${r})`; break
            }
        }
        return { text, varName }
    }
    constructor(lh: Node, rh: Node, public radius: number = 0, public mode?: BlendMode, public n?: number) {
        super(lh, rh)
    }
}

export class Pipe extends BinaryOperator {
    override getShapeType(): string { return "pipe" }
    override getIndicatorSymbol(): string { return "⊘" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="10" x2="10" y2="2" stroke="currentColor" stroke-width="1.5"/>`
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `pipe_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpPipeEx(${lhResult.text}, ${rhResult.text}, ${this.radius})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `pipe_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpPipeFast(${lhResult.text}, ${rhResult.text}, ${this.radius})`, varName }
    }
    constructor(lh: Node, rh: Node, public radius: number) {
        super(lh, rh)
    }
}

export class Engrave extends BinaryOperator {
    override getShapeType(): string { return "engrave" }
    override getIndicatorSymbol(): string { return "⊜" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1"/>`
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `engrave_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpEngraveEx(${lhResult.text}, ${rhResult.text}, ${this.radius})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `engrave_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpEngraveFast(${lhResult.text}, ${rhResult.text}, ${this.radius})`, varName }
    }
    constructor(lh: Node, rh: Node, public radius: number) {
        super(lh, rh)
    }
}

export class Groove extends BinaryOperator {
    override getShapeType(): string { return "groove" }
    override getIndicatorSymbol(): string { return "⊝" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.5"/>`
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `groove_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpGrooveEx(${lhResult.text}, ${rhResult.text}, ${this.ra}, ${this.rb})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `groove_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpGrooveFast(${lhResult.text}, ${rhResult.text}, ${this.ra}, ${this.rb})`, varName }
    }
    constructor(lh: Node, rh: Node, public ra: number, public rb: number) {
        super(lh, rh)
    }
}

export class Tongue extends BinaryOperator {
    override getShapeType(): string { return "tongue" }
    override getIndicatorSymbol(): string { return "⊞" }
    override getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="3" x2="6" y2="9" stroke="currentColor" stroke-width="1"/><line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1"/>`
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpTongueEx(${lhResult.text}, ${rhResult.text}, ${this.ra}, ${this.rb})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `tongue_${lhResult.varName}__${rhResult.varName}`
        return { text: `fOpTongueFast(${lhResult.text}, ${rhResult.text}, ${this.ra}, ${this.rb})`, varName }
    }
    constructor(lh: Node, rh: Node, public ra: number, public rb: number) {
        super(lh, rh)
    }
}

export class Shell extends UnaryOperator {
    override getShapeType(): string { return "shell" }
    override getIndicatorSymbol(): string { return "◯" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="1,1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfShellEx(${childResult.text}, ${this.thickness})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Shell${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfShellFast(${childResult.text}, ${this.thickness})` }
    }
    constructor(public thickness: number, arg: Node) {
        super(arg)
    }
}

export class Offset extends UnaryOperator {
    override getShapeType(): string { return "offset" }
    override getIndicatorSymbol(): string { return "⊕" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="3" fill="currentColor"/><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfOffsetEx(${childResult.text}, ${this.amount})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const funcName = `Offset${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfOffsetFast(${childResult.text}, ${this.amount})` }
    }
    constructor(public amount: number, arg: Node) {
        super(arg)
    }
}

export class Elongate extends UnaryOperator {
    hx: number
    hy: number
    hz: number

    override getShapeType(): string { return "elongate" }
    override getIndicatorSymbol(): string { return "⟷" }
    override getIndicatorSvg(): string {
        return `<line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.5"/><polygon points="0,6 3,4 3,8" fill="currentColor"/><polygon points="12,6 9,4 9,8" fill="currentColor"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const h = `vec3f(${this.hx}, ${this.hy}, ${this.hz})`
        const elongatedChild = childText.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
        const funcName = `Elongate${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: elongatedChild }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const h = `vec3f(${this.hx}, ${this.hy}, ${this.hz})`
        const elongatedChild = childText.replace(/\bp\b/g, `elongatePoint(p, ${h})`)
        const funcName = `Elongate${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: elongatedChild }
    }
    constructor(h: Vec3, arg: Node) {
        super(arg)
        const v = vec3(h)
        this.hx = v.x
        this.hy = v.y
        this.hz = v.z
    }
}

export class Twist extends UnaryOperator {
    override getShapeType(): string { return "twist" }
    override getIndicatorSymbol(): string { return "⌀" }
    override getIndicatorSvg(): string {
        return `<path d="M3,2 C9,4 3,8 9,10" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
        const funcName = `Twist${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfTwistNormal(${twistedChild}, p, ${this.rate})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const twistedChild = childText.replace(/\bp\b/g, `twistPoint(p, ${this.rate})`)
        const funcName = `Twist${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfTwistFast(${twistedChild}, p, ${this.rate})` }
    }
    constructor(public rate: number, arg: Node) {
        super(arg)
    }
}

export class Bend extends UnaryOperator {
    override getShapeType(): string { return "bend" }
    override getIndicatorSymbol(): string { return "⌒" }
    override getIndicatorSvg(): string {
        return `<path d="M2,10 Q6,1 10,10" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${this.amount})`)
        const funcName = `Bend${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfBendNormal(${bentChild}, p, ${this.amount})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const bentChild = childText.replace(/\bp\b/g, `bendPoint(p, ${this.amount})`)
        const funcName = `Bend${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfBendFast(${bentChild}, p, ${this.amount})` }
    }
    constructor(public amount: number, arg: Node) {
        super(arg)
    }
}

export class Taper extends UnaryOperator {
    override getShapeType(): string { return "taper" }
    override getIndicatorSymbol(): string { return "△" }
    override getIndicatorSvg(): string {
        return `<polygon points="3,11 9,11 7,1 5,1" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }
    override compile(indentLevel = 0): CompileResult {
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
        const funcName = `Taper${this.id}`
        const varName = decapitalize(funcName)
        return { funcName, varName, text: `sdfTaperNormal(${taperedChild}, p, ${this.ratio}, ${this.height})` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!
        const taperedChild = childText.replace(/\bp\b/g, `taperPoint(p, ${this.ratio}, ${this.height})`)
        const funcName = `Taper${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `sdfTaperFast(${taperedChild}, p, ${this.ratio}, ${this.height})` }
    }
    constructor(public ratio: number, public height: number, arg: Node) {
        super(arg)
    }
}

export class Morph extends BinaryOperator {
    override getShapeType(): string { return "morph" }
    override getIndicatorSymbol(): string { return "⇌" }
    override getIndicatorSvg(): string {
        return `<circle cx="3" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1"/><rect x="7" y="4" width="4" height="4" rx="0.5" fill="none" stroke="currentColor" stroke-width="1"/><line x1="5" y1="6" x2="7" y2="6" stroke="currentColor" stroke-width="1" stroke-dasharray="1,0.5"/>`
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `morph_${lhResult.varName}__${rhResult.varName}`
        return { text: `sdfMorphEx(${lhResult.text}, ${rhResult.text}, ${this.t})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `morph_${lhResult.varName}__${rhResult.varName}`
        return { text: `sdfMorphFast(${lhResult.text}, ${rhResult.text}, ${this.t})`, varName }
    }
    constructor(public t: number, lh: Node, rh: Node) {
        super(lh, rh)
    }
}

export class Seam extends BinaryOperator {
    override getShapeType(): string { return "seam" }
    override getIndicatorSymbol(): string { return "⊕" }
    override getIndicatorSvg(): string {
        return `<circle cx="4" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="8" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="6" cy="6" r="1" fill="currentColor"/>`
    }
    override compile(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        const varName = `seam_${lhResult.varName}__${rhResult.varName}`
        return { text: `sdfSeamEx(${lhResult.text}, ${rhResult.text}, ${this.radius})`, varName }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const lhResult = this.lh.compileFast(indentLevel)
        const rhResult = this.rh.compileFast(indentLevel)
        const varName = `seam_${lhResult.varName}__${rhResult.varName}`
        return { text: `sdfSeamFast(${lhResult.text}, ${rhResult.text}, ${this.radius})`, varName }
    }
    constructor(lh: Node, rh: Node, public radius: number) {
        super(lh, rh)
    }
}

export class Rotate extends UnaryOperator {
    /** Rotation around X axis in degrees */
    rx: number
    /** Rotation around Y axis in degrees */
    ry: number
    /** Rotation around Z axis in degrees */
    rz: number

    constructor(rotation: Vec3, arg: Node) {
        super(arg)
        const r = vec3(rotation)
        this.rx = r.x
        this.ry = r.y
        this.rz = r.z
    }

    override getShapeType(): string { return "rotate" }
    override getIndicatorSymbol(): string { return "↻" }
    override getIndicatorSvg(): string {
        return `<path d="M6,1 A5,5 0 1,1 1,6" fill="none" stroke="currentColor" stroke-width="1.5"/><polygon points="1,3 1,7 3,5" fill="currentColor"/>`
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.arg.getAllDescendantIds()]
    }

    /**
     * Compute forward and inverse rotation matrices in column-major order for WGSL.
     * Rotation order is ZYX (apply X first, then Y, then Z). Angles are in degrees.
     */
    getWgslMatrices(): { fwd: number[], inv: number[] } {
        const toRad = Math.PI / 180
        const cx = Math.cos(this.rx * toRad), sx = Math.sin(this.rx * toRad)
        const cy = Math.cos(this.ry * toRad), sy = Math.sin(this.ry * toRad)
        const cz = Math.cos(this.rz * toRad), sz = Math.sin(this.rz * toRad)

        // R = Rz * Ry * Rx (row-major):
        //   [cy*cz,   sx*sy*cz-cx*sz, cx*sy*cz+sx*sz]
        //   [cy*sz,   sx*sy*sz+cx*cz, cx*sy*sz-sx*cz]
        //   [-sy,     sx*cy,          cx*cy         ]
        //
        // WGSL mat3x3f is column-major: mat3x3f(col0.xyz, col1.xyz, col2.xyz)

        // Forward R: columns are rows of row-major transposed
        const fwd = [
            cy * cz, cy * sz, -sy,
            sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy,
            cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy,
        ]
        // Inverse R^T: columns
        const inv = [
            cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
            cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
            -sy, sx * cy, cx * cy,
        ]
        return { fwd, inv }
    }

    /**
     * Apply inverse rotation to a point (for JS-side SDF evaluation).
     */
    applyInvRotation(px: number, py: number, pz: number): [number, number, number] {
        const toRad = Math.PI / 180
        const cx = Math.cos(this.rx * toRad), sx = Math.sin(this.rx * toRad)
        const cy = Math.cos(this.ry * toRad), sy = Math.sin(this.ry * toRad)
        const cz = Math.cos(this.rz * toRad), sz = Math.sin(this.rz * toRad)
        // R_inv = R^T applied row-by-row
        return [
            (cy * cz) * px + (cy * sz) * py + (-sy) * pz,
            (sx * sy * cz - cx * sz) * px + (sx * sy * sz + cx * cz) * py + (sx * cy) * pz,
            (cx * sy * cz + sx * sz) * px + (cx * sy * sz - sx * cz) * py + (cx * cy) * pz,
        ]
    }

    private matToWgsl(m: number[]): string {
        // Use column-vector constructor: mat3x3f(col0, col1, col2)
        const f = (v: number) => v.toFixed(10)
        return `mat3x3f(vec3f(${f(m[0])}, ${f(m[1])}, ${f(m[2])}), vec3f(${f(m[3])}, ${f(m[4])}, ${f(m[5])}), vec3f(${f(m[6])}, ${f(m[7])}, ${f(m[8])}))`
    }

    override compile(indentLevel = 0): CompileResult {
        const { fwd, inv } = this.getWgslMatrices()
        const childResult = this.arg.compile(indentLevel)
        const childText = childResult.text!

        // Replace standalone 'p' (the point variable) with the inverse-rotated point
        const invMat = this.matToWgsl(inv)
        const fwdMat = this.matToWgsl(fwd)
        const rotatedChildText = childText.replace(/\bp\b/g, `(${invMat} * p)`)

        const funcName = `Rotate${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `sdfRotateNormal(${rotatedChildText}, ${fwdMat})`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const { inv } = this.getWgslMatrices()
        const childResult = this.arg.compileFast(indentLevel)
        const childText = childResult.text!

        const invMat = this.matToWgsl(inv)
        const rotatedChildText = childText.replace(/\bp\b/g, `(${invMat} * p)`)

        const funcName = `Rotate${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: rotatedChildText,
        }
    }
}

export class Sphere extends WithOpRadii(WithRaD(WithPos(Node))) {
    argIndex = {
        pos: 0,
        r: 0,
    }

    constructor(pos: Vec3, { r, d }: { r?: number; d?: number }) {
        super()
        this.pos = vec3(pos)
        this.r = asRadius(r, d)
    }

    override getShapeType(): string {
        return "sphere"
    }

    override getIndicatorSymbol(): string {
        return "●"  // Filled circle
    }

    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="currentColor"/>`
    }

    override updateScene(writeBuffer: (index: number, data: Float32Array) => void): void {
        writeBuffer(this.argIndex.pos, this.pos.data)
        writeBuffer(this.argIndex.r, new Float32Array([this.r]))
    }
    override build() {
        super.build()
        this.argIndex.pos = this.scene.nextArgIndex()
        this.argIndex.r = this.scene.nextArgIndex()
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Sphere${this.id}`
        const varName = `${decapitalize(funcName)}`
        return {
            funcName,
            varName,
            // Use extended sphere that returns SDFResult with gradient magnitude
            text: `fSphereEx(p - ${this.pos.wgsl}, ${this.r}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Sphere${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `fSphereFast(p - ${this.pos.wgsl}, ${this.r})`,
        }
    }
}

export class Cylinder extends WithRaD(WithPos(Node)) {
    h: number

    constructor(pos: Vec3, { r, d, h }: { r?: number; d?: number; h: number }) {
        super()
        this.pos = vec3(pos)
        this.r = asRadius(r, d)
        this.h = h
    }

    override getShapeType(): string { return "cylinder" }
    override getIndicatorSymbol(): string { return "⬭" }
    override getIndicatorSvg(): string {
        return `<rect x="1" y="2" width="10" height="8" rx="3" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = `${decapitalize(funcName)}`
        return { funcName, varName, text: `fCylinderEx(p - ${this.pos.wgsl}, ${this.r}, ${this.h}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cylinder${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fCylinderFast(p - ${this.pos.wgsl}, ${this.r}, ${this.h})` }
    }
}

export class Cone extends WithRaD(WithPos(Node)) {
    h: number

    constructor(pos: Vec3, { r, d, h }: { r?: number; d?: number; h: number }) {
        super()
        this.pos = vec3(pos)
        this.r = asRadius(r, d)
        this.h = h
    }

    override getShapeType(): string { return "cone" }
    override getIndicatorSymbol(): string { return "▲" }
    override getIndicatorSvg(): string {
        return `<polygon points="6,1 11,11 1,11" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}`
        return { funcName, varName, text: `fConeEx(p - ${this.pos.wgsl}, ${this.r}, ${this.h}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Cone${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fConeFast(p - ${this.pos.wgsl}, ${this.r}, ${this.h})` }
    }
}

export class Torus extends WithPos(Node) {
    sr: number
    lr: number

    constructor(pos: Vec3, { sr, lr }: { sr: number; lr: number }) {
        super()
        this.pos = vec3(pos)
        this.sr = sr
        this.lr = lr
    }

    override getShapeType(): string { return "torus" }
    override getIndicatorSymbol(): string { return "◎" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = `${decapitalize(funcName)}`
        return { funcName, varName, text: `fTorusEx(p - ${this.pos.wgsl}, ${this.sr}, ${this.lr}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Torus${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fTorusFast(p - ${this.pos.wgsl}, ${this.sr}, ${this.lr})` }
    }
}

export class Capsule extends WithRaD(WithPos(Node)) {
    c: number

    constructor(pos: Vec3, { r, d, c }: { r?: number; d?: number; c: number }) {
        super()
        this.pos = vec3(pos)
        this.r = asRadius(r, d)
        this.c = c
    }

    override getShapeType(): string { return "capsule" }
    override getIndicatorSymbol(): string { return "⬮" }
    override getIndicatorSvg(): string {
        return `<rect x="2" y="1" width="8" height="10" rx="4" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Capsule${this.id}`
        const varName = `${decapitalize(funcName)}`
        return { funcName, varName, text: `fCapsuleEx(p - ${this.pos.wgsl}, ${this.r}, ${this.c}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Capsule${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fCapsuleFast(p - ${this.pos.wgsl}, ${this.r}, ${this.c})` }
    }
}

export class PlaneNode extends WithPos(Node) {
    normal: Vec3f
    dist: number

    constructor(pos: Vec3, { n, dist = 0 }: { n: Vec3; dist?: number }) {
        super()
        this.pos = vec3(pos)
        this.normal = vec3(n).normalize()
        this.dist = dist
    }

    override getShapeType(): string { return "plane" }
    override getIndicatorSymbol(): string { return "▬" }
    override getIndicatorSvg(): string {
        return `<line x1="0" y1="6" x2="12" y2="6" stroke="currentColor" stroke-width="2"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = `${decapitalize(funcName)}`
        return { funcName, varName, text: `fPlaneEx(p - ${this.pos.wgsl}, ${this.normal.wgsl}, ${this.dist}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Plane${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fPlaneFast(p - ${this.pos.wgsl}, ${this.normal.wgsl}, ${this.dist})` }
    }
}

export class HexPrism extends WithRaD(WithPos(Node)) {
    h: number

    constructor(pos: Vec3, { r, d, h }: { r?: number; d?: number; h: number }) {
        super()
        this.pos = vec3(pos)
        this.r = asRadius(r, d)
        this.h = h
    }

    override getShapeType(): string { return "hexprism" }
    override getIndicatorSymbol(): string { return "⬡" }
    override getIndicatorSvg(): string {
        return `<polygon points="6,1 10.5,3.5 10.5,8.5 6,11 1.5,8.5 1.5,3.5" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `HexPrism${this.id}`
        const varName = `${decapitalize(funcName)}`
        return { funcName, varName, text: `fHexagonCircumcircleEx(p - ${this.pos.wgsl}, vec2f(${this.r}, ${this.h}), ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `HexPrism${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fHexagonCircumcircleFast(p - ${this.pos.wgsl}, vec2f(${this.r}, ${this.h}))` }
    }
}

export class Disc extends WithRaD(WithPos(Node)) {
    constructor(pos: Vec3, { r, d }: { r?: number; d?: number }) {
        super()
        this.pos = vec3(pos)
        this.r = asRadius(r, d)
    }

    override getShapeType(): string { return "disc" }
    override getIndicatorSymbol(): string { return "◉" }
    override getIndicatorSvg(): string {
        return `<ellipse cx="6" cy="6" rx="5" ry="2.5" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Disc${this.id}`
        const varName = `${decapitalize(funcName)}`
        return { funcName, varName, text: `fDiscEx(p - ${this.pos.wgsl}, ${this.r}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Disc${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fDiscFast(p - ${this.pos.wgsl}, ${this.r})` }
    }
}

export class Blob extends WithPos(Node) {
    constructor(pos: Vec3) {
        super()
        this.pos = vec3(pos)
    }

    override getShapeType(): string { return "blob" }
    override getIndicatorSymbol(): string { return "◌" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="4" fill="currentColor"/>`
    }
    override updateScene(): void { }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = `${decapitalize(funcName)}`
        return { funcName, varName, text: `fBlobEx(p - ${this.pos.wgsl}, ${this.id}u)` }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Blob${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return { funcName, varName, text: `fBlobFast(p - ${this.pos.wgsl})` }
    }
}

/**
 * A 2D SDF primitive defined by a closed polygon of vertices.
 * Cannot be used directly in a 3D scene — must be wrapped in Extrude or Loft.
 */
export class Polygon2D extends Node {
    vertices: [number, number][]

    constructor(vertices: [number, number][]) {
        super()
        if (vertices.length < 3) {
            throw new Error("polygon2d requires at least 3 vertices")
        }
        this.vertices = vertices
    }

    override getShapeType(): string { return "polygon2d" }
    override getIndicatorSymbol(): string { return "⬠" }
    override getIndicatorSvg(): string {
        return `<polygon points="6,1 11,5 9,11 3,11 1,5" fill="currentColor"/>`
    }
    override updateScene(): void { }

    /** Generate a unique WGSL function name for this polygon instance */
    get wgslFuncName(): string {
        return `fPolygon2D_${this.id}`
    }

    override compileAux(): string {
        const N = this.vertices.length
        const verts = this.vertices
            .map(([x, y]) => `vec2f(${x.toFixed(6)}, ${y.toFixed(6)})`)
            .join(", ")

        return `
fn ${this.wgslFuncName}(p: vec2f) -> f32 {
    const N = ${N}u;
    var v = array<vec2f, ${N}>(${verts});
    var d = dot(p - v[0], p - v[0]);
    var s = 1.0;
    var j = N - 1u;
    for (var i = 0u; i < N; i++) {
        let e = v[j] - v[i];
        let w = p - v[i];
        let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
        d = min(d, dot(b, b));
        let c0 = p.y >= v[i].y;
        let c1 = p.y < v[j].y;
        let c2 = e.x * w.y > e.y * w.x;
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
        j = i;
    }
    return s * sqrt(d);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        throw new Error("Polygon2D cannot be used directly in a 3D scene. Wrap it in extrude() or loft().")
    }
    override compileFast(indentLevel = 0): CompileResult {
        throw new Error("Polygon2D cannot be used directly in a 3D scene. Wrap it in extrude() or loft().")
    }
}

/**
 * Extrudes a 2D SDF child along the Y axis to produce a 3D solid.
 * h is the half-height (extends h above and h below the center, consistent with Cylinder).
 */
export class Extrude extends WithPos(Node) {
    h: number
    /** Twist angle in degrees over the full height. 0 = no twist. */
    twist: number
    child: Polygon2D

    constructor(child: Polygon2D, opts: { h: number; t?: number })
    constructor(pos: Vec3, child: Polygon2D, opts: { h: number; t?: number })
    constructor(...args: any[]) {
        super()
        if (args[0] instanceof Polygon2D) {
            this.pos = new Vec3f()
            this.child = args[0]
            this.h = args[1].h
            this.twist = args[1].t ?? 0
        } else {
            this.pos = vec3(args[0])
            this.child = args[1]
            this.h = args[2].h
            this.twist = args[2].t ?? 0
        }
    }

    override getShapeType(): string { return "extrude" }
    override getIndicatorSymbol(): string { return "⬒" }
    override getIndicatorSvg(): string {
        return `<rect x="2" y="1" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1"/>`
    }
    override updateScene(): void { }

    override build() {
        super.build()
        this.child.root = this.root
        this.child.build()
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.child.getAllDescendantIds()]
    }

    get wgslFieldFuncName(): string { return `fExtrude_${this.id}_field` }
    get wgslExFuncName(): string { return `fExtrude_${this.id}_Ex` }
    get wgslFastFuncName(): string { return `fExtrude_${this.id}_Fast` }

    override compileAux(): string {
        const childFunc = this.child.wgslFuncName
        const childId = this.child.id
        const h = this.h.toFixed(6)
        const hasTwist = this.twist !== 0

        if (!hasTwist) {
            // No twist: exact SDF with analytic normals
            return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let d2d = ${childFunc}(p.xz);
    let dCap = abs(p.y) - ${h};
    let d = max(d2d, dCap);
    let onSide = d2d > dCap;
    let eps = 0.001;
    let gx = ${childFunc}(p.xz + vec2f(eps, 0.0)) - ${childFunc}(p.xz - vec2f(eps, 0.0));
    let gz = ${childFunc}(p.xz + vec2f(0.0, eps)) - ${childFunc}(p.xz - vec2f(0.0, eps));
    let nSide = safeNormalize(vec3f(gx, 0.0, gz), vec3f(1.0, 0.0, 0.0));
    let nCap = vec3f(0.0, sgn(p.y), 0.0);
    let n = select(nCap, nSide, onSide);
    let resultId = select(${childId}u, id, onSide);
    return sdfTrue(d, resultId, n);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> vec2f {
    let d2d = ${childFunc}(p.xz);
    let dCap = abs(p.y) - ${h};
    return vec2f(max(d2d, dCap), 1.0);
}
`
        }

        // With twist: distance estimator, normals via 3D finite differences
        const twistRad = (this.twist * Math.PI / 180).toFixed(10)
        return `
fn ${this.wgslFieldFuncName}(p: vec3f) -> f32 {
    let h = ${h};
    let twist = ${twistRad};
    let t = clamp((p.y + h) / (2.0 * h), 0.0, 1.0);
    let angle = twist * t;
    let ca = cos(angle);
    let sa = sin(angle);
    let twisted = vec2f(ca * p.x + sa * p.z, -sa * p.x + ca * p.z);
    let d2d = ${childFunc}(twisted);
    let dCap = abs(p.y) - h;
    return max(d2d, dCap);
}

fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let d = ${this.wgslFieldFuncName}(p);
    let eps = 0.001;
    let nx = ${this.wgslFieldFuncName}(p + vec3f(eps, 0.0, 0.0)) - ${this.wgslFieldFuncName}(p - vec3f(eps, 0.0, 0.0));
    let ny = ${this.wgslFieldFuncName}(p + vec3f(0.0, eps, 0.0)) - ${this.wgslFieldFuncName}(p - vec3f(0.0, eps, 0.0));
    let nz = ${this.wgslFieldFuncName}(p + vec3f(0.0, 0.0, eps)) - ${this.wgslFieldFuncName}(p - vec3f(0.0, 0.0, eps));
    let n = safeNormalize(vec3f(nx, ny, nz), vec3f(0.0, 1.0, 0.0));
    let dCap = abs(p.y) - ${h};
    let onSide = (d - dCap) > 0.01;
    let resultId = select(${childId}u, id, onSide);
    return sdfR(d, 0.8, 1.0, resultId, n);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> vec2f {
    return vec2f(${this.wgslFieldFuncName}(p), 0.8);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Extrude${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${this.pos.wgsl}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Extrude${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${this.pos.wgsl})`,
        }
    }
}

/**
 * Revolves a 2D SDF profile around the Y axis to create a solid of revolution.
 * The profile is defined in the (radius, height) plane — the first coordinate of each
 * vertex is the radial distance from the Y axis, the second is the Y height.
 * The resulting 3D SDF is exact (revolution preserves the SDF property).
 */
export class Lathe extends WithPos(Node) {
    child: Polygon2D

    constructor(child: Polygon2D)
    constructor(pos: Vec3, child: Polygon2D)
    constructor(...args: any[]) {
        super()
        if (args[0] instanceof Polygon2D) {
            this.pos = new Vec3f()
            this.child = args[0]
        } else {
            this.pos = vec3(args[0])
            this.child = args[1]
        }
    }

    override getShapeType(): string { return "lathe" }
    override getIndicatorSymbol(): string { return "◐" }
    override getIndicatorSvg(): string {
        return `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" stroke-width="1" stroke-dasharray="2,1"/>`
    }
    override updateScene(): void { }

    override build() {
        super.build()
        this.child.root = this.root
        this.child.build()
    }

    override getAllDescendantIds(): number[] {
        return [this.id, ...this.child.getAllDescendantIds()]
    }

    get wgslExFuncName(): string { return `fLathe_${this.id}_Ex` }
    get wgslFastFuncName(): string { return `fLathe_${this.id}_Fast` }

    override compileAux(): string {
        const childFunc = this.child.wgslFuncName

        return `
fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let r = length(p.xz);
    let q = vec2f(r, p.y);
    let d = ${childFunc}(q);
    // 2D gradient via finite differences in the (radius, height) plane
    let eps = 0.001;
    let gr = ${childFunc}(q + vec2f(eps, 0.0)) - ${childFunc}(q - vec2f(eps, 0.0));
    let gy = ${childFunc}(q + vec2f(0.0, eps)) - ${childFunc}(q - vec2f(0.0, eps));
    // Map radial gradient back to 3D (spread across x and z)
    var radDir = vec2f(1.0, 0.0);
    if (r > 1e-8) {
        radDir = p.xz / r;
    }
    let n = safeNormalize(vec3f(gr * radDir.x, gy, gr * radDir.y), vec3f(0.0, 1.0, 0.0));
    return sdfTrue(d, id, n);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> vec2f {
    let q = vec2f(length(p.xz), p.y);
    return vec2f(${childFunc}(q), 1.0);
}
`
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${this.pos.wgsl}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Lathe${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${this.pos.wgsl})`,
        }
    }
}

/**
 * Lofts between two or more 2D SDF profiles along the Y axis.
 * h is the half-height. Profiles are evenly spaced from -h (first) to +h (last).
 * The interpolated field is a distance estimator (not exact SDF), but works for ray marching.
 */
export class Loft extends WithPos(Node) {
    h: number
    profiles: Polygon2D[]

    constructor(profiles: Polygon2D[], opts: { h: number })
    constructor(pos: Vec3, profiles: Polygon2D[], opts: { h: number })
    constructor(...args: any[]) {
        super()
        if (Array.isArray(args[0]) && args[0][0] instanceof Polygon2D) {
            this.pos = new Vec3f()
            this.profiles = args[0]
            this.h = args[1].h
        } else {
            this.pos = vec3(args[0])
            this.profiles = args[1]
            this.h = args[2].h
        }
        if (this.profiles.length < 2) {
            throw new Error("loft requires at least 2 profiles")
        }
    }

    override getShapeType(): string { return "loft" }
    override getIndicatorSymbol(): string { return "⏥" }
    override getIndicatorSvg(): string {
        return `<polygon points="3,1 9,1 11,11 1,11" fill="none" stroke="currentColor" stroke-width="1.5"/>`
    }
    override updateScene(): void { }

    override build() {
        super.build()
        for (const profile of this.profiles) {
            profile.root = this.root
            profile.build()
        }
    }

    override getAllDescendantIds(): number[] {
        const ids = [this.id]
        for (const profile of this.profiles) {
            ids.push(...profile.getAllDescendantIds())
        }
        return ids
    }

    get wgslFieldFuncName(): string { return `fLoft_${this.id}_field` }
    get wgslExFuncName(): string { return `fLoft_${this.id}_Ex` }
    get wgslFastFuncName(): string { return `fLoft_${this.id}_Fast` }

    override compileAux(): string {
        const N = this.profiles.length
        const h = this.h.toFixed(6)

        // Generate profile evaluation lines
        const evalLines = this.profiles
            .map((p, i) => `    let d${i} = ${p.wgslFuncName}(p.xz);`)
            .join("\n")

        // Generate interpolation logic
        let interpCode: string
        if (N === 2) {
            interpCode = `    let d_profile = mix(d0, d1, t);`
        } else {
            const numSegments = N - 1
            interpCode = `    let seg = t * ${numSegments.toFixed(1)};
    var d_profile: f32;
`
            for (let i = 0; i < numSegments; i++) {
                const localT = i === 0 ? "seg" : `seg - ${i.toFixed(1)}`
                if (i === 0) {
                    interpCode += `    if (seg < 1.0) {
        d_profile = mix(d${i}, d${i + 1}, ${localT});
`
                } else if (i === numSegments - 1) {
                    interpCode += `    } else {
        d_profile = mix(d${i}, d${i + 1}, ${localT});
    }
`
                } else {
                    interpCode += `    } else if (seg < ${(i + 1).toFixed(1)}) {
        d_profile = mix(d${i}, d${i + 1}, ${localT});
`
                }
            }
        }

        const fieldFunc = `
fn ${this.wgslFieldFuncName}(p: vec3f) -> f32 {
    let h = ${h};
    let t = clamp((p.y + h) / (2.0 * h), 0.0, 1.0);
${evalLines}
${interpCode}
    let dCap = abs(p.y) - h;
    return max(d_profile, dCap);
}

fn ${this.wgslExFuncName}(p: vec3f, id: u32) -> SDFResult {
    let d = ${this.wgslFieldFuncName}(p);
    let eps = 0.001;
    let nx = ${this.wgslFieldFuncName}(p + vec3f(eps, 0.0, 0.0)) - ${this.wgslFieldFuncName}(p - vec3f(eps, 0.0, 0.0));
    let ny = ${this.wgslFieldFuncName}(p + vec3f(0.0, eps, 0.0)) - ${this.wgslFieldFuncName}(p - vec3f(0.0, eps, 0.0));
    let nz = ${this.wgslFieldFuncName}(p + vec3f(0.0, 0.0, eps)) - ${this.wgslFieldFuncName}(p - vec3f(0.0, 0.0, eps));
    let n = safeNormalize(vec3f(nx, ny, nz), vec3f(0.0, 1.0, 0.0));
    let dCap = abs(p.y) - ${h};
    let onSide = (d - dCap) > 0.01;
    let bottomCap = p.y < 0.0;
    let capId = select(${this.profiles[this.profiles.length - 1].id}u, ${this.profiles[0].id}u, bottomCap);
    let resultId = select(capId, id, onSide);
    return sdfR(d, 0.8, 1.0, resultId, n);
}

fn ${this.wgslFastFuncName}(p: vec3f) -> vec2f {
    return vec2f(${this.wgslFieldFuncName}(p), 0.8);
}
`
        return fieldFunc
    }

    override compile(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `${this.wgslExFuncName}(p - ${this.pos.wgsl}, ${this.id}u)`,
        }
    }

    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Loft${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `${this.wgslFastFuncName}(p - ${this.pos.wgsl})`,
        }
    }
}

export class Box extends WithSize(WithPos(Node)) {
    argIndex = {
        pos: 0,
        size: 0,
    }

    constructor(pos: Vec3, size: Vec3) {
        super()
        this.pos = vec3(pos)
        this.size = vec3(size)
    }

    override getShapeType(): string {
        return "box"
    }

    override getIndicatorSymbol(): string {
        return "■"  // Filled square
    }

    override getIndicatorSvg(): string {
        return `<rect x="1" y="1" width="10" height="10" rx="1" fill="currentColor"/>`
    }

    override updateScene(writeBuffer: (index: number, data: Float32Array) => void): void {
        writeBuffer(this.argIndex.pos, this.pos.data)
        writeBuffer(this.argIndex.size, this.size.data)
    }
    override build() {
        super.build()
        this.argIndex.pos = this.scene.nextArgIndex()
        this.argIndex.size = this.scene.nextArgIndex()
    }
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = `${decapitalize(funcName)}`
        return {
            funcName,
            varName,
            // Use extended box that returns SDFResult with gradient magnitude
            text: `fBoxEx(p - ${this.pos.wgsl}, ${this.size.wgsl}, ${this.id}u)`,
        }
    }
    override compileFast(indentLevel = 0): CompileResult {
        const funcName = `Box${this.id}`
        const varName = `${decapitalize(funcName)}_f`
        return {
            funcName,
            varName,
            text: `fBoxFast(p - ${this.pos.wgsl}, ${this.size.wgsl})`,
        }
    }
}

function decapitalize(s: string) {
    return s[0].toLowerCase() + s.slice(1)
}

export function group(...nodes: Node[]): Group {
    return new Group(...nodes)
}

export type UnionOptions = { r?: number; mode?: BlendMode; n?: number }

export function union(opts: UnionOptions, ...parts: Node[]): Union
export function union(radius: number, ...parts: Node[]): Union
export function union(...parts: Node[]): Union
export function union(...args: any[]): Union {
    let radius: number | undefined = undefined
    let mode: BlendMode | undefined = undefined
    let n: number | undefined = undefined
    if (typeof args[0] === "number") {
        radius = args[0] as number
        args.shift()
    } else if (args[0] !== null && typeof args[0] === "object" && !(args[0] instanceof Node)) {
        const opts = args[0] as UnionOptions
        radius = opts.r
        mode = opts.mode
        n = opts.n
        args.shift()
    }
    if (args.length < 2) {
        throw new Error("union requires at least two things to union together")
    }
    while (args.length > 1) {
        args.push(new Union(args.pop(), args.pop(), radius, mode, n))
    }
    const result = args[0] as Union
    if (!(result instanceof Union)) throw new Error("unexpected type during union stacking")
    return result
}

export type SubtractOptions = { r?: number; mode?: BlendMode; n?: number }

export function subtract(opts: SubtractOptions, ...parts: Node[]): Subtract
export function subtract(radius: number, ...parts: Node[]): Subtract
export function subtract(...parts: Node[]): Subtract
export function subtract(...args: any[]): Subtract {
    let radius: number | undefined = undefined
    let mode: BlendMode | undefined = undefined
    let n: number | undefined = undefined
    if (typeof args[0] === "number") {
        radius = args[0] as number
        args.shift()
    } else if (args[0] !== null && typeof args[0] === "object" && !(args[0] instanceof Node)) {
        const opts = args[0] as SubtractOptions
        radius = opts.r
        mode = opts.mode
        n = opts.n
        args.shift()
    }
    if (args.length < 2) {
        throw new Error("subtract requires at least two arguments")
    }
    args.reverse()
    while (args.length > 1) {
        args.push(new Subtract(args.pop(), args.pop(), radius, mode, n))
    }
    const result = args[0] as Subtract
    if (!(result instanceof Subtract)) throw new Error("unexpected type during subtract stacking")
    return result
}

export function box(pos: Vec3, size: Vec3): Box {
    return new Box(pos, size)
}

export function sphere(pos: Vec3, { r, d }: { r?: number; d?: number }): Sphere {
    return new Sphere(pos, { r, d })
}

export function cylinder(pos: Vec3, opts: { r?: number; d?: number; h: number }): Cylinder {
    return new Cylinder(pos, opts)
}

export function cone(pos: Vec3, opts: { r?: number; d?: number; h: number }): Cone {
    return new Cone(pos, opts)
}

export function torus(pos: Vec3, opts: { sr: number; lr: number }): Torus {
    return new Torus(pos, opts)
}

export function capsule(pos: Vec3, opts: { r?: number; d?: number; c: number }): Capsule {
    return new Capsule(pos, opts)
}

export function plane(pos: Vec3, opts: { n: Vec3; dist?: number }): PlaneNode {
    return new PlaneNode(pos, opts)
}

export function hexprism(pos: Vec3, opts: { r?: number; d?: number; h: number }): HexPrism {
    return new HexPrism(pos, opts)
}

export function disc(pos: Vec3, opts: { r?: number; d?: number }): Disc {
    return new Disc(pos, opts)
}

export function blob(pos: Vec3): Blob {
    return new Blob(pos)
}

export function rotate(rotation: Vec3, child: Node): Rotate {
    return new Rotate(rotation, child)
}

export type IntersectOptions = { r?: number; mode?: BlendMode; n?: number }

export function intersect(opts: IntersectOptions, lh: Node, rh: Node): Intersect
export function intersect(lh: Node, rh: Node): Intersect
export function intersect(...args: any[]): Intersect {
    let radius = 0
    let mode: BlendMode | undefined = undefined
    let n: number | undefined = undefined
    if (args[0] !== null && typeof args[0] === "object" && !(args[0] instanceof Node)) {
        const opts = args[0] as IntersectOptions
        radius = opts.r ?? 0
        mode = opts.mode
        n = opts.n
        args.shift()
    }
    if (args.length < 2) {
        throw new Error("intersect requires exactly two shapes")
    }
    return new Intersect(args[0], args[1], radius, mode, n)
}

export function pipe(lh: Node, rh: Node, radius: number): Pipe {
    return new Pipe(lh, rh, radius)
}

export function engrave(lh: Node, rh: Node, radius: number): Engrave {
    return new Engrave(lh, rh, radius)
}

export function groove(lh: Node, rh: Node, ra: number, rb: number): Groove {
    return new Groove(lh, rh, ra, rb)
}

export function tongue(lh: Node, rh: Node, ra: number, rb: number): Tongue {
    return new Tongue(lh, rh, ra, rb)
}

export function shell(thickness: number, child: Node): Shell {
    return new Shell(thickness, child)
}

export function offset(amount: number, child: Node): Offset {
    return new Offset(amount, child)
}

export function elongate(h: Vec3, child: Node): Elongate {
    return new Elongate(h, child)
}

export function twist(rate: number, child: Node): Twist {
    return new Twist(rate, child)
}

export function bend(amount: number, child: Node): Bend {
    return new Bend(amount, child)
}

export function taper(ratio: number, height: number, child: Node): Taper {
    return new Taper(ratio, height, child)
}

export function morph(t: number, lh: Node, rh: Node): Morph {
    return new Morph(t, lh, rh)
}

export function seam(lh: Node, rh: Node, radius: number): Seam {
    return new Seam(lh, rh, radius)
}

export function polygon2d(vertices: [number, number][]): Polygon2D {
    return new Polygon2D(vertices)
}

export function extrude(child: Polygon2D, opts: { h: number; t?: number }): Extrude
export function extrude(pos: Vec3, child: Polygon2D, opts: { h: number; t?: number }): Extrude
export function extrude(...args: any[]): Extrude {
    if (args[0] instanceof Polygon2D) {
        return new Extrude(args[0], args[1])
    }
    return new Extrude(args[0], args[1], args[2])
}

export function loft(...args: any[]): Loft {
    // loft(profile1, profile2, ..., { h })
    // loft(pos, profile1, profile2, ..., { h })
    let pos: Vec3 | undefined
    let startIdx = 0

    // Check if first arg is a position array (not a Polygon2D)
    if (!(args[0] instanceof Polygon2D) && Array.isArray(args[0]) && typeof args[0][0] === "number") {
        pos = args[0] as Vec3
        startIdx = 1
    }

    // Last arg is the options object
    const opts = args[args.length - 1] as { h: number }
    if (!opts || typeof opts.h !== "number") {
        throw new Error("loft requires an options object with { h } as the last argument")
    }

    // Middle args are profiles
    const profiles = args.slice(startIdx, args.length - 1) as Polygon2D[]
    if (profiles.length < 2) {
        throw new Error("loft requires at least 2 profiles")
    }
    for (const p of profiles) {
        if (!(p instanceof Polygon2D)) {
            throw new Error("loft profiles must be polygon2d() instances")
        }
    }

    if (pos) {
        return new Loft(pos, profiles, opts)
    }
    return new Loft(profiles, opts)
}

export function lathe(child: Polygon2D): Lathe
export function lathe(pos: Vec3, child: Polygon2D): Lathe
export function lathe(...args: any[]): Lathe {
    if (args[0] instanceof Polygon2D) {
        return new Lathe(args[0])
    }
    return new Lathe(args[0], args[1])
}
