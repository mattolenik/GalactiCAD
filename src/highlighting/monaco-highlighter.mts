/**
 * Monaco Highlighter - Manages Monaco editor decorations for highlighting selected shapes,
 * showing color indicators for shape functions, and highlighting fluent CAD method names
 */

import * as monaco from "monaco-editor"
import { getShapePalette, PALETTE_SIZE } from "../colorPalette.mjs"
import { log } from "../logging/debug-log.mjs"
import type { Vec3f } from "../vecmat/vector.mjs"
import type { FluentMethodLocation } from "../parser/source-parser.mjs"

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
 * Keep decorations glued to exactly their token. Monaco's default decoration stickiness is
 * `AlwaysGrowsWhenTypingAtEdges`, which makes a decoration absorb text typed at its boundary —
 * so typing a modifier (e.g. `scale(`) right before a decorated shape name grows that shape's
 * pill over the freshly-typed text. The intermediate source is usually a syntax error (unbalanced
 * paren), so the build can't recompute/reset the decorations and the growth visibly accumulates
 * per keystroke. `NeverGrowsWhenTypingAtEdges` makes the decoration shift with, but never swallow,
 * text inserted at either edge.
 */
const STICKY_TOKEN = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges

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
            this.styleElement.id = "monaco-shape-indicators"
            document.head.appendChild(this.styleElement)
        }
    }

    /**
     * Generate CSS for a shape indicator.
     * `textClass` styles the function name (colored bottom underline). `iconClass` styles the leading
     * icon, which is rendered as Monaco injected `before` text (not a CSS `::before`) so that the text
     * caret sits to the LEFT of the icon — placing the cursor at the symbol start lands before the icon,
     * not between the icon and the name.
     */
    private generateIndicatorCss(textClass: string, iconClass: string, svg: string, r: number, g: number, b: number): string {
        const colorRgb = `rgb(${r},${g},${b})`
        const svgWithColor = svg.replace(/currentColor/g, colorRgb)
        const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">${svgWithColor}</svg>`
        const dataUri = `data:image/svg+xml,${encodeURIComponent(fullSvg)}`
        // Fira Code VF: small cardinal shadows add a touch of weight without heavy faux-bold.
        const subtleBoldShadow = [
            `0.2px 0 0 ${colorRgb}`,
            `-0.2px 0 0 ${colorRgb}`,
            `0 0.2px 0 ${colorRgb}`,
            `0 -0.2px 0 ${colorRgb}`,
        ].join(", ")

        // 22px box with the 12px icon centered → ~5-6px breathing room on each side
        // (between the caret and the icon, and between the icon and the name).
        return `.${textClass} {
            background-color: transparent;
            border-bottom: 1px solid ${colorRgb};
            color: ${colorRgb} !important;
            font-weight: 600 !important;
            text-shadow: ${subtleBoldShadow};
            -webkit-box-decoration-break: clone;
            box-decoration-break: clone;
            box-sizing: border-box;
        }
        .${iconClass} {
            display: inline-block;
            width: 22px;
            height: 12px;
            vertical-align: middle;
            background-image: url("${dataUri}");
            background-size: 12px 12px;
            background-position: center;
            background-repeat: no-repeat;
            cursor: default;
        }\n`
    }

    /**
     * Update color indicators for all shape functions
     * @param indicators Array of shape indicators with nodeId for color lookup and SVG content
     * @param palette Optional palette for colors; defaults to dark theme palette
     */
    setColorIndicators(indicators: ShapeIndicator[], palette?: Vec3f[]) {
        if (!this.editor) {
            log("MonacoHighlighter").warn("No editor set")
            return
        }

        const model = this.editor.getModel()
        if (!model) return

        this.ensureStyleElement()

        const colorPalette = palette ?? getShapePalette("dark")

        // Reset counter for new batch of indicators
        this.indicatorCounter = 0

        // Generate CSS for all indicators and build decorations
        let css = ""
        const newDecorations: monaco.editor.IModelDeltaDecoration[] = indicators.map(indicator => {
            const colorIndex = indicator.nodeId % PALETTE_SIZE
            const color = colorPalette[colorIndex]
            const r = Math.round(color.x * 255)
            const g = Math.round(color.y * 255)
            const b = Math.round(color.z * 255)

            const idx = this.indicatorCounter++
            const className = `shape-indicator-${idx}`
            const iconClass = `shape-indicator-icon-${idx}`
            css += this.generateIndicatorCss(className, iconClass, indicator.svg, r, g, b)

            return {
                range: new monaco.Range(
                    indicator.startLine,
                    indicator.startColumn,
                    indicator.endLine,
                    indicator.endColumn
                ),
                options: {
                    inlineClassName: className,
                    // Icon as injected text (not CSS ::before) so the caret sits to the LEFT of the icon.
                    before: {
                        content: "\u200B",
                        inlineClassName: iconClass,
                        inlineClassNameAffectsLetterSpacing: true,
                        cursorStops: monaco.editor.InjectedTextCursorStops.None,
                    },
                    stickiness: STICKY_TOKEN
                }
            }
        })

        // Append selection modifiers: thicker solid underline for primary, dashed underline for children.
        // Each rule defines a complete border-bottom so it also shows on selection-only ranges (no base pill).
        css += `.shape-indicator-selected { border-bottom: 3px solid currentColor; }
        [data-theme="dark"] .shape-indicator-selected { border-bottom-color: #fff; }
        .shape-indicator-selected-child { border-bottom: 2px dashed currentColor; }
        [data-theme="dark"] .shape-indicator-selected-child { border-bottom-color: #fff; }\n`

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
     * Highlight function name ranges corresponding to selected shapes.
     * Primary ranges get solid border; child ranges get dashed border.
     * @param primaryRanges Ranges for primary selection (solid border)
     * @param childRanges Ranges for children of selection (dashed border)
     * @param overviewRulerColor Theme-aware color for the overview ruler (default: yellow for dark theme)
     */
    highlightRanges(primaryRanges: HighlightRange[], childRanges: HighlightRange[], overviewRulerColor = "#ffff00") {
        if (!this.editor) {
            log("MonacoHighlighter").warn("No editor set")
            return
        }

        const model = this.editor.getModel()
        if (!model) return

        if (primaryRanges.length === 0 && childRanges.length === 0) {
            this.clearHighlighting()
            return
        }

        const ruler = { color: overviewRulerColor, position: monaco.editor.OverviewRulerLane.Full as const }
        const primaryDecorations: monaco.editor.IModelDeltaDecoration[] = primaryRanges.map(range => ({
            range: new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn),
            options: { inlineClassName: "shape-indicator-selected", overviewRuler: ruler, stickiness: STICKY_TOKEN }
        }))
        const childDecorations: monaco.editor.IModelDeltaDecoration[] = childRanges.map(range => ({
            range: new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn),
            options: { inlineClassName: "shape-indicator-selected-child", overviewRuler: ruler, stickiness: STICKY_TOKEN }
        }))

        // Highlight the whole line of each primary-selected object. Deduped by line so several
        // selected objects sharing a line don't stack translucent backgrounds.
        const primaryLines = new Set<number>()
        for (const range of primaryRanges) {
            for (let line = range.startLine; line <= range.endLine; line++) primaryLines.add(line)
        }
        const lineDecorations: monaco.editor.IModelDeltaDecoration[] = [...primaryLines].map(line => ({
            range: new monaco.Range(line, 1, line, 1),
            options: { isWholeLine: true, className: "shape-line-selected", stickiness: STICKY_TOKEN }
        }))

        this.selectionDecorationIds = this.editor.deltaDecorations(
            this.selectionDecorationIds,
            [...lineDecorations, ...primaryDecorations, ...childDecorations]
        )

        const firstRange = primaryRanges[0] ?? childRanges[0]
        if (firstRange) this.editor.revealLineInCenterIfOutsideViewport(firstRange.startLine)
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
     * Set decorations for fluent CAD method names (.radius, .shift, .round, etc.)
     * Makes them stand out with a distinct color.
     * Receives pre-computed positions from AST-based parsing (app drives updates).
     */
    setFluentMethodDecorations(locations: FluentMethodLocation[]) {
        if (!this.editor) return

        const decorations: monaco.editor.IModelDeltaDecoration[] = locations.map(loc => ({
            range: new monaco.Range(
                loc.startLine,
                loc.startColumn,
                loc.endLine,
                loc.endColumn
            ),
            options: { inlineClassName: "cad-fluent-method", stickiness: STICKY_TOKEN }
        }))

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
