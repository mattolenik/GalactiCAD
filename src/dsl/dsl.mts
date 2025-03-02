import { Vec3 } from "../vecmat/vecmat.mjs"

type Constructor<T = {}> = new (...args: any[]) => T

function WithOpRadii<TBase extends Constructor>(Base: TBase) {
    return class extends Base {
        opRadius = {
            union: 0,
            subtract: 0,
            smooth: {
                union: 2,
                subtract: 2,
            },
        }
    }
}

export abstract class Node {}

export class Group extends Node {
    constructor(public children: Node[] = []) {
        super()
    }
}

class ShapeBase extends Node {
    constructor(public position: Vec3) {
        super()
    }
}

export class Shape extends WithOpRadii(ShapeBase) {}

export class Sphere extends Shape {
    r: number
    get d(): number {
        return this.r * 2
    }

    constructor({ pos, r, d }: { pos: Vec3; r: number | undefined; d: number | undefined }) {
        super(pos)
        this.r = rOrD(r, d)
    }

    toTree() {}
}

// returns a radius given a radius or diameter. One of the two must be undefined, otherwise it throws.
function rOrD(r: number | undefined, d: number | undefined): number {
    if (r == undefined && d == undefined) {
        throw new Error("either radius or diameter must be specified")
    }
    if (r != undefined && d == undefined) {
        if (r <= 0) {
            throw new Error("radius must be greater than 0")
        }
        return r
    }
    if (r == undefined && d != undefined) {
        if (d <= 0) {
            throw new Error("diameter must be greater than 0")
        }
        return d / 2
    }
    throw new Error("cannot define both radius and diameter")
}

export abstract class Operator extends Node {}

export class BinaryOperator extends Operator {
    constructor(public lh: Node, public rh: Node) {
        super()
    }
    toTree() {}
}

export class Union extends BinaryOperator {
    constructor(lh: Node, rh: Node, public radius: number = 0) {
        super(lh, rh)
    }
}

export class Subtract extends BinaryOperator {
    constructor(lh: Node, rh: Node, public radius: number = 0) {
        super(lh, rh)
    }
}
