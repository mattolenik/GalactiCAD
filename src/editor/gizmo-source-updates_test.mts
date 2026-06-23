import assert from "node:assert/strict"
import test from "node:test"
import { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { SourceParser } from "../parser/source-parser.mjs"
import { applyGizmoTranslate, applyGizmoRotate } from "./gizmo-source-updates.mjs"

/**
 * A gizmo move/rotate edits the source, which rebuilds the scene and renumbers
 * node ids whenever the edit adds a node (wrapping the chain in `translate(...)`,
 * or turning `.rotate(...)` on a field-less primitive into a `Rotate` operator).
 * The fix has the edit functions return the object's POST-EDIT source position so
 * the app can re-select it (and re-anchor the gizmo) against the renumbered tree.
 * These tests assert that returned position still lands on the same object's
 * function name in the edited source.
 */

/** Minimal headless EditorView: enough for applyGizmo* (state.doc + dispatch). */
function headlessView(initial: string): EditorView {
    let state = EditorState.create({ doc: initial })
    return {
        get state() {
            return state
        },
        dispatch(spec: { changes?: unknown }) {
            state = state.update(spec as Parameters<EditorState["update"]>[0]).state
        },
    } as unknown as EditorView
}

/** 1-based {line, column} of the first occurrence of `needle` in `src`. */
function posOf(src: string, needle: string): { line: number; column: number } {
    const idx = src.indexOf(needle)
    assert.ok(idx >= 0, `"${needle}" present`)
    const before = src.slice(0, idx)
    const line = before.split("\n").length
    const column = idx - before.lastIndexOf("\n")
    return { line, column }
}

/** Character at a 1-based {line, column} in a doc string. */
function charAt(doc: string, line: number, column: number): string {
    const text = doc.split("\n")[line - 1] ?? ""
    return text[column - 1] ?? ""
}

const parser = new SourceParser()

function targetAt(src: string, name: string) {
    const { line, column } = posOf(src, name)
    const t = parser.findTransformTargetAtPosition(src, line, column)
    assert.ok(t, `transform target resolved at ${name}`)
    return t!
}

test("translate append (box, no prior shift): position stable, resolves to box", () => {
    const src = "return box(2,2,2)"
    const view = headlessView(src)
    const re = applyGizmoTranslate(view, targetAt(src, "box"), [3, 1, 0], [3, 1, 0])
    const doc = view.state.doc.toString()
    assert.match(doc, /box\(2,2,2\)\.shift\(\[3, 1, 0\]\)/)
    assert.equal(charAt(doc, re.line, re.column), "b", "re-select lands on 'box'")
    assert.equal(parser.findTransformTargetAtPosition(doc, re.line, re.column)?.location.functionName, "box")
})

test("translate in-place (box, literal shift): resolves to box", () => {
    const src = "return box(2,2,2).shift([1,0,0])"
    const view = headlessView(src)
    const re = applyGizmoTranslate(view, targetAt(src, "box"), [4, 0, 0], [3, 0, 0])
    const doc = view.state.doc.toString()
    assert.match(doc, /\.shift\(\[4, 0, 0\]\)/)
    assert.equal(charAt(doc, re.line, re.column), "b")
    assert.equal(parser.findTransformTargetAtPosition(doc, re.line, re.column)?.location.functionName, "box")
})

test("translate WRAP (box, non-literal shift): position tracks the prefix, still resolves to box", () => {
    const src = "const a = 5\nreturn box(2,2,2).shift([a,0,0])"
    const view = headlessView(src)
    const re = applyGizmoTranslate(view, targetAt(src, "box"), [0, 0, 0], [3, 0, 0])
    const doc = view.state.doc.toString()
    assert.match(doc, /translate\(\[3, 0, 0\], box\(2,2,2\)\.shift\(\[a,0,0\]\)\)/)
    // The function name shifted right by the inserted prefix; the position must
    // still land on 'box' (NOT the new 'translate' wrapper).
    assert.equal(charAt(doc, re.line, re.column), "b", "re-select lands on the inner 'box'")
    assert.equal(parser.findTransformTargetAtPosition(doc, re.line, re.column)?.location.functionName, "box")
})

test("rotate field (box): position stable, resolves to box", () => {
    const src = "return box(2,2,2)"
    const view = headlessView(src)
    const re = applyGizmoRotate(view, targetAt(src, "box"), 2, 45)
    const doc = view.state.doc.toString()
    assert.match(doc, /box\(2,2,2\)\.rotate\(/)
    assert.equal(charAt(doc, re.line, re.column), "b")
    assert.equal(parser.findTransformTargetAtPosition(doc, re.line, re.column)?.location.functionName, "box")
})

test("rotate operator-wrap (sphere has no rot field): position stable, resolves to sphere", () => {
    const src = "return sphere.radius(2)"
    const view = headlessView(src)
    const re = applyGizmoRotate(view, targetAt(src, "sphere"), 2, 45)
    const doc = view.state.doc.toString()
    assert.match(doc, /sphere\.radius\(2\)\.rotate\(/)
    assert.equal(charAt(doc, re.line, re.column), "s", "re-select lands on 'sphere'")
    assert.equal(parser.findTransformTargetAtPosition(doc, re.line, re.column)?.location.functionName, "sphere")
})
