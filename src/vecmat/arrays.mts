export class Vec4Array {
    private data: Float32Array

    constructor(numVectors: number) {
        this.data = new Float32Array(numVectors * 4)
    }

    public set(index: number, vec: Float32Array): void {
        if (vec.length !== 4) {
            throw new Error("Input vector must have exactly 4 elements")
        }
        const offset = index * 4
        if (offset < 0 || offset + 4 > this.data.length) {
            throw new Error("Index out of bounds")
        }
        this.data.set(vec, offset)
    }

    public get(index: number): Float32Array {
        const offset = index * 4
        if (offset < 0 || offset + 4 > this.data.length) {
            throw new Error("Index out of bounds")
        }
        return this.data.slice(offset, offset + 4)
    }
}
