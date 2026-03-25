/**
 * Source code updates for extrude, loft, and threaded_rod cap push/pull.
 * Updates the `height` value and `.shift([...])` in source when the user drags a cap.
 */

import * as monaco from "monaco-editor"
import type { ExtrudeLoftCallInfo } from "../parser/source-parser.mjs"

export function formatNumber(n: number): string {
    const rounded = Math.round(n * 1000) / 1000
    return String(rounded)
}

/**
 * Update the Y component of a position argument in source.
 * Handles string-form "x y z" and array-form [x, y, z].
 */
export function updatePosY(posText: string, newY: number): string | null {
    const trimmed = posText.trim()

    // String form: "x y z"
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
        const quote = trimmed[0]
        const inner = trimmed.slice(1, -1).trim()
        const parts = inner.split(/\s+/)
        if (parts.length === 3) {
            parts[1] = formatNumber(newY)
            return `${quote}${parts.join(" ")}${quote}`
        }
        return null
    }

    // Array form: [x, y, z]
    if (trimmed.startsWith("[")) {
        const inner = trimmed.slice(1, -1)
        const parts = inner.split(",").map(s => s.trim())
        if (parts.length === 3) {
            parts[1] = formatNumber(newY)
            return `[${parts.join(", ")}]`
        }
        return null
    }

    return null
}

/** Node with h and pos used by extrude/loft for in-memory sync after cap drag. */
export interface ExtrudeLikeNode {
    h: number
    pos: { y: number }
}

/**
 * Apply cap push/pull updates to the model: h value and optionally position.
 * Also updates the in-memory node so the next drag starts from correct values.
 */
export function applyExtrudeLoftCapUpdates(
    model: monaco.editor.ITextModel,
    info: ExtrudeLoftCallInfo,
    newH: number,
    newPosY: number,
    node?: ExtrudeLikeNode,
    groupEdits = false
): void {
    if (node && "h" in node) {
        node.h = newH
        node.pos.y = newPosY
    }

    const src = model.getValue()
    if (!groupEdits) model.pushStackElement()

    const edits: { range: monaco.IRange; text: string }[] = []

    // Update h value
    const hStart = model.getPositionAt(info.hValueStart)
    const hEnd = model.getPositionAt(info.hValueEnd)
    edits.push({
        range: new monaco.Range(hStart.lineNumber, hStart.column, hEnd.lineNumber, hEnd.column),
        text: formatNumber(newH),
    })

    // Update position if it exists, or insert one if the Y component changed
    if (info.posArgStart !== null && info.posArgEnd !== null) {
        const posText = src.substring(info.posArgStart, info.posArgEnd)
        const updatedPosText = updatePosY(posText, newPosY)
        if (updatedPosText !== null) {
            const posStart = model.getPositionAt(info.posArgStart)
            const posEnd = model.getPositionAt(info.posArgEnd)
            edits.push({
                range: new monaco.Range(posStart.lineNumber, posStart.column, posEnd.lineNumber, posEnd.column),
                text: updatedPosText,
            })
        }
    } else if (Math.abs(newPosY) > 0.0005) {
        // No .shift() yet: append fluent `.shift([0, y, 0])` at the end of the full call (not object-style `pos:`).
        const insertPos = model.getPositionAt(info.insertPosOffset)
        edits.push({
            range: new monaco.Range(insertPos.lineNumber, insertPos.column, insertPos.lineNumber, insertPos.column),
            text: `.shift([0, ${formatNumber(newPosY)}, 0])`,
        })
    }

    // Apply edits in reverse offset order so earlier edits don't shift later ones
    edits.sort((a, b) => {
        if (a.range.startLineNumber !== b.range.startLineNumber)
            return b.range.startLineNumber - a.range.startLineNumber
        return b.range.startColumn - a.range.startColumn
    })
    model.pushEditOperations([], edits, () => null)
    if (!groupEdits) model.pushStackElement()
}
