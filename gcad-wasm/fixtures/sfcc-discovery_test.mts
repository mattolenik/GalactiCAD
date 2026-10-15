/** Fixture-free discovery controls through the real Bridge JSON/WASM boundary. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { Worker } from "node:worker_threads"
import {
    initSync, export_sfcc, sfcc_worker_prepare, sfcc_worker_merge,
    sfcc_decide_partition, sfcc_octree_begin, sfcc_octree_current_frontier,
    sfcc_octree_apply_decisions, sfcc_octree_finish,
} from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const center = [0.04125955406450752, 1.53, 1.53]
const radius = 0.01650382162580301
const children = [
    { kind: "box", pos: [-50, 0, 0], half: [50, 100, 100] },
    { kind: "sphere", pos: center, r: radius },
]
const hidden = JSON.stringify({ kind: "union", children })
const many = JSON.stringify({ kind: "union", children: [
    ...children, ...Array.from({ length: 14 }, (_, i) => ({ kind: "sphere", pos: [-50, i, 0], r: 0.1 })),
] })
const cube = [-100, -100, -100, 200] as const
const countLeaves = (b: Uint8Array) => Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(48, true))

function hiddenLeaf(b: Uint8Array, c = center, r = radius) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    assert.equal(v.getUint32(0, true), 0x53464c33)
    const origin = [16, 24, 32].map(o => v.getFloat64(o, true))
    const size = v.getFloat64(40, true)
    for (let i = 0; i < countLeaves(b); i++) {
        const o = 56 + i * 48, level = v.getUint32(o, true), side = size / 2 ** level
        const low = [8, 16, 24].map((k, a) => origin[a] + Number(v.getBigInt64(o + k, true)) * side)
        if (low.every((x, a) => c[a] - r > x && c[a] + r < x + side)) {
            return { i, level, degenerate: v.getUint32(o + 4, true) !== 0 }
        }
    }
    assert.fail("the actual hidden sphere-containing cell was culled")
}

function degenerateLeaves(b: Uint8Array) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let count = 0
    for (let i = 0; i < countLeaves(b); i++) count += Number(v.getUint32(60 + i * 48, true) !== 0)
    return count
}

function runWorker(data: Record<string, unknown>): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./sfcc-discovery-worker.mjs", import.meta.url), { workerData: data })
        let output: Uint8Array | undefined
        worker.once("message", value => { output = value })
        worker.once("error", reject)
        worker.once("exit", code => {
            if (code !== 0) reject(new Error(`worker exit ${code}`))
            else if (output === undefined) reject(new Error("worker exited without a result"))
            else resolve(output)
        })
    })
}

function combineDecisions(parts: Uint8Array[]) {
    const n = parts.reduce((s, p) => s + (p.byteLength - 12) / 17, 0)
    const result = new Uint8Array(12 + n * 17), v = new DataView(result.buffer)
    v.setUint32(0, 0x53464443, true)
    v.setBigUint64(4, BigInt(n), true)
    let at = 12
    for (const p of parts) {
        result.set(p.subarray(12), at)
        at += p.byteLength - 12
    }
    return result
}

// Cyclic rotation preserves winding; all eight vertex fields remain in the comparison.
function canonicalTriangles(verts: Float32Array, tris: Uint32Array) {
    const output: string[] = []
    for (let i = 0; i < tris.length; i += 3) {
        const p = [0, 1, 2].map(j => Array.from(verts.subarray(tris[i + j] * 8, tris[i + j] * 8 + 8)).join(","))
        output.push([p.join("|"), [p[1], p[2], p[0]].join("|"), [p[2], p[0], p[1]].join("|")].sort()[0])
    }
    return output.sort()
}

test("hidden and many-leaf decisions survive serial/resumable/real workers at 1/2/4/8 partitions", { timeout: 180_000 }, async () => {
    const tuning = JSON.stringify({ normalVariationDeg: 180, blendCurvatureRefine: false })
    for (const scene of [hidden, many]) {
        const leaves = sfcc_worker_prepare(scene, tuning, ...cube)
        const cell = hiddenLeaf(leaves)
        assert.equal(cell.level, 8)
        assert.equal(cell.degenerate, true)
        const n = countLeaves(leaves)
        const whole = sfcc_decide_partition(scene, tuning, ...cube, leaves, 0, n)
        assert.equal(whole[12 + cell.i * 17], 1)
        for (const count of [1, 2, 4, 8]) {
            const completed = await Promise.all(Array.from({ length: count }, async (_, index) => ({
                index, bytes: await runWorker({ task: "decide", scene, tuning, cube, leaves,
                    start: Math.floor(index * n / count), end: Math.floor((index + 1) * n / count) }),
            })))
            completed.reverse()
            completed.sort((a, b) => a.index - b.index)
            assert.deepEqual(combineDecisions(completed.map(p => p.bytes)), whole)
            sfcc_octree_begin(scene, tuning, ...cube)
            let done = false
            for (let rounds = 0; rounds < 32 && !done; rounds++) {
                const frontier = sfcc_octree_current_frontier(), size = countLeaves(frontier)
                const parts = Array.from({ length: count }, (_, i) => ({ i,
                    bytes: sfcc_decide_partition(scene, tuning, ...cube, frontier,
                        Math.floor(i * size / count), Math.floor((i + 1) * size / count)),
                })).reverse()
                parts.sort((a, b) => a.i - b.i)
                done = sfcc_octree_apply_decisions(combineDecisions(parts.map(p => p.bytes)))
            }
            assert.ok(done, "finite depth ceiling must terminate session")
            assert.deepEqual(sfcc_octree_finish(), leaves)
        }
    }
})

test("raw WASM mesh merges preserve actual hidden-cell degeneracy without recovery", { timeout: 180_000 }, async () => {
    const tuning = "{}", leaves = sfcc_worker_prepare(hidden, tuning, ...cube)
    assert.ok(hiddenLeaf(leaves).degenerate)
    const rawDegenerate = degenerateLeaves(leaves)
    const serial = export_sfcc(hidden, tuning, ...cube)
    try {
        const stats = JSON.parse(serial.stats_json)
        assert.equal(stats.failedCells, 0)
        assert.ok(rawDegenerate > 0)
        assert.equal(stats.degenerateCells, rawDegenerate)
        assert.equal(stats.validation.unresolvedCells, rawDegenerate)
        assert.equal(serial.ok, false)
        const expected = canonicalTriangles(serial.verts, serial.tris)
        for (const count of [1, 2, 4, 8]) {
            const partials = await Promise.all(Array.from({ length: count }, (_, index) =>
                runWorker({ task: "mesh", scene: hidden, tuning, cube, leaves, index, count })))
            for (const order of [partials, [...partials].reverse()]) {
                const result = sfcc_worker_merge(hidden, tuning, ...cube, order)
                try {
                    const merged = JSON.parse(result.stats_json)
                    assert.equal(merged.serialRecovery, false)
                    assert.equal(merged.failedCells, 0)
                    assert.equal(merged.degenerateCells, rawDegenerate)
                    assert.deepEqual(merged.validation, stats.validation)
                    assert.deepEqual(canonicalTriangles(result.verts, result.tris), expected)
                    assert.equal(result.ok, false)
                } finally { result.free() }
            }
        }
    } finally { serial.free() }
})

test("sufficient depth reconstructs two independently localized connected components", () => {
    const result = export_sfcc(hidden, JSON.stringify({ depthMax: 14, surfaceTolMm: 1e-5 }), ...cube)
    try {
        const verts = result.verts, tris = result.tris
        const parent = new Map<number, number>()
        const find = (v: number): number => {
            const p = parent.get(v)
            if (p === undefined) { parent.set(v, v); return v }
            if (p === v) return v
            const r = find(p)
            parent.set(v, r)
            return r
        }
        for (let i = 0; i < tris.length; i += 3) {
            const a = find(tris[i])
            parent.set(find(tris[i + 1]), a)
            parent.set(find(tris[i + 2]), a)
        }
        const groups = new Map<number, number[]>()
        for (const v of parent.keys()) {
            const root = find(v), g = groups.get(root) ?? []
            g.push(v)
            groups.set(root, g)
        }
        assert.equal(groups.size, 2)
        let spheres = 0, boxes = 0
        for (const group of groups.values()) {
            const radial = group.map(i => Math.hypot(...center.map((c, a) => verts[i * 8 + a] - c)))
            if (radial.every(r => Math.abs(r - radius) < radius * 0.01)) {
                spheres++
                assert.ok(group.length >= 4)
            } else {
                assert.ok(group.some(i => verts[i * 8] < -1))
                boxes++
            }
        }
        assert.equal(spheres, 1)
        assert.equal(boxes, 1)
        assert.equal(JSON.parse(result.stats_json).failedCells, 0)
    } finally { result.free() }
})

test("serial recovery preserves hidden-cell diagnostics through real workers and reversed merge order", { timeout: 180_000 }, async () => {
    const p = [4.8, 0.3, 0.3], r = 0.01
    const scene = JSON.stringify({ kind: "union", children: [
        { kind: "extrude", pos: [0, 0, 0], verts: [[-3, -3], [3, -3], [3, 0], [0, 0], [0, 3], [-3, 3]], h: 5, twist_degrees: 90 },
        { kind: "sphere", pos: p, r },
    ] })
    const domain = [-6, -6, -6, 12] as const
    const tuning = JSON.stringify({ depthMin: 4, depthMax: 7, maxPolylinePointsPerCell: 1, curveChordTolMm: 1e-8 })
    const leaves = sfcc_worker_prepare(scene, tuning, ...domain)
    assert.ok(hiddenLeaf(leaves, p, r).degenerate)
    const serial = export_sfcc(scene, tuning, ...domain)
    try {
        const stats = JSON.parse(serial.stats_json)
        assert.ok(stats.validation.unresolvedCells > 0)
        assert.ok(stats.validation.chordBudgetFailures > 0)
        for (const count of [1, 2, 4, 8]) {
            const parts = await Promise.all(Array.from({ length: count }, (_, index) =>
                runWorker({ task: "mesh", scene, tuning, cube: domain, leaves, index, count })))
            for (const order of [parts, [...parts].reverse()]) {
                const result = sfcc_worker_merge(scene, tuning, ...domain, order)
                try {
                    const merged = JSON.parse(result.stats_json)
                    assert.equal(merged.serialRecovery, true)
                    assert.ok(merged.reRefineRounds > 0)
                    assert.deepEqual(merged.validation, stats.validation)
                    assert.deepEqual(result.verts, serial.verts)
                    assert.deepEqual(result.tris, serial.tris)
                    assert.equal(result.ok, false)
                } finally { result.free() }
            }
        }
    } finally { serial.free() }
})
