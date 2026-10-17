/** Exact witness checks across the real bridge and matching WASM bounds. */
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { audit_field_intervals, audit_primitive_inputs, export_sfcc, initSync, sfcc_octree_begin, sfcc_octree_current_frontier, sfcc_decide_partition, sfcc_octree_finish } from "../wasm/pkg/gcad_wasm.js"
initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const sphere = { kind: "sphere", pos: [0, 0, 0], r: 1 }
const intervals = (scene: unknown, center: number[], half = [0, 0, 0]) =>
    audit_field_intervals(JSON.stringify(scene), new Float64Array([...center, ...half, half[0]]))
function possible(v: Float64Array) {
    for (let i = 0; i < v.length; i += 2) assert.ok(!(v[i] > 0 || v[i + 1] < 0), `false exclusion ${v}`)
}
test("WASM exact algebraic contacts survive box, ball and regional query paths", () => {
    const a = 1 + 2 ** -22
    possible(intervals({ kind: "rotate", fwd: [a, 0, 0, 0, 1, 0, 0, 0, 1], arg: sphere }, [1 / a, 0, 0], [2 ** -53, 0, 0]))
    const x = 16072908759584n, y = 218874968123250n, r = 219464325271666n
    assert.equal(x * x + y * y, r * r)
    possible(intervals({ ...sphere, r: Number(r) }, [Number(x), Number(y), 0]))
    possible(intervals({ ...sphere, r: Number.MIN_VALUE }, [Number.MIN_VALUE, 0, 0]))
    possible(intervals(sphere, [1, 0, 0]))
    possible(intervals({ kind: "box", pos: [0, 0, 0], half: [1, 1, 1] }, [1, 0, 0]))
})
test("WASM represented rotations and co-scales retain useful strict signs", () => {
    const a = 0.713, c = Math.cos(a), s = Math.sin(a)
    for (const scale of [2 ** -500, 1, 2 ** 500]) {
        const scene = { kind: "scale", sx: scale, sy: scale, sz: scale, arg: {
            kind: "rotate", fwd: [c, s, 0, -s, c, 0, 0, 0, 1], arg: sphere,
        } }
        possible(intervals(scene, [0, 0, scale]))
        const positive = intervals(scene, [0, 0, 3 * scale], [0.01 * scale, 0.01 * scale, 0.01 * scale])
        const negative = intervals(scene, [0, 0, 0], [0.01 * scale, 0.01 * scale, 0.01 * scale])
        for (let i = 0; i < 6; i += 2) {
            assert.ok(positive[i] > 0)
            assert.ok(negative[i + 1] < 0)
        }
    }
})
test("WASM invalid query arithmetic is not masked by hard composition", () => {
    const scene = { kind: "union", children: [sphere, { ...sphere, pos: [10, 0, 0] }] }
    for (const values of [[NaN, 0, 0], [Infinity, 0, 0]]) {
        const v = intervals(scene, values)
        assert.ok(Array.from(v).every(Number.isNaN))
    }
})

test("ordinary f64 and f32 serialized rotations retain the frozen successful export controls", () => {
    const lines = readFileSync(new URL("../../docs/research/sfcc-step2/rotated-baseline.jsonl", import.meta.url), "utf8").trim().split("\n")
    for (const line of lines) {
        const fixture = JSON.parse(line)
        const result = export_sfcc(JSON.stringify(fixture.scene), "{}", -4, -4, -4, 8)
        try {
            const stats = JSON.parse(result.stats_json)
            assert.equal(stats.leaves, fixture.leaves, line)
            assert.equal(stats.components, fixture.components, line)
            assert.equal(stats.validation.unresolvedCells, fixture.unresolved, line)
            assert.equal(result.ok, fixture.ok, line)
        } finally { result.free() }
    }
})

test("mixed opaque controls preserve legacy blend operand bounds", () => {
    const lines = readFileSync(new URL("../../docs/research/sfcc-step2/mixed-baseline.jsonl", import.meta.url), "utf8").trim().split("\n")
    for (const line of lines) {
        const fixture = JSON.parse(line)
        const result = export_sfcc(JSON.stringify(fixture.scene), "{}", -4, -4, -4, 8)
        try {
            const stats = JSON.parse(result.stats_json)
            assert.equal(stats.leaves, fixture.leaves, line)
            assert.equal(stats.components, fixture.components, line)
            assert.equal(stats.validation.unresolvedCells, fixture.unresolved, line)
            assert.equal(result.ok, fixture.ok, line)
        } finally { result.free() }
    }
})

test("opaque legacy bounds expose finite-input transform overflow before box min/max", () => {
    const scale = 2 ** -1022
    const tinyBox = { kind: "scale", sx: scale, sy: scale, sz: scale,
        arg: { kind: "box", pos: [0, 0, 0], half: [1, 1, 1] } }
    const blend = { kind: "union", radius: 0.2, mode: "round", children: [tinyBox, sphere] }
    for (const scene of [blend, { kind: "union", children: [blend, sphere] }]) {
        assert.ok(Array.from(intervals(scene, [4, 4, 0], [0.01, 0.01, 0.01])).every(Number.isNaN))
    }
})

test("subnormal nominal step cannot silently shrink the initial WASM domain", () => {
    const unit = Number.MIN_VALUE, size = 23001 * unit
    const scene = JSON.stringify({ kind: "sphere", pos: [21000 * unit, 8000 * unit, 8000 * unit], r: 500 * unit })
    const tuning = JSON.stringify({ depthMin: 0, depthMax: 14, boundsPaddingMm: 0 })
    sfcc_octree_begin(scene, tuning, 0, 0, 0, size)
    try {
        const frontier = sfcc_octree_current_frontier()
        const view = new DataView(frontier.buffer, frontier.byteOffset, frontier.byteLength)
        assert.equal(view.getBigUint64(48, true), 1n, "known-zero root was removed before discovery")
        const decision = sfcc_decide_partition(scene, tuning, 0, 0, 0, size, frontier, 0, 1)
        assert.equal(decision[12], 1, "actual discovery must request refinement")
    } finally {
        // Release this deliberately interrupted diagnostic session; do not mesh or claim a final result.
        sfcc_octree_finish()
    }
})



test("actual WASM input bits support an independent exact-algebraic oracle", () => {
    const cases = JSON.parse(readFileSync(new URL("../../docs/research/sfcc-step2/inputs.json", import.meta.url), "utf8")) as {scene: unknown, query: number[]}[]
    const bits = (values: ArrayLike<number>) => Array.from(values, value => {
        const view = new DataView(new ArrayBuffer(8))
        view.setFloat64(0, value, false)
        return view.getBigUint64(0, false).toString(16).padStart(16, "0")
    })
    const records = cases.map((c, i) => {
        const bounds = audit_field_intervals(JSON.stringify(c.scene), new Float64Array(c.query))
        if (i >= 120) possible(bounds)
        for (let k = 0; k < 2; ++k) assert.ok(Object.is(bounds[k], bounds[k + 4]), "retained-view interval parity")
        return {bounds: bits(bounds.slice(0, 4)), query: bits(c.query), inputs: bits(audit_primitive_inputs(JSON.stringify(c.scene)))}
    })
    if (process.env.SFCC_BOUND_OUTPUT) writeFileSync(process.env.SFCC_BOUND_OUTPUT, JSON.stringify(records) + "\n")
})
