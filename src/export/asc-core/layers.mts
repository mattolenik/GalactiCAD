import type { AscTierIndex } from "./tier.mjs"
import { createAscRuntimeContext } from "./dikelign.mjs"
import { AscVoxelGrid } from "./data-grid.mjs"
import { AscBlock } from "./block.mjs"
import { XDIM, YDIM, ZDIM } from "./constants.mjs"

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

export interface AscLayerSweepResult {
    positions: number[]
    normals: number[]
    indices: number[]
}

/**
 * Layer-by-layer ASC extraction with optional `CommunicateSimple` (asc `asc.cpp` / `interface.cpp`).
 * `bkWidth`/`bkDepth`/`bkHeight` count macro-blocks along each axis (ceil((dim-1)/N)).
 */
export function runAscLayerSweep(params: AscLayerSweepParams): AscLayerSweepResult {
    const ctx = createAscRuntimeContext(params.tierIndex)
    const { N } = ctx.tier
    const gw = params.grid.width
    const gd = params.grid.depth
    const gh = params.grid.height
    const bkWidth = Math.ceil((gw - 1) / N)
    const bkDepth = Math.ceil((gd - 1) / N)
    const bkHeight = Math.ceil((gh - 1) / N)
    const layersize = bkWidth * bkDepth

    const out: AscLayerSweepResult = { positions: [], normals: [], indices: [] }
    const meshOpts = {
        widthScale: params.widthScale,
        depthScale: params.depthScale,
        heightScale: params.heightScale,
        handleBeauty: params.handleBeauty,
        angleThreshRad: params.angleThreshRad,
    }

    if (!params.communicate) {
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
