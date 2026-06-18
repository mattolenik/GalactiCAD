/**
 * CadHighlighter — CodeMirror 6 decoration manager for GalactiCAD: shape color
 * indicators, selection-linked highlights, and fluent-method name coloring.
 *
 * Port of the former Monaco `MonacoHighlighter`. Three independently-updated
 * decoration families, each backed by its own `StateField<DecorationSet>` and
 * driven by a `StateEffect` (the app dispatches new sets after each build /
 * selection change). The combined extension is installed once via
 * `CodeEditor.setDecorationsExtension`.
 *
 *   1. Color indicators — `Decoration.mark` (colored underline + bold name) plus
 *      a leading SVG icon `Decoration.widget` (side -1, so the caret sits to the
 *      LEFT of the icon, matching Monaco's injected `before` text). Per-indicator
 *      CSS is generated into a dedicated <style> element.
 *   2. Selection highlights — primary `Decoration.mark` (solid underline) + child
 *      mark (dashed) + whole-line `Decoration.line` wash. The static class CSS
 *      lives in app `#injectStyles`.
 *   3. Fluent methods — `Decoration.mark` (`.cad-fluent-method`).
 *
 * Monaco `NeverGrowsWhenTypingAtEdges` stickiness maps to CM6 mark decorations'
 * default (inclusiveStart/End = false). The Monaco overview-ruler markers have no
 * CM6 equivalent and are dropped (the `overviewRulerColor` arg is ignored).
 */

import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view"
import { StateEffect, StateField, type Extension, type StateEffectType, type Text } from "@codemirror/state"
import type { CodeEditor } from "../editor/codemirror-editor.mjs"
import { getShapePalette, PALETTE_SIZE } from "../colorPalette.mjs"
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

// ── StateFields: one per independently-updated decoration family ─────────────
const setIndicators = StateEffect.define<DecorationSet>()
const setSelection = StateEffect.define<DecorationSet>()
const setFluent = StateEffect.define<DecorationSet>()

function decoField(effect: StateEffectType<DecorationSet>) {
    return StateField.define<DecorationSet>({
        create: () => Decoration.none,
        update(deco, tr) {
            deco = deco.map(tr.changes)
            for (const e of tr.effects) if (e.is(effect)) deco = e.value
            return deco
        },
        provide: f => EditorView.decorations.from(f),
    })
}

const indicatorsField = decoField(setIndicators)
const selectionField = decoField(setSelection)
const fluentField = decoField(setFluent)

/** The extension installed into the editor (all three decoration layers). */
const decorationsExtension: Extension = [indicatorsField, selectionField, fluentField]

/** Leading shape icon, rendered as a widget so the caret sits to its left. */
class IconWidget extends WidgetType {
    constructor(readonly iconClass: string) {
        super()
    }
    override eq(other: IconWidget): boolean {
        return other.iconClass === this.iconClass
    }
    override toDOM(): HTMLElement {
        const span = document.createElement("span")
        span.className = this.iconClass
        span.setAttribute("aria-hidden", "true")
        return span
    }
    override ignoreEvent(): boolean {
        return false
    }
}

/**
 * Generate CSS for one shape indicator. `textClass` styles the function name
 * (colored bottom underline + subtle bold); `iconClass` styles the leading icon
 * widget (SVG data-URI background). Ported verbatim from the Monaco highlighter.
 */
function generateIndicatorCss(textClass: string, iconClass: string, svg: string, r: number, g: number, b: number): string {
    const colorRgb = `rgb(${r},${g},${b})`
    const svgWithColor = svg.replace(/currentColor/g, colorRgb)
    const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">${svgWithColor}</svg>`
    const dataUri = `data:image/svg+xml,${encodeURIComponent(fullSvg)}`
    const subtleBoldShadow = [
        `0.2px 0 0 ${colorRgb}`,
        `-0.2px 0 0 ${colorRgb}`,
        `0 0.2px 0 ${colorRgb}`,
        `0 -0.2px 0 ${colorRgb}`,
    ].join(", ")

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

export class CadHighlighter {
    #editor: CodeEditor | null = null
    #styleElement: HTMLStyleElement | null = null

    setEditor(editor: CodeEditor): void {
        this.#editor = editor
        this.#ensureStyleElement()
        editor.setDecorationsExtension(decorationsExtension)
    }

    get editor(): CodeEditor | null {
        return this.#editor
    }

    #ensureStyleElement(): void {
        if (!this.#styleElement) {
            this.#styleElement = document.createElement("style")
            this.#styleElement.id = "cad-shape-indicators"
            document.head.appendChild(this.#styleElement)
        }
    }

    /** 1-based line/column → document offset, clamped to the current doc. */
    #offset(doc: Text, line: number, column: number): number {
        const ln = Math.min(Math.max(1, line), doc.lines)
        const l = doc.line(ln)
        return l.from + Math.min(Math.max(0, column - 1), l.length)
    }

    setColorIndicators(indicators: ShapeIndicator[], palette?: Vec3f[]): void {
        const editor = this.#editor
        if (!editor) return
        this.#ensureStyleElement()

        const colorPalette = palette ?? getShapePalette("dark")
        const doc = editor.view.state.doc

        let css = ""
        const decos = indicators.flatMap((indicator, idx) => {
            const color = colorPalette[indicator.nodeId % PALETTE_SIZE]
            const r = Math.round(color.x * 255)
            const g = Math.round(color.y * 255)
            const b = Math.round(color.z * 255)
            const textClass = `shape-indicator-${idx}`
            const iconClass = `shape-indicator-icon-${idx}`
            css += generateIndicatorCss(textClass, iconClass, indicator.svg, r, g, b)

            const from = this.#offset(doc, indicator.startLine, indicator.startColumn)
            const to = this.#offset(doc, indicator.endLine, indicator.endColumn)
            const out = []
            // Leading icon before the name (side -1 → caret sits left of the icon).
            out.push(Decoration.widget({ widget: new IconWidget(iconClass), side: -1 }).range(from))
            if (to > from) out.push(Decoration.mark({ class: textClass }).range(from, to))
            return out
        })

        this.#styleElement!.textContent = css
        editor.view.dispatch({ effects: setIndicators.of(Decoration.set(decos, true)) })
    }

    clearColorIndicators(): void {
        this.#editor?.view.dispatch({ effects: setIndicators.of(Decoration.none) })
    }

    /**
     * Highlight function-name ranges for selected shapes: primary = solid
     * underline + whole-line wash, children = dashed underline. The
     * `overviewRulerColor` arg is ignored (no CM6 overview ruler).
     */
    highlightRanges(primaryRanges: HighlightRange[], childRanges: HighlightRange[], _overviewRulerColor = "#ffff00"): void {
        const editor = this.#editor
        if (!editor) return
        if (primaryRanges.length === 0 && childRanges.length === 0) {
            this.clearHighlighting()
            return
        }

        const doc = editor.view.state.doc
        const decos = []

        // Whole-line wash for primary-selected lines, deduped so overlapping
        // selections on one line don't stack translucent backgrounds.
        const primaryLines = new Set<number>()
        for (const range of primaryRanges) {
            for (let line = range.startLine; line <= range.endLine; line++) primaryLines.add(line)
        }
        for (const line of primaryLines) {
            const ln = Math.min(Math.max(1, line), doc.lines)
            decos.push(Decoration.line({ class: "shape-line-selected" }).range(doc.line(ln).from))
        }

        for (const range of primaryRanges) {
            const from = this.#offset(doc, range.startLine, range.startColumn)
            const to = this.#offset(doc, range.endLine, range.endColumn)
            if (to > from) decos.push(Decoration.mark({ class: "shape-indicator-selected" }).range(from, to))
        }
        for (const range of childRanges) {
            const from = this.#offset(doc, range.startLine, range.startColumn)
            const to = this.#offset(doc, range.endLine, range.endColumn)
            if (to > from) decos.push(Decoration.mark({ class: "shape-indicator-selected-child" }).range(from, to))
        }

        editor.view.dispatch({ effects: setSelection.of(Decoration.set(decos, true)) })

        const firstRange = primaryRanges[0] ?? childRanges[0]
        if (firstRange) editor.revealLineCenterIfOutside(firstRange.startLine)
    }

    clearHighlighting(): void {
        this.#editor?.view.dispatch({ effects: setSelection.of(Decoration.none) })
    }

    setFluentMethodDecorations(locations: FluentMethodLocation[]): void {
        const editor = this.#editor
        if (!editor) return
        const doc = editor.view.state.doc
        const decos = locations.flatMap(loc => {
            const from = this.#offset(doc, loc.startLine, loc.startColumn)
            const to = this.#offset(doc, loc.endLine, loc.endColumn)
            return to > from ? [Decoration.mark({ class: "cad-fluent-method" }).range(from, to)] : []
        })
        editor.view.dispatch({ effects: setFluent.of(Decoration.set(decos, true)) })
    }
}
