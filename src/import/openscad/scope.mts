/**
 * Lexical scope for the evaluator: a variable map with a parent chain. OpenSCAD variables are
 * compile-time constants with last-assignment-wins per scope (the caller pre-binds a block's
 * assignments before evaluating its geometry). $-variable dynamic scoping is TODO (plan §3.3).
 */

import type { Value } from "./values.mjs"

export class Scope {
    readonly #vars = new Map<string, Value>()

    constructor(readonly parent: Scope | null = null) {}

    get(name: string): Value | undefined {
        return this.#vars.get(name) ?? this.parent?.get(name)
    }

    set(name: string, value: Value): void {
        this.#vars.set(name, value)
    }

    child(): Scope {
        return new Scope(this)
    }
}
