import { Vec4 } from "./vecmat.mjs"

export class Vec4Array {
    data: Float32Array

    constructor(numVectors: number) {
        this.data = new Float32Array(numVectors * 4)
    }

    set(index: number, vec: Float32Array | Vec4): void {
        if (vec instanceof Vec4) {
            vec = vec.elements
        }
        if (vec.length !== 4) {
            throw new Error("Input vector must have exactly 4 elements")
        }
        const offset = index * 4
        if (offset < 0 || offset + 4 > this.data.length) {
            throw new Error("Index out of bounds")
        }
        this.data.set(vec, offset)
    }

    get(index: number): Vec4 {
        const offset = index * 4
        if (offset < 0 || offset + 4 > this.data.length) {
            throw new Error("Index out of bounds")
        }
        return new Vec4(this.data.slice(offset, offset + 4))
    }

    get byteLength(): number {
        return this.data.byteLength
    }

    get length(): number {
        return this.data.length / 4
    }
}
