/**
 * Source code updates for path2d() calls.
 * Used when the user edits a bezier path in the (curve-aware) polygon editor.
 *
 * path2d is varargs — each argument is one element (a vertex `[x,y]` or a
 * 2/3/4-point control polygon). There is no wrapping array, so the editable
 * span runs from the first argument to the last (see Path2DCallInfo).
 */

import type { EditorView } from "@codemirror/view"
import type { Path2DCallInfo } from "../parser/source-parser.mjs"
import type { PathElement, Vec2 } from "../scene/primitives/path2d.mjs"

export interface PathArgsFormat {
    indent: string
    newlinePerElement: boolean
}

function num(n: number): string {
    return String(Math.round(n * 100) / 100)
}

/**
 * Format one element: `[x, y]` (vertex) or `[[x,y], …]` (control polygon). A
 * control polygon carries an optional trailing node-type tag (`…,"smooth"]`);
 * tags on vertices are ignored (a bare vertex is always a cusp).
 */
export function formatPathElement(el: PathElement, tag?: string | null): string {
    if (typeof el[0] === "number") {
        const [x, y] = el as Vec2
        return `[${num(x)}, ${num(y)}]`
    }
    const pts = el as Vec2[]
    const body = pts.map(([x, y]) => `[${num(x)}, ${num(y)}]`).join(", ")
    return tag ? `[${body}, "${tag}"]` : `[${body}]`
}

/**
 * Infer the existing argument formatting from the original args text (the slice
 * between the first and last argument). One-element-per-line if it contains a
 * newline; the indent is the whitespace following the first interior newline.
 */
export function analyzePathFormatting(argsText: string): PathArgsFormat {
    if (!argsText.includes("\n")) {
        return { indent: "", newlinePerElement: false }
    }
    const match = argsText.match(/\n([ \t]*)/)
    const indent = match ? match[1] : "    "
    return { indent, newlinePerElement: true }
}

/**
 * Render the replacement args content (between `(` and `)`). The first element
 * carries no leading indent — the original indent before it lives outside the
 * replaced span — while subsequent elements are re-indented to match.
 */
export function formatPathElements(
    elements: PathElement[],
    format: PathArgsFormat,
    tags?: (string | null)[],
): string {
    const parts = elements.map((el, i) => formatPathElement(el, tags?.[i]))
    if (format.newlinePerElement && parts.length > 0) {
        return parts
            .map((p, i) => (i === 0 ? "" : format.indent) + p + (i < parts.length - 1 ? "," : ""))
            .join("\n")
    }
    return parts.join(", ")
}

/**
 * Apply element updates to the document. When the element count is unchanged,
 * does surgical in-place edits (no reformatting); otherwise replaces the whole
 * args span with format preservation. Mirrors polygon-source-updates so undo
 * grouping (CM6 time-based history) merges rapid drag edits.
 */
export function applyPathUpdates(
    view: EditorView,
    info: Path2DCallInfo,
    elements: PathElement[],
    nodeTypes?: (string | null)[],
): void {
    if (elements.length === info.elementRanges.length) {
        const changes = elements.map((el, i) => ({
            from: info.elementRanges[i].start,
            to: info.elementRanges[i].end,
            insert: formatPathElement(el, nodeTypes?.[i]),
        }))
        view.dispatch({ changes })
    } else {
        const originalText = view.state.doc.sliceString(info.argsStartOffset, info.argsEndOffset)
        const format = analyzePathFormatting(originalText)
        const newText = formatPathElements(elements, format, nodeTypes)
        view.dispatch({ changes: { from: info.argsStartOffset, to: info.argsEndOffset, insert: newText } })
    }
}
