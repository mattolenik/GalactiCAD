import test from "node:test"
import assert from "node:assert/strict"
import { Vec4Array } from "./arrays.mjs"

test("Vec4Array basic set and get", () => {
    const vecArray = new Vec4Array(3)
    const vector0 = new Float32Array([1, 2, 3, 4])
    const vector1 = new Float32Array([5, 6, 7, 8])
    const vector2 = new Float32Array([9, 10, 11, 12])

    vecArray.set(0, vector0)
    vecArray.set(1, vector1)
    vecArray.set(2, vector2)

    assert.deepEqual(vecArray.get(0).elements, vector0, "Vector at index 0 should match")
    assert.deepEqual(vecArray.get(1).elements, vector1, "Vector at index 1 should match")
    assert.deepEqual(vecArray.get(2).elements, vector2, "Vector at index 2 should match")
})

test("Vec4Array should throw error for invalid vector length", () => {
    const vecArray = new Vec4Array(1)
    assert.throws(
        () => {
            vecArray.set(0, new Float32Array([1, 2, 3])) // Only 3 elements
        },
        {
            message: "Input vector must have exactly 4 elements",
        }
    )
})

test("Vec4Array should throw error for set/get out-of-bounds", () => {
    const vecArray = new Vec4Array(1)
    // Setting out-of-bounds.
    assert.throws(
        () => {
            vecArray.set(1, new Float32Array([1, 2, 3, 4]))
        },
        {
            message: "Index out of bounds",
        }
    )

    // Getting out-of-bounds.
    assert.throws(
        () => {
            vecArray.get(1)
        },
        {
            message: "Index out of bounds",
        }
    )
})
