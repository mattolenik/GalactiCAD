/**
 * Public entry point for the OpenSCAD → gcad importer.
 *
 *   convertOpenScadToGcad(scadSource) → { dsl, diagnostics }
 *
 * In-memory and on-demand: the caller opens `dsl` as a new gcad document (saved as `.gcad`
 * like any other) and surfaces `diagnostics` to the user. See the design docs:
 *   docs/research/openscad-importer-feasibility.md
 *   docs/research/openscad-importer-implementation-plan.md
 *
 * SCAFFOLD: a CSG-core vertical slice (plan Phase 0/1). Unmapped constructs are dropped and
 * reported as diagnostics rather than failing the import.
 */

import { Ctx } from "./context.mjs"
import { type Diagnostic, Diagnostics } from "./diagnostics.mjs"
import { emitDocument } from "./emit.mjs"
import { evalStatements } from "./eval-geom.mjs"
import { EMPTY, type GeomNode, group } from "./geom-ir.mjs"
import { parseScad } from "./parse.mjs"
import { Scope } from "./scope.mjs"

export interface ConvertResult {
    /** gcad DSL source text, ready to open as a new document. */
    dsl: string
    /** Parse errors + every construct that could not be mapped. */
    diagnostics: Diagnostic[]
}

/**
 * @param includeSources Pre-fetched `use`/`include` sources keyed by the filename as written
 *   (gather them with gatherIncludeSources). Omit for single-file imports.
 */
export function convertOpenScadToGcad(
    scadSource: string,
    fileName = "import.scad",
    includeSources?: Map<string, string>,
): ConvertResult {
    const diag = new Diagnostics()
    const [ast, errors] = parseScad(scadSource, fileName)
    reportParseErrors(errors, fileName, diag, "error")

    let body: GeomNode = EMPTY
    if (ast) {
        const ctx = new Ctx(diag)
        for (const [name, text] of includeSources ?? []) {
            const [iast, ierrors] = parseScad(text, name)
            if (iast) ctx.includes.set(name, iast)
            reportParseErrors(ierrors, name, diag, "warn")
        }
        try {
            body = group(evalStatements(ast.statements, new Scope(), ctx))
        } catch (e) {
            // Never crash the import: a runaway recursion / unexpected error becomes a diagnostic.
            diag.error(`import aborted: ${e instanceof Error ? e.message : String(e)}`)
            body = EMPTY
        }
    }
    return { dsl: emitDocument(body, diag.list), diagnostics: diag.list }
}

function reportParseErrors(
    errors: ReturnType<typeof parseScad>[1],
    fileName: string,
    diag: Diagnostics,
    severity: "error" | "warn",
): void {
    if (!errors.hasErrors()) return
    for (const e of errors.errors) {
        const at = e.codeLocation
        const msg = fileName === "import.scad" ? e.message : `in ${fileName}: ${e.message}`
        diag[severity](msg, (at?.line ?? -1) + 1, (at?.col ?? -1) + 1)
    }
}
