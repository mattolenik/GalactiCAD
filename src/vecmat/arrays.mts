import { Vec2, Vec3, Vec4 } from "./vector.mjs"

export class ArgArray {
    data: Float32Array

    constructor(numArgs: number) {
        this.data = new Float32Array(numArgs * 4)
    }

    set(index: number, val: number | Float32Array | Vec2 | Vec3 | Vec4): void {
        const offset = this.offset(index)

        if (typeof val === "number") {
            val = new Float32Array([val, 0, 0, 0])
        } else if (val instanceof Vec2) {
            val = new Float32Array([val.elements[0], val.elements[1], 0, 0])
        } else if (val instanceof Vec3) {
            val = new Float32Array([val.elements[0], val.elements[1], val.elements[2], 0])
        } else if (val instanceof Vec4) {
            val = val.elements
        }
        if (val.length !== 4) {
            throw new Error("Input vector must have exactly 4 elements")
        }
        this.data.set(val, offset)
    }

    private offset(index: number) {
        const offset = index * 4
        if (offset < 0 || offset + 4 > this.data.length) {
            throw new Error("Index out of bounds")
        }
        return offset
    }

    get byteLength(): number {
        return this.data.byteLength
    }

    get length(): number {
        return this.data.length
    }
}
