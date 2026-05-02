import { ascBinTier, type AscTierIndex } from "./tier.mjs"
import { createAscRuntimeContext } from "./dikelign.mjs"
import type { AscVoxelGrid } from "./data-grid.mjs"
import { AscBlock } from "./block.mjs"
import { XDIM, YDIM, ZDIM } from "./constants.mjs"
import { isSharedMemoryAvailable } from "../../shared-render-buffer.mjs"
import {
    mergeAscLayerSweepChunks,
    type AscLayerSweepMeshChunk,
} from "../asc-layer-merge.mjs"

export interface AscLayerSweepParams {
    readonly tierIndex: AscTierIndex
    readonly grid: AscVoxelGrid
    readonly handleAmbiguity: boolean
    readonly communicate: boolean
    /** Voxel scales (asc `G_WidthScale` / `G_DepthScale` / `G_HeightScale`). */
    readonly widthScale: number
    readonly depthScale: number
    readonly heightScale: number
    readonly handleBeauty: boolean
    /** Initial angle threshold in radians (asc `G_AngleThresh`). */
    readonly angleThreshRad: number
}

export type AscLayerSweepResult = AscLayerSweepMeshChunk

interface MeshOpts {
    widthScale: number
    depthScale: number
    heightScale: number
    handleBeauty: boolean
    angleThreshRad: number
}

interface CollectWorkerReq {
    gridSab: SharedArrayBuffer
    gw: number
    gd: number
    gh: number
    threshold: number
    tierIndex: AscTierIndex
    handleAmbiguity: boolean
    widthScale: number
    depthScale: number
    heightScale: number
    handleBeauty: boolean
    angleThreshRad: number
    cells: readonly { readonly i: number; readonly j: number; readonly k: number }[]
}

function ascCollectWorkerUrl(): URL {
    return new URL("./asc-collect-worker.js", import.meta.url)
}

function runCollectWorkerChunk(url: URL, req: CollectWorkerReq): Promise<AscLayerSweepMeshChunk> {
    return new Promise((resolve, reject) => {
        const w = new Worker(url, { type: "module", name: "asc-collect" })
        w.onmessage = (ev: MessageEvent<{ merged?: AscLayerSweepMeshChunk }>) => {
            w.terminate()
            const m = ev.data.merged
            if (m) resolve(m)
            else reject(new Error("asc-collect-worker: missing merged payload"))
        }
        w.onmessageerror = () => {
            w.terminate()
            reject(new Error("asc-collect-worker: message error"))
        }
        w.onerror = (e) => {
            w.terminate()
            reject(e.error ?? new Error(String(e.message)))
        }
        w.postMessage(req)
    })
}

function shouldUseAscCollectWorkers(totalCells: number): boolean {
    return (
        typeof Worker !== "undefined" &&
        isSharedMemoryAvailable() &&
        totalCells >= 24 &&
        (typeof navigator === "undefined" || (navigator.hardwareConcurrency ?? 1) > 1)
    )
}

async function runAscNonCommunicatingCollectWorkers(params: AscLayerSweepParams, meshOpts: MeshOpts): Promise<AscLayerSweepResult> {
    const { N } = ascBinTier(params.tierIndex)
    const gw = params.grid.width
    const gd = params.grid.depth
    const gh = params.grid.height
    const bkWidth = Math.ceil((gw - 1) / N)
    const bkDepth = Math.ceil((gd - 1) / N)
    const bkHeight = Math.ceil((gh - 1) / N)

    const cells: { i: number; j: number; k: number }[] = []
    for (let k = 0; k < bkHeight; k++) {
        for (let j = 0; j < bkDepth; j++) {
            for (let i = 0; i < bkWidth; i++) {
                cells.push({ i, j, k })
            }
        }
    }

    const gridSab = new SharedArrayBuffer(params.grid.data.byteLength)
    new Float32Array(gridSab).set(params.grid.data)

    const hw =
        typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
            ? navigator.hardwareConcurrency
            : 4
    const maxWorkers = Math.min(8, Math.max(2, hw))
    const workerCount = Math.min(maxWorkers, Math.max(2, Math.ceil(cells.length / 8)))
    const slice = Math.ceil(cells.length / workerCount)

    const url = ascCollectWorkerUrl()
    const jobs: Promise<AscLayerSweepMeshChunk>[] = []
    for (let w = 0; w < workerCount; w++) {
        const start = w * slice
        const end = Math.min(cells.length, start + slice)
        if (start >= end) continue
        jobs.push(
            runCollectWorkerChunk(url, {
                gridSab,
                gw,
                gd,
                gh,
                threshold: params.grid.threshold,
                tierIndex: params.tierIndex,
                handleAmbiguity: params.handleAmbiguity,
                widthScale: meshOpts.widthScale,
                depthScale: meshOpts.depthScale,
                heightScale: meshOpts.heightScale,
                handleBeauty: meshOpts.handleBeauty,
                angleThreshRad: meshOpts.angleThreshRad,
                cells: cells.slice(start, end),
            }),
        )
    }

    const parts = await Promise.all(jobs)
    return mergeAscLayerSweepChunks(parts)
}

/**
 * Layer-by-layer ASC extraction with optional `CommunicateSimple` (asc `asc.cpp` / `interface.cpp`).
 * `bkWidth`/`bkDepth`/`bkHeight` count macro-blocks along each axis (ceil((dim-1)/N)).
 */
export async function runAscLayerSweep(params: AscLayerSweepParams): Promise<AscLayerSweepResult> {
    const ctx = createAscRuntimeContext(params.tierIndex)
    const { N } = ctx.tier
    const gw = params.grid.width
    const gd = params.grid.depth
    const gh = params.grid.height
    const bkWidth = Math.ceil((gw - 1) / N)
    const bkDepth = Math.ceil((gd - 1) / N)
    const bkHeight = Math.ceil((gh - 1) / N)

    const meshOpts: MeshOpts = {
        widthScale: params.widthScale,
        depthScale: params.depthScale,
        heightScale: params.heightScale,
        handleBeauty: params.handleBeauty,
        angleThreshRad: params.angleThreshRad,
    }

    if (!params.communicate) {
        const totalCells = bkWidth * bkDepth * bkHeight
        if (shouldUseAscCollectWorkers(totalCells)) {
            try {
                return await runAscNonCommunicatingCollectWorkers(params, meshOpts)
            } catch {
                /* fall through to sequential */
            }
        }

        const out: AscLayerSweepResult = { positions: [], normals: [], indices: [] }
        for (let k = 0; k < bkHeight; k++) {
            for (let j = 0; j < bkDepth; j++) {
                for (let i = 0; i < bkWidth; i++) {
                    const block = new AscBlock(ctx, params.grid, gw, gd, gh)
                    block.setOrientation(XDIM, YDIM, ZDIM)
                    block.init(N * i, N * j, N * k)
                    if (!block.emptyQ()) {
                        block.buildHighRice(params.handleAmbiguity)
                        block.collectTriangles(out, meshOpts)
                        block.cleanUp()
                    }
                }
            }
        }
        return out
    }

    const layersize = bkWidth * bkDepth
    const out: AscLayerSweepResult = { positions: [], normals: [], indices: [] }

    const layer: AscBlock[][] = [[], [], []]
    for (let z = 0; z < 3; z++) {
        for (let n = 0; n < layersize; n++) {
            layer[z]!.push(new AscBlock(ctx, params.grid, gw, gd, gh))
        }
    }

    for (let k = 0; k - 2 < bkHeight; k++) {
        const k0 = k % 3
        const k1 = (k - 1 + 3) % 3
        const k2 = (k - 2 + 3) % 3
        const kminus0 = layer[k0]!
        const kminus1 = layer[k1]!
        const kminus2 = layer[k2]!

        if (k < bkHeight) {
            for (let j = 0; j < bkDepth; j++) {
                for (let i = 0; i < bkWidth; i++) {
                    const currij = j * bkWidth + i
                    const b = kminus0[currij]!
                    b.setOrientation(XDIM, YDIM, ZDIM)
                    b.init(N * i, N * j, N * k)
                    if (!b.emptyQ()) b.buildHighRice(params.handleAmbiguity)
                }
            }
        }

        if (k >= 1 && k - 1 < bkHeight) {
            for (let j = 0; j < bkDepth; j++) {
                for (let i = 0; i < bkWidth; i++) {
                    const currij = j * bkWidth + i
                    const b = kminus1[currij]!
                    if (b.emptyQ()) continue
                    const bottom = k === 1 ? null : kminus2[currij]!
                    const top = k === bkHeight ? null : kminus0[currij]!
                    const nearxz = j === 0 ? null : kminus1[(j - 1) * bkWidth + i]!
                    const farxz = j === bkDepth - 1 ? null : kminus1[(j + 1) * bkWidth + i]!
                    const nearyz = i === 0 ? null : kminus1[j * bkWidth + i - 1]!
                    const faryz = i === bkWidth - 1 ? null : kminus1[j * bkWidth + i + 1]!
                    b.communicateSimple(bottom, top, nearxz, farxz, nearyz, faryz)
                    b.collectTriangles(out, meshOpts)
                }
            }
        }

        if (k >= 2) {
            for (let j = 0; j < bkDepth; j++) {
                for (let i = 0; i < bkWidth; i++) {
                    const currij = j * bkWidth + i
                    const b = kminus2[currij]!
                    if (!b.emptyQ()) b.cleanUp()
                }
            }
        }
    }

    return out
}
