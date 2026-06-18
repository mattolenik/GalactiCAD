/**
 * CadHighlighter — CodeMirror 6 decoration manager for GalactiCAD: shape color
 * indicators, selection-linked highlights, and fluent-method name coloring.
 *
 * STEP 1 STATE: this is a no-op shell. It accepts the same inputs the old
 * Monaco `MonacoHighlighter` did, but renders nothing yet. The real CM6
 * implementation — `Decoration.mark` / `Decoration.line` / `Decoration.widget`
 * driven by a `StateField<DecorationSet>`, wired through
 * `CodeEditor.setDecorationsExtension` — lands in the "Port decorations"
 * migration step. Keeping the surface identical lets the rest of the app
 * compile and run with the editor live while decorations are ported.
 */

import type { CodeEditor } from "../editor/codemirror-editor.mjs"
import type { Vec3f } from "../vecmat/vector.mjs"
import type { FluentMethodLocation } from "../parser/source-parser.mjs"

/** Range to highlight in the editor (1-based function-name position). */
export interface HighlightRange {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
}

/** Shape indicator with location, node ID for color lookup, and SVG icon. */
export interface ShapeIndicator {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
    nodeId: number
    functionName: string
    svg: string
}

export class CadHighlighter {
    #editor: CodeEditor | null = null

    setEditor(editor: CodeEditor): void {
        this.#editor = editor
    }

    get editor(): CodeEditor | null {
        return this.#editor
    }

    setColorIndicators(_indicators: ShapeIndicator[], _palette?: Vec3f[]): void {
        // TODO(decorations step): render shape color indicators.
    }

    clearColorIndicators(): void {
        // TODO(decorations step)
    }

    highlightRanges(_primaryRanges: HighlightRange[], _childRanges: HighlightRange[], _overviewRulerColor = "#ffff00"): void {
        // TODO(decorations step): render selection-linked highlights.
    }

    clearHighlighting(): void {
        // TODO(decorations step)
    }

    setFluentMethodDecorations(_locations: FluentMethodLocation[]): void {
        // TODO(decorations step): color fluent CAD method names.
    }
}
