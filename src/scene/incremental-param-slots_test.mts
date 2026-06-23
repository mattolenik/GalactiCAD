import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { transpileCadSource } from "../cad-transpile.mjs"
import { SceneInfo } from "./scene.mjs"

/**
 * Drift-free invariant for the incremental param-edit fast path
 * (docs/plans/gizmo-incremental-param-edit.md): a structure-preserving literal
 * edit must leave EVERY node's param/preview slot assignment bit-identical, because
 * the worker patches the moved node's slot in place rather than re-deriving the
 * layout. If slots were not stable, the patch would write to the wrong place and
 * the incremental state would diverge from a full rebuild. The allocator is a
 * monotonic bump counter advanced in build order, so slots depend only on
 * structure (types + topology), never values — these tests assert exactly that.
 */

function build(src: string): SceneInfo {
    return new SceneInfo(transpileCadSource(src), { bvhEnabled: true })
}

function assertSlotsStable(a: SceneInfo, b: SceneInfo): void {
    assert.equal(a.structuralFingerprint(), b.structuralFingerprint(), "structural fingerprint unchanged")
    const aNodes = new Map(a.getAllNodes().map(n => [n.id, n]))
    const bNodes = b.getAllNodes()
    assert.equal(aNodes.size, bNodes.length, "same node count")
    for (const nb of bNodes) {
        const na = aNodes.get(nb.id)
        assert.ok(na, `node ${nb.id} present in both builds`)
        assert.equal(na!.paramOffset, nb.paramOffset, `paramOffset stable (node ${nb.id})`)
        assert.equal(na!.previewVec3Slot, nb.previewVec3Slot, `previewVec3Slot stable (node ${nb.id})`)
        assert.equal(na!.previewF32Slot, nb.previewF32Slot, `previewF32Slot stable (node ${nb.id})`)
        assert.equal(na!.previewMat3Slot, nb.previewMat3Slot, `previewMat3Slot stable (node ${nb.id})`)
        assert.equal(na!.rotPreviewMat3Slot, nb.rotPreviewMat3Slot, `rotPreviewMat3Slot stable (node ${nb.id})`)
    }
}

test("submersible: editing one shift literal leaves all slots stable", () => {
    const path = fileURLToPath(new URL("./samples/submersible.gcad", import.meta.url))
    const s0 = readFileSync(path, "utf8")
    assert.ok(s0.includes(".shift(6, 0, -12)"), "fixture anchor present")
    const s1 = s0.replace(".shift(6, 0, -12)", ".shift([7, 1, -11])")
    assertSlotsStable(build(s0), build(s1))
})

test("editing a rotate literal leaves all slots stable", () => {
    const s0 = "return box(2,2,2).rotate([0, 0, 45]).shift([1,0,0])"
    const s1 = "return box(2,2,2).rotate([0, 0, 50]).shift([1,0,0])"
    assertSlotsStable(build(s0), build(s1))
})

test("a structural edit (added node) DOES shift slots — fast path must not apply", () => {
    const s0 = "return box(2,2,2).shift([1,0,0])"
    const s1 = "return union(box(2,2,2).shift([1,0,0]), sphere.radius(1))"
    const a = build(s0)
    const b = build(s1)
    assert.notEqual(a.structuralFingerprint(), b.structuralFingerprint())
})
