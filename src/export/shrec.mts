import { GPUHelper } from "../gpu/helper.mjs"
import { log as dbgLog } from "../logging/debug-log.mjs"
import { dualContourCPU } from "./shrec/dc-cpu.mjs"
import type { MeshData } from "./export.mjs"
import type { ProgressCallback } from "./mdc.mjs"
import { GridSampler, type GridSampleResult } from "./grid-sample.mjs"

/**
 * Parameters for SHREC / MergeSharp export.
 *
 * Mirrors the grid-defining subset of MDCParams so a single set of UI controls
 * can drive either exporter. SHREC-specific tuning lives in the optional
 * `merge*` / `feature*` fields and is consumed by the CPU stage.
 */
export interface ShrecParams {
    gridDimX: number
    gridDimY: number
    gridDimZ: number
    /** Iso-surface value (typically 0 for an SDF). */
    isoValue: number
    gridOffsetX: number
    gridOffsetY: number
    gridOffsetZ: number
    voxelSize: number

    // --- MergeSharp tuning knobs (consumed by upcoming CPU stage). ---
    /**
     * Cosine of the angle threshold below which two gradient directions are
     * considered to belong to different smooth regions. Default ≈ cos(30°).
     */
    featureAngleCosThreshold?: number
    /** Maximum world-space radius for sharp-feature vertex clustering. */
    mergeRadius?: number
    /** Cap on MergeSharp relocation iterations. */
    mergeIterations?: number
}

/**
 * Alternate exporter that produces a mesh via SHREC / MergeSharp instead of
 * the integrated GPU MDC pipeline.
 *
 * Pipeline:
 *   1. GPU: sample the scene SDF on a uniform 3D grid (scalar + gradient).
 *      → `GridSampler` (see `grid-sample.mts`).
 *   2. CPU: extract a base mesh via plain dual contouring on the sampled grid.
 *   3. CPU: relocate vertices onto sharp features using MergeSharp's gradient
 *      clustering + 3x3 SVD.
 *   4. (Reuses `simplifyMesh` from `simplify.mjs` if requested.)
 *
 * The constructor signature deliberately matches `MDCExport` so the dispatcher
 * in `render-worker-core.mts` can swap exporters without touching scene-param
 * plumbing.
 *
 * Stages 2 and 3 are stubs in this scaffold; they currently emit an empty mesh
 * and log a message indicating the CPU mesher is pending. Stage 1 is fully
 * functional and is what the rest of the pipeline will be built on top of.
 */
export class ShrecExport {
    #helper: GPUHelper
    #polygonVerticesBuffer: GPUBuffer
    #faceSelectionBuffer: GPUBuffer
    #mdcSceneParamsBuffer: GPUBuffer

    constructor(
        helper: GPUHelper,
        private params: ShrecParams,
        polygonVerticesBuffer: GPUBuffer,
        faceSelectionBuffer: GPUBuffer,
        mdcSceneParamsBuffer: GPUBuffer,
    ) {
        this.#helper = helper
        this.#polygonVerticesBuffer = polygonVerticesBuffer
        this.#faceSelectionBuffer = faceSelectionBuffer
        this.#mdcSceneParamsBuffer = mdcSceneParamsBuffer
    }

    async export(
        sampleGridShaderModule: GPUShaderModule,
        progressCallback?: ProgressCallback,
    ): Promise<MeshData> {
        const checkCancelled = () => {
            if (progressCallback?.cancelled) {
                throw new Error("SHREC export was cancelled")
            }
        }

        progressCallback?.updateProgress("SHREC: sampling SDF on GPU grid", 10)
        checkCancelled()

        const sampler = new GridSampler(
            this.#helper,
            this.#polygonVerticesBuffer,
            this.#faceSelectionBuffer,
            this.#mdcSceneParamsBuffer,
        )
        const grid = await sampler.sample(sampleGridShaderModule, {
            gridDimX: this.params.gridDimX,
            gridDimY: this.params.gridDimY,
            gridDimZ: this.params.gridDimZ,
            voxelSize: this.params.voxelSize,
            gridOffsetX: this.params.gridOffsetX,
            gridOffsetY: this.params.gridOffsetY,
            gridOffsetZ: this.params.gridOffsetZ,
        })

        this.#logGridStats(grid)
        progressCallback?.updateProgress("SHREC: dual contouring on CPU", 50)
        checkCancelled()

        const mesh = dualContourCPU(grid, { isoValue: this.params.isoValue })

        // TODO: Stage 3 — MergeSharp vertex relocation using `grid.gradient`
        // and the params.feature* / merge* knobs. Implement in
        // `shrec/merge-sharp.mts` with a small inline 3x3 SVD. For now the
        // mass-point dual contouring output is returned as-is.

        progressCallback?.updateProgress("SHREC: complete", 100)
        const triCount = (mesh.tris.length / 3) | 0
        const vertCount = (mesh.verts.length / 8) | 0
        dbgLog("ShrecExport").info(
            `ShrecExport.export(): emitted ${vertCount} vertices, ${triCount} triangles ` +
            `(MergeSharp vertex relocation pending).`,
        )

        return mesh
    }

    /** Log distance-range / sign-balance diagnostics so the caller can sanity-check the grid pre-CPU. */
    #logGridStats(grid: GridSampleResult): void {
        const n = grid.scalar.length
        if (n === 0) {
            dbgLog("ShrecExport").warn("Sampled grid is empty.")
            return
        }
        let dMin = Infinity
        let dMax = -Infinity
        let inside = 0
        let outside = 0
        // Sample at most 1M voxels for stats to keep this cheap on huge grids.
        const stride = Math.max(1, Math.floor(n / 1_000_000))
        for (let i = 0; i < n; i += stride) {
            const d = grid.scalar[i]!
            if (d < dMin) dMin = d
            if (d > dMax) dMax = d
            if (d <= this.params.isoValue) inside++
            else outside++
        }
        dbgLog("ShrecExport").debug(
            `Grid stats (stride=${stride}): scalar∈[${dMin.toFixed(4)}, ${dMax.toFixed(4)}], ` +
            `inside=${inside} outside=${outside} sampled=${inside + outside} totalVoxels=${n}`,
        )
    }
}
