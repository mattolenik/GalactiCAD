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

import { type Diagnostic, Diagnostics } from "./diagnostics.mjs"
import { type CodeFile, ParsingHelper } from "./parser-imports.mjs"
import { evalStatements } from "./eval-geom.mjs"
import { emitDocument } from "./emit.mjs"
import { EMPTY, group } from "./geom-ir.mjs"
import { Scope } from "./scope.mjs"

export interface ConvertResult {
    /** gcad DSL source text, ready to open as a new document. */
    dsl: string
    /** Parse errors + every construct that could not be mapped. */
    diagnostics: Diagnostic[]
}

export function convertOpenScadToGcad(scadSource: string, fileName = "import.scad"): ConvertResult {
    const diag = new Diagnostics()
    // Fabricate a CodeFile structurally so we never import the real class (it pulls fs/path,
    // which breaks the browser bundle). The lexer only reads .code / .path / .filename.
    const codeFile = { path: `/${fileName}`, code: scadSource, filename: fileName } as unknown as CodeFile
    const [ast, errors] = ParsingHelper.parseFile(codeFile)

    if (errors.hasErrors()) {
        for (const e of errors.errors) {
            const lineCol = e.codeLocation
            diag.error(e.message, (lineCol?.line ?? -1) + 1, (lineCol?.col ?? -1) + 1)
        }
    }

    const body = ast ? group(evalStatements(ast.statements, new Scope(), diag)) : EMPTY
    return { dsl: emitDocument(body, diag.list), diagnostics: diag.list }
}
