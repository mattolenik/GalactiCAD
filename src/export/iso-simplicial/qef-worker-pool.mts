/**
 * Worker pool for parallelizing per-frontier QEF compute (`computeNodeQefResults`).
 *
 * Use {@link QefWorkerPool.processBatch} to dispatch a frontier's N nodes across the pool's
 * workers; each worker writes its slice into the shared output buffer concurrently (ranges
 * are disjoint, no atomics required). The caller then reads the output buffer with
 * {@link QEF_OUT_STRIDE}-strided indexing.
 *
 * Lifecycle: construct once per export session, call {@link destroy} when the build finishes.
 */

import type { Phase1NormScratch } from "./iso-octree.mjs"
import type { QefWorkerRequest, QefWorkerResponse } from "./iso-qef-worker.mjs"

export const QEF_OUT_STRIDE = 134

/** Float layout of a single node's packed result inside the shared output buffer. */
export const QEF_OUT_LAYOUT = {
    nodePos: { offset: 0, length: 4 },
    edges: { offset: 4, length: 48 },
    faces: { offset: 52, length: 24 },
    reEvalNorm: { offset: 76, length: 57 },
    qefError: { offset: 133, length: 1 },
} as const

export interface QefWorkerPoolConfig {
    workerUrl: URL
    workerCount: number
}

export interface QefBatchInputs {
    sharedVerts: SharedArrayBuffer
    sharedNormPts: SharedArrayBuffer
    sharedSdf: SharedArrayBuffer
    sharedOut: SharedArrayBuffer
    nodeCount: number
    scratchProto: Phase1NormScratch
    oversampleQef: number
    dualVertexBorderFraction: number
    invWorldScale: number
    /** Optional per-node packed `SDFResultMid` corner data (N × 8 × 28 floats). */
    sharedCornerFeature?: SharedArrayBuffer
    featurePlaneEnabled?: boolean
    featurePlaneDistFactor?: number
    rootMinX?: number
    rootMinY?: number
    rootMinZ?: number
    worldScale?: number
    /** Optional FeatureGraph plane-source sidecar — see `iso-fg-shared-buffer.mts`. */
    sharedFgData?: SharedArrayBuffer
    sharedFgOffsets?: SharedArrayBuffer
    fgStrideFloats?: number
}

interface PendingBatch {
    expected: number
    received: number
    resolve: () => void
    reject: (err: unknown) => void
}

export class QefWorkerPool {
    #workers: Worker[]
    #pending = new Map<number, PendingBatch>()
    #nextBatchId = 1
    #destroyed = false

    constructor(config: QefWorkerPoolConfig) {
        const n = Math.max(1, config.workerCount | 0)
        this.#workers = []
        for (let i = 0; i < n; i++) {
            const w = new Worker(config.workerUrl, { type: "module", name: `iso-qef-${i}` })
            w.onmessage = (e: MessageEvent<QefWorkerResponse>) => this.#handleResponse(e.data)
            w.onerror = (e: ErrorEvent) => this.#handleError(e)
            this.#workers.push(w)
        }
    }

    get workerCount(): number {
        return this.#workers.length
    }

    /**
     * Dispatch a frontier's QEF work across all workers and resolve when every slice is done.
     * Splits `[0, nodeCount)` into one contiguous range per worker.
     */
    processBatch(inputs: QefBatchInputs): Promise<void> {
        if (this.#destroyed) throw new Error("QefWorkerPool: processBatch on destroyed pool")
        const batchId = this.#nextBatchId++
        const N = inputs.nodeCount
        const W = this.#workers.length
        if (N === 0) return Promise.resolve()
        return new Promise((resolve, reject) => {
            const expected = Math.min(W, N)
            this.#pending.set(batchId, { expected, received: 0, resolve, reject })
            for (let wi = 0; wi < expected; wi++) {
                const startIdx = Math.floor((wi * N) / expected)
                const endIdx = Math.floor(((wi + 1) * N) / expected)
                if (startIdx >= endIdx) continue
                const req: QefWorkerRequest = {
                    type: "qef-batch",
                    batchId,
                    workerIdx: wi,
                    sharedVerts: inputs.sharedVerts,
                    sharedNormPts: inputs.sharedNormPts,
                    sharedSdf: inputs.sharedSdf,
                    sharedOut: inputs.sharedOut,
                    startIdx,
                    endIdx,
                    totalPhase1: inputs.scratchProto.totalPhase1,
                    edgeOffs: inputs.scratchProto.edgeOffs,
                    faceOffs: inputs.scratchProto.faceOffs,
                    nodeCount: inputs.scratchProto.nodeCount,
                    edgeSamples: inputs.scratchProto.edgeSamples,
                    faceSamples: inputs.scratchProto.faceSamples,
                    oversampleQef: inputs.oversampleQef,
                    dualVertexBorderFraction: inputs.dualVertexBorderFraction,
                    invWorldScale: inputs.invWorldScale,
                    sharedCornerFeature: inputs.sharedCornerFeature,
                    featurePlaneEnabled: inputs.featurePlaneEnabled,
                    featurePlaneDistFactor: inputs.featurePlaneDistFactor,
                    rootMinX: inputs.rootMinX,
                    rootMinY: inputs.rootMinY,
                    rootMinZ: inputs.rootMinZ,
                    worldScale: inputs.worldScale,
                    sharedFgData: inputs.sharedFgData,
                    sharedFgOffsets: inputs.sharedFgOffsets,
                    fgStrideFloats: inputs.fgStrideFloats,
                }
                this.#workers[wi]!.postMessage(req)
            }
        })
    }

    destroy(): void {
        this.#destroyed = true
        for (const w of this.#workers) w.terminate()
        this.#workers = []
        for (const p of this.#pending.values()) p.reject(new Error("QefWorkerPool destroyed"))
        this.#pending.clear()
    }

    #handleResponse(resp: QefWorkerResponse): void {
        if (resp.type !== "qef-batch-done") return
        const p = this.#pending.get(resp.batchId)
        if (!p) return
        p.received++
        if (p.received >= p.expected) {
            this.#pending.delete(resp.batchId)
            p.resolve()
        }
    }

    #handleError(e: ErrorEvent): void {
        const err = new Error(`QefWorkerPool worker error: ${e.message}`)
        for (const p of this.#pending.values()) p.reject(err)
        this.#pending.clear()
    }
}
