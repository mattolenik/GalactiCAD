/**
 * Monaco Highlighter - Manages Monaco editor decorations for highlighting selected shapes
 */

import * as monaco from "monaco-editor"

/**
 * Range to highlight in the editor (function name position)
 */
export interface HighlightRange {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
}

/**
 * Manages Monaco editor decorations for highlighting selected shapes
 */
export class MonacoHighlighter {
    private editor: monaco.editor.IStandaloneCodeEditor | null = null
    private decorationIds: string[] = []

    /**
     * Set the editor instance to work with
     */
    setEditor(editor: monaco.editor.IStandaloneCodeEditor) {
        this.editor = editor
    }

    /**
     * Highlight function name ranges corresponding to selected shapes
     * @param ranges Array of ranges to highlight (function name positions)
     */
    highlightRanges(ranges: HighlightRange[]) {
        if (!this.editor) {
            console.warn("[MonacoHighlighter] No editor set")
            return
        }

        const model = this.editor.getModel()
        if (!model) {
            console.warn("[MonacoHighlighter] No model available")
            return
        }

        if (ranges.length === 0) {
            this.clearHighlighting()
            return
        }

        console.log(`[MonacoHighlighter] Highlighting ${ranges.length} range(s):`, ranges)

        // Create decorations for each range (just the function name, not whole line)
        const newDecorations: monaco.editor.IModelDeltaDecoration[] = ranges.map(range => ({
            range: new monaco.Range(
                range.startLine,
                range.startColumn,
                range.endLine,
                range.endColumn
            ),
            options: {
                inlineClassName: "selected-shape-name",
                overviewRuler: {
                    color: "#ffff00",
                    position: monaco.editor.OverviewRulerLane.Full
                }
            }
        }))

        // Update decorations (removes old, adds new)
        this.decorationIds = this.editor.deltaDecorations(this.decorationIds, newDecorations)
        console.log(`[MonacoHighlighter] Applied ${newDecorations.length} decorations, IDs:`, this.decorationIds)

        // Scroll to first selected range
        if (ranges.length > 0) {
            this.editor.revealLineInCenterIfOutsideViewport(ranges[0].startLine)
        }
    }

    /**
     * Clear all highlighting
     */
    clearHighlighting() {
        console.log("[MonacoHighlighter] Clearing highlighting")
        if (this.editor) {
            this.decorationIds = this.editor.deltaDecorations(this.decorationIds, [])
        }
    }

    /**
     * Get current decoration IDs
     */
    getDecorationIds(): string[] {
        return [...this.decorationIds]
    }
}

/**
 * Singleton instance for global use
 */
export const monacoHighlighter = new MonacoHighlighter()
