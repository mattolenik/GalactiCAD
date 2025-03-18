import { Vec2f, Vec3f, Vec4f } from "./vector.mjs"

export class ArgArray {
    data: Float32Array

    constructor(numArgs: number) {
        this.data = new Float32Array(numArgs * 4)
    }

    set(index: number, val: number | Float32Array | Vec2f | Vec3f | Vec4f): void {
        const offset = this.offset(index)

        if (typeof val === "number") {
            val = new Float32Array([val, 0, 0, 0])
        } else if (val instanceof Vec2f) {
            val = new Float32Array([val.data[0], val.data[1], 0, 0])
        } else if (val instanceof Vec3f) {
            val = new Float32Array([val.data[0], val.data[1], val.data[2], 1])
        } else if (val instanceof Vec4f) {
            val = val.data
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
