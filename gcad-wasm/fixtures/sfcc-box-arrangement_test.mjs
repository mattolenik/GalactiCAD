/** Complete bounded rectilinear fallback; rendering remains manual QA. */
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { initSync, export_sfcc, sfcc_worker_prepare, sfcc_worker_merge } from "../wasm/pkg/gcad_wasm.js"
import { Worker } from "node:worker_threads"
initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const box = (pos, half) => ({ kind: "box", nodeId: 7, pos, half })
const cube = [-128, -128, -128, 256]
const outer = box([0, 0, 0], [1, 1, 1])
const examples = [
    ["one enclosed", box([-0.5, -0.5, -0.5], [0.0625, 0.0625, 0.0625]), 1, 1],
    ["two enclosed", { kind: "union", children: [box([-0.625, -0.5, -0.5], [0.0625, 0.0625, 0.0625]), box([-0.375, -0.5, -0.5], [0.0625, 0.0625, 0.0625])] }, 2, 1],
    ["cavity", { kind: "subtract", lh: outer, rh: box([0, 0, 0], [0.75, 0.75, 0.75]) }, 2],
    ["through hole", { kind: "subtract", lh: outer, rh: box([0, 0, 0], [0.25, 0.25, 2]) }, 1],
    ["thin wall", box([0, 0, 0], [0.015625, 0.5, 0.5]), 1],
    ["separated inexact f32 planes", box([-0.5, -0.5, -0.5], [0.0625 + 2 ** -30, 0.0625, 0.0625]), 1, 1],
]
function worker(data, file = "./sfcc-discovery-worker.mjs") {
    return new Promise((resolve, reject) => {
        const w = new Worker(new URL(file, import.meta.url), { workerData: data })
        let result
        w.once("message", r => { result = r })
        w.once("error", reject)
        w.once("exit", code => code === 0 && result !== undefined ? resolve(result) : reject(new Error(`worker exit ${code}`)))
    })
}
function canonical(v, t) {
    const bits = new Uint32Array(v.buffer, v.byteOffset, v.length)
    const out = []
    for (let i = 0; i < t.length; i += 3) {
        const a = [0, 1, 2].map(j => Array.from(bits.subarray(t[i + j] * 8, t[i + j] * 8 + 8)).join(","))
        out.push([a.join("|"), [a[1], a[2], a[0]].join("|"), [a[2], a[0], a[1]].join("|")].sort()[0])
    }
    return out.sort()
}
test("closed internal components, cavities, holes and thin walls reconstruct", async () => {
    for (const [name, scene, components, expectedCells] of examples) {
        const source = JSON.stringify(scene), result = export_sfcc(source, "{}", ...cube)
        try {
            const stats = JSON.parse(result.stats_json)
            assert.equal(result.ok, true, `${name}: ${JSON.stringify(stats.validation)}`)
            assert.equal(stats.components, components, name)
            assert.equal(stats.validation.localCoverage.scope, "signedBoxArrangement")
            if (expectedCells) assert.equal(stats.leaves, expectedCells)
            const leaves = sfcc_worker_prepare(source, "{}", ...cube)
            const parts = await Promise.all([0, 1, 2, 3].map(index => worker({ task: "mesh", scene: source, tuning: "{}", cube, leaves, index, count: 4 })))
            const merged = sfcc_worker_merge(source, "{}", ...cube, parts.reverse())
            try {
                const mergedStats = JSON.parse(merged.stats_json)
                assert.equal(mergedStats.serialRecovery, false)
                assert.deepEqual(mergedStats.validation, stats.validation)
                assert.deepEqual(canonical(merged.verts, merged.tris), canonical(result.verts, result.tris))
            } finally { merged.free() }
        } finally { result.free() }
    }
})
test("zero-only signed sheet stays explicitly unresolved", () => {
    const source = JSON.stringify({ kind: "subtract", lh: outer, rh: outer })
    const result = export_sfcc(source, "{}", ...cube)
    try {
        assert.equal(result.ok, false)
        const stats = JSON.parse(result.stats_json)
        assert.ok(stats.validation.localCoverage.unresolved.some(r => r.reason === "arrangement_zero_only_face"))
    } finally { result.free() }
})

test("wasm32 rejects envelope integers that would truncate to valid values", async () => {
    const scene = JSON.stringify(box([-0.5, -0.5, -0.5], [0.0625, 0.0625, 0.0625]))
    for (const field of ["manifest", "manifestLeafCount", "group", "count", "leafLevel", "leafIndex"]) {
        const r = await worker({ scene, tuning: "{}", cube, field }, "./sfcc-box-arrangement-corrupt-worker.mjs")
        assert.equal(r.rejected, true, field)
    }
})
