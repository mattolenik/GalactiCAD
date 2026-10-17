// Run against two explicitly identified packages; this script makes no timing claim.
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
const [basePath, candidatePath, output] = process.argv.slice(2)
assert.ok(basePath && candidatePath && output)
async function load(path) {
    const m = await import(pathToFileURL(resolve(path, "gcad_wasm.js")))
    m.initSync({ module: readFileSync(resolve(path, "gcad_wasm_bg.wasm")) })
    return m
}
const baseline = await load(basePath), candidate = await load(candidatePath)
const sphere = (r = 9, pos = [0, 0, 0]) => ({ kind: "sphere", r, pos })
const box = (half, pos = [0, 0, 0]) => ({ kind: "box", half, pos })
const union = children => ({ kind: "union", children })
const intersect = (lh, rh) => ({ kind: "intersect", lh, rh })
const sheets = union([box([2.125, 4, 4], [-1.875, 0, 0]), intersect(box([1.75, 4, 4], [2.25, 0, 0]), box([2.375, 4, 4], [-1.625, 0, 0]))])
const cube = [-10, -10, -10, 20]
const rotation = [Math.cos(.713), Math.sin(.713), 0, -Math.sin(.713), Math.cos(.713), 0, 0, 0, 1]
const cases = [
    ["sphere", sphere(), cube],
    ["default-box-flips", box([3, 3, 3]), cube],
    ["clipped-box", intersect(box([1, 1, 1]), box([2.25, 4, 4], [-1.75, 0, 0])), [-4, -4, -4, 8]],
    ["three-sheets-coarse", sheets, [-128, -128, -128, 256]],
    ["three-sheets-fine", sheets, [-5, -5, -5, 10]],
    ["duplicates-4", union(Array.from({length:4}, () => sphere())), cube],
    ["duplicates-16", union(Array.from({length:16}, () => sphere())), cube],
    ["nonadjacent-duplicates", union(Array.from({length:16}, (_, i) => sphere(9, [i % 2 / 8, 0, 0]))), cube],
    ["unique-16", union(Array.from({length:16}, (_, i) => sphere(9, [i / 128, 0, 0]))), cube],
    ["opposite-sign", {kind:"subtract", lh:sphere(), rh:sphere(8.99)}, cube],
    ["rotated", {kind:"rotate", fwd:rotation, arg:sphere()}, cube],
    ["opaque-separated", union([sphere(), {...union([sphere(), sphere(2, [5, 0, 0])]), radius:.2, mode:"round"}, sphere()]), cube],
    ["quality-sphere", sphere(), cube, {qualityTriangulation:true, qualityRefinement:true, qualityRemeshing:true}],
]
const bytes = x => Buffer.from(x.buffer, x.byteOffset, x.byteLength)
const hash = x => createHash("sha256").update(x).digest("hex")
function data(m, scene, tuning, c) {
    const r = m.export_sfcc(scene, tuning, ...c)
    try {
        const stats = JSON.parse(r.stats_json)
        const leaves = m.sfcc_worker_prepare(scene, tuning, ...c)
        const n = Number(new DataView(leaves.buffer, leaves.byteOffset, leaves.byteLength).getBigUint64(48, true))
        const decisions = m.sfcc_decide_partition(scene, tuning, ...c, leaves, 0, n)
        return {ok:r.ok, validation:stats.validation, geometry:hash(Buffer.concat([bytes(r.verts), bytes(r.tris)])),
            featureIntervals:hash(bytes(r.feature_edges)), taggedLeaves:hash(leaves), decisions:hash(decisions),
            leaves:stats.leaves, triangles:stats.tris, components:stats.components, failed:stats.failedCells,
            fallbacks:stats.featureCellFallbacks, rounds:stats.reRefineRounds}
    } finally {r.free()}
}
const rows = []
for (const [name, s, c, t = {}] of cases) {
    const scene = JSON.stringify(s), tuning = JSON.stringify(t)
    const a = data(baseline, scene, tuning, c), b = data(candidate, scene, tuning, c)
    assert.deepEqual(b, a, name)
    rows.push({name, scene:s, cube:c, tuning:t, ...b})
    process.stderr.write(`WASM baseline/candidate equal: ${name}\n`)
}
writeFileSync(output, JSON.stringify(rows, null, 2) + "\n")
