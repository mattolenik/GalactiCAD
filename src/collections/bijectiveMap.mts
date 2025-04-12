export class BijectiveMap<TKey, TValue> implements Map<TKey, TValue> {
    #forward: Map<TKey, TValue> = new Map()
    #backward: Map<TValue, TKey> = new Map()

    // Core methods to maintain bijection
    set(key: TKey, value: TValue): this {
        const existingValue = this.#forward.get(key)
        const existingKey = this.#backward.get(value)

        // If assigning same pair, allow it
        if (existingValue === value && existingKey === key) {
            return this
        }

        // Enforce bijection: delete existing associations
        if (existingValue !== undefined) {
            this.#backward.delete(existingValue)
        }
        if (existingKey !== undefined) {
            this.#forward.delete(existingKey)
        }

        this.#forward.set(key, value)
        this.#backward.set(value, key)
        return this
    }

    get(key: TKey): TValue | undefined {
        return this.#forward.get(key)
    }

    getInverse(value: TValue): TKey | undefined {
        return this.#backward.get(value)
    }

    has(key: TKey): boolean {
        return this.#forward.has(key)
    }

    hasValue(value: TValue): boolean {
        return this.#backward.has(value)
    }

    delete(key: TKey): boolean {
        if (!this.#forward.has(key)) return false
        const value = this.#forward.get(key)!
        this.#forward.delete(key)
        this.#backward.delete(value)
        return true
    }

    clear(): void {
        this.#forward.clear()
        this.#backward.clear()
    }

    get size(): number {
        return this.#forward.size
    }

    entries(): IterableIterator<[TKey, TValue]> {
        return this.#forward.entries()
    }

    keys(): IterableIterator<TKey> {
        return this.#forward.keys()
    }

    values(): IterableIterator<TValue> {
        return this.#forward.values()
    }

    forEach(callbackfn: (value: TValue, key: TKey, map: Map<TKey, TValue>) => void, thisArg?: any): void {
        this.#forward.forEach((value, key) => {
            callbackfn.call(thisArg, value, key, this)
        })
    }

    [Symbol.iterator](): IterableIterator<[TKey, TValue]> {
        return this.entries()
    }

    // Additional property (read-only view)
    get inverse(): Map<TValue, TKey> {
        return new Map(this.#backward)
    }

    // Required by TypeScript to fulfill Map interface
    readonly [Symbol.toStringTag]: string = "BijectiveMap"
}
