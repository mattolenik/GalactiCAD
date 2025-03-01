import { Vec4 } from "../vecmat/vecmat.mjs"

export abstract class Node {
    tags: Map<string, any> = new Map<string, any>()
}

export class Group extends Node {
    constructor(public children: Node[] = []) {
        super()
    }
}

export class Shape extends Node {
    constructor(public position: Vec4) {
        super()
    }
}

export abstract class Operator extends Node {}

export class BinaryOperator extends Operator {
    constructor(public lh: Node, public rh: Node) {
        super()
    }
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
