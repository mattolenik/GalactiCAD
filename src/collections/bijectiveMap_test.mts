import test from "node:test"
import assert from "node:assert/strict"
import { BijectiveMap } from "./bijectiveMap.mjs"

// Helper factory for unique functions and symbols
const makeFn = (n: number) => () => n
const makeSym = (desc: string) => Symbol(desc)

test("Map interface: set/get/delete/has/size/clear", () => {
    const map = new BijectiveMap<number, string>()
    assert.equal(map.size, 0)

    map.set(1, "a")
    map.set(2, "b")

    assert.equal(map.get(1), "a")
    assert.equal(map.has(2), true)
    assert.equal(map.size, 2)

    assert.equal(map.delete(1), true)
    assert.equal(map.get(1), undefined)
    assert.equal(map.size, 1)

    map.clear()
    assert.equal(map.size, 0)
    assert.equal(map.has(2), false)
})

test("Map interface: keys/values/entries/[Symbol.iterator]", () => {
    const map = new BijectiveMap<string, number>()
    map.set("x", 10).set("y", 20)

    assert.deepEqual([...map.keys()], ["x", "y"])
    assert.deepEqual([...map.values()], [10, 20])
    assert.deepEqual(
        [...map.entries()],
        [
            ["x", 10],
            ["y", 20],
        ]
    )
    assert.deepEqual(
        [...map],
        [
            ["x", 10],
            ["y", 20],
        ]
    )
})

test("Map interface: forEach", () => {
    const map = new BijectiveMap<string, number>()
    map.set("a", 1).set("b", 2)

    const results: [string, number][] = []
    map.forEach((v, k) => results.push([k, v]))
    assert.deepEqual(results, [
        ["a", 1],
        ["b", 2],
    ])
})

test("Supports object keys and values", () => {
    const k1 = { foo: 1 }
    const v1 = { bar: 2 }
    const map = new BijectiveMap<object, object>()
    map.set(k1, v1)

    assert.equal(map.get(k1), v1)
    assert.equal(map.getInverse(v1), k1)
    assert.equal(map.has(k1), true)
    assert.equal(map.hasValue(v1), true)
})

test("Supports function keys and values", () => {
    const f1 = makeFn(1)
    const f2 = makeFn(2)

    const map = new BijectiveMap<Function, Function>()
    map.set(f1, f2)

    assert.equal(map.get(f1), f2)
    assert.equal(map.getInverse(f2), f1)
})

test("Supports symbol keys and values", () => {
    const s1 = makeSym("a")
    const s2 = makeSym("b")

    const map = new BijectiveMap<symbol, symbol>()
    map.set(s1, s2)

    assert.equal(map.get(s1), s2)
    assert.equal(map.getInverse(s2), s1)
    assert.equal(map.has(s1), true)
    assert.equal(map.hasValue(s2), true)
})

test("Map interface: chaining set", () => {
    const map = new BijectiveMap<number, string>()
    map.set(1, "one").set(2, "two").set(3, "three")
    assert.equal(map.size, 3)
})

test("Inverse map is safe from external mutation", () => {
    const map = new BijectiveMap<string, number>()
    map.set("a", 1)
    const inv = map.inverse

    inv.set(99, "hax")
    assert.equal(map.getInverse(99), undefined) // Should not exist
})

test("String coercion tag", () => {
    const map = new BijectiveMap<number, string>()
    assert.equal(Object.prototype.toString.call(map), "[object BijectiveMap]")
})
