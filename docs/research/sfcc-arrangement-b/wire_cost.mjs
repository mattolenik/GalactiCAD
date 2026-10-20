import { readFileSync } from "node:fs"
import { initSync, export_sfcc, sfcc_worker_prepare, sfcc_worker_mesh_partition } from "../../../gcad-wasm/wasm/pkg/gcad_wasm.js"
initSync({ module: readFileSync(new URL("../../../gcad-wasm/wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const box = (pos, half) => ({ kind: "box", pos, half })
const scene = JSON.stringify({ kind: "union", children: [box([-1.875, 0, 0], [2.125, 4, 4]), { kind: "intersect", lh: box([2.25, 0, 0], [1.75, 4, 4]), rh: box([-1.625, 0, 0], [2.375, 4, 4]) }] })
const cube = [-128, -128, -128, 256], leaves = sfcc_worker_prepare(scene, "{}", ...cube)
const view = new DataView(leaves.buffer, leaves.byteOffset, leaves.byteLength)
const count = Number(view.getBigUint64(48, true))
let degenerate = 0
for (let i = 0; i < count; i++) degenerate += Number(view.getUint32(56 + i * 48 + 4, true) !== 0)
const partials = [1, 2, 4, 8].map(n => {
    const bytes = Array.from({ length: n }, (_, i) => sfcc_worker_mesh_partition(scene, "{}", ...cube, leaves, i, n).byteLength)
    return { workers: n, bytes, total: bytes.reduce((a, b) => a + b, 0) }
})
const r = export_sfcc(scene, "{}", ...cube)
try { console.log(JSON.stringify({ originalPreparedCells: count, originalPreparedDegenerate: degenerate, preparedBytes: leaves.byteLength, partials, final: JSON.parse(r.stats_json), verts: Array.from(r.verts), tris: Array.from(r.tris) }, null, 2)) }
finally { r.free() }
