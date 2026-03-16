/**
 * Source code updates for polygon2d vertex arrays.
 * Used when the user edits vertices in the polygon editor.
 */

import * as monaco from "monaco-editor"
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
 * Apply vertex updates to the model. When vertex count matches, does surgical
 * in-place edits (no reformatting). Otherwise falls back to full replace with format preservation.
 */
export function applyVertexUpdates(
    model: monaco.editor.ITextModel,
    info: Polygon2DCallInfo,
    vertices: [number, number][],
    groupEdits = false
): void {
    if (vertices.length === info.vertexRanges.length) {
        const edits = vertices
            .map((v, i) => {
                const start = model.getPositionAt(info.vertexRanges[i].start)
                const end = model.getPositionAt(info.vertexRanges[i].end)
                return {
                    range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                    text: formatVertex(v),
                }
            })
            .sort((a, b) => {
                const ap = a.range.getStartPosition()
                const bp = b.range.getStartPosition()
                return bp.lineNumber - ap.lineNumber || bp.column - ap.column
            })
        if (!groupEdits) model.pushStackElement()
        model.pushEditOperations([], edits, () => null)
        if (!groupEdits) model.pushStackElement()
    } else {
        const originalText = model.getValue().slice(info.arrayStartOffset, info.arrayEndOffset)
        const format = analyzeArrayFormatting(originalText)
        const newText = formatVertices(vertices, format)
        const startPos = model.getPositionAt(info.arrayStartOffset)
        const endPos = model.getPositionAt(info.arrayEndOffset)
        const range = new monaco.Range(
            startPos.lineNumber, startPos.column,
            endPos.lineNumber, endPos.column
        )
        if (!groupEdits) model.pushStackElement()
        model.pushEditOperations([], [{ range, text: newText }], () => null)
        if (!groupEdits) model.pushStackElement()
    }
}
