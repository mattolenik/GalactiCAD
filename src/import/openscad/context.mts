/**
 * Per-conversion evaluation context: the diagnostics sink, a mutable call-depth guard, and the
 * pre-resolved `use`/`include` ASTs (fetched by the async gather pass, consumed by the sync
 * evaluator). The depth guard bounds user module/function recursion so a runaway recursive
 * `.scad` can't hang or stack-overflow the import. See implementation plan §3.3.
 */

import type { Diagnostics } from "./diagnostics.mjs"
import type { ScadFile } from "./parser-imports.mjs"

export class Ctx {
    /** Current user module/function call depth (incremented on entry, decremented on exit). */
    depth = 0

    /** Pre-parsed `use`/`include` targets, keyed by the filename as written in the directive. */
    readonly includes = new Map<string, ScadFile>()
    /** include/use filenames already hoisted (declaration pass) — cycle guard. */
    readonly hoisted = new Set<string>()
    /** include filenames already inlined (geometry pass) — cycle + diamond-dedup guard. */
    readonly expanded = new Set<string>()

    constructor(
        readonly diag: Diagnostics,
        /** Hard cap on recursion depth; exceeding it yields a diagnostic + empty result. */
        readonly maxDepth = 1000,
    ) {}
}
