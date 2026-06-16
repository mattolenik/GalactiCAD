/**
 * Lexical scope for the evaluator. OpenSCAD has three separate namespaces — variables,
 * functions, and modules — each looked up through the parent chain. Declarations capture the
 * scope they were defined in (lexical/static scoping); a call binds parameters in a child of
 * that defining scope. Variables are compile-time constants, last-assignment-wins per scope
 * (the caller pre-binds a block's assignments before evaluating its geometry).
 *
 * $-variable dynamic scoping is not modelled beyond `$children` (plan §3.3); since `$fn` etc.
 * are intentionally ignored for the smooth-SDF primitives, this is acceptable for now.
 */

import type { GeomNode } from "./geom-ir.mjs"
import type { FunctionDeclarationStmt, ModuleDeclarationStmt } from "./parser-imports.mjs"
import type { Value } from "./values.mjs"

/** A user module declaration plus the scope it was defined in (for lexical body evaluation). */
export interface ModuleDef {
    decl: ModuleDeclarationStmt
    scope: Scope
}

/** A user function declaration plus its defining scope. */
export interface FunctionDef {
    decl: FunctionDeclarationStmt
    scope: Scope
}

export class Scope {
    readonly #vars = new Map<string, Value>()
    readonly #modules = new Map<string, ModuleDef>()
    readonly #functions = new Map<string, FunctionDef>()

    /** Children geometry of the current user-module invocation; resolved by `children()`. */
    moduleChildren: GeomNode[] | null = null

    constructor(readonly parent: Scope | null = null) {}

    get(name: string): Value | undefined {
        return this.#vars.get(name) ?? this.parent?.get(name)
    }
    set(name: string, value: Value): void {
        this.#vars.set(name, value)
    }

    getModule(name: string): ModuleDef | undefined {
        return this.#modules.get(name) ?? this.parent?.getModule(name)
    }
    setModule(name: string, def: ModuleDef): void {
        this.#modules.set(name, def)
    }

    getFunction(name: string): FunctionDef | undefined {
        return this.#functions.get(name) ?? this.parent?.getFunction(name)
    }
    setFunction(name: string, def: FunctionDef): void {
        this.#functions.set(name, def)
    }

    /** Nearest enclosing module invocation's children, or null at top level. */
    getChildren(): GeomNode[] | null {
        return this.moduleChildren ?? this.parent?.getChildren() ?? null
    }

    child(): Scope {
        return new Scope(this)
    }
}
