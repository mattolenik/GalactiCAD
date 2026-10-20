/** Bounded quiet baseline/consensus WASM comparison; rows flush per case. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"

const paths = process.argv.slice(2)
assert.equal(paths.length, 2, "pass baseline and final package directories")
const modules = await Promise.all(paths.map(async path => {
    const module = await import(pathToFileURL(`${path}/gcad_wasm.js`))
    module.initSync({ module: readFileSync(`${path}/gcad_wasm_bg.wasm`) })
    return module
}))
const box = (pos, half) => ({ kind: "box", pos, half })
const flat = box([0, 0, 0], [3, 3, 3])
const sheets = { kind: "union", children: [box([-1.875, 0, 0], [2.125, 4, 4]),
    { kind: "intersect", lh: box([2.25, 0, 0], [1.75, 4, 4]),
        rh: box([-1.625, 0, 0], [2.375, 4, 4]) }] }
const cases = [
    ["single-box", flat, [-10, -10, -10, 20]],
    ["16-duplicates", { kind: "union", children: Array.from({ length: 16 }, () => flat) }, [-10, -10, -10, 20]],
    ["clipped-box", { kind: "intersect", lh: box([0, 0, 0], [1, 1, 1]),
        rh: box([-1.75, 0, 0], [2.25, 4, 4]) }, [-4, -4, -4, 8]],
    ["coarse-reconstruction", sheets, [-128, -128, -128, 256]],
]
for (const [name, scene, cube] of cases) {
    const source = JSON.stringify(scene), samples = [[], []], reference = []
    const outcomes = []
    for (let round = -1; round < 5; round++) {
        for (const version of round % 2 === 0 ? [0, 1] : [1, 0]) {
            const start = performance.now()
            const result = modules[version].export_sfcc(source, "{}", ...cube)
            const elapsed = performance.now() - start
            try {
                if (round >= 0) samples[version].push(elapsed)
                const vertices = result.verts, edges = result.feature_edges
                const bits = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length)
                const edgeBits = new BigUint64Array(edges.buffer, edges.byteOffset, edges.length)
                const stats = JSON.parse(result.stats_json)
                const geometry = JSON.stringify([Array.from(bits), Array.from(result.tris),
                    Array.from(edgeBits, String), result.ok, stats.validation])
                reference[version] ??= geometry
                assert.equal(geometry, reference[version], `${name}: unstable repeated output`)
                outcomes[version] = { triangles: stats.tris, components: stats.components,
                    unresolved: stats.validation.unresolvedCells, ok: result.ok }
            } finally { result.free() }
        }
    }
    const unchanged = name !== "coarse-reconstruction"
    if (unchanged) assert.equal(reference[0], reference[1], `${name}: legacy output changed`)
    else assert.deepEqual(outcomes, [
        { triangles: 700, components: 1, unresolved: 72, ok: false },
        { triangles: 848, components: 2, unresolved: 0, ok: true },
    ])
    console.log(JSON.stringify({ name, samplesMs: samples,
        mediansMs: samples.map(s => [...s].sort((a, b) => a - b)[2]),
        exactOrderedGeometryAndValidation: unchanged, outcomes }))
}
