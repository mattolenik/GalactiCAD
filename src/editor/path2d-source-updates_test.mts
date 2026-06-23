import assert from "node:assert/strict"
import test from "node:test"
import type { PathElement } from "../scene/primitives/path2d.mjs"
import { formatPathElement, formatPathElements } from "./path2d-source-updates.mjs"

test("formatPathElement: appends a node-type tag to a control polygon", () => {
    const cubic: PathElement = [[0, 0], [1, 2], [3, 4], [5, 0]]
    assert.equal(formatPathElement(cubic, "smart"), `[[0, 0], [1, 2], [3, 4], [5, 0], "smart"]`)
})

test("formatPathElement: no tag when absent; a vertex is never tagged", () => {
    assert.equal(formatPathElement([[0, 0], [5, 0]]), `[[0, 0], [5, 0]]`)
    assert.equal(formatPathElement([3, 4], "smooth"), `[3, 4]`) // vertex ignores the tag
})

test("formatPathElements: tags are applied per element index", () => {
    const els: PathElement[] = [[0, 0], [[0, 0], [1, 1], [2, 0]]]
    const out = formatPathElements(els, { indent: "", newlinePerElement: false }, [null, "symmetric"])
    assert.equal(out, `[0, 0], [[0, 0], [1, 1], [2, 0], "symmetric"]`)
})
