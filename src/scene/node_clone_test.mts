import assert from "node:assert/strict"
import test from "node:test"
import {
    box,
    extrude,
    polygon2d,
    sphere,
    subtract,
    translate,
    type Box,
    type Extrude,
    type Subtract,
    type Translate,
} from "./scene.mjs"

test("Node.clone deep-copies CSG and primitives", () => {
    const root = subtract(box([2, 2, 2]), sphere.radius(1)) as Subtract
    const copy = root.clone() as Subtract
    assert.notEqual(root, copy)
    assert.notEqual(root.lh, copy.lh)
    const b0 = root.lh as Box
    const b1 = copy.lh as Box
    b1.size.x = 99
    assert.notEqual(b0.size.x, 99)
})

test("Node.clone deep-copies extrude caps and profile", () => {
    const poly = polygon2d(
        [0, 0],
        [1, 0],
        [0.5, 1],
    )
    const root = extrude.profile(poly).height(0.5) as Extrude
    const copy = root.clone() as Extrude
    assert.notEqual(root, copy)
    assert.notEqual(root.child, copy.child)
    assert.notEqual(root.capTop, copy.capTop)
    assert.notEqual(root.capBottom, copy.capBottom)
    copy.child.vertices[0]![0] = 123
    assert.notEqual(root.child.vertices[0]![0], 123)
})

test("Node.clone deep-copies translate chain", () => {
    const root = translate([1, 2, 3], sphere.radius(1)) as Translate
    const copy = root.clone() as Translate
    assert.notEqual(root, copy)
    assert.notEqual(root.arg, copy.arg)
})
