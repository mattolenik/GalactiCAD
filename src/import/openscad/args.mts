/**
 * Argument parsing shared by built-in handlers, user-module calls, and user-function calls.
 * OpenSCAD packs positional and named arguments into one `AssignmentNode[]`: positional args
 * have an empty `name`, named args (`name = value`) have it populated.
 */

import type { AssignmentNode, Expression } from "./parser-imports.mjs"

export interface Args {
    pos: Expression[]
    named: Map<string, Expression>
}

export function parseArgs(args: AssignmentNode[]): Args {
    const pos: Expression[] = []
    const named = new Map<string, Expression>()
    for (const a of args) {
        if (!a.value) continue
        if (a.name === "") pos.push(a.value)
        else named.set(a.name, a.value)
    }
    return { pos, named }
}
