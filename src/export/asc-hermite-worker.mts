import { AscVoxelGrid } from "./asc-core/data-grid.mjs"
import {
    applyAscHermiteQefVertexRange,
    type AscHermiteQefOptions,
} from "./asc-hermite-qef-range.mjs"

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

addEventListener("message", (ev: MessageEvent<HermiteWorkerRequest>) => {
    const d = ev.data
    const verts = new Float32Array(d.vertsSab)
    const grid = new AscVoxelGrid(
        new Float32Array(d.gridSab),
        d.gridWidth,
        d.gridDepth,
        d.gridHeight,
        d.threshold,
    )
    const moved = applyAscHermiteQefVertexRange(verts, grid, d.opts, d.featureDot, d.maxMove, d.viStart, d.viEnd)
    postMessage({ moved })
})
