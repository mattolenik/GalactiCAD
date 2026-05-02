import type { AscTierIndex } from "./asc-core/tier.mjs"
import { createAscRuntimeContext } from "./asc-core/dikelign.mjs"
import { AscVoxelGrid } from "./asc-core/data-grid.mjs"
import { AscBlock } from "./asc-core/block.mjs"
import { XDIM, YDIM, ZDIM } from "./asc-core/constants.mjs"
import { mergeAscLayerSweepChunks, type AscLayerSweepMeshChunk } from "./asc-layer-merge.mjs"

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

interface MeshOpts {
    widthScale: number
    depthScale: number
    heightScale: number
    handleBeauty: boolean
    angleThreshRad: number
}

addEventListener("message", (ev: MessageEvent<CollectWorkerReq>) => {
    const d = ev.data
    const grid = new AscVoxelGrid(new Float32Array(d.gridSab), d.gw, d.gd, d.gh, d.threshold)
    const ctx = createAscRuntimeContext(d.tierIndex)
    const { N } = ctx.tier
    const meshOpts: MeshOpts = {
        widthScale: d.widthScale,
        depthScale: d.depthScale,
        heightScale: d.heightScale,
        handleBeauty: d.handleBeauty,
        angleThreshRad: d.angleThreshRad,
    }
    const scratches: AscLayerSweepMeshChunk[] = []
    for (const cell of d.cells) {
        const { i, j, k } = cell
        const scratch: AscLayerSweepMeshChunk = { positions: [], normals: [], indices: [] }
        const block = new AscBlock(ctx, grid, d.gw, d.gd, d.gh)
        block.setOrientation(XDIM, YDIM, ZDIM)
        block.init(N * i, N * j, N * k)
        if (!block.emptyQ()) {
            block.buildHighRice(d.handleAmbiguity)
            block.collectTriangles(scratch, meshOpts)
            block.cleanUp()
        }
        scratches.push(scratch)
    }
    const merged = mergeAscLayerSweepChunks(scratches)
    postMessage({ merged })
})
