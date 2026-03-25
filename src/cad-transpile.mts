/**
 * Transpile CAD source (TypeScript/JavaScript) to executable JavaScript using the TypeScript compiler.
 * Used by the transpile worker for scene builds. TypeScript remains in the main thread for
 * SourceParser (AST-based source matching).
 */

import * as ts from "typescript"
import { WRAP_PREFIX, WRAP_SUFFIX } from "./parser/source-parser.mjs"

function firstCompileErrorMessage(diagnostics: readonly ts.Diagnostic[] | undefined): string | undefined {
    if (!diagnostics?.length) return undefined
    for (const d of diagnostics) {
        if (d.category === ts.DiagnosticCategory.Error) {
            return ts.flattenDiagnosticMessageText(d.messageText, "\n")
        }
    }
    return undefined
}

/**
 * Transpile CAD source to JavaScript body suitable for new Function(...).
 * Wraps source in function _() { ... }, transpiles, and appends "return _();".
 * @throws Error with first diagnostic message on syntax/compile errors
 */
export function transpileCadSource(src: string): string {
    const wrapped = WRAP_PREFIX + src + WRAP_SUFFIX
    const result = ts.transpileModule(wrapped, {
        compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            esModuleInterop: true,
            skipLibCheck: true,
        },
        fileName: "cad-scene.ts",
        reportDiagnostics: true,
    })
    const errMsg = firstCompileErrorMessage(result.diagnostics)
    if (errMsg) {
        throw new Error(errMsg)
    }
    return result.outputText + "\nreturn _();"
}
