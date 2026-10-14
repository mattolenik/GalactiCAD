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
            assert.equal(validation.triangleNondegeneracy, "passed")
            assert.equal(validation.invalidTriangles, 0)
        } finally { result.free() }
    }
})

test("SFCC WASM uses sampled refinement for the legacy analytic blend option", () => {
    const scene = JSON.stringify({
        kind: "union", mode: "round", radius: 0.5,
        children: [-0.6, 0.6].map(x => ({ kind: "sphere", pos: [x, 0, 0], r: 1 })),
    })
    const tuning = { depthMin: 3, depthMax: 5 }
    const sampled = export_sfcc(scene, JSON.stringify(tuning), -2, -2, -2, 4)
    const legacy = export_sfcc(scene, JSON.stringify({ ...tuning, blendCurvatureAnalytic: true }), -2, -2, -2, 4)
    try {
        assert.ok(sampled.tris.length > 0)
        assert.deepEqual(legacy.verts, sampled.verts)
        assert.deepEqual(legacy.tris, sampled.tris)
        assert.deepEqual(JSON.parse(legacy.stats_json).validation, JSON.parse(sampled.stats_json).validation)
        assert.equal(legacy.ok, sampled.ok)
    } finally { sampled.free(); legacy.free() }
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

test("SFCC WASM rejects float32-collapsed triangles in serial and worker output", () => {
    const sphere = JSON.stringify({ kind: "sphere", pos: [1000, 1000, 1000], r: 1 })
    const cube = [999, 999, 999, 2] as const
    const leaves = sfcc_worker_prepare(sphere, "{}", ...cube)
    const partials = [1, 0].map(i => sfcc_worker_mesh_partition(sphere, "{}", ...cube, leaves, i, 2))
    const serial = export_sfcc(sphere, "{}", ...cube)
    const merged = sfcc_worker_merge(sphere, "{}", ...cube, partials)
    try {
        for (const result of [serial, merged]) {
            const verts = result.verts
            const tris = result.tris
            let collapsed = 0
            for (let i = 0; i < tris.length; i += 3) {
                const a = tris[i] * 8
                const b = tris[i + 1] * 8
                const c = tris[i + 2] * 8
                const u = [0, 1, 2].map(j => verts[b + j] - verts[a + j])
                const v = [0, 1, 2].map(j => verts[c + j] - verts[a + j])
                if (u[1] * v[2] === u[2] * v[1] && u[2] * v[0] === u[0] * v[2] && u[0] * v[1] === u[1] * v[0]) collapsed++
            }
            assert.ok(collapsed > 0, "exercise actual output collapse")
            const { validation } = JSON.parse(result.stats_json)
            assert.equal(validation.edgeIncidence, "passed")
            assert.equal(validation.vertexLinks, "passed")
            assert.equal(validation.vertexResiduals, "passed")
            assert.equal(validation.triangleNondegeneracy, "failed")
            assert.equal(validation.invalidTriangles, collapsed)
            assert.equal(validation.status, "failed")
            assert.equal(result.ok, false)
        }
        assert.equal(JSON.parse(merged.stats_json).serialRecovery, false)
        assert.deepEqual(JSON.parse(merged.stats_json).validation, JSON.parse(serial.stats_json).validation)
    } finally { serial.free(); merged.free() }
})

test("SFCC WASM preserves a clipped cube whose edges fall between old trim samples", () => {
    const center = 2.44140625
    const scene = JSON.stringify({
        kind: "intersect", radius: 0,
        lh: { kind: "box", pos: [0, 0, 0], half: [2, 5000, 2] },
        rh: { kind: "box", pos: [0, center, 0], half: [20, 2, 20] },
    })
    const result = export_sfcc(scene, "{}", -2, center - 2, -2, 4)
    try {
        assert.equal(result.ok, true, result.stats_json)
        const { validation } = JSON.parse(result.stats_json)
        assert.equal(validation.featureTrace.unresolvedTrims, 0)
        assert.equal(validation.featureChains.status, "passed")
        const edges = result.feature_edges
        const curves = new Set<number>()
        for (let i = 2; i < edges.length; i += 5) curves.add(edges[i])
        assert.equal(curves.size, 12, "all twelve sharp edges must reach the output")
        const verts = result.verts
        const tris = result.tris
        for (let i = 0; i < tris.length; i += 3) {
            const p = [0, 1, 2].map(k => (verts[tris[i] * 8 + k] + verts[tris[i + 1] * 8 + k] + verts[tris[i + 2] * 8 + k]) / 3)
            p[1] -= center
            const q = p.map(v => Math.abs(v) - 2)
            const distance = Math.hypot(...q.map(v => Math.max(v, 0))) + Math.min(Math.max(...q), 0)
            assert.ok(Math.abs(distance) < 1e-6, `triangle ${i / 3} bridges the exact cube boundary`)
        }
    } finally { result.free() }
})

test("SFCC WASM workers retain unresolved exposed-seam discovery", () => {
    const cut = 10 * Math.cos(Math.PI / 180)
    const scene = JSON.stringify({
        kind: "intersect", radius: 0,
        lh: { kind: "sphere", pos: [0, 0, 0], r: 10 },
        rh: { kind: "box", pos: [0, 0, cut - 20], half: [20, 20, 20] },
    })
    const cube = [-10, -10, -10, 20] as const
    const serial = export_sfcc(scene, "{}", ...cube)
    const leaves = sfcc_worker_prepare(scene, "{}", ...cube)
    const partials = [1, 0].map(i => sfcc_worker_mesh_partition(scene, "{}", ...cube, leaves, i, 2))
    const merged = sfcc_worker_merge(scene, "{}", ...cube, partials)
    try {
        for (const result of [serial, merged]) {
            const { validation } = JSON.parse(result.stats_json)
            assert.ok(validation.featureTrace.unresolvedDiscovery > 0)
            assert.equal(result.ok, false, "untraced exposed seam must prevent success")
        }
        assert.equal(JSON.parse(merged.stats_json).serialRecovery, false)
        assert.deepEqual(JSON.parse(merged.stats_json).validation.featureTrace, JSON.parse(serial.stats_json).validation.featureTrace)
    } finally { serial.free(); merged.free() }
})
