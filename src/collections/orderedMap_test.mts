// orderedMap.test.ts
import test from "node:test"
import assert from "node:assert/strict"
import { OrderedMap } from "./orderedMap.mjs"

test("empty map has size 0 and no entries", () => {
    const om = new OrderedMap<string, number>()
    assert.strictEqual(om.size, 0)
    assert.deepStrictEqual([...om.keys()], [])
    assert.deepStrictEqual([...om.values()], [])
    assert.deepStrictEqual([...om.entries()], [])
    let called = false
    om.forEach(() => {
        called = true
    })
    assert.strictEqual(called, false, "forEach should not be called on empty map")
})

test("insertion order is preserved for keys, values, and entries", () => {
    const om = new OrderedMap<string, number>()
    om.set("one", 1).set("two", 2).set("three", 3)
    assert.deepStrictEqual([...om.keys()], ["one", "two", "three"])
    assert.deepStrictEqual([...om.values()], [1, 2, 3])
    assert.deepStrictEqual(
        [...om.entries()],
        [
            ["one", 1],
            ["two", 2],
            ["three", 3],
        ]
    )
    // Symbol.iterator should be same as entries()
    assert.deepStrictEqual([...om], [...om.entries()])
})

test("updating an existing key does not change its position", () => {
    const om = new OrderedMap<string, number>()
    om.set("a", 10).set("b", 20).set("c", 30)
    om.set("b", 200)
    assert.deepStrictEqual([...om.keys()], ["a", "b", "c"])
    assert.deepStrictEqual([...om.values()], [10, 200, 30])
})

test("deleting a key removes it and preserves order of the rest", () => {
    const om = new OrderedMap<string, number>()
    om.set("x", 9).set("y", 8).set("z", 7)
    assert.strictEqual(om.delete("y"), true)
    assert.deepStrictEqual([...om.keys()], ["x", "z"])
    assert.deepStrictEqual([...om.values()], [9, 7])
    // deleting non-existent key
    assert.strictEqual(om.delete("not-there"), false)
    assert.deepStrictEqual([...om.keys()], ["x", "z"])
})

test("clear() empties the map", () => {
    const om = new OrderedMap<number, number>([
        [1, 1],
        [2, 2],
        [3, 3],
    ])
    assert.strictEqual(om.size, 3)
    om.clear()
    assert.strictEqual(om.size, 0)
    assert.deepStrictEqual([...om.entries()], [])
})

test("constructor(entries) initializes in given order", () => {
    const entries: Array<[string, number]> = [
        ["first", 100],
        ["second", 200],
        ["third", 300],
    ]
    const om = new OrderedMap(entries)
    assert.deepStrictEqual([...om.keys()], ["first", "second", "third"])
    assert.deepStrictEqual([...om.values()], [100, 200, 300])
})

test("set() returns this for chaining", () => {
    const om = new OrderedMap<number, number>()
    const returned = om.set(1, 1).set(2, 2).set(3, 3)
    assert.strictEqual(returned, om)
    assert.deepStrictEqual([...om.keys()], [1, 2, 3])
})

test("get() and has() behave like Map", () => {
    const om = new OrderedMap<string, boolean>()
    assert.strictEqual(om.has("foo"), false)
    assert.strictEqual(om.get("foo"), undefined)
    om.set("foo", true)
    assert.strictEqual(om.has("foo"), true)
    assert.strictEqual(om.get("foo"), true)
})
