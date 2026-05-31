import { log as dbgLog } from "../logging/debug-log.mjs"
import { GridSampler } from "./grid-sample.mjs"
import { GPUHelper } from "../gpu/helper.mjs"
import { splitCreaseVertices } from "./crease-split.mjs"
import type { MeshData } from "./export.mjs"
import type { ProgressCallback } from "./mdc.mjs"
import { flexiCubesCPU } from "./flexicubes/fc-cpu.mjs"
import sampleGridShader from "../shaders/sample_grid.wgsl"
import type { MeshExporter } from "./mesh-exporter.mjs"
import {
    FLEXICUBES_DISPLAY_NAME,
    DEFAULT_FLEXICUBES_TUNING,
    normalizeFlexiCubesTuning,
    type FlexiCubesTuning,
} from "./flexicubes/flexicubes-tuning.mjs"

export interface FlexiCubesParams {
    gridDimX: number
    gridDimY: number
    gridDimZ: number
    isoValue: number
    gridOffsetX: number
    gridOffsetY: number
    gridOffsetZ: number
    voxelSize: number
    /** Crease angle (degrees) for normal derivation pass. Default 30. */
    creaseAngleDeg?: number
    /**
     * QEF singular-value cutoff as a fraction of the largest eigenvalue.
     * Smaller → sharper features. Default 0.1.
     */
    qefRelCutoff?: number
}

/**
 * FlexiCubes mesh exporter.
 *
 * Architecture: GPU SDF sampling (reuses sample_grid.wgsl via GridSampler) +
 * CPU meshing (TypeScript port of the FlexiCubes algorithm, QEF mode).
 *
 * Non-ML mode only — no learned beta/alpha/gamma weights. Analytic SDF
 * normals from the grid sampler drive QEF vertex placement.
 */
export class FlexiCubesExport {
    #sampler: GridSampler
    #params: FlexiCubesParams

    constructor(
        helper: GPUHelper,
        polygonVerticesBuffer: GPUBuffer,
        faceSelectionBuffer: GPUBuffer,
        mdcSceneParamsBuffer: GPUBuffer,
        params: FlexiCubesParams,
        _progress?: ProgressCallback,
    ) {
        this.#sampler = new GridSampler(helper, polygonVerticesBuffer, faceSelectionBuffer, mdcSceneParamsBuffer)
        this.#params = params
    }

    async export(sampleGridShaderModule: GPUShaderModule, signal?: AbortSignal): Promise<MeshData> {
        const p = this.#params
        const log = dbgLog("FlexiCubesExport")

        const throwIfAborted = () => {
            if (signal?.aborted) {
                const e = new Error("FlexiCubes export aborted")
                e.name = "AbortError"
                throw e
            }
        }
        throwIfAborted()

        log.info(`FlexiCubesExport: ${p.gridDimX}×${p.gridDimY}×${p.gridDimZ} voxelSize=${p.voxelSize}`)
        const t0 = performance.now()

        const grid = await this.#sampler.sample(sampleGridShaderModule, {
            gridDimX: p.gridDimX,
            gridDimY: p.gridDimY,
            gridDimZ: p.gridDimZ,
            voxelSize: p.voxelSize,
            gridOffsetX: p.gridOffsetX,
            gridOffsetY: p.gridOffsetY,
            gridOffsetZ: p.gridOffsetZ,
        })
        throwIfAborted()

        const t1 = performance.now()
        log.info(`FlexiCubesExport: grid sampled in ${(t1 - t0).toFixed(1)}ms, running CPU meshing…`)

        const { verts: rawVerts, tris } = flexiCubesCPU(grid, p.isoValue, p.qefRelCutoff ?? 0.1)

        const t2 = performance.now()
        log.info(`FlexiCubesExport: CPU meshing done in ${(t2 - t1).toFixed(1)}ms, ` +
            `${(rawVerts.length / 8) | 0} verts, ${(tris.length / 3) | 0} tris — running crease split…`)

        const mesh = splitCreaseVertices(rawVerts, tris, p.creaseAngleDeg ?? 30)

        const t3 = performance.now()
        log.info(`FlexiCubesExport: done in ${(t3 - t0).toFixed(1)}ms total`)

        return mesh
    }
}

/**
 * The FlexiCubes mesh exporter: GPU grid sampling + CPU FlexiCubes dual
 * extraction (QEF mode). Sizes a uniform grid from `tuning.voxelSizeMm`.
 * Cancellation is best-effort (checks `ctx.signal` around the single GPU
 * dispatch).
 */
export const flexicubesExporter: MeshExporter<FlexiCubesTuning> = {
    displayName: FLEXICUBES_DISPLAY_NAME,
    defaultTuning: DEFAULT_FLEXICUBES_TUNING,
    normalizeTuning: normalizeFlexiCubesTuning,
    async run(ctx, tuning) {
        const grid = ctx.computeUniformGrid(tuning.voxelSizeMm)
        const params: FlexiCubesParams = {
            ...grid,
            isoValue: tuning.isoValue,
            voxelSize: tuning.voxelSizeMm,
            creaseAngleDeg: tuning.creaseAngleDeg,
            qefRelCutoff: tuning.qefRelCutoff,
        }
        const module = ctx.makeSceneCompiler().compile(sampleGridShader, "FlexiCubes Sample Grid")
        const fc = new FlexiCubesExport(
            ctx.helper,
            ctx.uniformBuffers.polygonVertices,
            ctx.uniformBuffers.faceSelection,
            ctx.uniformBuffers.mdcSceneParams,
            params,
        )
        return fc.export(module, ctx.signal)
    },
}
