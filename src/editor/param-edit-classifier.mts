/**
 * Classify a CodeMirror document change as a *structure-preserving param edit* —
 * a numeric-literal change confined to a single transform's literal args
 * (`.shift(...)` / pre-shift `.rotate(...)`). Such an edit provably cannot change
 * the scene's structural fingerprint (types + topology, never values), so the
 * worker can patch the affected node's stable param slot in place instead of
 * re-evaluating the whole DSL and re-packing every node.
 *
 * It keys off the *change*, not its origin, so it uniformly covers the gizmo's
 * commit, a human typing a number into a `.shift`, and undo/redo of either.
 * Conservative by design: anything it can't prove safe returns null → the caller
 * falls back to a full build. See docs/plans/gizmo-incremental-param-edit.md.
 */

import type { ChangeSet } from "@codemirror/state"
import type { SourceParser } from "../parser/source-parser.mjs"

export interface ParamEditResult {
    /** Transform target's function-name position (1-based), for node resolution by the caller. */
    line: number
    column: number
    kind: "translate" | "rotate"
    /** Absolute local translation / Euler (deg) the source now evaluates to. */
    value: [number, number, number]
}

/** Only digits, signs, exponent, decimal points, vector commas, whitespace, brackets. */
const NUMERIC_INSERT = /^[-+0-9.eE,\s[\]]*$/

/** 1-based {line, column} of a 0-based character offset in `doc`. */
function offsetToLineColumn(doc: string, offset: number): { line: number; column: number } {
    let line = 1
    let lineStart = 0
    for (let i = 0; i < offset && i < doc.length; i++) {
        if (doc.charCodeAt(i) === 10 /* \n */) {
            line++
            lineStart = i + 1
        }
    }
    return { line, column: offset - lineStart + 1 }
}

/**
 * Returns the param-patch descriptor when `changes` is a single contiguous,
 * numeric-only edit fully inside one transform's literal args; otherwise null.
 * `newDoc` is the post-change document. `parser` re-parses it to resolve the
 * transform target (the same call the gizmo uses).
 */
export function classifyParamEdit(changes: ChangeSet, newDoc: string, parser: SourceParser): ParamEditResult | null {
    // 1) Exactly one contiguous changed range.
    const ranges: { fromB: number; toB: number }[] = []
    changes.iterChanges((_fromA, _toA, fromB, toB) => ranges.push({ fromB, toB }))
    if (ranges.length !== 1) return null
    const { fromB, toB } = ranges[0]!

    // 2) Inserted text is numeric-literal-only (cheap structural guard; deletions
    //    have empty inserted text and pass — the containment + parse checks below
    //    still gate them).
    if (!NUMERIC_INSERT.test(newDoc.slice(fromB, toB))) return null

    // 3) Resolve the transform target at the edit position.
    const { line, column } = offsetToLineColumn(newDoc, fromB)
    const t = parser.findTransformTargetAtPosition(newDoc, line, column)
    if (!t) return null

    // 4) The edited range must sit fully inside one transform's literal args, and
    //    that literal must parse to a numeric Vec3 in the new doc.
    const within = (r: { start: number; end: number } | null) => r !== null && fromB >= r.start && toB <= r.end
    if (within(t.shiftRange) && t.shiftValue) {
        return { line: t.location.startLine, column: t.location.startColumn, kind: "translate", value: t.shiftValue }
    }
    // Rotate composes across calls, so a single literal == the absolute rot only
    // when there's exactly one pre-shift rotate; otherwise fall back.
    if (within(t.rotateRange) && t.rotateBaseEuler && t.preShiftRotateCount === 1) {
        return { line: t.location.startLine, column: t.location.startColumn, kind: "rotate", value: t.rotateBaseEuler }
    }
    return null
}
