/**
 * SFCC-rs partition worker — meshes ONE Morton partition of the prepared octree.
 *
 * Mirrors `iso-qef-worker.mts`: a module worker that loads the (non-atomics) gcad-wasm
 * `pkg/` SFCC kernel and runs `sfcc_worker_mesh_partition` on its assigned share. The
 * main (render) worker runs the expensive `sfcc_worker_prepare` ONCE and scatters the
 * resulting tagged-leaf byte buffer to N of these workers, each owning Morton group
 * `groupIndex` of `groupCount`. Each worker returns a partial-mesh byte buffer; the main
 * thread collects all N and runs `sfcc_worker_merge` to produce the final mesh.
 *
 * No SharedArrayBuffer / atomics: the leaves buffer is a per-worker structured-clone copy,
 * so the N `pkg/` wasm instances are fully independent.
 */

import { installWorkerDevLogBridge } from "../../logging/debug-log.mjs"
import { ensureWasmReady, sfcc_worker_mesh_partition } from "./wasm-loader.mjs"

installWorkerDevLogBridge("sfcc-partition-worker")

export interface SfccPartitionRequest {
    type: "sfcc-partition"
    reqId: number
    sceneJson: string
    tuningJson: string
    minX: number
    minY: number
    minZ: number
    size: number
    /** The `sfcc_worker_prepare` tagged-leaf byte buffer (per-worker copy). */
    leaves: ArrayBuffer
    groupIndex: number
    groupCount: number
}

export interface SfccPartitionDone {
    type: "sfcc-partition-done"
    reqId: number
    /** The `sfcc_worker_mesh_partition` partial-mesh byte buffer (transferred). */
    partial: ArrayBuffer
}

export interface SfccPartitionError {
    type: "sfcc-partition-error"
    reqId: number
    error: string
}

self.onmessage = async (e: MessageEvent<SfccPartitionRequest>) => {
    const msg = e.data
    if (!msg || msg.type !== "sfcc-partition") return
    try {
        await ensureWasmReady()
        const partial = sfcc_worker_mesh_partition(
            msg.sceneJson,
            msg.tuningJson,
            msg.minX,
            msg.minY,
            msg.minZ,
            msg.size,
            new Uint8Array(msg.leaves),
            msg.groupIndex,
            msg.groupCount,
        )
        // `sfcc_worker_mesh_partition` returns a fresh JS-owned Uint8Array (the glue
        // `.slice()`s out of wasm), so its buffer is safe to transfer.
        const done: SfccPartitionDone = {
            type: "sfcc-partition-done",
            reqId: msg.reqId,
            partial: partial.buffer as ArrayBuffer,
        }
        self.postMessage(done, { transfer: [partial.buffer as ArrayBuffer] })
    } catch (err) {
        const resp: SfccPartitionError = {
            type: "sfcc-partition-error",
            reqId: msg.reqId,
            error: err instanceof Error ? err.message : String(err),
        }
        self.postMessage(resp)
    }
}
