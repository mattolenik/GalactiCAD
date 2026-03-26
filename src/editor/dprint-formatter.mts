/**
 * dprint-based TypeScript formatter for Monaco editor.
 * Loads the WASM plugin from /assets/dprint-typescript.wasm (copied by build from node_modules).
 */

import * as monaco from "monaco-editor"
import { createStreaming } from "@dprint/formatter"

const WASM_URL = "/assets/dprint-typescript.wasm"

const GLOBAL_CONFIG = {
    indentWidth: 2,
    lineWidth: 100,
    useTabs: false,
}

const PLUGIN_CONFIG = {
    semiColons: "asi",
    quoteStyle: "preferSingle",
    quoteProps: "asNeeded",
    useBraces: "preferNone",
    preferHanging: true,
    "arrowFunction.useParentheses": "preferNone",
    "ignoreNodeCommentText": "no-format"
}

let formatter: { formatText: (req: { filePath: string; fileText: string }) => string } | null = null

async function loadFormatter(): Promise<typeof formatter> {
    if (formatter) return formatter
    const f = await createStreaming(fetch(WASM_URL))
    f.setConfig(GLOBAL_CONFIG, PLUGIN_CONFIG)
    formatter = f
    return formatter
}

function formatWithDprint(model: monaco.editor.ITextModel): string | null {
    if (!formatter) return null
    try {
        const filePath = model.uri.path || "document.ts"
        const fileText = model.getValue()
        return formatter.formatText({ filePath, fileText })
    } catch {
        return null
    }
}

function createEdits(model: monaco.editor.ITextModel, token: monaco.CancellationToken): monaco.languages.TextEdit[] | null {
    if (token.isCancellationRequested) return null
    const formatted = formatWithDprint(model)
    if (formatted === null) return null
    if (token.isCancellationRequested) return null
    const range = model.getFullModelRange()
    return [{ range, text: formatted }]
}

/**
 * Initialize dprint formatting and register Monaco providers.
 * Call without awaiting for non-blocking startup; format uses Monaco built-in until ready.
 */
export async function initDprintFormatting(): Promise<void> {
    await loadFormatter()
    if (!formatter) return

    monaco.languages.registerDocumentFormattingEditProvider("typescript", {
        provideDocumentFormattingEdits(model, _options, token) {
            return createEdits(model, token)
        },
    })

    monaco.languages.registerDocumentRangeFormattingEditProvider("typescript", {
        provideDocumentRangeFormattingEdits(_model, _range, _options, token) {
            // dprint only supports full-document formatting; format entire document
            const model = _model
            return createEdits(model, token)
        },
    })
}
