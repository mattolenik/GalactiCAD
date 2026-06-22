import assert from "node:assert/strict"
import test from "node:test"
import { SceneInfo } from "../scene/scene.mjs"
import { transpileCadSource } from "../cad-transpile.mjs"
import { nodePlacement } from "./world-transform.mjs"

function build(src: string): SceneInfo {
    return new SceneInfo(transpileCadSource(src))
}

test("nodePlacement: root box is its own live rotate target (rot field engaged)", () => {
    const scene = build("return box(2,2,2)")
    const box = scene.root
    assert.ok(box.rotPreviewMat3Slot >= 0, "box reserved a rot preview slot")
    const placed = nodePlacement(scene.root, box.id)
    assert.ok(placed, "placement resolved")
    assert.equal(placed!.rotateNodeId, box.id, "box itself is the rotate target (live), not 0/operator")
})

test("nodePlacement: shifted box still has live rot target", () => {
    const scene = build("return box(2,2,2).shift([5,0,0])")
    const box = scene.root
    const placed = nodePlacement(scene.root, box.id)
    assert.equal(placed!.rotateNodeId, box.id)
    // center is the shifted position (rotation about center keeps it there)
    assert.deepEqual(placed!.center.map(n => Math.round(n)), [5, 0, 0])
})

test("nodePlacement finds a box nested in an N-ary union (generic child walk)", () => {
    const scene = build("return union(sphere.radius(3).shift([-5,0,0]), box(2,2,2).shift([5,0,0]), sphere.radius(1))")
    // Find the box node id.
    let boxId = 0
    for (const n of scene.getAllNodes()) if (n.getShapeType() === "box") boxId = n.id
    assert.ok(boxId > 0, "found a box in the union")
    const placed = nodePlacement(scene.root, boxId)
    assert.ok(placed, "placement resolved through the union")
    assert.equal(placed!.rotateNodeId, boxId, "box inside union is the live rotate target (not 0)")
    assert.deepEqual(placed!.center.map(n => Math.round(n)), [5, 0, 0], "world center accounts for the box's position")
})

test("FLOATING-FAR case: box at local origin, positioned by ancestor translate INSIDE a union", () => {
    // box() has no .shift -> local center is origin; it's placed at [100,0,0] by a
    // translate() that sits inside an N-ary union. Pre-fix the walk died at the
    // union and the center fell back to origin (handle floats far from the object).
    const scene = build("return union(translate([100,0,0], box(2,2,2)), sphere.radius(1))")
    let boxId = 0
    for (const n of scene.getAllNodes()) if (n.getShapeType() === "box") boxId = n.id
    const placed = nodePlacement(scene.root, boxId)
    assert.ok(placed, "resolved through union + translate")
    assert.deepEqual(placed!.center.map(n => Math.round(n)), [100, 0, 0], "center is the WORLD position, not local origin")
})

test("nested under translate->rotate inside union: center tracks ancestors", () => {
    const scene = build("return union(sphere.radius(1), rotate([0,0,90], translate([10,0,0], box(2,2,2))))")
    let boxId = 0
    for (const n of scene.getAllNodes()) if (n.getShapeType() === "box") boxId = n.id
    const placed = nodePlacement(scene.root, boxId)
    assert.ok(placed)
    // translate to [10,0,0] then rotate 90° about Z -> [0,10,0]
    assert.deepEqual(placed!.center.map(n => Math.round(n)), [0, 10, 0])
})

test("box.rotate before shift sets rot field (no operator node added)", () => {
    const scene = build("return box(2,2,2).rotate([0,0,45]).shift([5,0,0])")
    const box = scene.root
    assert.equal(box.getShapeType(), "box", "root is still the box, no Rotate operator wrapper")
    assert.ok(Math.abs(box.rot.z - 45) < 1e-6, "rot.z = 45")
})
