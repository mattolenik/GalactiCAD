import assert from "node:assert/strict"
import test from "node:test"
import { computeRemoveEdits, mergeEdits, type TextEdit } from "./remove-symbol.mjs"

/** Parse a source string with a `|` caret marker → { src, offset }. */
function caret(marked: string): { src: string; offset: number } {
    const offset = marked.indexOf("|")
    assert.ok(offset >= 0, "test source must contain a | caret")
    return { src: marked.slice(0, offset) + marked.slice(offset + 1), offset }
}

/** Apply edits (descending, non-overlapping) to produce the resulting source. */
function applyEdits(src: string, edits: TextEdit[]): string {
    let out = src
    for (const e of [...edits].sort((a, b) => b.from - a.from)) {
        out = out.slice(0, e.from) + e.insert + out.slice(e.to)
    }
    return out
}

/** Run computeRemoveEdits at the caret and assert the resulting source. */
function expectRemove(marked: string, expected: string): void {
    const { src, offset } = caret(marked)
    const edits = computeRemoveEdits(src, offset)
    assert.notEqual(edits, null, `expected removable symbol in: ${src}`)
    assert.equal(applyEdits(src, edits!), expected)
}

function expectNull(marked: string): void {
    const { src, offset } = caret(marked)
    assert.equal(computeRemoveEdits(src, offset), null)
}

// --- functional unary modifier unwrap ---------------------------------------

test("unary modifier unwrap → geometry (last) argument", () => {
    expectRemove("rot|ate(30, foo)", "foo")
})

test("nested unwrap: remove inner modifier keeps the wrapper", () => {
    expectRemove("rotate(30, transl|ate([1, 0, 0], foo))", "rotate(30, foo)")
})

test("nested unwrap: remove outer modifier keeps the inner call", () => {
    expectRemove("rot|ate(30, translate([1, 0, 0], foo))", "translate([1, 0, 0], foo)")
})

// --- fluent modifier segment strip ------------------------------------------

test("fluent strip: remove a middle .method() segment", () => {
    expectRemove("foo.sh|ift(x).rotate(y)", "foo.rotate(y)")
})

test("fluent strip: remove a tail .method() segment", () => {
    expectRemove("foo.shift(x).ro|tate(y)", "foo.shift(x)")
})

test("fluent strip: optional tail keeps the primitive", () => {
    expectRemove("let s = sphere.radius(2).sh|ift(x)", "let s = sphere.radius(2)")
})

// --- leaf primitive / required-first method → whole expression --------------

test("required first method removes the whole primitive", () => {
    expectRemove("let s = sphere.rad|ius(2).shift(x)", "let s = ")
})

test("primitive namespace receiver removes the whole primitive", () => {
    expectRemove("let s = sph|ere.radius(2).shift(x)", "let s = ")
})

test("bare-call primitive head removes the whole expression", () => {
    expectRemove("let b = bo|x([1, 1, 1]).shift([2, 0, 0])", "let b = ")
})

// --- rendering composites with a namespace constructor ----------------------

test("extrude namespace receiver removes the whole expression", () => {
    expectRemove("let e = extr|ude.profile(poly).height(2)", "let e = ")
})

test("extrude required first method removes the whole expression", () => {
    expectRemove("let e = extrude.pro|file(poly).height(2)", "let e = ")
})

test("extrude optional tail method is stripped", () => {
    expectRemove("let e = extrude.profile(poly).hei|ght(2)", "let e = extrude.profile(poly)")
})

test("loft namespace receiver removes the whole expression", () => {
    expectRemove("let l = lo|ft.sections(a, b)", "let l = ")
})

// --- shape as a list element → clean elision --------------------------------

test("shape as middle argument elides with its comma", () => {
    expectRemove("union(a, bo|x([1, 1, 1]), c)", "union(a, c)")
})

test("shape as first argument elides trailing comma", () => {
    expectRemove("union(bo|x([1, 1, 1]), c)", "union(c)")
})

test("shape as last argument elides preceding comma", () => {
    expectRemove("union(a, bo|x([1, 1, 1]))", "union(a)")
})

test("shape as only argument leaves an empty list", () => {
    expectRemove("union(bo|x([1, 1, 1]))", "union()")
})

// --- n-ary operator / composite head → whole call ---------------------------

test("operator head removes the whole call", () => {
    expectRemove("let s = uni|on(a, b, c)", "let s = ")
})

test("operator head as an argument elides cleanly", () => {
    expectRemove("subtract(uni|on(a, b), d)", "subtract(d)")
})

// --- non-DSL / custom code → no removal -------------------------------------

test("custom function head is not removable", () => {
    expectNull("myHel|per(x, y)")
})

test("unrecognized .property method is not removable", () => {
    expectNull("foo.ba|r(x)")
})

test("undeclared bare identifier is not removable", () => {
    expectNull("union(a|, b)")
})

// --- variable declaration removal + reference cascade -----------------------

test("removing a variable name deletes its declaration and elides references", () => {
    // Note: the array is assigned (`let arr = [...]`) so it parses as an array
    // literal rather than fusing with the previous line via ASI as element access.
    const src = "let obj = box([1, 1, 1])\nlet z = obj\nunion(a, obj, c)\nlet arr = [obj, d]"
    const offset = src.indexOf("obj") + 1 // caret inside the declaration name
    const edits = computeRemoveEdits(src, offset)
    assert.notEqual(edits, null)
    assert.equal(applyEdits(src, edits!), "let z = \nunion(a, c)\nlet arr = [d]")
})

test("cascade: reference as the sole argument leaves the enclosing call", () => {
    const src = "let obj = sphere.radius(1)\nsome(expression(obj))"
    const offset = src.indexOf("obj") + 1
    const edits = computeRemoveEdits(src, offset)
    assert.notEqual(edits, null)
    assert.equal(applyEdits(src, edits!), "some(expression())")
})

test("cascade: member-access names sharing the variable name are preserved", () => {
    const src = "let obj = box([1, 1, 1])\nq.obj"
    const offset = src.indexOf("obj") + 1
    const edits = computeRemoveEdits(src, offset)
    assert.notEqual(edits, null)
    assert.equal(applyEdits(src, edits!), "q.obj")
})

test("variable reference occurrence removes just that occurrence", () => {
    const src = "let obj = box([1, 1, 1])\nunion(a, obj, c)"
    const offset = src.indexOf("obj", src.indexOf("union")) + 1 // caret on the reference in union
    const edits = computeRemoveEdits(src, offset)
    assert.notEqual(edits, null)
    assert.equal(applyEdits(src, edits!), "let obj = box([1, 1, 1])\nunion(a, c)")
})

// --- multi-object removal (SDF-preview selection / Delete key) ---------------

/** Mirror removeSymbolsAt's pure core: edits for many offsets, computed together, merged. */
function removeMany(src: string, offsets: number[]): string {
    const all: TextEdit[] = []
    for (const o of offsets) {
        const edits = computeRemoveEdits(src, o)
        if (edits) all.push(...edits)
    }
    return applyEdits(src, mergeEdits(all))
}

test("multi-object: two distinct objects are removed together", () => {
    const src = "let a = box([1, 1, 1])\nlet b = sphere.radius(2)"
    const out = removeMany(src, [src.indexOf("box") + 1, src.indexOf("sphere") + 1])
    assert.equal(out, "let a = \nlet b = ")
})

test("multi-object: overlapping parent+child edits merge to the parent removal", () => {
    const src = "let s = union(box([1, 1, 1]), sphere.radius(1))"
    const out = removeMany(src, [src.indexOf("union") + 1, src.indexOf("box") + 1])
    assert.equal(out, "let s = ")
})

test("mergeEdits: disjoint deletions are kept separate and sorted", () => {
    const merged = mergeEdits([
        { from: 10, to: 15, insert: "" },
        { from: 2, to: 5, insert: "" },
    ])
    assert.deepEqual(merged, [
        { from: 2, to: 5, insert: "" },
        { from: 10, to: 15, insert: "" },
    ])
})

test("mergeEdits: overlapping ranges collapse into one", () => {
    const merged = mergeEdits([
        { from: 5, to: 20, insert: "" },
        { from: 8, to: 12, insert: "" },
    ])
    assert.deepEqual(merged, [{ from: 5, to: 20, insert: "" }])
})
