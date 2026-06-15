/**
 * Async gather pass: walk a `.scad` file's transitive `use`/`include` graph and fetch each
 * referenced file's source via a caller-supplied resolver (the browser folder/prompt logic, or
 * an in-memory map in tests). Returns filename → source, ready to hand to convertOpenScadToGcad.
 *
 * This is the only async part of import; the evaluator stays synchronous and pure.
 */

import { findIncludeRefs, parseScad } from "./parse.mjs"

/** Resolve an include/use path to source text, or null if it can't be found. May be interactive. */
export type IncludeResolver = (path: string) => Promise<string | null>

export async function gatherIncludeSources(src: string, resolve: IncludeResolver): Promise<Map<string, string>> {
    const sources = new Map<string, string>()
    const visited = new Set<string>()

    async function walk(text: string): Promise<void> {
        const [ast] = parseScad(text, "scan.scad")
        if (!ast) return
        for (const ref of findIncludeRefs(ast)) {
            if (visited.has(ref)) continue
            visited.add(ref)
            const resolved = await resolve(ref)
            if (resolved == null) continue
            sources.set(ref, resolved)
            await walk(resolved)
        }
    }

    await walk(src)
    return sources
}
