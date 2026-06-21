/**
 * Source code updates for extrude, loft, and threaded_rod cap push/pull.
 * Updates the `height` value and `.shift([...])` in source when the user drags a cap.
 */

import type { EditorView } from "@codemirror/view"
import type { ExtrudeLoftCallInfo } from "../parser/source-parser.mjs"

export function formatNumber(n: number): string {
    const rounded = Math.round(n * 1000) / 1000
    return String(rounded)
}

/**
 * Update the Y component of a position argument in source.
 * Handles string-form "x y z", array-form [x, y, z], and the literal
 * component form x, y, z (from `.shift(x, y, z)`).
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

    // Literal component form: x, y, z (from .shift(x, y, z) — no brackets; the
    // parser's posArg range spans all three components).
    const parts = trimmed.split(",").map(s => s.trim())
    if (parts.length === 3) {
        parts[1] = formatNumber(newY)
        return parts.join(", ")
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
    view: EditorView,
    info: ExtrudeLoftCallInfo,
    newH: number,
    newPosY: number,
    node?: ExtrudeLikeNode,
): void {
    if (node && "h" in node) {
        node.h = newH
        node.pos.y = newPosY
    }

    const src = view.state.doc.toString()
    // Parser offsets are user-source coordinates; dispatch them directly. CM6 maps
    // all changes against the original doc, so no reverse-sort is needed.
    const changes: { from: number; to: number; insert: string }[] = []

    // Update h value
    changes.push({ from: info.hValueStart, to: info.hValueEnd, insert: formatNumber(newH) })

    // Update position if it exists, or insert one if the Y component changed
    if (info.posArgStart !== null && info.posArgEnd !== null) {
        const posText = src.substring(info.posArgStart, info.posArgEnd)
        const updatedPosText = updatePosY(posText, newPosY)
        if (updatedPosText !== null) {
            changes.push({ from: info.posArgStart, to: info.posArgEnd, insert: updatedPosText })
        }
    } else if (Math.abs(newPosY) > 0.0005) {
        // No .shift() yet: append fluent `.shift([0, y, 0])` at the end of the full call (not object-style `pos:`).
        changes.push({ from: info.insertPosOffset, to: info.insertPosOffset, insert: `.shift([0, ${formatNumber(newPosY)}, 0])` })
    }

    view.dispatch({ changes })
}
