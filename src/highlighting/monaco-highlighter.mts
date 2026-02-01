/**
 * Monaco Highlighter - Manages Monaco editor decorations for highlighting selected shapes
 * and showing color indicators for shape functions
 */

import * as monaco from "monaco-editor"
import { DEFAULT_PALETTE, PALETTE_SIZE } from "../colorPalette.mjs"

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
 * Shape indicator with location, node ID for color lookup, and symbol
 */
export interface ShapeIndicator {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
    nodeId: number
    functionName: string
    symbol: string  // Shape-specific indicator symbol (e.g., ● for sphere, ■ for box)
}

/**
 * Manages Monaco editor decorations for highlighting selected shapes
 * and showing color indicators
 */
export class MonacoHighlighter {
    private editor: monaco.editor.IStandaloneCodeEditor | null = null
    private selectionDecorationIds: string[] = []
    private colorIndicatorDecorationIds: string[] = []
    private styleElement: HTMLStyleElement | null = null

    /**
     * Set the editor instance to work with
     */
    setEditor(editor: monaco.editor.IStandaloneCodeEditor) {
        this.editor = editor
        this.ensureStyleElement()
    }

    /**
     * Ensure the style element for dynamic CSS exists
     */
    private ensureStyleElement() {
        if (!this.styleElement) {
            this.styleElement = document.createElement("style")
            this.styleElement.id = "monaco-shape-colors"
            document.head.appendChild(this.styleElement)
            
            // Generate CSS classes for all palette colors
            let css = ""
            for (let i = 0; i < PALETTE_SIZE; i++) {
                const color = DEFAULT_PALETTE[i]
                const r = Math.round(color.x * 255)
                const g = Math.round(color.y * 255)
                const b = Math.round(color.z * 255)
                css += `.shape-color-${i} {
                    color: rgb(${r}, ${g}, ${b}) !important;
                    text-shadow: 0 0 1px rgba(0,0,0,0.3);
                    font-size: 1.1em;
                }\n`
            }
            this.styleElement.textContent = css
        }
    }

    /**
     * Update color indicators for all shape functions
     * @param indicators Array of shape indicators with nodeId for color lookup
     */
    setColorIndicators(indicators: ShapeIndicator[]) {
        if (!this.editor) {
            console.warn("[MonacoHighlighter] No editor set")
            return
        }

        const model = this.editor.getModel()
        if (!model) {
            console.warn("[MonacoHighlighter] No model available")
            return
        }

        this.ensureStyleElement()

        // Create decorations for each shape with color indicator
        const newDecorations: monaco.editor.IModelDeltaDecoration[] = indicators.map(indicator => {
            const colorIndex = indicator.nodeId % PALETTE_SIZE
            return {
                range: new monaco.Range(
                    indicator.startLine,
                    indicator.startColumn,
                    indicator.endLine,
                    indicator.endColumn
                ),
                options: {
                    before: {
                        content: indicator.symbol + " ",
                        inlineClassName: `shape-color-${colorIndex}`
                    }
                }
            }
        })

        // Update decorations (removes old, adds new)
        this.colorIndicatorDecorationIds = this.editor.deltaDecorations(
            this.colorIndicatorDecorationIds, 
            newDecorations
        )
    }

    /**
     * Clear all color indicators
     */
    clearColorIndicators() {
        if (this.editor) {
            this.colorIndicatorDecorationIds = this.editor.deltaDecorations(
                this.colorIndicatorDecorationIds, 
                []
            )
        }
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
        this.selectionDecorationIds = this.editor.deltaDecorations(
            this.selectionDecorationIds, 
            newDecorations
        )

        // Scroll to first selected range
        if (ranges.length > 0) {
            this.editor.revealLineInCenterIfOutsideViewport(ranges[0].startLine)
        }
    }

    /**
     * Clear selection highlighting (not color indicators)
     */
    clearHighlighting() {
        if (this.editor) {
            this.selectionDecorationIds = this.editor.deltaDecorations(
                this.selectionDecorationIds, 
                []
            )
        }
    }

    /**
     * Get current selection decoration IDs
     */
    getDecorationIds(): string[] {
        return [...this.selectionDecorationIds]
    }
}

/**
 * Singleton instance for global use
 */
export const monacoHighlighter = new MonacoHighlighter()
