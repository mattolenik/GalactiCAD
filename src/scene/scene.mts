import { ArgArray } from "../vecmat/arrays.mjs"
import { vec3, Vec3f } from "../vecmat/vector.mjs"
import { asRadius } from "./geom.mjs"

type Constructor<T = {}> = new (...args: any[]) => T

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
    compile(): string {
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
    override compile(): string {
        return this.children.map(c => c.compile()).join(";\n") + ";\n"
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
    override compile(): string {
        return !this.radius
            ? `min( ${this.lh.compile()}, ${this.rh.compile()} )`
            : `fOpUnionRound( ${this.lh.compile()}, ${this.rh.compile()}, ${this.radius} )`
    }
    constructor(lh: Node, rh: Node, public radius?: number) {
        super(lh, rh)
    }
}

export class Subtract extends BinaryOperator {
    override compile(): string {
        return this.radius === undefined
            ? `max( ${this.lh.compile()}, ${this.rh.compile()} )`
            : `fOpDifferenceRound( ${this.lh.compile()}, ${this.rh.compile()}, ${this.radius} )`
    }
    constructor(lh: Node, rh: Node, public radius?: number) {
        super(lh, rh)
    }
}

export class Sphere extends WithOpRadii(WithRaD(WithPos(Node))) {
    argIndex = {
        pos: 0,
        r: 0,
    }

    constructor({ pos, r, d }: { pos: Vec3f; r?: number; d?: number }) {
        super()
        this.pos = pos
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
    override compile(): string {
        return `fSphere( p - args[${this.argIndex.pos}].xyz, args[${this.argIndex.r}].x )`
    }
}

export class Box extends WithSize(WithPos(Node)) {
    argIndex = {
        pos: 0,
        size: 0,
    }

    constructor({ pos, l, w, h }: { pos: Vec3f; l: number; w: number; h: number }) {
        super()
        this.pos = pos
        this.size = vec3(l, w, h)
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
    override compile(): string {
        return `fBox( p - args[${this.argIndex.pos}].xyz, args[${this.argIndex.size}].xyz )`
    }
}
