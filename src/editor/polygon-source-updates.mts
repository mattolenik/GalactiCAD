/**
 * Source code updates for polygon2d vertex arrays.
 * Used when the user edits vertices in the polygon editor.
 */

import type { EditorView } from "@codemirror/view"
import type { Polygon2DCallInfo } from "../parser/source-parser.mjs"

export interface ArrayFormat {
    indent: string
    newlinePerVertex: boolean
}

export function analyzeArrayFormatting(text: string): ArrayFormat {
    if (!text.includes("\n")) {
        return { indent: "", newlinePerVertex: false }
    }
    // Find indent: between first "[" (outer) and second "[" (first vertex)
    const firstBracket = text.indexOf("[")
    const between = text.slice(firstBracket + 1, text.indexOf("[", firstBracket + 1))
    const match = between.match(/\n([ \t]*)$/)
    const indent = match ? match[1] : "   "  // fallback: 3 spaces (matches tabSize)
    return { indent, newlinePerVertex: true }
}

export function formatVertex([x, y]: [number, number]): string {
    const xs = String(Math.round(x * 100) / 100)
    const ys = String(Math.round(y * 100) / 100)
    return `[${xs}, ${ys}]`
}

export function formatVertices(vertices: [number, number][], format?: ArrayFormat): string {
    const pairs = vertices.map(formatVertex)
    if (format?.newlinePerVertex && pairs.length > 0) {
        const indent = format.indent
        const lines = pairs.map((p, i) => indent + p + (i < pairs.length - 1 ? "," : ""))
        return "[\n" + lines.join("\n") + "\n]"
    }
    return `[${pairs.join(", ")}]`
}

/**
 * Apply vertex updates to the document. When the vertex count matches, does
 * surgical in-place edits (no reformatting); otherwise falls back to a full
 * array replace with format preservation.
 *
 * The parser's offsets are already in user-source coordinates, and CodeMirror's
 * document model is offset-based, so the edits dispatch directly (no line/column
 * round-trip, no reverse-sort — CM6 maps all changes against the original doc).
 * Undo grouping is handled by CM6's time-based history (rapid drag edits merge).
 */
export function applyVertexUpdates(
    view: EditorView,
    info: Polygon2DCallInfo,
    vertices: [number, number][],
): void {
    if (vertices.length === info.vertexRanges.length) {
        const changes = vertices.map((v, i) => ({
            from: info.vertexRanges[i].start,
            to: info.vertexRanges[i].end,
            insert: formatVertex(v),
        }))
        view.dispatch({ changes })
    } else {
        const originalText = view.state.doc.sliceString(info.arrayStartOffset, info.arrayEndOffset)
        const format = analyzeArrayFormatting(originalText)
        const newText = formatVertices(vertices, format)
        view.dispatch({ changes: { from: info.arrayStartOffset, to: info.arrayEndOffset, insert: newText } })
    }
}
