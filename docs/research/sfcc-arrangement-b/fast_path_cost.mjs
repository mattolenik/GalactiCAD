/** Diagnostic alternating WASM timings, not a speed claim under shared load. */
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error("pass baseline and candidate package directories")
const modules = await Promise.all(paths.map(async path => {
    const m = await import(pathToFileURL(`${path}/gcad_wasm.js`))
    m.initSync({ module: readFileSync(`${path}/gcad_wasm_bg.wasm`) })
    return m
}))
const box = (pos, half) => ({ kind: "box", pos, half })
const flat = box([0, 0, 0], [3, 3, 3])
const cases = [
    ["single-box", flat, [-10, -10, -10, 20]],
    ["16-duplicates", { kind: "union", children: Array.from({ length: 16 }, () => flat) }, [-10, -10, -10, 20]],
    ["clipped-box", { kind: "intersect", lh: box([0, 0, 0], [1, 1, 1]), rh: box([-1.75, 0, 0], [2.25, 4, 4]) }, [-4, -4, -4, 8]],
]
const rows = []
for (const [name, scene, cube] of cases) {
    const source = JSON.stringify(scene), samples = [[], []], geometry = []
    for (let round = -1; round < 5; round++) for (const version of round % 2 === 0 ? [0, 1] : [1, 0]) {
        const start = performance.now(), r = modules[version].export_sfcc(source, "{}", ...cube)
        const elapsed = performance.now() - start
        try {
            if (round >= 0) samples[version].push(elapsed)
            const bits = new Uint32Array(r.verts.buffer, r.verts.byteOffset, r.verts.length)
            const edges = r.feature_edges
            const edgeBits = new BigUint64Array(edges.buffer, edges.byteOffset, edges.length)
            geometry[version] = JSON.stringify([Array.from(bits), Array.from(r.tris), Array.from(edgeBits, String), r.ok, JSON.parse(r.stats_json).validation])
        } finally { r.free() }
    }
    if (geometry[0] !== geometry[1]) throw new Error(`${name}: baseline geometry or validation changed`)
    rows.push({ name, samplesMs: samples, mediansMs: samples.map(s => [...s].sort((a, b) => a - b)[2]), exactOrderedGeometryAndValidation: true })
}
console.log(JSON.stringify({ caution: "Diagnostic wall times under shared load; no speed claim", paths, rows }, null, 2))
