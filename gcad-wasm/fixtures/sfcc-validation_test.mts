/** Fixture-free tests of the shipped SIMD WASM boundary; no browser needed. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { initSync, export_sfcc, sfcc_worker_prepare, sfcc_worker_mesh_partition, sfcc_worker_merge } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const box = JSON.stringify({ kind: "box", pos: [0, 0, 0], half: [3, 3, 3] })
const smallSphere = JSON.stringify({ kind: "sphere", pos: [0.3, 0.3, 0.3], r: 0.01 })
const domain = [-10, -10, -10, 20] as const

test("SFCC WASM reports performed and skipped audits distinctly", () => {
    for (const checkVertexLinks of [true, false]) {
        const result = export_sfcc(box, JSON.stringify({ checkVertexLinks }), ...domain)
        try {
            const { validation } = JSON.parse(result.stats_json)
            assert.equal(result.ok, checkVertexLinks)
            assert.equal(validation.status, checkVertexLinks ? "passed" : "incomplete")
            assert.equal(validation.vertexLinks, checkVertexLinks ? "passed" : "notChecked")
            assert.equal(validation.vertexResiduals, "passed")
        } finally { result.free() }
    }
})

test("SFCC WASM reports a hidden surface as unresolved, then discovers it with sufficient depth", () => {
    const coarse = export_sfcc(smallSphere, "{}", ...domain)
    try {
        assert.equal(coarse.ok, false)
        assert.ok(JSON.parse(coarse.stats_json).validation.unresolvedCells > 0)
    } finally { coarse.free() }
    const fine = export_sfcc(smallSphere, JSON.stringify({ depthMax: 13 }), ...domain)
    try {
        assert.ok(fine.tris.length > 0)
        const { validation, components } = JSON.parse(fine.stats_json)
        assert.equal(components, 1)
        assert.equal(validation.edgeIncidence, "passed")
        assert.equal(validation.vertexLinks, "passed")
    } finally { fine.free() }
})

test("SFCC WASM workers retain serial diagnostics and support reversed completion order", () => {
    const tuning = JSON.stringify({ depthMin: 4, depthMax: 7 })
    const leaves = sfcc_worker_prepare(box, tuning, ...domain)
    const partials = [0, 1].map(i => sfcc_worker_mesh_partition(box, tuning, ...domain, leaves, i, 2))
    const serial = export_sfcc(box, tuning, ...domain)
    const merged = sfcc_worker_merge(box, tuning, ...domain, partials.reverse())
    try {
        const stats = JSON.parse(merged.stats_json)
        assert.equal(stats.serialRecovery, false, "exercise worker merge, not serial fallback")
        assert.deepEqual(stats.validation, JSON.parse(serial.stats_json).validation)
        assert.deepEqual(merged.verts, serial.verts)
        assert.deepEqual(merged.tris, serial.tris)
        assert.equal(merged.ok, serial.ok)
    } finally { serial.free(); merged.free() }
})
