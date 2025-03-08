import test from "node:test"
import assert from "node:assert/strict"
import { ArgArray } from "./arrays.mjs"

test("ArgArray should throw error for invalid vector length", () => {
    const vecArray = new ArgArray(1)
    assert.throws(
        () => {
            vecArray.set(0, new Float32Array([1, 2, 3]))
        },
        {
            message: "Input vector must have exactly 4 elements",
        }
    )
})

test("ArgArray should throw error for set out of bounds", () => {
    const vecArray = new ArgArray(1)
    assert.throws(
        () => {
            vecArray.set(4, new Float32Array([1, 2, 3, 4]))
        },
        {
            message: "Index out of bounds",
        }
    )
})
