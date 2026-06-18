/**
 * On-thread TypeScript language-service environment for the CAD DSL, backed by
 * @typescript/vfs. This restores the IntelliSense Monaco's ts.worker used to
 * provide (completion, hover, type-error diagnostics) without Monaco.
 *
 * The CAD ambient API types (`CAD_TYPES_DECL`) are seeded as `/cad-api.d.ts` —
 * the direct analog of Monaco's `addExtraLib(CAD_TYPES_DECL, "file:///cad-api.d.ts")`.
 * The lib.*.d.ts files are bundled locally via the `ts-libs` virtual module
 * (build/ts-libs-plugin.mts), so type-checking works fully offline.
 *
 * NOTE: the environment runs on the main thread (the `typescript` compiler is
 * already in the bundle). Moving it into a Web Worker via @valtown/codemirror-ts's
 * `*Worker` variants + comlink is a possible follow-up if large documents cause
 * UI jank; the CAD documents are small, so on-thread is fine for now.
 */

import * as ts from "typescript"
import {
    createSystem,
    createVirtualTypeScriptEnvironment,
    type VirtualTypeScriptEnvironment,
} from "@typescript/vfs"
import libs from "ts-libs"
import { CAD_TYPES_DECL } from "../scene/cad-types-decl.mjs"

/** Virtual path of the editor's active document inside the TS environment. */
export const CAD_DOC_PATH = "/cad-document.ts"
const CAD_TYPES_PATH = "/cad-api.d.ts"

/**
 * 1108 = "A 'return' statement can only be used within a function body" — the user
 * can write a top-level `return` (legal once the source is wrapped in `function _(){}`
 * at execution time), so this diagnostic is suppressed (matches the old Monaco config).
 */
export const DIAGNOSTIC_CODES_TO_IGNORE = [1108]

/** Compiler options mirror the former Monaco `cadCompilerOptions` (app.mts). DOM lib
 *  is omitted on purpose so completions aren't flooded with DOM globals. */
const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.None,
    lib: ["esnext"],
    strict: false,
    noImplicitAny: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    allowUnreachableCode: true,
}

/**
 * Create the CAD TypeScript environment (lib files + ambient CAD API).
 *
 * The active document file (CAD_DOC_PATH) is intentionally NOT seeded here: the
 * vfs host treats an empty file as "not found" (TS6053), so the document is
 * created on first sync with non-empty content (see ts-language.mts).
 */
export function createCadTsEnvironment(): VirtualTypeScriptEnvironment {
    const fsMap = new Map<string, string>(Object.entries(libs))
    fsMap.set(CAD_TYPES_PATH, CAD_TYPES_DECL)
    const system = createSystem(fsMap)
    return createVirtualTypeScriptEnvironment(system, [CAD_TYPES_PATH], ts, compilerOptions)
}
