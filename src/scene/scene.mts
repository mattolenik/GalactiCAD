import { ArgArray } from "../vecmat/arrays.mjs"
import { Vec3 } from "../vecmat/vector.mjs"
import { asRadius } from "./geom.mjs"

type Constructor<T = {}> = new (...args: any[]) => T

export class SceneUniform {
    args: ArgArray
    root: Node

    constructor(root: Node) {
        this.root = root
        this.args = new ArgArray(this.root.scene.numArgs)
    }

    get bufferSize(): number {
        return this.args.byteLength
    }

    writeBuffer(device: GPUDevice, buffer: GPUBuffer) {
        device.queue.writeBuffer(buffer, 0, this.args.data)
        console.log(this.args.data)
    }
}

export class SceneInfo {
    private nodeByID = new Map<number, Node>()
    private nodes = new Set<Node>()

    numArgs = 0
    numNodes = 0
    nextArgIndex(): number {
        this.nodeByID.values
        return this.numArgs++
    }
    add(node: Node) {
        if (this.nodes.has(node)) return

        node.id = this.numNodes++
        this.nodes.add(node)
        this.nodeByID.set(node.id, node)
    }
    get<T extends Node>(id: number): T {
        return this.nodeByID.get(id) as T
    }
}

export class Node {
    id!: number
    root: Node
    private _scene!: SceneInfo

    get scene() {
        return this.root._scene
    }
    set scene(si: SceneInfo) {
        this.root._scene = si
    }

    constructor() {
        this.root = this
    }
    compile() {
        throw new Error("Method not implemented.")
    }
    uniformCopy(args: SceneUniform) {
        throw new Error("Method not implemented.")
    }
    init(si: SceneInfo): Node {
        this.scene = si
        this.scene.add(this)
        return this
    }
}

function WithChildren<TBase extends Constructor>(base: TBase) {
    return class extends base {
        children: Node[] = []
    }
}

function WithPos<TBase extends Constructor>(base: TBase) {
    return class extends base {
        pos: Vec3 = new Vec3(0, 0, 0)
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
        r: number = -1
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

export class Group extends WithChildren(Node) {
    override uniformCopy(args: SceneUniform) {
        for (let child of this.children) {
            child.uniformCopy(args)
        }
    }
    override init(si: SceneInfo): Group {
        super.init(si)
        for (let child of this.children) {
            child.root = this.root
            child.init(si)
        }
        return this
    }
    override compile(): string {
        return this.children.map((c) => c.compile()).join(";\n") + ";\n"
    }
    constructor(...children: Node[]) {
        super()
        this.children = children
        for (let child of children) {
            child.root = this.root
        }
    }
}

export abstract class UnaryOperator extends Node {
    override uniformCopy(args: SceneUniform) {
        this.arg.uniformCopy(args)
    }
    override init(si: SceneInfo): UnaryOperator {
        super.init(si)
        this.arg.root = this.root
        this.arg.init(si)
        return this
    }
    constructor(public arg: Node) {
        super()
    }
}

export abstract class BinaryOperator extends Node {
    override uniformCopy(args: SceneUniform) {
        this.lh.uniformCopy(args)
        this.rh.uniformCopy(args)
    }
    override init(si: SceneInfo): BinaryOperator {
        super.init(si)
        this.lh.root = this.root
        this.rh.root = this.root
        this.lh.init(si)
        this.rh.init(si)
        return this
    }
    constructor(public lh: Node, public rh: Node) {
        super()
    }
}

export class Union extends BinaryOperator {
    override compile(): string {
        return this.radius === undefined
            ? `opUnion( ${this.lh.compile()}, ${this.rh.compile()} )`
            : `opSmoothUnion( ${this.lh.compile()}, ${this.rh.compile()}, ${this.radius} )`
    }
    override init(si: SceneInfo): Union {
        super.init(si)
        return this
    }
    constructor(lh: Node, rh: Node, public radius?: number) {
        super(lh, rh)
    }
}

export class Subtract extends BinaryOperator {
    override compile(): string {
        return this.radius === undefined
            ? `opSubtract( ${this.lh.compile()}, ${this.rh.compile()} )`
            : `opSmoothSubtract( ${this.lh.compile()}, ${this.rh.compile()}, ${this.radius} )`
    }
    override init(si: SceneInfo): Subtract {
        super.init(si)
        return this
    }
    constructor(lh: Node, rh: Node, public radius?: number) {
        super(lh, rh)
    }
}

export class Sphere extends WithOpRadii(WithRaD(WithPos(Node))) {
    idx = {
        pos: 0,
        r: 0,
    }

    constructor({ pos, r, d }: { pos: Vec3; r?: number; d?: number }) {
        super()
        this.pos = pos
        this.r = asRadius(r, d)
    }
    override uniformCopy(args: SceneUniform): void {
        args.args.set(this.idx.pos, this.pos)
        args.args.set(this.idx.r, this.r)
    }
    override init(si: SceneInfo): Sphere {
        super.init(si)
        this.idx.pos = this.scene.nextArgIndex()
        this.idx.r = this.scene.nextArgIndex()
        return this
    }
    override compile(): string {
        return `sdSphere( p - args[${this.idx.pos}].xyz, args[${this.idx.r}].x )`
    }
}
