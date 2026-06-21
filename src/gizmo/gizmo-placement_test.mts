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

test("box.rotate before shift sets rot field (no operator node added)", () => {
    const scene = build("return box(2,2,2).rotate([0,0,45]).shift([5,0,0])")
    const box = scene.root
    assert.equal(box.getShapeType(), "box", "root is still the box, no Rotate operator wrapper")
    assert.ok(Math.abs(box.rot.z - 45) < 1e-6, "rot.z = 45")
})
