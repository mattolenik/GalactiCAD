import test from "node:test"
import assert from "node:assert/strict"
import { AveragedBuffer } from "./averagedbuffer.mjs"

test("constructor throws on non-positive length", () => {
    assert.throws(() => new AveragedBuffer(0), /length must be > 0/)
    assert.throws(() => new AveragedBuffer(-5), /length must be > 0/)
})

test("initial average is zero", () => {
    const buf = new AveragedBuffer(4)
    assert.strictEqual(buf.average, 0)
})

test("average after fewer updates includes implicit zeros", () => {
    const buf = new AveragedBuffer(3)
    buf.update(3)
    // buffer = [3, 0, 0] → sum = 3 → average = 3/3 = 1
    assert.strictEqual(buf.average, 1)
    buf.update(6)
    // buffer = [3, 6, 0] → sum = 9 → average = 9/3 = 3
    assert.strictEqual(buf.average, 3)
})

test("average after full buffer updates", () => {
    const buf = new AveragedBuffer(3)
    buf.update(1)
    buf.update(2)
    buf.update(3)
    // buffer = [1,2,3] → sum = 6 → average = 2
    assert.strictEqual(buf.average, 2)
})

test("rolling average drops oldest value correctly", () => {
    const buf = new AveragedBuffer(3)
    buf.update(1)
    buf.update(2)
    buf.update(3)
    // sum = 6, average = 2
    buf.update(4)
    // dropped 1, added 4 → sum = 6 + (4 - 1) = 9 → average = 3
    assert.strictEqual(buf.average, 3)
    buf.update(5)
    // dropped 2, added 5 → sum = 9 + (5 - 2) = 12 → average = 4
    assert.strictEqual(buf.average, 4)
})

test("reset brings buffer back to zeros", () => {
    const buf = new AveragedBuffer(3)
    buf.update(10)
    buf.update(20)
    assert.notStrictEqual(buf.average, 0)
    buf.reset()
    assert.strictEqual(buf.average, 0)
    // after reset, behaves like fresh buffer
    buf.update(6)
    // buffer = [6,0,0] → average = 6/3 = 2
    assert.strictEqual(buf.average, 2)
})
