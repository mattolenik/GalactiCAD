/**
 * Lightweight constants shared between the TS language-service worker
 * (ts-worker.mts / ts-environment.mts) and the main-thread CodeMirror client
 * (ts-language.mts).
 *
 * This module has NO heavy imports (no `typescript`, no `@typescript/vfs`, no
 * bundled libs) on purpose: the client imports it without pulling the compiler
 * or the lib.*.d.ts payload into app.js — that all lives in the worker bundle.
 */

/** Virtual path of the editor's active document inside the TS environment. */
export const CAD_DOC_PATH = "/cad-document.ts"

/**
 * 1108 = "A 'return' statement can only be used within a function body" — the user
 * can write a top-level `return` (legal once the source is wrapped in `function _(){}`
 * at execution time), so this diagnostic is suppressed (matches the old Monaco config).
 */
export const DIAGNOSTIC_CODES_TO_IGNORE = [1108]
