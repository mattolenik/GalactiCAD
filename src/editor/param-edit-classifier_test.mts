import assert from "node:assert/strict"
import test from "node:test"
import { EditorState } from "@codemirror/state"
import { SourceParser } from "../parser/source-parser.mjs"
import { classifyParamEdit, type ParamEditResult } from "./param-edit-classifier.mjs"

/**
 * classifyParamEdit gates the incremental param-patch fast path: a numeric-literal
 * change confined to one transform's literal args is eligible (gizmo commit, manual
 * number edit, undo/redo); everything structural falls back to a full build.
 */

const parser = new SourceParser()

/** Apply one or more changes to `doc` and classify the resulting transaction. */
function classify(doc: string, changes: { from: number; to: number; insert: string } | { from: number; to: number; insert: string }[]): ParamEditResult | null {
    const s = EditorState.create({ doc })
    const tr = s.update({ changes })
    return classifyParamEdit(tr.changes, tr.state.doc.toString(), parser)
}

/** Offset of `needle` in `doc` (asserts it exists and is unique enough). */
function at(doc: string, needle: string): number {
    const i = doc.indexOf(needle)
    assert.ok(i >= 0, `"${needle}" present`)
    return i
}

test("eligible: edit a digit inside a literal .shift → translate", () => {
    const doc = "return box(2,2,2).shift([6, 0, -12])"
    const from = at(doc, "6, 0, -12")
    const r = classify(doc, { from, to: from + 1, insert: "60" }) // 6 -> 60
    assert.deepEqual(r, { line: 1, column: 8, kind: "translate", value: [60, 0, -12] })
})

test("eligible: scalar-form .shift(x, y, z) too", () => {
    const doc = "return box(2,2,2).shift(6, 0, -12)"
    const from = at(doc, "-12")
    const r = classify(doc, { from, to: from + 3, insert: "-15" })
    assert.ok(r && r.kind === "translate")
    assert.deepEqual(r!.value, [6, 0, -15])
})

test("eligible: edit a single pre-shift .rotate literal → rotate", () => {
    const doc = "return box(2,2,2).rotate([0, 0, 45]).shift([1,0,0])"
    const from = at(doc, "45")
    const r = classify(doc, { from, to: from + 2, insert: "50" })
    assert.deepEqual(r, { line: 1, column: 8, kind: "rotate", value: [0, 0, 50] })
})

test("eligible: undo of a shift edit is itself a numeric edit", () => {
    const doc = "return box(2,2,2).shift([6, 0, -12])"
    const from = at(doc, "6, 0, -12")
    const s0 = EditorState.create({ doc })
    const tr = s0.update({ changes: { from, to: from + 1, insert: "60" } })
    // Undo: invert the change relative to the edited doc, apply over original.
    const inv = tr.changes.invert(s0.doc)
    const r = classifyParamEdit(inv, s0.doc.toString(), parser)
    assert.deepEqual(r, { line: 1, column: 8, kind: "translate", value: [6, 0, -12] })
})

test("not eligible: non-literal (variable) shift arg", () => {
    const doc = "const a = 5\nreturn box(2,2,2).shift([a, 0, 0])"
    const from = at(doc, "0, 0])")
    assert.equal(classify(doc, { from, to: from + 1, insert: "1" }), null)
})

test("not eligible: multiple pre-shift rotates (composition)", () => {
    const doc = "return box(2,2,2).rotate([10,0,0]).rotate([0, 0, 45]).shift([1,0,0])"
    const from = at(doc, "45")
    assert.equal(classify(doc, { from, to: from + 2, insert: "50" }), null)
})

test("not eligible: inserting a new method (structural)", () => {
    const doc = "return box(2,2,2).shift([1,0,0])"
    const from = at(doc, ".shift")
    assert.equal(classify(doc, { from, to: from, insert: ".rotate([0,0,5])" }), null)
})

test("not eligible: wrapping in translate(...) operator", () => {
    const doc = "return box(2,2,2).shift([1,0,0])"
    const r = classify(doc, [
        { from: at(doc, "box"), to: at(doc, "box"), insert: "translate([1,0,0], " },
        { from: doc.length, to: doc.length, insert: ")" },
    ])
    assert.equal(r, null) // two ranges + non-numeric text
})

test("not eligible: edit outside any transform arg", () => {
    const doc = "const a = 5\nreturn box(2,2,2).shift([1,0,0])"
    const from = at(doc, "5")
    assert.equal(classify(doc, { from, to: from + 1, insert: "6" }), null)
})

test("not eligible: deletion that changes arity (3 args → 2)", () => {
    const doc = "return box(2,2,2).shift(6, 0, -12)"
    const from = at(doc, ", -12")
    // delete ", -12" → .shift(6, 0): no longer a Vec3 literal → fall back
    assert.equal(classify(doc, { from, to: from + 5, insert: "" }), null)
})
