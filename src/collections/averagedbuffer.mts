// Keeps a running buffered average, for e.g. input smoothing
export class AveragedBuffer {
    #array: Float32Array
    #i = 0
    #sum = 0

    constructor(length: number) {
        if (length <= 0) throw new Error("length must be > 0")
        this.#array = new Float32Array(length)
    }

    update(value: number): void {
        const old = this.#array[this.#i] ?? 0
        this.#sum += value - old
        this.#array[this.#i] = value
        this.#i = (this.#i + 1) % this.#array.length
    }

    get average(): number {
        return this.#sum / this.#array.length
    }

    reset(): void {
        this.#array.fill(0)
        this.#sum = 0
        this.#i = 0
    }
}
