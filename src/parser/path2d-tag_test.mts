import assert from "node:assert/strict"
import test from "node:test"
import { sourceParser } from "./source-parser.mjs"

test("path2d parser: extracts a trailing node-type tag, geometry unaffected", () => {
    const src = `const p = path2d([0,0], [[0,0],[1,2],[3,4],[5,0], "smart"], [10,0])`
    const info = sourceParser.findPath2DAtPosition(src, 1, 13) // a column inside the call
    assert.ok(info, "path2d call found")
    assert.equal(info!.elements.length, 3)
    assert.deepStrictEqual(info!.elements[1], [[0, 0], [1, 2], [3, 4], [5, 0]], "tag stripped from geometry")
    assert.deepStrictEqual(info!.nodeTypes, [null, "smart", null])
})

test("path2d parser: an untagged path yields all-null tags (back-compat)", () => {
    const src = `const p = path2d([0,0], [[0,0],[1,1],[2,0]])`
    const info = sourceParser.findPath2DAtPosition(src, 1, 13)
    assert.ok(info)
    assert.deepStrictEqual(info!.nodeTypes, [null, null])
    assert.deepStrictEqual(info!.elements[1], [[0, 0], [1, 1], [2, 0]])
})
