/**
 * CodeMirror 6 language-service integration for the CAD DSL: completion, hover,
 * and type-error diagnostics from an on-thread @typescript/vfs environment, via
 * @valtown/codemirror-ts. This replaces the IntelliSense Monaco's ts.worker gave us.
 *
 * Document syncing is driven by the caller (CodeEditor.onUpdate) rather than the
 * library's `tsSync`: `tsSync` shares one "first load" flag across all states, so
 * with one editor + many tab states it would only sync the first document. Driving
 * `sync()` from the always-on update listener handles typing AND tab switches (the
 * post-setState selection dispatch produces an update), keeping a single vfs path.
 *
 * The completion source is registered as JS/TS language data so it composes with
 * the base `javascript()` grammar + `autocompletion()` already in CodeEditor.
 */

import type { Extension } from "@codemirror/state"
import { javascriptLanguage } from "@codemirror/lang-javascript"
import { tsAutocomplete, tsFacet, tsHover, tsLinter } from "@valtown/codemirror-ts"
import type { VirtualTypeScriptEnvironment } from "@typescript/vfs"
import { CAD_DOC_PATH, createCadTsEnvironment, DIAGNOSTIC_CODES_TO_IGNORE } from "./ts-environment.mjs"

/** In TypeScript a file must be created before it can be updated. */
function createOrUpdateFile(env: VirtualTypeScriptEnvironment, path: string, code: string): void {
    if (!env.getSourceFile(path)) env.createFile(path, code)
    else env.updateFile(path, code)
}

export interface CadTsLanguage {
    extension: Extension
    /** Push the active document's text into the TS environment. Call on every editor update. */
    sync(content: string): void
}

export function createCadTsLanguageExtension(): CadTsLanguage {
    const env = createCadTsEnvironment()
    let lastSynced: string | null = null
    const sync = (content: string): void => {
        if (content === lastSynced) return
        lastSynced = content
        // The vfs host treats an empty file as missing (TS6053); keep ≥1 char.
        createOrUpdateFile(env, CAD_DOC_PATH, content.length ? content : " ")
    }
    const extension: Extension = [
        tsFacet.of({ env, path: CAD_DOC_PATH }),
        tsLinter({ diagnosticCodesToIgnore: DIAGNOSTIC_CODES_TO_IGNORE }),
        javascriptLanguage.data.of({ autocomplete: tsAutocomplete() }),
        tsHover(),
    ]
    return { extension, sync }
}
