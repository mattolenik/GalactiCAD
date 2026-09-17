/** Exercise all quality stages and SFP4 through independent WASM workers. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { test } from "node:test"
import { SceneInfo } from "../../src/scene/scene.mjs"
import { serializeSceneToBridgeJson } from "../../src/export/sfcc-rs/scene-bridge.mjs"
import { initSync, export_sfcc, sfcc_worker_prepare, sfcc_worker_merge } from "../wasm/pkg/gcad_wasm.js"

const wasm = readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url))
initSync({ module: wasm })
const moduleUrl = new URL("../wasm/pkg/gcad_wasm.js", import.meta.url).href
const tuningJson = JSON.stringify({ depthMin: 3, depthMax: 5, qualityTriangulation: true, qualityRefinement: true, qualityRemeshing: true })

function canonical(verts: Float32Array, tris: Uint32Array): string[] {
    const result: string[] = []
    const vertex = (i: number) => [...verts.slice(i * 8, i * 8 + 3), ...verts.slice(i * 8 + 4, i * 8 + 7)].join(",")
    for (let i = 0; i < tris.length; i += 3) {
        const t = [vertex(tris[i]!), vertex(tris[i + 1]!), vertex(tris[i + 2]!)]
        result.push([0, 1, 2].map(k => [t[k], t[(k + 1) % 3], t[(k + 2) % 3]].join(";")).sort()[0]!)
    }
    return result.sort()
}

async function partition(sceneJson: string, leaves: Uint8Array, groupIndex: number, groupCount: number): Promise<Uint8Array> {
    const worker = new Worker(`
        const { parentPort, workerData: d } = require("node:worker_threads");
        (async () => {
            const api = await import(d.moduleUrl);
            api.initSync({ module: d.wasm });
            const partial = api.sfcc_worker_mesh_partition(d.sceneJson, d.tuningJson, -10, -10, -10, 20, d.leaves, d.groupIndex, d.groupCount);
            parentPort.postMessage(partial, [partial.buffer]);
        })().catch(e => { throw e; });
    `, { eval: true, workerData: { wasm, moduleUrl, tuningJson, sceneJson, leaves, groupIndex, groupCount } })
    try {
        return await new Promise<Uint8Array>((resolve, reject) => {
            worker.once("message", resolve)
            worker.once("error", reject)
            worker.once("exit", code => { if (code !== 0) reject(new Error(`partition worker exited ${code}`)) })
        })
    } finally {
        await worker.terminate()
    }
}

for (const source of [
    "return box(10, 10, 10)",
    "return sphere.radius(8)",
    "return union(sphere.radius(5), ...Array.from({length: 7}, (_, i) => sphere.radius(0.1).shift(i * 0.1, 0, 0)))",
]) {
test(`quality stages retain topology and ownership across actual WASM workers: ${source}`, { timeout: 180_000 }, async () => {
    const scene = new SceneInfo(source)
    const sceneJson = serializeSceneToBridgeJson(scene.root)
    const serial = export_sfcc(sceneJson, tuningJson, -10, -10, -10, 20)
    try {
        const expected = canonical(serial.verts, serial.tris)
        assert.ok(expected.length > 100, "fixture must contain the complete box surface")
        const stats = JSON.parse(serial.stats_json)
        assert.equal(stats.validation.edgeIncidence, "passed")
        assert.equal(stats.validation.vertexLinks, "passed")
        assert.equal(stats.validation.quality.geometryFailures, 0, JSON.stringify(stats.validation.quality))
        assert.equal(stats.validation.quality.intersections, 0)
        const leaves = sfcc_worker_prepare(sceneJson, tuningJson, -10, -10, -10, 20)
        for (const n of [1, 2, 4, 8]) {
            const partials = await Promise.all(Array.from({ length: n }, (_, i) => partition(sceneJson, leaves, i, n)))
            const merged = sfcc_worker_merge(sceneJson, tuningJson, -10, -10, -10, 20, partials.reverse())
            try {
                const actual = JSON.parse(merged.stats_json)
                assert.equal(actual.serialRecovery, false, "must exercise distributed merge")
                assert.deepEqual(actual.validation, stats.validation)
                assert.deepEqual(canonical(merged.verts, merged.tris), expected)
            } finally { merged.free() }
        }
    } finally { serial.free() }
})
}
