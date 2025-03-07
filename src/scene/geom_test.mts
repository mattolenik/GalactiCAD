import test from "node:test"
import assert from "node:assert/strict"
import { asRadius } from "./geom.mjs"

test("asRadius", () => {
    assert.equal(asRadius(undefined, 10), 5)
    assert.equal(asRadius(0, 10), 5)
    assert.equal(asRadius(10, undefined), 10)
    assert.equal(asRadius(10, 0), 10)
    assert.throws(() => asRadius(10, 10), { message: "must pass a non-zero radius or diameter" })
    assert.throws(() => asRadius(undefined, undefined), { message: "must pass a non-zero radius or diameter" })
    assert.throws(() => asRadius(0, 0), { message: "must pass a non-zero radius or diameter" })
    assert.throws(() => asRadius(undefined, 0), { message: "must pass a non-zero radius or diameter" })
    assert.throws(() => asRadius(0, undefined), { message: "must pass a non-zero radius or diameter" })
})
