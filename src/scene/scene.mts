import { Vec4Array } from "../vecmat/arrays.mjs"
import { Vec3 } from "../vecmat/vector.mjs"
import { asRadius } from "./geom.mjs"

type Constructor<T = {}> = new (...args: any[]) => T

export class SceneUniform {
    args: Vec4Array

    constructor(numArgs: number) {
        this.args = new Vec4Array(numArgs)
    }

    get bufferSize(): number {
        return this.args.byteLength
    }

    writeBuffer(device: GPUDevice, buffer: GPUBuffer) {
        device.queue.writeBuffer(buffer, 0, this.args.data)
    }
}

export class SceneInfo {
    numArgs = 0
    nextArgIndex(): number {
        return this.numArgs++
    }
}

export class Node {
    root!: Node
    private _scene: SceneInfo
    get scene() {
        return this.root._scene
    }
    set scene(si: SceneInfo) {
        this.root._scene = si
    }
    constructor() {
        this.root = this
        this._scene = new SceneInfo()
    }
    compile() {
        throw new Error("Method not implemented.")
    }
    uniformCopy(args: SceneUniform) {
        throw new Error("Method not implemented.")
    }
    init(): Node {
        throw new Error("Method not implemented.")
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
    override init(): Group {
        for (let child of this.children) {
            child.root = this.root
            child.scene = this.scene
            child.init()
        }
        return this
    }
    override compile(): string {
        return this.children.map((c) => c.compile()).join(";\n") + ";\n"
    }
    constructor(children: Node[] = []) {
        super()
        this.children = children
        for (let child of children) {
            child.root = this.root
            child.scene = this.root.scene
        }
    }
}

export abstract class UnaryOperator extends Node {
    override uniformCopy(args: SceneUniform) {
        this.arg.uniformCopy(args)
    }
    override init(): UnaryOperator {
        this.arg.root = this.root
        this.arg.scene = this.scene
        this.arg.init()
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
    override init(): BinaryOperator {
        this.lh.root = this.root
        this.rh.root = this.root
        this.lh.scene = this.scene
        this.rh.scene = this.scene
        this.lh.init()
        this.rh.init()
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
    override init(): Union {
        super.init()
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
    override init(): Subtract {
        super.init()
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
    private args!: Vec4Array

    constructor({ pos, r, d }: { pos: Vec3; r?: number; d?: number }) {
        super()
        this.pos = pos
        this.r = asRadius(r, d)
    }
    override uniformCopy(args: SceneUniform): void {
        this.args = args.args
        this.args.set(this.idx.pos, this.pos)
        this.args.set(this.idx.r, this.r)
    }
    override init(): Sphere {
        this.idx.pos = this.scene.nextArgIndex()
        this.idx.r = this.scene.nextArgIndex()
        return this
    }
    override compile(): string {
        return `sdSphere( args[${this.idx.pos}].xyz, args[${this.idx.r}].x )`
    }
}
