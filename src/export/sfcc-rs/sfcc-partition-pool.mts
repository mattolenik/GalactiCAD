/**
 * Warm worker pool for SFCC-rs partition meshing.
 *
 * Mirrors {@link QefWorkerPool}: constructs N module workers (one per Morton partition),
 * each loading the non-atomics gcad-wasm `pkg/` SFCC kernel. {@link meshAll} scatters one
 * `sfcc_worker_mesh_partition` request to each worker and resolves to the N partial-mesh
 * byte buffers in partition-index order, ready for `sfcc_worker_merge`.
 *
 * The pool is WARM — constructed once and reused across export calls (rebuilt only when the
 * requested partition count changes). Call {@link destroy} to tear it down.
 *
 * The prepared leaves buffer is COPIED per worker (structured clone), NOT transferred — the
 * caller keeps the original (it's reused for the merge step) and the N workers each get an
 * independent copy, so the wasm instances stay fully independent (no shared/atomics).
 */

import type {
    SfccPartitionRequest,
    SfccPartitionDone,
    SfccPartitionError,
} from "./partition-worker.mjs"

type WorkerResponse = SfccPartitionDone | SfccPartitionError

export interface SfccPartitionPoolConfig {
    workerUrl: URL
    workerCount: number
}

export interface SfccMeshAllInputs {
    sceneJson: string
    tuningJson: string
    cube: { min: ArrayLike<number>; max: ArrayLike<number> }
    /** The `sfcc_worker_prepare` tagged-leaf byte buffer (shared; copied per worker). */
    leaves: Uint8Array
    /** Number of partitions — must equal {@link workerCount}. */
    count: number
}

interface PendingPartition {
    resolve: (partial: Uint8Array) => void
    reject: (err: unknown) => void
}

export class SfccPartitionPool {
    #workers: Worker[]
    #pending = new Map<number, PendingPartition>()
    #nextReqId = 1
    #destroyed = false

    constructor(config: SfccPartitionPoolConfig) {
        const n = Math.max(1, config.workerCount | 0)
        this.#workers = []
        for (let i = 0; i < n; i++) {
            const w = new Worker(config.workerUrl, { type: "module", name: `sfcc-partition-${i}` })
            w.onmessage = (e: MessageEvent<WorkerResponse>) => this.#handleResponse(e.data)
            w.onerror = (e: ErrorEvent) => this.#handleError(e)
            this.#workers.push(w)
        }
    }

    get workerCount(): number {
        return this.#workers.length
    }

    /**
     * Scatter partition `i` to worker `i` and resolve to the N partial-mesh `Uint8Array`s
     * in index order. `inputs.count` must equal {@link workerCount}.
     */
    meshAll(inputs: SfccMeshAllInputs): Promise<Uint8Array[]> {
        if (this.#destroyed) throw new Error("SfccPartitionPool: meshAll on destroyed pool")
        const N = inputs.count
        if (N !== this.#workers.length) {
            throw new Error(
                `SfccPartitionPool: meshAll count ${N} !== workerCount ${this.#workers.length}`,
            )
        }
        const minX = inputs.cube.min[0]!
        const minY = inputs.cube.min[1]!
        const minZ = inputs.cube.min[2]!
        const size = inputs.cube.max[0]! - inputs.cube.min[0]!

        const promises: Promise<Uint8Array>[] = []
        for (let i = 0; i < N; i++) {
            const reqId = this.#nextReqId++
            promises.push(
                new Promise<Uint8Array>((resolve, reject) => {
                    this.#pending.set(reqId, { resolve, reject })
                }),
            )
            // Per-worker structured-clone copy of the leaves buffer; do NOT transfer the
            // shared leaves (it would detach the caller's copy / sibling workers' copies).
            const leavesCopy = inputs.leaves.slice().buffer
            const req: SfccPartitionRequest = {
                type: "sfcc-partition",
                reqId,
                sceneJson: inputs.sceneJson,
                tuningJson: inputs.tuningJson,
                minX,
                minY,
                minZ,
                size,
                leaves: leavesCopy,
                groupIndex: i,
                groupCount: N,
            }
            // Transfer THIS worker's private copy (cheap; the original is untouched).
            this.#workers[i]!.postMessage(req, [leavesCopy])
        }
        return Promise.all(promises)
    }

    destroy(): void {
        this.#destroyed = true
        for (const w of this.#workers) w.terminate()
        this.#workers = []
        for (const p of this.#pending.values()) p.reject(new Error("SfccPartitionPool destroyed"))
        this.#pending.clear()
    }

    #handleResponse(resp: WorkerResponse): void {
        const p = this.#pending.get(resp.reqId)
        if (!p) return
        this.#pending.delete(resp.reqId)
        if (resp.type === "sfcc-partition-done") {
            p.resolve(new Uint8Array(resp.partial))
        } else {
            p.reject(new Error(`SfccPartitionPool worker: ${resp.error}`))
        }
    }

    #handleError(e: ErrorEvent): void {
        const err = new Error(`SfccPartitionPool worker error: ${e.message}`)
        for (const p of this.#pending.values()) p.reject(err)
        this.#pending.clear()
    }
}
