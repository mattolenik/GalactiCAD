/**
 * QEF worker — runs `computeNodeQefResults` on a slice of nodes from a frontier.
 *
 * Input/output are passed via `SharedArrayBuffer`s so the render-worker thread and N QEF workers
 * read/write directly without copies. Each worker is assigned a non-overlapping `[startIdx, endIdx)`
 * range, so concurrent writes are safe without atomics.
 *
 * Per-node layout (for both input and output):
 * - sharedVerts:    N * 32 floats — `node.verts` (8 corners × vec4)
 * - sharedNormPts:  N * totalPhase1 * 4 floats — Phase-1 lattice positions per node (normalized space)
 * - sharedSdf:      N * totalPhase1 * 4 floats — Phase-1 GPU readback `[nx, ny, nz, d]` per sample
 * - sharedOut:      N * 134 floats — per-node packed result:
 *     [0..3]    nodePos     (4 floats, → `node.node[0..3]`; slot 3 is QEF-estimated `w`)
 *     [4..51]   edges       (48 floats, → `node.edges`)
 *     [52..75]  faces       (24 floats, → `node.faces`)
 *     [76..132] reEvalNorm  (57 floats — used by the Phase 2 re-eval mega-batch when enabled)
 *     [133]     qefError    (1 float)
 */

import { installWorkerDevLogBridge } from "../../logging/debug-log.mjs"
import { computeNodeQefResults } from "./iso-octree.mjs"

installWorkerDevLogBridge("iso-qef-worker")

export const QEF_OUT_STRIDE = 134

export interface QefWorkerRequest {
    type: "qef-batch"
    batchId: number
    workerIdx: number
    sharedVerts: SharedArrayBuffer
    sharedNormPts: SharedArrayBuffer
    sharedSdf: SharedArrayBuffer
    sharedOut: SharedArrayBuffer
    startIdx: number
    endIdx: number
    totalPhase1: number
    edgeOffs: number[]
    faceOffs: number[]
    nodeCount: number
    edgeSamples: number
    faceSamples: number
    oversampleQef: number
    dualVertexBorderFraction: number
    invWorldScale: number
}

export interface QefWorkerResponse {
    type: "qef-batch-done"
    batchId: number
    workerIdx: number
}

function handle(req: QefWorkerRequest): void {
    const verts = new Float32Array(req.sharedVerts)
    const normPts = new Float32Array(req.sharedNormPts)
    const sdf = new Float32Array(req.sharedSdf)
    const out = new Float32Array(req.sharedOut)
    const VERTS_STRIDE = 32
    const PHASE1_STRIDE = req.totalPhase1 * 4

    for (let i = req.startIdx; i < req.endIdx; i++) {
        const vertsSlice = verts.subarray(i * VERTS_STRIDE, (i + 1) * VERTS_STRIDE)
        const normPtsSlice = normPts.subarray(i * PHASE1_STRIDE, (i + 1) * PHASE1_STRIDE)
        const sdfSlice = sdf.subarray(i * PHASE1_STRIDE, (i + 1) * PHASE1_STRIDE)
        const scratch = {
            normPts: normPtsSlice,
            edgeOffs: req.edgeOffs,
            faceOffs: req.faceOffs,
            totalPhase1: req.totalPhase1,
            nodeCount: req.nodeCount,
            edgeSamples: req.edgeSamples,
            faceSamples: req.faceSamples,
        }
        const r = computeNodeQefResults(
            vertsSlice,
            scratch,
            sdfSlice,
            req.oversampleQef,
            req.dualVertexBorderFraction,
            req.invWorldScale,
        )
        const o = i * QEF_OUT_STRIDE
        out[o] = r.nodePos[0]!
        out[o + 1] = r.nodePos[1]!
        out[o + 2] = r.nodePos[2]!
        out[o + 3] = r.nodePos[3]!
        out.set(r.edges, o + 4)
        out.set(r.faces, o + 52)
        out.set(r.reEvalNorm, o + 76)
        out[o + 133] = r.qefError
    }
}

self.onmessage = (e: MessageEvent<QefWorkerRequest>) => {
    const msg = e.data
    if (msg.type !== "qef-batch") return
    handle(msg)
    const resp: QefWorkerResponse = { type: "qef-batch-done", batchId: msg.batchId, workerIdx: msg.workerIdx }
    self.postMessage(resp)
}
