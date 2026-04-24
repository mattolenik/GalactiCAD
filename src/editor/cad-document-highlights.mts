/**
 * Custom document highlight provider that suppresses occurrence highlighting
 * for CAD API symbols (shapes, operators) while preserving it for user variables.
 */

import * as monaco from "monaco-editor"

/** CAD API symbols: shapes, operators, modifiers. No occurrence highlighting for these. */
const CAD_SYMBOLS = new Set([
    // Primitives
    "sphere",
    "box",
    "cylinder",
    "cone",
    "torus",
    "threaded_rod",
    "capsule",
    "plane",
    "hexprism",
    "disc",
    "blob",
    "polygon2d",
    // CSG / operators
    "union",
    "subtract",
    "intersect",
    "pipe",
    "engrave",
    "groove",
    "knurl",
    "tongue",
    "seam",
    "morph",
    // 2D → 3D
    "extrude",
    "loft",
    "lathe",
    // Modifiers
    "rotate",
    "scale",
    "shell",
    "offset",
    "elongate",
    "twist",
    "bend",
    "taper",
    "repeatPolar",
])

function getWordAtPosition(model: monaco.editor.ITextModel, position: monaco.Position): string | null {
    const word = model.getWordAtPosition(position)
    return word?.word ?? null
}

/**
 * Initialize custom document highlighting: disable built-in TypeScript highlights
 * and register a provider that delegates for non-CAD symbols and returns empty for CAD symbols.
 */
export function initCadDocumentHighlights(): void {
    monaco.typescript.typescriptDefaults.setModeConfiguration({
        completionItems: true,
        hovers: true,
        documentSymbols: true,
        definitions: true,
        references: true,
        documentHighlights: false,
        rename: true,
        diagnostics: true,
        documentRangeFormattingEdits: true,
        signatureHelp: true,
        onTypeFormattingEdits: true,
        codeActions: true,
        inlayHints: true,
    })

    monaco.languages.registerDocumentHighlightProvider("typescript", {
        async provideDocumentHighlights(
            model: monaco.editor.ITextModel,
            position: monaco.Position,
            token: monaco.CancellationToken
        ): Promise<monaco.languages.DocumentHighlight[] | undefined> {
            const word = getWordAtPosition(model, position)
            if (!word || CAD_SYMBOLS.has(word)) return []

            const worker = await monaco.typescript.getTypeScriptWorker()
            const proxy = await worker(model.uri)
            const fileName = model.uri.toString()
            const offset = model.getOffsetAt(position)
            const filesToSearch = [fileName]
            const highlights = await proxy.getDocumentHighlights(fileName, offset, filesToSearch)
            if (token.isCancellationRequested) return undefined
            return highlights ? [...highlights] : []
        },
    })
}
