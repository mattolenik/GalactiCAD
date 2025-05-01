import { Vec2f, Vec3f, Vec4f } from "../vecmat/vector.mjs"

export interface Storable {
    toStorage(): string
    loadStorage(s: string): void
}

export class LocalStorage {
    getItem(key: string) {
        return this.#store.getItem(key)
    }
    setItem(key: string, val: string) {
        this.#store.setItem(key, val)
    }
    removeItem(key: string) {
        this.#store.removeItem(key)
    }
    #prefix: string
    #store: Storage

    constructor(store: Storage = localStorage, namespace: string = "") {
        this.#store = store
        this.#prefix = namespace ? `${namespace}:` : ""
    }

    setFloat(key: string, value: number): void {
        this.#store.setItem(this.#prefix + key, value.toString())
    }

    getFloat(key: string): number | undefined {
        const item = this.#store.getItem(this.#prefix + key)
        if (item === null) return undefined
        return parseFloat(item)
    }

    setInt(key: string, value: number): void {
        this.#store.setItem(this.#prefix + key, value.toFixed(0))
    }

    getInt(key: string): number | undefined {
        const item = this.#store.getItem(this.#prefix + key)
        if (item === null) return undefined
        return parseInt(item, 10)
    }

    getVec2f(key: string): Vec2f {
        return new Vec2f(this.#store.getItem(this.#prefix + key))
    }

    setVec3f(key: string, value: Vec3f): void {
        this.#store.setItem(this.#prefix + key, value.toStorage())
    }

    getVec3f(key: string): Vec3f {
        return new Vec3f(this.#store.getItem(this.#prefix + key))
    }

    setVec4f(key: string, value: Vec4f): void {
        this.#store.setItem(this.#prefix + key, value.toStorage())
    }

    getVec4f(key: string): Vec4f {
        return new Vec4f(this.#store.getItem(this.#prefix + key))
    }
}

export function locallyStored<T extends Storable>(storage: LocalStorage, key: string, defaultValue: T) {
    return function (
        target: ClassAccessorDecoratorTarget<unknown, T>,
        context: ClassAccessorDecoratorContext<unknown, T>
    ): ClassAccessorDecoratorResult<unknown, T> {
        return {
            // runs once on instance construction
            init(initialValue: T): T {
                const raw = storage.getItem(key)
                if (raw === null) return defaultValue
                if (typeof initialValue === "object" && "loadStorage" in initialValue) {
                    initialValue.loadStorage(raw)
                    return initialValue
                } else {
                    return JSON.parse(initialValue)
                }
            },

            // subsequent reads return the in-memory slot
            get(this: unknown): T {
                return context.access.get(this)
            },

            // writes persist and update the slot
            set(this: unknown, value: T) {
                if (value === null || value === undefined) {
                    storage.removeItem(key)
                }
                storage.setItem(key, value?.toStorage() ?? JSON.stringify(value))
                context.access.set(this, value)
            },
        }
    }
}
