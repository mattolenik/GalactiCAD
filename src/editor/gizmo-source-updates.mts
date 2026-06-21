/**
 * Source-code write-back for the transform gizmo.
 *
 * Translate rules (see GizmoTransformTarget):
 *  - existing **literal** `.shift([...])` → replace its args with the new
 *    absolute value in place (a primitive's `.shift` sets `pos` absolutely; an
 *    operator `Translate`'s value is likewise the absolute delta we tracked).
 *  - existing **non-literal** `.shift([expr])` → can't edit it (and a primitive
 *    `.shift` doesn't stack), so WRAP the whole chain in `translate([Δ], …)`,
 *    which composes additively for both primitives and operators.
 *  - **no** `.shift` → append `.shift([final])` at the chain end.
 *
 * CM6 history merges the (single) dispatch into the surrounding undo group.
 */

import type { EditorView } from "@codemirror/view"
import type { GizmoTransformTarget } from "../parser/source-parser.mjs"
import { eulerToFwd, fwdToEuler, matMul3 } from "../gizmo/rotation.mjs"

/** Format a number for source: round to 4 decimals, drop trailing zeros. */
function fmt(n: number): string {
    const r = Math.round(n * 1e4) / 1e4
    return Object.is(r, -0) ? "0" : String(r)
}

function vecLiteral(v: readonly [number, number, number]): string {
    return `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`
}

/**
 * Apply a gizmo translate to the source. `final` is the new absolute local
 * translation (base + delta); `delta` is the local delta from drag start.
 */
export function applyGizmoTranslate(
    view: EditorView,
    target: GizmoTransformTarget,
    final: readonly [number, number, number],
    delta: readonly [number, number, number],
): void {
    if (target.shiftIsLiteral && target.shiftRange) {
        // Edit the existing literal shift in place (always emit array form).
        view.dispatch({ changes: { from: target.shiftRange.start, to: target.shiftRange.end, insert: vecLiteral(final) } })
        return
    }
    if (target.hasShift) {
        // Non-literal shift: wrap the chain in an additive translate(...).
        const original = view.state.doc.sliceString(target.chainStart, target.insertOffset)
        view.dispatch({
            changes: { from: target.chainStart, to: target.insertOffset, insert: `translate(${vecLiteral(delta)}, ${original})` },
        })
        return
    }
    // No shift yet — append one at the chain end (sets the absolute position).
    view.dispatch({ changes: { from: target.insertOffset, insert: `.shift(${vecLiteral(final)})` } })
}

/**
 * Apply a gizmo rotation (local, body-frame) about local `axis` by `angleDeg`
 * to the source. Composes onto the existing pre-shift rotation (body-frame
 * post-multiply) and writes a pre-shift `.rotate(...)`:
 *  - existing literal pre-shift rotate → replace with the composed Euler.
 *  - existing non-literal pre-shift rotate → insert a delta `.rotate` before the shift.
 *  - none → insert `.rotate([euler])` before the first `.shift` (or at chain end).
 */
export function applyGizmoRotate(view: EditorView, target: GizmoTransformTarget, axis: number, angleDeg: number): void {
    const base = target.rotateBaseEuler ?? [0, 0, 0]
    const deltaEuler: [number, number, number] = [axis === 0 ? angleDeg : 0, axis === 1 ? angleDeg : 0, axis === 2 ? angleDeg : 0]
    const newEuler = fwdToEuler(matMul3(eulerToFwd(base[0]!, base[1]!, base[2]!), eulerToFwd(deltaEuler[0], deltaEuler[1], deltaEuler[2])))

    if (target.rotateIsLiteral && target.rotateRange) {
        view.dispatch({ changes: { from: target.rotateRange.start, to: target.rotateRange.end, insert: vecLiteral(newEuler) } })
        return
    }
    if (target.hasPreShiftRotate) {
        // Non-literal existing rotate: stack a delta rotate before the shift.
        view.dispatch({ changes: { from: target.rotateInsertOffset, insert: `.rotate(${vecLiteral(deltaEuler)})` } })
        return
    }
    view.dispatch({ changes: { from: target.rotateInsertOffset, insert: `.rotate(${vecLiteral(newEuler)})` } })
}
