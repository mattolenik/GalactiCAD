/** Step 3 B: actual WASM controls and localized edge-multiplicity obstruction. */
import assert from "node:assert/strict"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { Worker } from "node:worker_threads"
import { initSync, export_sfcc, sfcc_worker_prepare, sfcc_worker_merge, sfcc_decide_partition,
    audit_primitive_inputs } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const box = (pos, half) => ({ kind: "box", pos, half })
const a = box([-1.875, 0, 0], [2.125, 4, 4])
const b = box([2.25, 0, 0], [1.75, 4, 4])
const c = box([-1.625, 0, 0], [2.375, 4, 4])
const sheets = { kind: "union", children: [a, { kind: "intersect", lh: b, rh: c }] }
const fixtures = [
    { name: "clipped-box", scene: { kind: "intersect", lh: box([0, 0, 0], [1, 1, 1]), rh: box([-1.75, 0, 0], [2.25, 4, 4]) },
        cube: [-4, -4, -4, 8], leaves: 132, triangles: 656, components: 1, unresolved: 0 },
    { name: "sphere-success", scene: { kind: "sphere", pos: [0, 0, 0], r: 9 },
        cube: [-10, -10, -10, 20], leaves: 2763, triangles: 6776, components: 1, unresolved: 0 },
    { name: "three-sheets-fine", scene: sheets,
        cube: [-5, -5, -5, 10], leaves: 4372, triangles: 11608, components: 2, unresolved: 0 },
    { name: "three-sheets-coarse", scene: sheets,
        cube: [-128, -128, -128, 256], leaves: 106, triangles: 848, components: 2, unresolved: 0 },
]

function save(name, value) {
    if (!process.env.SFCC_COVERAGE_B_DIR) return
    mkdirSync(process.env.SFCC_COVERAGE_B_DIR, { recursive: true })
    writeFileSync(`${process.env.SFCC_COVERAGE_B_DIR}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`)
}

function canonicalTriangles(verts, tris) {
    const bits = new Uint32Array(verts.buffer, verts.byteOffset, verts.length)
    const out = []
    for (let i = 0; i < tris.length; i += 3) {
        const v = [0, 1, 2].map(j => Array.from(bits.subarray(tris[i + j] * 8, tris[i + j] * 8 + 8)).join(","))
        out.push([v.join("|"), [v[1], v[2], v[0]].join("|"), [v[2], v[0], v[1]].join("|")].sort()[0])
    }
    return out.sort()
}

function canonicalEdges(verts, edges) {
    const out = []
    for (let i = 0; i < edges.length; i += 5) {
        let p = Array.from(verts.subarray(edges[i] * 8, edges[i] * 8 + 3)).join(",")
        let q = Array.from(verts.subarray(edges[i + 1] * 8, edges[i + 1] * 8 + 3)).join(",")
        let start = edges[i + 3], end = edges[i + 4]
        if (p > q) { [p, q] = [q, p]; [start, end] = [end, start] }
        out.push(`${p}|${q}|${edges[i + 2]}|${start}|${end}`)
    }
    return out.sort()
}

function runWorker(data) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./sfcc-discovery-worker.mjs", import.meta.url), { workerData: data })
        let output
        worker.once("message", value => { output = value })
        worker.once("error", reject)
        worker.once("exit", code => {
            if (code !== 0) reject(new Error(`worker exit ${code}`))
            else if (output === undefined) reject(new Error("worker exited without a result"))
            else resolve(output)
        })
    })
}

function targetCells(bytes, decisions) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    assert.equal(view.getUint32(0, true), 0x53464c33)
    const origin = [16, 24, 32].map(o => view.getFloat64(o, true))
    const size = view.getFloat64(40, true), count = Number(view.getBigUint64(48, true))
    const rows = []
    for (let i = 0; i < count; i++) {
        const o = 56 + 48 * i, level = view.getUint32(o, true), side = size / 2 ** level
        const indices = [8, 16, 24].map(k => Number(view.getBigInt64(o + k, true)))
        const low = origin.map((p, j) => p + indices[j] * side)
        const high = low.map(p => p + side)
        if (low[0] < 0.25 && high[0] > 0.75 && low[1] > -3 && high[1] < 3 && low[2] > -3 && high[2] < 3) {
            rows.push({ cell: [level, ...indices], bounds: [...low, ...high],
                degenerate: view.getUint32(o + 4, true) !== 0, split: decisions[12 + 17 * i] !== 0 })
        }
    }
    return rows
}

test("mandatory positive controls and full-object localized three-sheet obstruction", () => {
    for (const f of fixtures) {
        const scene = JSON.stringify(f.scene), result = export_sfcc(scene, "{}", ...f.cube)
        try {
            const stats = JSON.parse(result.stats_json)
            {
                assert.equal(stats.leaves, f.leaves)
                assert.equal(stats.tris, f.triangles)
                assert.equal(stats.components, f.components)
                assert.equal(stats.validation.unresolvedCells, f.unresolved)
            }
            assert.equal(stats.failedCells, 0)
            assert.equal(result.ok, f.unresolved === 0)
            if (f.name === "clipped-box" || f.name === "sphere-success") {
                assert.equal(stats.validation.localCoverage.certifiedCells, stats.leaves)
                assert.deepEqual(stats.validation.localCoverage.unresolved, [])
            } else if (f.name === "three-sheets-coarse") {
                assert.equal(stats.validation.localCoverage.scope, "signedBoxArrangement")
                assert.equal(stats.validation.localCoverage.certifiedCells, stats.leaves)
                assert.deepEqual(stats.validation.localCoverage.unresolved, [])
            } else {
                assert.equal(stats.validation.localCoverage.scope, "outsideScope")
                assert.equal(stats.validation.localCoverage.certifiedCells, 0)
            }
            const record = { ...f, stats, ok: result.ok }
            const prepared = sfcc_worker_prepare(scene, "{}", ...f.cube)
            const pv = new DataView(prepared.buffer, prepared.byteOffset, prepared.byteLength)
            const f64bits = x => { const b = new ArrayBuffer(8), v = new DataView(b); v.setFloat64(0, x, true); return v.getBigUint64(0, true).toString(16).padStart(16, "0") }
            record.lattice = { depth: pv.getUint32(12, true), origin: [16,24,32].map(o => pv.getFloat64(o, true)), size: pv.getFloat64(40, true) }
            record.lattice.bits = [...record.lattice.origin, record.lattice.size].map(f64bits)
            const primitiveNodes = node => node.kind === "intersect" ? [...primitiveNodes(node.lh), ...primitiveNodes(node.rh)] : node.kind === "union" ? node.children.flatMap(primitiveNodes) : [node]
            record.primitiveInputs = primitiveNodes(f.scene).map(p => Array.from(audit_primitive_inputs(JSON.stringify(p))))
            record.primitiveInputBits = record.primitiveInputs.map(v => v.map(f64bits))
            if (f.name !== "three-sheets-fine") {
                record.assembledTriangles = []
                const v = result.verts, t = result.tris
                for (let i = 0; i < t.length; i += 3) {
                    record.assembledTriangles.push([0, 1, 2].map(j => Array.from(v.subarray(t[i + j] * 8, t[i + j] * 8 + 3))))
                }
            }
            if (f.name === "three-sheets-coarse") {
                const bytes = sfcc_worker_prepare(scene, "{}", ...f.cube)
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                const decisions = sfcc_decide_partition(scene, "{}", ...f.cube, bytes, 0, Number(view.getBigUint64(48, true)))
                record.targetedCells = targetCells(bytes, decisions)
                assert.ok(record.targetedCells.length > 0)
                assert.ok(record.targetedCells.every(c => c.degenerate && c.split))
                const original = [[7,64,63,63],[7,64,63,64],[7,64,64,63],[7,64,64,64],
                    ...[126,127,128,129,130].map(y => [8,128,y,130])]
                const origin = [16,24,32].map(o => view.getFloat64(o,true))
                const size = view.getFloat64(40,true)
                for (const [level,,iy,iz] of original) {
                    const side = size / 2 ** level
                    const y = origin[1] + (iy + 1/3) * side, z = origin[2] + (iz + 2/5) * side
                    assert.ok(record.targetedCells.some(c => c.bounds[1]<y && y<c.bounds[4] &&
                        c.bounds[2]<z && z<c.bounds[5] && c.degenerate && c.split),
                    "each original responsible region is represented at its existing depth")
                }
                record.primitiveInputs = [a, b, c].map(p => Array.from(audit_primitive_inputs(JSON.stringify(p))))
            }
            save(`wasm-${f.name}`, record)
        } finally { result.free() }
    }
})

test("raw positive workers and complete coarse construction retain both completion orders", { timeout: 180_000 }, async () => {
    for (const f of fixtures) {
        const scene = JSON.stringify(f.scene), tuning = "{}", leaves = sfcc_worker_prepare(scene, tuning, ...f.cube)
        const serial = export_sfcc(scene, tuning, ...f.cube)
        try {
            const stats = JSON.parse(serial.stats_json)
            const triangles = canonicalTriangles(serial.verts, serial.tris)
            const edges = canonicalEdges(serial.verts, serial.feature_edges)
            const rows = []
            for (const count of [1, 2, 4, 8]) {
                const parts = await Promise.all(Array.from({ length: count }, (_, index) =>
                    runWorker({ task: "mesh", scene, tuning, cube: f.cube, leaves, index, count })))
                for (const reversed of [false, true]) {
                    const merged = sfcc_worker_merge(scene, tuning, ...f.cube, reversed ? [...parts].reverse() : parts)
                    try {
                        const actual = JSON.parse(merged.stats_json)
                        const expectRecovery = false
                        assert.equal(actual.serialRecovery, expectRecovery, `${f.name} N=${count}`)
                        if (expectRecovery) assert.ok(stats.featureCellFallbacks > 0, "coarse fallbacks trigger recovery")
                        assert.equal(actual.failedCells, 0)
                        assert.deepEqual(actual.validation, stats.validation)
                        assert.deepEqual(canonicalTriangles(merged.verts, merged.tris), triangles)
                        assert.deepEqual(canonicalEdges(merged.verts, merged.feature_edges), edges)
                        rows.push({ count, reversed, recovery: actual.serialRecovery, components: actual.components,
                            unresolved: actual.validation.unresolvedCells, triangles: merged.tris.length / 3 })
                    } finally { merged.free() }
                }
            }
            save(`wasm-workers-${f.name}`, rows)
        } finally { serial.free() }
    }
})
