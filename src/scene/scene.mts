import { ArgArray } from "../vecmat/arrays.mjs"
import { Vec2, Vec3, vec3, Vec3f } from "../vecmat/vector.mjs"
import { asRadius } from "./geom.mjs"

export type CompilerResult = {
    funcName?: string
    varName?: string
    text?: string
}

export class SceneInfo {
    args: ArgArray
    root: Node

    numArgs = 0
    numNodes = 0

    #nodeByID = new Map<number, Node>()
    #nodes = new Set<Node>()

    nextArgIndex(): number {
        return this.numArgs++
    }
    add(node: Node) {
        if (this.#nodes.has(node)) return

        node.id = this.numNodes++
        this.#nodes.add(node)
        this.#nodeByID.set(node.id, node)
    }
    get<T extends Node>(id: number): T {
        return this.#nodeByID.get(id) as T
    }

    constructor(root: Node) {
        this.root = root
        this.root.scene = this
        this.root.build()
        this.args = new ArgArray(this.root.scene.numArgs)
    }

    get bufferSize(): number {
        return this.args.byteLength
    }

    compile(): string {
        const compiledResult = this.root.compile(1)
        let compiledText = compiledResult.text
        if (!compiledText) {
            throw new Error("compilation returned no result")
        }
        compiledText += `\nreturn ${compiledResult.varName};\n`
        return compiledText
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
    compile(indentLevel = 0): CompilerResult {
        throw new Error("Method not implemented.")
    }
    updateScene() {
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
    override updateScene() {
        for (let child of this.children) {
            child.updateScene()
        }
    }
    override build() {
        super.build()
        for (let child of this.children) {
            child.root = this.root
            child.build()
        }
    }
    override compile(): CompilerResult {
        const res = this.children[0].compile()
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
    override updateScene() {
        this.arg.updateScene()
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
    override updateScene() {
        this.lh.updateScene()
        this.rh.updateScene()
    }
    override build() {
        super.build()
        this.lh.root = this.root
        this.rh.root = this.root
        this.lh.build()
        this.rh.build()
    }
    constructor(public lh: Node, public rh: Node) {
        super()
    }
}

export class Union extends BinaryOperator {
    override compile(indentLevel = 0): CompilerResult {
        let text = ""
        const lhResult = this.lh.compile()
        const rhResult = this.rh.compile()
        if (lhResult.text) text += lhResult.text + "\n"
        if (rhResult.text) text += rhResult.text + "\n"
        const varName = `u_${lhResult.varName}__${rhResult.varName}`
        text += `let ${varName} = `
        if (this.radius) {
            text += `fOpUnionRound(${lhResult.varName}, ${rhResult.varName}, ${this.radius});`
        } else {
            text += `min( ${lhResult.varName}, ${rhResult.varName} );`
        }
        return { text, varName }
    }
    constructor(lh: Node, rh: Node, public radius?: number) {
        super(lh, rh)
    }
}

export class Subtract extends BinaryOperator {
    override compile(indentLevel = 0): CompilerResult {
        let text = ""
        const lhResult = this.lh.compile(indentLevel)
        const rhResult = this.rh.compile(indentLevel)
        if (lhResult.text) text += lhResult.text + "\n"
        if (rhResult.text) text += rhResult.text + "\n"
        const varName = `d_${lhResult.varName}__${rhResult.varName}`
        text += `let ${varName} = fOpDifferenceRound(${lhResult.varName}, ${rhResult.varName}, ${this.radius});`
        return { text, varName }
    }
    constructor(lh: Node, rh: Node, public radius: number = 0) {
        super(lh, rh)
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
    override updateScene(): void {
        this.scene.args.set(this.argIndex.pos, this.pos)
        this.scene.args.set(this.argIndex.r, this.r)
    }
    override build() {
        super.build()
        this.argIndex.pos = this.scene.nextArgIndex()
        this.argIndex.r = this.scene.nextArgIndex()
    }
    override compile(indentLevel = 0): CompilerResult {
        const funcName = `Sphere${this.id}`
        const varName = `${decapitalize(funcName)}`
        return {
            funcName,
            varName,
            text: `let ${varName} = fSphere(p - args[${this.argIndex.pos}].xyz, args[${this.argIndex.r}].x);`,
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
    override updateScene(): void {
        this.scene.args.set(this.argIndex.pos, this.pos)
        this.scene.args.set(this.argIndex.size, vec3(this.l, this.w, this.h))
    }
    override build() {
        super.build()
        this.argIndex.pos = this.scene.nextArgIndex()
        this.argIndex.size = this.scene.nextArgIndex()
    }
    override compile(indentLevel = 0): CompilerResult {
        const funcName = `Box${this.id}`
        const varName = `${decapitalize(funcName)}`
        return {
            funcName,
            varName,
            text: `let ${varName} = fBox(p - args[${this.argIndex.pos}].xyz, args[${this.argIndex.size}].xyz);`,
        }
    }
}

function decapitalize(s: string) {
    return s[0].toLowerCase() + s.slice(1)
}

export function group(...nodes: Node[]): Group {
    return new Group(...nodes)
}

export function union(radius: number, ...parts: Node[]): Union
export function union(...parts: Node[]): Union
export function union(...args: any[]): Union {
    let radius: number | undefined = undefined
    if (typeof args[0] === "number") {
        radius = args[0] as number
        args.shift()
    }
    if (args.length < 2) {
        throw new Error("union requires at least two things to union together")
    }
    while (args.length > 1) {
        args.push(new Union(args.pop(), args.pop(), radius))
    }
    const result = args[0] as Union
    if (!(result instanceof Union)) throw new Error("unexpected type during union stacking")
    return result
}

export function subtract(radius: number, ...parts: Node[]): Subtract
export function subtract(...parts: Node[]): Subtract
export function subtract(...args: any[]): Subtract {
    let radius: number | undefined = undefined
    if (typeof args[0] === "number") {
        radius = args[0] as number
        args.shift()
    }
    if (args.length < 2) {
        throw new Error("subtract requires at least two arguments")
    }
    args.reverse()
    while (args.length > 1) {
        args.push(new Subtract(args.pop(), args.pop(), radius))
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
