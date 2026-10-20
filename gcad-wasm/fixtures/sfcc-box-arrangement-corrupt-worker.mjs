import { parentPort, workerData } from "node:worker_threads"
import { readFileSync } from "node:fs"
import { initSync, sfcc_worker_prepare, sfcc_worker_mesh_partition, sfcc_worker_merge } from "../wasm/pkg/gcad_wasm.js"
initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const { scene, tuning, cube, field } = workerData
const leaves = sfcc_worker_prepare(scene, tuning, ...cube)
const partial = sfcc_worker_mesh_partition(scene, tuning, ...cube, leaves, 0, 1)
const view = new DataView(partial.buffer, partial.byteOffset, partial.byteLength)
if (view.getUint32(0, true) !== 0x53464131) throw new Error("fixture did not enter arrangement protocol")
const size = Number(view.getBigUint64(4, true))
if (field === "leafLevel") view.setUint32(68, 0xffffffff, true)
else if (field === "leafIndex") view.setBigInt64(76, 0x7fffffffffffffffn, true)
else {
    const offset = field === "manifest" ? 4 : field === "manifestLeafCount" ? 60 : field === "group" ? 12 + size : 20 + size
    view.setBigUint64(offset, view.getBigUint64(offset, true) + (1n << 32n), true)
}
try {
    const r = sfcc_worker_merge(scene, tuning, ...cube, [partial])
    r.free()
    parentPort.postMessage({ rejected: false })
} catch (error) {
    parentPort.postMessage({ rejected: true, error: String(error) })
}
