/**
 * Monaco Highlighter - Manages Monaco editor decorations for highlighting selected shapes,
 * showing color indicators for shape functions, and highlighting fluent CAD method names
 */

import * as monaco from "monaco-editor"
import { DEFAULT_PALETTE, PALETTE_SIZE } from "../colorPalette.mjs"
import { FLUENT_METHODS } from "../scene/scene.mjs"

const FLUENT_METHOD_PATTERN = new RegExp(
    `\\.(${[...FLUENT_METHODS].join("|")})\\b`,
    "g"
)

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
 * Shape indicator with location, node ID for color lookup, and SVG
 */
export interface ShapeIndicator {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
    nodeId: number
    functionName: string
    svg: string  // SVG content for the indicator (uses currentColor for dynamic coloring)
}

/**
 * Manages Monaco editor decorations for highlighting selected shapes
 * and showing color indicators
 */
export class MonacoHighlighter {
    private editor: monaco.editor.IStandaloneCodeEditor | null = null
    private selectionDecorationIds: string[] = []
    private colorIndicatorDecorationIds: string[] = []
    private fluentMethodDecorationIds: string[] = []
    private styleElement: HTMLStyleElement | null = null
    private indicatorCounter = 0  // Unique ID counter for indicator CSS classes

    private modelChangeDisposable: monaco.IDisposable | null = null

    /**
     * Set the editor instance to work with
     */
    setEditor(editor: monaco.editor.IStandaloneCodeEditor) {
        this.modelChangeDisposable?.dispose()
        this.editor = editor
        this.ensureStyleElement()
        this.updateFluentMethodDecorations()
        this.modelChangeDisposable = editor.onDidChangeModel(() => {
            this.updateFluentMethodDecorations()
        })
    }

    /**
     * Ensure the style element for dynamic CSS exists
     */
    private ensureStyleElement() {
        if (!this.styleElement) {
            this.styleElement = document.createElement("style")
            this.styleElement.id = "monaco-shape-indicators"
            document.head.appendChild(this.styleElement)
        }
    }

    /**
     * Generate CSS for a shape indicator.
     * Two separate classes are used to avoid the ::before pseudo-element firing twice:
     *   - `className`       → SVG icon only (used with beforeContentClassName)
     *   - `className-text`  → text color only (used with inlineClassName)
     */
    private generateIndicatorCss(className: string, svg: string, r: number, g: number, b: number): string {
        const rgb = `rgb(${r},${g},${b})`
        const svgWithColor = svg.replace(/currentColor/g, rgb)
        const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">${svgWithColor}</svg>`
        const dataUri = `data:image/svg+xml,${encodeURIComponent(fullSvg)}`

        return `.${className}::before {
            content: "";
            display: inline-block;
            width: 12px;
            height: 12px;
            margin-right: 4px;
            vertical-align: middle;
            background-image: url("${dataUri}");
            background-size: contain;
            background-repeat: no-repeat;
            cursor: default;
        }
        .${className}-text {
            color: ${rgb} !important;
        }\n`
    }

    /**
     * Update color indicators for all shape functions
     * @param indicators Array of shape indicators with nodeId for color lookup and SVG content
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

        // Reset counter for new batch of indicators
        this.indicatorCounter = 0
        
        // Generate CSS for all indicators and build decorations
        let css = ""
        const newDecorations: monaco.editor.IModelDeltaDecoration[] = indicators.map(indicator => {
            const colorIndex = indicator.nodeId % PALETTE_SIZE
            const color = DEFAULT_PALETTE[colorIndex]
            const r = Math.round(color.x * 255)
            const g = Math.round(color.y * 255)
            const b = Math.round(color.z * 255)
            
            const className = `shape-indicator-${this.indicatorCounter++}`
            css += this.generateIndicatorCss(className, indicator.svg, r, g, b)
            
            return {
                range: new monaco.Range(
                    indicator.startLine,
                    indicator.startColumn,
                    indicator.endLine,
                    indicator.endColumn
                ),
                options: {
                    beforeContentClassName: className,
                    inlineClassName: `${className}-text`
                }
            }
        })

        // Update the style element with generated CSS
        this.styleElement!.textContent = css

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
     * Update decorations for fluent CAD method names (.radius, .shift, .round, etc.)
     * Makes them stand out with a distinct color.
     */
    updateFluentMethodDecorations() {
        if (!this.editor) return
        const model = this.editor.getModel()
        if (!model) return

        const text = model.getValue()
        const decorations: monaco.editor.IModelDeltaDecoration[] = []

        for (const match of text.matchAll(FLUENT_METHOD_PATTERN)) {
            const startOffset = match.index! + 1  // Skip the leading dot
            const endOffset = startOffset + match[1].length
            const start = model.getPositionAt(startOffset)
            const end = model.getPositionAt(endOffset)
            if (start && end) {
                decorations.push({
                    range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                    options: { inlineClassName: "cad-fluent-method" }
                })
            }
        }

        this.fluentMethodDecorationIds = this.editor.deltaDecorations(
            this.fluentMethodDecorationIds,
            decorations
        )
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
