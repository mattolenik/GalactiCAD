import { parentPort, workerData } from "node:worker_threads"
import { readFileSync } from "node:fs"
import { initSync, sfcc_decide_partition, sfcc_worker_mesh_partition } from "../wasm/pkg/gcad_wasm.js"

initSync({ module: readFileSync(new URL("../wasm/pkg/gcad_wasm_bg.wasm", import.meta.url)) })
const { task, scene, tuning, cube, leaves, index, count, start, end } = workerData
if (task !== "mesh" && task !== "decide") throw new Error(`Unknown worker task: ${task}`)
const output = task === "mesh"
    ? sfcc_worker_mesh_partition(scene, tuning, ...cube, leaves, index, count)
    : sfcc_decide_partition(scene, tuning, ...cube, leaves, start, end)
parentPort.postMessage(output)
