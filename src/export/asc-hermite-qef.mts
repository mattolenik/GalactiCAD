import type { MeshData } from "./export.mjs"
import type { AscVoxelGrid } from "./asc-core/index.mjs"
import { isSharedMemoryAvailable } from "../shared-render-buffer.mjs"
import {
    ASC_HERMITE_VERTEX_STRIDE_F32,
    applyAscHermiteQefVertexRange,
    type AscHermiteQefOptions,
} from "./asc-hermite-qef-range.mjs"

export type { AscHermiteQefOptions } from "./asc-hermite-qef-range.mjs"

export interface AscHermiteQefResult extends MeshData {
    movedVertices: number
}

interface HermiteWorkerRequest {
    vertsSab: SharedArrayBuffer
    gridSab: SharedArrayBuffer
    gridWidth: number
    gridDepth: number
    gridHeight: number
    threshold: number
    opts: AscHermiteQefOptions
    featureDot: number
    maxMove: number
    viStart: number
    viEnd: number
}

function hermiteWorkerUrl(): URL {
    return new URL("./asc-hermite-worker.js", import.meta.url)
}

function runHermiteWorkerJob(url: URL, req: HermiteWorkerRequest): Promise<number> {
    return new Promise((resolve, reject) => {
        const w = new Worker(url, { type: "module", name: "asc-hermite-qef" })
        w.onmessage = (ev: MessageEvent<{ moved?: number }>) => {
            w.terminate()
            resolve(ev.data.moved ?? 0)
        }
        w.onmessageerror = () => {
            w.terminate()
            reject(new Error("asc-hermite-worker message error"))
        }
        w.onerror = (e) => {
            w.terminate()
            reject(e.error ?? new Error(String(e.message)))
        }
        w.postMessage(req)
    })
}

async function applyAscHermiteQefParallelWorkers(
    mesh: MeshData,
    grid: AscVoxelGrid,
    opts: AscHermiteQefOptions,
    featureDot: number,
    maxMove: number,
    vertCount: number,
): Promise<AscHermiteQefResult> {
    const vertsSab = new SharedArrayBuffer(mesh.verts.byteLength)
    const verts = new Float32Array(vertsSab)
    verts.set(mesh.verts)

    let gridSab: SharedArrayBuffer
    if (grid.data.buffer instanceof SharedArrayBuffer) {
        gridSab = grid.data.buffer as SharedArrayBuffer
    } else {
        gridSab = new SharedArrayBuffer(grid.data.byteLength)
        new Float32Array(gridSab).set(grid.data)
    }

    const hw =
        typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
            ? navigator.hardwareConcurrency
            : 4
    const maxWorkers = Math.min(8, Math.max(2, hw))
    const chunkCount = Math.min(maxWorkers, Math.max(2, Math.ceil(vertCount / 256)))
    const chunk = Math.ceil(vertCount / chunkCount)

    const url = hermiteWorkerUrl()
    const jobs: Promise<number>[] = []
    for (let w = 0; w < chunkCount; w++) {
        const viStart = w * chunk
        const viEnd = Math.min(vertCount, viStart + chunk)
        if (viStart >= viEnd) continue
        jobs.push(
            runHermiteWorkerJob(url, {
                vertsSab,
                gridSab,
                gridWidth: grid.width,
                gridDepth: grid.depth,
                gridHeight: grid.height,
                threshold: grid.threshold,
                opts,
                featureDot,
                maxMove,
                viStart,
                viEnd,
            }),
        )
    }

    const movedParts = await Promise.all(jobs)
    let movedVertices = 0
    for (const m of movedParts) movedVertices += m

    return { verts: verts as unknown as MeshData["verts"], tris: mesh.tris, movedVertices }
}

/** Single-thread pass (reference / fallback); vert writes stay within `{verts}` buffer. */
export function applyAscHermiteQefSync(mesh: MeshData, grid: AscVoxelGrid, opts: AscHermiteQefOptions): AscHermiteQefResult {
    const verts = new Float32Array(mesh.verts)
    const vertCount = (verts.length / ASC_HERMITE_VERTEX_STRIDE_F32) | 0
    const featureDot = opts.featureNormalDot ?? Math.cos((35 * Math.PI) / 180)
    const maxMove = (opts.maxMoveVoxels ?? 1.25) * Math.max(Math.abs(opts.scaleX), Math.abs(opts.scaleY), Math.abs(opts.scaleZ))
    const movedVertices = applyAscHermiteQefVertexRange(verts, grid, opts, featureDot, maxMove, 0, vertCount)
    return { verts, tris: mesh.tris, movedVertices }
}

function shouldUseHermiteWorkers(vertCount: number): boolean {
    return (
        typeof Worker !== "undefined" &&
        isSharedMemoryAvailable() &&
        vertCount >= 512 &&
        (typeof navigator === "undefined" || (navigator.hardwareConcurrency ?? 1) > 1)
    )
}

/**
 * Pull ASC vertices near multi-normal grid crossings toward the Hermite QEF solution.
 * This improves hard SDF features (box edges, square contours) without changing ASC topology.
 */
export async function applyAscHermiteQef(mesh: MeshData, grid: AscVoxelGrid, opts: AscHermiteQefOptions): Promise<AscHermiteQefResult> {
    const vertCount = (mesh.verts.length / ASC_HERMITE_VERTEX_STRIDE_F32) | 0
    if (vertCount === 0) {
        return { verts: new Float32Array(0), tris: mesh.tris, movedVertices: 0 }
    }
    const featureDot = opts.featureNormalDot ?? Math.cos((35 * Math.PI) / 180)
    const maxMove = (opts.maxMoveVoxels ?? 1.25) * Math.max(Math.abs(opts.scaleX), Math.abs(opts.scaleY), Math.abs(opts.scaleZ))

    if (shouldUseHermiteWorkers(vertCount)) {
        try {
            return await applyAscHermiteQefParallelWorkers(mesh, grid, opts, featureDot, maxMove, vertCount)
        } catch {
            // Worker bootstrap failures fall back to sequential (e.g. bad URL in unusual hosts).
        }
    }

    return applyAscHermiteQefSync(mesh, grid, opts)
}
