import { log as dbgLog } from "../logging/debug-log.mjs"
import { GridSampler } from "./grid-sample.mjs"
import { GPUHelper } from "../gpu/helper.mjs"
import { splitCreaseVertices } from "./crease-split.mjs"
import type { MeshData } from "./export.mjs"
import type { ProgressCallback } from "./mdc.mjs"
import { flexiCubesCPU } from "./flexicubes/fc-cpu.mjs"
import { ContourSpatialIndex } from "./shrec/contour-snap.mjs"
import type { ContourBufferView } from "../scene/contour-buffer.mjs"
import { featureGraphToContours } from "../feature-graph/feature-graph-to-contours.mjs"
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
    /** Feature-vs-surface constraint strength when FeatureGraph constraints are active. Default 4. */
    featureWeight?: number
    /** SDF-validation tolerance for accepting a feature, as a fraction of voxel size. Default 0.75. */
    featureValidationTol?: number
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
    /** Authoritative FeatureGraph corners/creases to fold into the QEF, or null. */
    #contours: ContourBufferView | null

    constructor(
        helper: GPUHelper,
        polygonVerticesBuffer: GPUBuffer,
        faceSelectionBuffer: GPUBuffer,
        mdcSceneParamsBuffer: GPUBuffer,
        params: FlexiCubesParams,
        contours?: ContourBufferView | null,
        _progress?: ProgressCallback,
    ) {
        this.#sampler = new GridSampler(helper, polygonVerticesBuffer, faceSelectionBuffer, mdcSceneParamsBuffer)
        this.#params = params
        this.#contours = contours && (contours.segmentCount + contours.pointCount) > 0 ? contours : null
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

        // Build the per-cell feature index from the survival-aware FeatureGraph
        // contours (same cube-cell convention as fc-cpu: cell origin =
        // gridOffset + cellCoord · voxelSize).
        const featureIndex = this.#contours
            ? ContourSpatialIndex.build(this.#contours, grid.voxelSize, grid.gridOffset)
            : null
        if (featureIndex) {
            log.info(
                `FlexiCubesExport: feature constraints active ` +
                    `(segments=${this.#contours!.segmentCount} points=${this.#contours!.pointCount} weight=${p.featureWeight ?? 4})`,
            )
        }

        const { verts: rawVerts, tris } = flexiCubesCPU(
            grid, p.isoValue, p.qefRelCutoff ?? 0.1, featureIndex,
            p.featureWeight ?? 4, p.featureValidationTol ?? 0.75,
        )

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
            featureWeight: tuning.featureWeight,
            featureValidationTol: tuning.featureValidationTol,
        }
        const module = ctx.makeSceneCompiler().compile(sampleGridShader, "FlexiCubes Sample Grid")

        // Fold authoritative corners/creases from the survival-aware
        // FeatureGraph into the per-cell QEF (mirrors SHREC's contour wiring).
        let contours: ContourBufferView | null = null
        if (tuning.featureConstrainedPlacement) {
            const fg = await ctx.buildFeatureGraph(ctx.scene, tuning.voxelSizeMm)
            if (fg) {
                contours = featureGraphToContours(fg.cpu, fg.worldPositions)
                dbgLog("FlexiCubesExport").info(
                    `FlexiCubes contours from FeatureGraph ` +
                        `(alive verts=${fg.aliveVertexCount}/${fg.finalVertexCount}, ` +
                        `alive edges=${fg.aliveEdgeCount}/${fg.finalEdgeCount})`,
                )
            } else {
                dbgLog("FlexiCubesExport").info("FlexiCubes: FeatureGraph unavailable; no feature constraints")
            }
        }

        const fc = new FlexiCubesExport(
            ctx.helper,
            ctx.uniformBuffers.polygonVertices,
            ctx.uniformBuffers.faceSelection,
            ctx.uniformBuffers.mdcSceneParams,
            params,
            contours,
        )
        return fc.export(module, ctx.signal)
    },
}
