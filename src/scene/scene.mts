import { Vec4Array } from "../vecmat/arrays.mjs"
import { asVec4, Vec2, vec3, Vec3, Vec4 } from "../vecmat/vecmat.mjs"
import { asRadius } from "./geom.mjs"

type Constructor<T = {}> = new (...args: any[]) => T

function WithChildren<TBase extends Constructor>(base: TBase) {
    return class extends base {
        children: Node[] = []
    }
}

function WithPos<TBase extends Constructor>(base: TBase) {
    return class extends base {
        pos: Vec3 = vec3(0, 0, 0)
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

export class SceneInitState {
    numArgs = 0
    addArg() {
        return this.numArgs++
    }
}

export class SceneArgsUniform {
    args: Vec4Array

    constructor(state: SceneInitState) {
        this.args = new Vec4Array(state.numArgs)
    }

    get bufferSize(): number {
        return this.args.byteLength
    }

    writeBuffer(device: GPUDevice, buffer: GPUBuffer) {
        device.queue.writeBuffer(buffer, 0, this.args.data)
    }
}

export class Node {
    compile() {
        throw new Error("Method not implemented.")
    }
    uniformCopy(args: SceneArgsUniform) {
        throw new Error("Method not implemented.")
    }
    uniformSetup(im: SceneInitState) {
        throw new Error("Method not implemented.")
    }
}

export class Group extends WithChildren(Node) {
    override uniformCopy(args: SceneArgsUniform) {
        for (let child of this.children) {
            child.uniformCopy(args)
        }
    }
    override uniformSetup(state: SceneInitState) {
        for (let child of this.children) {
            child.uniformSetup(state)
        }
    }
    override compile(): string {
        return this.children.map((c) => c.compile()).join(";\n") + ";\n"
    }
    constructor(children: Node[] = []) {
        super()
        this.children = children
    }
}

export abstract class UnaryOperator extends Node {
    override uniformCopy(args: SceneArgsUniform) {
        this.arg.uniformCopy(args)
    }
    override uniformSetup(state: SceneInitState) {
        this.arg.uniformSetup(state)
    }
    constructor(public arg: Node) {
        super()
    }
}

export abstract class BinaryOperator extends Node {
    override uniformCopy(args: SceneArgsUniform) {
        this.lh.uniformCopy(args)
        this.rh.uniformCopy(args)
    }
    override uniformSetup(state: SceneInitState) {
        this.lh.uniformSetup(state)
        this.rh.uniformSetup(state)
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
    constructor({ pos, r, d }: { pos: Vec3; r?: number; d?: number }) {
        super()
        this.pos = pos
        this.r = asRadius(r, d)
    }
    override uniformCopy(args: SceneArgsUniform): void {
        args.args.set(this.idx.pos, this.pos.xyz0)
        args.args.set(this.idx.r, asVec4(this.r))
    }
    override uniformSetup(state: SceneInitState): void {
        this.idx.pos = state.addArg()
        this.idx.r = state.addArg()
    }
    override compile(): string {
        return `sdSphere( args[${this.idx.pos}].xyz, args[${this.idx.r}].x )`
    }
}
