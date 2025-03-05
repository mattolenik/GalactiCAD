import { Vec4Array } from "../vecmat/arrays.mjs"
import { Vec3, Vec4 } from "../vecmat/vector.mjs"
import { asRadius } from "./geom.mjs"

type Constructor<T = {}> = new (...args: any[]) => T

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

export class SceneArgsUniform {
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
    addArg(): number {
        return this.numArgs++
    }
}

export class Node {
    root!: Node
    _scene: SceneInfo
    get scene() {
        return this.root._scene
    }
    constructor() {
        this.root = this
        this._scene = new SceneInfo()
    }
    compile() {
        throw new Error("Method not implemented.")
    }
    uniformCopy(args: SceneArgsUniform) {
        throw new Error("Method not implemented.")
    }
    sceneSetup() {
        throw new Error("Method not implemented.")
    }
}

export class Group extends WithChildren(Node) {
    override uniformCopy(args: SceneArgsUniform) {
        for (let child of this.children) {
            child.uniformCopy(args)
        }
    }
    override sceneSetup() {
        for (let child of this.children) {
            child.sceneSetup()
        }
    }
    override compile(): string {
        return this.children.map((c) => c.compile()).join(";\n") + ";\n"
    }
    constructor(children: Node[] = []) {
        super()
        children.forEach((c) => this.add(c))
    }
    add(child: Node) {
        child.root = this.root
        child._scene = this.root._scene
        this.children.push(child)
    }
}

export abstract class UnaryOperator extends Node {
    override uniformCopy(args: SceneArgsUniform) {
        this.arg.uniformCopy(args)
    }
    override sceneSetup() {
        this.arg.sceneSetup()
    }
    constructor(public arg: Node) {
        super()
        arg.root = this.root
        arg._scene = this._scene
    }
}

export abstract class BinaryOperator extends Node {
    override uniformCopy(args: SceneArgsUniform) {
        this.lh.uniformCopy(args)
        this.rh.uniformCopy(args)
    }
    override sceneSetup() {
        this.lh.sceneSetup()
        this.rh.sceneSetup()
    }
    constructor(public lh: Node, public rh: Node) {
        super()
        lh.root = rh.root = this.root
        lh._scene = rh._scene = this._scene
    }
}

export class Union extends BinaryOperator {
    override compile(): string {
        return this.radius === undefined
            ? `opUnion( ${this.lh.compile()}, ${this.rh.compile()} )`
            : `opSmoothUnion( ${this.lh.compile()}, ${this.rh.compile()}, ${this.radius} )`
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
    override uniformCopy(args: SceneArgsUniform): void {
        this.args = args.args
        this.args.set(this.idx.pos, this.pos)
        this.args.set(this.idx.r, this.r)
    }
    override sceneSetup(): void {
        this.idx.pos = this.scene.addArg()
        this.idx.r = this.scene.addArg()
    }
    override compile(): string {
        return `sdSphere( args[${this.idx.pos}].xyz, args[${this.idx.r}].x )`
    }
}
