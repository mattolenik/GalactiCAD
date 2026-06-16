/**
 * Parsing helpers shared by the converter and the include-gather pass. Wraps openscad-parser
 * with a structurally-fabricated CodeFile (so the fs/path-pulling class is never imported — see
 * parser-imports.mts) and a top-level `use`/`include` scan.
 */

import { type CodeFile, IncludeStmt, ParsingHelper, type ScadFile, UseStmt } from "./parser-imports.mjs"

export function parseScad(src: string, fileName: string): ReturnType<typeof ParsingHelper.parseFile> {
    const codeFile = { path: `/${fileName}`, code: src, filename: fileName } as unknown as CodeFile
    return ParsingHelper.parseFile(codeFile)
}

/** The filenames referenced by top-level `use <...>` / `include <...>` directives. */
export function findIncludeRefs(ast: ScadFile): string[] {
    const refs: string[] = []
    for (const s of ast.statements) {
        if (s instanceof UseStmt || s instanceof IncludeStmt) refs.push(s.filename)
    }
    return refs
}
