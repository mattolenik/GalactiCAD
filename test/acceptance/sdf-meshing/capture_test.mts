import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { MeshAcceptanceCapture, acceptanceDisplayMesh } from "../../../src/agent-autotest/mesh-acceptance-capture.mjs"

test("one artifact is retained; duplicate exports and stale IDs are rejected", async () => {
    let exports = 0
    const capture = new MeshAcceptanceCapture({ renderMesh: async () => {
        exports++
        return { verts: new Float32Array(24), tris: new Uint32Array([0, 1, 2]), debug: { sfcc: { execution: { ok: false, exportMs: 3 }, stats: { tris: 1 }, validation: { status: "incomplete" } } } }
    } } as any)
    const prepare = { kind: "meshAcceptance", action: "prepare", captureId: "one", request: {
        sourceBase64: btoa(" return complexModel() "), viewportWidth: 1200, viewportHeight: 1000,
        meshExport: { exporter: "sfcc-rs", simplifyOnExport: false },
    } } as any
    const p = await capture.run(prepare)
    assert.equal(p.sourceSha256, createHash("sha256").update("return complexModel()").digest("hex"))
    const result = await capture.run({ kind: "meshAcceptance", action: "export", captureId: "one" }) as any
    assert.equal(result.triangles, 1)
    assert.equal(result.execution.ok, false)
    for (const a of Object.values(result.artifacts) as any[]) assert.equal(createHash("sha256").update(Buffer.from(a.base64, "base64")).digest("hex"), a.sha256)
    await assert.rejects(capture.run({ kind: "meshAcceptance", action: "export", captureId: "one" }), /already attempted/)
    await assert.rejects(capture.run({ kind: "meshAcceptance", action: "export", captureId: "stale" }), /stale/)
    assert.equal(exports, 1)
    await capture.run({ kind: "meshAcceptance", action: "clear", captureId: "one" })
    await assert.rejects(capture.run({ kind: "meshAcceptance", action: "export", captureId: "one" }), /stale/)
    await capture.run(prepare)
    const artifact = { sourceSha256: p.sourceSha256 as string, meshDigest: result.meshDigest,
        verts: result.artifacts.verts.base64, tris: result.artifacts.tris.base64, features: result.artifacts.features.base64 }
    await assert.rejects(capture.run({ kind: "meshAcceptance", action: "restore", captureId: "one", artifact: { ...artifact, sourceSha256: "wrong" } }), /source mismatch/)
    await assert.rejects(capture.run({ kind: "meshAcceptance", action: "restore", captureId: "one", artifact: { ...artifact, meshDigest: "wrong" } }), /digest mismatch/)
    const replay = await capture.run({ kind: "meshAcceptance", action: "restore", captureId: "one", artifact })
    assert.equal(replay.meshDigest, result.meshDigest)
    assert.equal(exports, 1, "replaying a saved artifact must not remesh")
})

test("display copy preserves every triangle corner and restores a sharp normal discontinuity", () => {
    const verts = new Float32Array(32)
    const positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
    positions.forEach((p, i) => { verts.set(p, i * 8); verts.set([0, Math.SQRT1_2, Math.SQRT1_2], i * 8 + 4) })
    const tris = new Uint32Array([0, 1, 2, 1, 0, 3])
    const saved = verts.slice(), indices = tris.slice()
    const display = acceptanceDisplayMesh({ verts, tris })
    for (let i = 0; i < tris.length; i++) {
        assert.deepEqual(display.verts.slice(display.tris[i] * 8, display.tris[i] * 8 + 3), verts.slice(tris[i] * 8, tris[i] * 8 + 3))
        assert.deepEqual(Array.from(display.verts.slice(i * 8 + 4, i * 8 + 7)), i < 3 ? [0, 0, 1] : [0, 1, 0])
    }
    assert.deepEqual(verts, saved)
    assert.deepEqual(tris, indices)
})
