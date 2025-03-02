import { Vec3 } from "../vecmat/vecmat.mjs"
import { rOrD } from "./geom.mjs"

type Constructor<T = {}> = new (...args: any[]) => T

function WithOpRadii<TBase extends Constructor>(Base: TBase) {
    return class extends Base {
        opRadius = {
            union: 2,
            subtract: 2,
        }
    }
}

function WithRaD<TBase extends Constructor>(Base: TBase) {
    return class extends Base {
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

export abstract class Node {
    abstract compile(): string
    abstract walk(cb: (n: Node) => boolean): boolean
}

export class Group extends Node {
    walk(cb: (n: Node) => boolean): boolean {
        for (let child of this.children) {
            if (!cb(child)) {
                return false
            }
        }
        return true
    }
    compile(): string {
        return this.children.map((c) => c.compile()).join(";\n")
    }
    constructor(public children: Node[] = []) {
        super()
    }
}

class Shape extends Node {
    walk(cb: (n: Node) => boolean): boolean {
        throw new Error("Method not implemented.")
    }
    compile(): string {
        throw new Error("Method not implemented.")
    }
    constructor(public position: Vec3) {
        super()
    }
}

export class Sphere extends WithOpRadii(WithRaD(Shape)) {
    walk(cb: (n: Node) => boolean): boolean {
        return cb(this)
    }
    constructor({ pos, r, d }: { pos: Vec3; r: number | undefined; d: number | undefined }) {
        super(pos)
        this.r = rOrD(r, d)
    }

    compile(): string {
        return "sdSphere(pos, 4)"
    }
}

export abstract class Operator extends Node {}

export abstract class BinaryOperator extends Operator {
    walk(cb: (n: Node) => boolean): boolean {
        return cb(this) && this.lh.walk(cb) && this.rh.walk(cb)
    }
    compile(): string {
        throw new Error("Method not implemented.")
    }
    constructor(public lh: Node, public rh: Node) {
        super()
    }
}

export class Union extends BinaryOperator {
    walk(cb: (n: Node) => boolean): boolean {
        return super.walk(cb)
    }
    compile(): string {
        throw new Error("Method not implemented.")
    }
    constructor(lh: Node, rh: Node, public radius: number = 0) {
        super(lh, rh)
    }
}

export class Subtract extends BinaryOperator {
    walk(cb: (n: Node) => boolean): boolean {
        return super.walk(cb)
    }
    constructor(lh: Node, rh: Node, public radius: number = 0) {
        super(lh, rh)
    }
}
