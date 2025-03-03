import { Vec3 } from "../vecmat/vecmat.mjs"
import { rOrD } from "./geom.mjs"

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

export class IndexMapping {
    topVec2 = -1
    topVec3 = -1
    topFloat = -1
}

export class SceneArgsUniform {
    float: Float32Array
    vec3: Vec3[]

    constructor(numFloatArgs: number, numVec3Args: number) {
        this.float = new Float32Array(numFloatArgs)
        this.vec3 = new Array(numVec3Args)
    }
}

export class Node {
    compile() {
        throw new Error("Method not implemented.")
    }
    uniformCopy(args: SceneArgsUniform) {
        throw new Error("Method not implemented.")
    }
    mapUniformArgs(im: IndexMapping) {
        throw new Error("Method not implemented.")
    }
}

export class Group extends WithChildren(Node) {
    override uniformCopy(args: SceneArgsUniform) {
        for (let child of this.children) {
            child.uniformCopy(args)
        }
    }
    override mapUniformArgs(im: IndexMapping) {
        for (let child of this.children) {
            child.mapUniformArgs(im)
        }
    }
    override compile(): string {
        return this.children.map((c) => c.compile()).join(";\n")
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
    override mapUniformArgs(im: IndexMapping) {
        this.arg.mapUniformArgs(im)
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
    override mapUniformArgs(im: IndexMapping) {
        this.lh.mapUniformArgs(im)
        this.rh.mapUniformArgs(im)
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
    constructor(lh: Node, rh: Node, public radius: number | undefined = undefined) {
        super(lh, rh)
    }
}

export class Subtract extends BinaryOperator {
    override compile(): string {
        return this.radius === undefined
            ? `opSubtract( ${this.lh.compile()}, ${this.rh.compile()} )`
            : `opSmoothSubtract( ${this.lh.compile()}, ${this.rh.compile()}, ${this.radius} )`
    }
    constructor(lh: Node, rh: Node, public radius: number | undefined = undefined) {
        super(lh, rh)
    }
}

export class Sphere extends WithOpRadii(WithRaD(WithPos(Node))) {
    idx = {
        pos: 0,
        r: 0,
    }
    constructor({ pos, r, d }: { pos: Vec3; r: number | undefined; d: number | undefined }) {
        super()
        this.pos = pos
        this.r = rOrD(r, d)
    }
    override uniformCopy(args: SceneArgsUniform): void {
        args.vec3[this.idx.pos] = this.pos
        args.float.set([this.r], this.idx.r)
    }
    override mapUniformArgs(im: IndexMapping): void {
        this.idx.pos = im.topVec3++
        this.idx.r = im.topFloat++
    }
    override compile(): string {
        return `sdSphere( scene.vec3[${this.idx.pos}], scene.float[${this.idx.r}] )`
    }
}
