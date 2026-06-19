/**
 * dprint-based TypeScript formatter, wired into CodeMirror 6.
 *
 * Loads the WASM plugin from /assets/dprint-typescript.wasm (copied by the build
 * from node_modules). dprint only does full-document formatting, so both the
 * format command and format-on-paste reformat the whole document.
 *
 * Exposed as a CM6 keymap command (Shift-Alt-F) + paste handler, replacing the
 * old editor's document-formatting providers.
 */

import { EditorView, keymap } from "@codemirror/view"
import type { Extension } from "@codemirror/state"
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
    "ignoreNodeCommentText": "no-format",
}

let formatter: { formatText: (req: { filePath: string; fileText: string }) => string } | null = null

async function loadFormatter(): Promise<typeof formatter> {
    if (formatter) return formatter
    const f = await createStreaming(fetch(WASM_URL))
    f.setConfig(GLOBAL_CONFIG, PLUGIN_CONFIG)
    formatter = f
    return formatter
}

/** Format source text with dprint, or null if the formatter isn't ready / it failed. */
function formatText(src: string): string | null {
    if (!formatter) return null
    try {
        return formatter.formatText({ filePath: "document.ts", fileText: src })
    } catch {
        return null
    }
}

/**
 * Format the whole document in the view (no-op until the WASM formatter loads).
 * Returns true if the document changed.
 */
export function formatDocument(view: EditorView): boolean {
    const src = view.state.doc.toString()
    const formatted = formatText(src)
    if (formatted === null || formatted === src) return false
    const head = view.state.selection.main.head
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted },
        // Crude cursor preservation: clamp the old offset into the new text.
        selection: { anchor: Math.min(head, formatted.length) },
    })
    return true
}

/** Start loading the dprint WASM formatter (non-blocking). */
export function initDprintFormatting(): void {
    void loadFormatter()
}

/**
 * CM6 extension: a format command (Shift-Alt-F) plus format-on-paste, mirroring
 * Monaco's `formatOnPaste: true`. Both reformat the whole document via dprint.
 */
export function dprintFormatting(): Extension {
    return [
        keymap.of([
            {
                key: "Shift-Alt-f",
                run: view => {
                    formatDocument(view)
                    return true
                },
            },
        ]),
        EditorView.domEventHandlers({
            paste(_event, view) {
                // Format after the paste is applied to the document.
                setTimeout(() => formatDocument(view), 0)
                return false
            },
        }),
    ]
}
