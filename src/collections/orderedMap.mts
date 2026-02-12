export class OrderedMap<K, V> implements Iterable<[K, V]> {
    #map = new Map<K, V>()
    #order: K[] = []

    constructor(entries?: readonly (readonly [K, V])[] | null) {
        if (entries) {
            for (const [k, v] of entries) {
                this.set(k, v)
            }
        }
    }

    set(key: K, value: V): this {
        if (!this.#map.has(key)) {
            this.#order.push(key)
        }
        this.#map.set(key, value)
        return this
    }

    get(key: K): V | undefined {
        return this.#map.get(key)
    }

    has(key: K): boolean {
        return this.#map.has(key)
    }

    delete(key: K): boolean {
        if (!this.#map.has(key)) return false
        this.#map.delete(key)
        const idx = this.#order.indexOf(key)
        if (idx !== -1) this.#order.splice(idx, 1)
        return true
    }

    clear(): void {
        this.#map.clear()
        this.#order = []
    }

    get size(): number {
        return this.#map.size
    }

    // Ordered iteration
    *entries(): IterableIterator<[K, V]> {
        for (const k of this.#order) {
            // non-null because key was in map
            yield [k, this.#map.get(k)!]
        }
    }

    *keys(): IterableIterator<K> {
        yield* this.#order
    }

    *values(): IterableIterator<V> {
        for (const k of this.#order) {
            yield this.#map.get(k)!
        }
    }

    [Symbol.iterator](): IterableIterator<[K, V]> {
        return this.entries()
    }

    forEach(callback: (value: V, key: K, map: OrderedMap<K, V>) => void, thisArg?: any): void {
        for (const k of this.#order) {
            callback.call(thisArg, this.#map.get(k)!, k, this)
        }
    }

    /** Return the key at the given index, or undefined if out of bounds */
    keyAt(index: number): K | undefined {
        if (index < 0 || index >= this.#order.length) return undefined
        return this.#order[index]
    }

    /** Move the key at fromIndex to toIndex (0 to n inclusive). No-op if indices are equal or out of bounds. */
    moveToIndex(fromIndex: number, toIndex: number): void {
        const n = this.#order.length
        if (fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex > n || fromIndex === toIndex) return
        const key = this.#order[fromIndex]
        this.#order.splice(fromIndex, 1)
        const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex
        this.#order.splice(insertAt, 0, key)
    }
}
