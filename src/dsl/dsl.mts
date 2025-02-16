export abstract class Node {
    Tags = new Map<string, any>()

    public Tag<T>(key: string): T
    public Tag<T>(key: string, val: T): T
    public Tag<T>(key: string, val?: T): T {
        if (arguments.length === 1) {
            return this.Tags.get(key) as T
        }
        const old = this.Tags.get(key)
        this.Tags.set(key, val)
        return old
    }
}

export class Shape extends Node {
    // Position: Vec4
    constructor() {
        super()
        this.Tag("accents.smoothing.radius", 2)
    }
}
