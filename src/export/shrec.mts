import { GPUHelper } from "../gpu/helper.mjs"
import { log as dbgLog } from "../logging/debug-log.mjs"
import { dualContourCPU } from "./shrec/dc-cpu.mjs"
import { mergeSharpRelocate } from "./shrec/merge-sharp.mjs"
import { deduplicateMergedVertices } from "./shrec/dedup.mjs"
import { ContourSpatialIndex } from "./shrec/contour-snap.mjs"
import { fitSeamEdges } from "./shrec/edge-fit.mjs"
import { splitCreaseVertices } from "./crease-split.mjs"
import type { MeshData } from "./export.mjs"
import type { ProgressCallback } from "./mdc.mjs"
import { GridSampler, type GridSampleResult } from "./grid-sample.mjs"
import type { ContourBufferView } from "../scene/contour-buffer.mjs"

/**
 * Parameters for SHREC / MergeSharp export.
 *
 * Mirrors the grid-defining subset of MDCParams so a single set of UI controls
 * can drive either exporter. The `merge*` knobs tune the MergeSharp vertex
 * relocation stage; defaults are chosen to behave well on typical CAD scenes
 * with `voxelSize ≈ 0.1mm`.
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

    /** Set false to skip the MergeSharp relocation pass (output = plain DC mass-point mesh). Default true. */
    mergeSharpEnabled?: boolean
    /**
     * Singular-value cutoff for the rank-aware QEF pseudo-inverse, expressed
     * as a fraction of the QEF's largest eigenvalue. Smaller → more vertices
     * snap to detected features. Default 0.05.
     */
    mergeRelCutoff?: number
    /**
     * Optional extra clamp on how far a vertex may move from its original DC
     * position (in mm), on top of the always-on cell-bounds clamp. When
     * undefined, only the cell-bounds clamp applies (this is the recommended
     * default — the cell clamp is what preserves DC topology).
     */
    mergeMaxDisplacement?: number
    /**
     * Crease angle threshold (degrees) for the post-pass that re-derives
     * per-vertex normals from triangle face normals and splits vertices at
     * sharp features. Default 30. Set to 180 to keep one smooth group per
     * vertex (still face-derived; eliminates flat-surface banding without
     * splitting any creases). Setting to a value `< 0` skips the pass
     * entirely and keeps the MergeSharp / DC normals.
     */
    creaseAngleDeg?: number
    /**
     * Exponent applied to the SDF gradient magnitude when weighting each
     * cube-edge crossing in the QEF. See `MergeSharpParams.gradientWeightPower`
     * for the full description. Default 0 (uniform weight).
     */
    mergeGradientWeightPower?: number
    /**
     * Vertex deduplication radius (mm). After MergeSharp relocation,
     * vertices within this distance of each other are collapsed into a
     * single shared vertex; degenerate triangles around the merged corner
     * are dropped. Default `0` skips the dedup pass. Typical setting is
     * `0.5 × voxelSize`.
     */
    dedupRadius?: number
    /**
     * Enable the seam-aware QEF path: cells whose corner voxels report a
     * coherent CSG seam tangent are solved with a 1D constrained least-
     * squares along that seam line, rather than the full 3D Tikhonov QEF.
     * Eliminates residual edge-jitter on long sharp CSG edges. See
     * `MergeSharpParams.seamAwareEnabled`. Default `true`.
     */
    seamAwareEnabled?: boolean
    /**
     * Cosine of the per-cell tangent-agreement threshold for the seam-aware
     * path. See `MergeSharpParams.seamAgreementCosThreshold`. Default
     * `cos(15°) ≈ 0.97`.
     */
    seamAgreementCosThreshold?: number
    /**
     * Run the post-MergeSharp line-fit refinement on seam-classified
     * cells. See `fitSeamEdges` in `edge-fit.mts`. Default `true`.
     */
    edgeFitEnabled?: boolean
}

/**
 * Alternate exporter that produces a mesh via SHREC / MergeSharp instead of
 * the integrated GPU MDC pipeline.
 *
 * Pipeline:
 *   1. **GPU** — sample the scene SDF on a uniform 3D grid (scalar + gradient).
 *      See `GridSampler` in `grid-sample.mts`.
 *   2. **CPU** — plain dual contouring (`dc-cpu.mts`) emits one vertex per
 *      active cell at its mass point and one quad per crossing edge.
 *   3. **CPU** — MergeSharp (`merge-sharp.mts`) relocates each vertex onto
 *      the underlying sharp feature using a per-vertex QEF over surrounding
 *      gradient samples, with a rank-aware pseudo-inverse for feature
 *      classification.
 *
 * The constructor signature deliberately matches `MDCExport` so the dispatcher
 * in `render-worker-core.mts` can swap exporters without touching scene-param
 * plumbing.
 */
export class ShrecExport {
    #helper: GPUHelper
    #polygonVerticesBuffer: GPUBuffer
    #faceSelectionBuffer: GPUBuffer
    #mdcSceneParamsBuffer: GPUBuffer
    #contours: ContourBufferView | null

    constructor(
        helper: GPUHelper,
        private params: ShrecParams,
        polygonVerticesBuffer: GPUBuffer,
        faceSelectionBuffer: GPUBuffer,
        mdcSceneParamsBuffer: GPUBuffer,
        contours?: ContourBufferView,
    ) {
        this.#helper = helper
        this.#polygonVerticesBuffer = polygonVerticesBuffer
        this.#faceSelectionBuffer = faceSelectionBuffer
        this.#mdcSceneParamsBuffer = mdcSceneParamsBuffer
        // null short-circuits the spatial-index build and the per-cell snap
        // path when no primitive in the scene contributed any contours.
        this.#contours = contours && (contours.segmentCount + contours.pointCount + contours.ringCount) > 0
            ? contours
            : null
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

        // Print the active tuning at the top of every export so a user moving
        // sliders in Dev Tools can confirm the values are propagating through
        // the renderMesh → worker → ShrecExport chain. If you change a knob
        // and re-export but this line shows the same number, the issue is
        // upstream of ShrecExport (e.g. mesh viewer is off, so no auto-remesh).
        const p = this.params
        dbgLog("ShrecExport").info(
            `ShrecExport.export() params: ` +
            `grid=${p.gridDimX}x${p.gridDimY}x${p.gridDimZ} voxel=${p.voxelSize} ` +
            `mergeSharpEnabled=${p.mergeSharpEnabled ?? true} ` +
            `mergeRelCutoff=${p.mergeRelCutoff ?? 0.05} ` +
            `mergeMaxDisplacement=${p.mergeMaxDisplacement ?? "(off)"} ` +
            `mergeGradientWeightPower=${p.mergeGradientWeightPower ?? 0} ` +
            `dedupRadius=${p.dedupRadius ?? "(off)"} ` +
            `seamAware=${p.seamAwareEnabled ?? true} ` +
            `seamAgreementCos=${p.seamAgreementCosThreshold ?? 0.97} ` +
            `edgeFit=${p.edgeFitEnabled ?? true} ` +
            `creaseAngleDeg=${p.creaseAngleDeg ?? 30}`,
        )

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
        progressCallback?.updateProgress("SHREC: dual contouring on CPU", 40)
        checkCancelled()

        const dcMesh = dualContourCPU(grid, { isoValue: this.params.isoValue })

        const mergeEnabled = this.params.mergeSharpEnabled ?? true
        let mesh: MeshData
        // Captured here so the per-cell debug samples emitted by MergeSharp
        // can be re-attached to the mesh after the dedup/crease passes
        // (those passes don't touch debug data; the records' world-space
        // positions remain meaningful overlays regardless).
        let mergeDebugSamples: Float32Array<ArrayBuffer> | null = null
        let mergeDebugStats: {
            seamSnapped: number
            tikhonovSolved: number
            contourLineSnaps: number
            contourCornerSnaps: number
            vertexCount: number
        } | null = null
        if (mergeEnabled && dcMesh.verts.length > 0) {
            progressCallback?.updateProgress("SHREC: MergeSharp vertex relocation", 60)
            checkCancelled()
            // Build the contour spatial index over the SHREC voxel grid only
            // when the scene actually carries contours. Cheap when present
            // (one Map insertion per cell touched by a contour AABB), free
            // when absent (the constructor stored null).
            const contourIndex = this.#contours
                ? ContourSpatialIndex.build(this.#contours, grid.voxelSize, grid.gridOffset)
                : undefined
            if (contourIndex) {
                dbgLog("ShrecExport").debug(
                    `contour index: segments=${this.#contours!.segmentCount} ` +
                    `points=${this.#contours!.pointCount} ` +
                    `rings=${this.#contours!.ringCount} ` +
                    `nodes=${this.#contours!.nodeRanges.size}`,
                )
            }
            const result = mergeSharpRelocate(dcMesh, grid, {
                relCutoff: this.params.mergeRelCutoff,
                maxDisplacement: this.params.mergeMaxDisplacement,
                gradientWeightPower: this.params.mergeGradientWeightPower,
                seamAwareEnabled: this.params.seamAwareEnabled,
                seamAgreementCosThreshold: this.params.seamAgreementCosThreshold,
                contourIndex,
            })
            mesh = result.mesh
            mergeDebugSamples = result.stats.debugSamples
            mergeDebugStats = {
                seamSnapped: result.stats.seamSnapped,
                tikhonovSolved: result.stats.tikhonovSolved,
                contourLineSnaps: result.stats.contourLineSnaps,
                contourCornerSnaps: result.stats.contourCornerSnaps,
                vertexCount: result.stats.vertexCount,
            }

            // Post-MergeSharp line-fit refinement. Groups topologically-
            // connected seam cells with consistent tangents into chains and
            // projects each chain's vertices onto a single SVD-fitted line.
            // Eliminates per-cell QEF noise that would otherwise leave a
            // long CSG seam very faintly wavy (each cell's pseudo-inverse
            // solve is mathematically right in isolation but small position
            // differences between adjacent cells add up across the seam).
            // The pass also updates the corresponding debug-overlay glyph
            // positions so the visual matches the actual mesh.
            const edgeFitEnabled = this.params.edgeFitEnabled ?? true
            if (edgeFitEnabled && result.stats.seamCellRecords.length > 0) {
                progressCallback?.updateProgress("SHREC: line-fit refinement", 75)
                checkCancelled()
                fitSeamEdges(
                    mesh.verts,
                    mergeDebugSamples,
                    result.stats.seamCellRecords,
                    {
                        chainCosThreshold: this.params.seamAgreementCosThreshold,
                    },
                )
            }
        } else {
            mesh = { verts: dcMesh.verts, tris: dcMesh.tris }
        }

        // Vertex deduplication — the "merge" half of MergeSharp. Collapses
        // adjacent cells' vertices that snapped to the same sharp feature
        // into one shared vertex; runs **before** the crease split so the
        // crease detector sees the cleaned-up topology and computes correct
        // face groups around the merged corners.
        const dedupRadius = this.params.dedupRadius ?? 0
        if (dedupRadius > 0 && mesh.verts.length > 0) {
            progressCallback?.updateProgress("SHREC: vertex deduplication", 80)
            checkCancelled()
            mesh = deduplicateMergedVertices(mesh, dedupRadius).mesh
        }

        // Crease split + face-normal re-derivation. Eliminates flat-surface
        // banding (face normals across a flat surface are identical, so
        // per-vertex averages match across cell boundaries with no
        // interpolation drift) and gives clean per-side normals at sharp
        // features. The same routine MDC uses post-export.
        const creaseAngleDeg = this.params.creaseAngleDeg ?? 30
        if (creaseAngleDeg >= 0 && mesh.verts.length > 0) {
            progressCallback?.updateProgress("SHREC: face-normal re-derivation", 90)
            checkCancelled()
            const beforeVerts = (mesh.verts.length / 8) | 0
            mesh = splitCreaseVertices(mesh.verts, mesh.tris, creaseAngleDeg)
            const afterVerts = (mesh.verts.length / 8) | 0
            dbgLog("ShrecExport").debug(
                `crease-split: ${beforeVerts} → ${afterVerts} verts (+${afterVerts - beforeVerts}, ${creaseAngleDeg}° threshold)`,
            )
        }

        progressCallback?.updateProgress("SHREC: complete", 100)
        const triCount = (mesh.tris.length / 3) | 0
        const vertCount = (mesh.verts.length / 8) | 0
        dbgLog("ShrecExport").info(
            `ShrecExport.export(): emitted ${vertCount} vertices, ${triCount} triangles ` +
            `(MergeSharp ${mergeEnabled ? "applied" : "skipped"}, ` +
            `creaseAngleDeg=${creaseAngleDeg}).`,
        )

        // Attach the per-cell debug samples emitted by MergeSharp into the
        // shared `mesh.debug.mdc` slot — same shape the mesh viewer's
        // existing "Debug" / "Feature glyphs" toggles consume for MDC
        // output. Each record's `klass` field encodes which solve path
        // the cell took (1 = seam-line, 5 = seam-degenerate, 0 = Tikhonov).
        if (mergeDebugSamples && mergeDebugStats) {
            return {
                ...mesh,
                debug: {
                    mdc: {
                        samples: mergeDebugSamples,
                        stats: {
                            totalSamples: mergeDebugStats.vertexCount,
                            // Map SHREC's classification onto the existing
                            // MDC stats fields the HUD already understands:
                            //   acceptedLine   ← contour-line snap (explicit edge feature)
                            //   acceptedCorner ← contour-corner snap (explicit point / intersection)
                            //   acceptedSeam   ← CSG seam (rank-aware pseudo-inverse, sharp 90° edge,
                            //                    klass=3 violet glyph)
                            //   acceptedNone   ← Tikhonov fallback (no seam, no contour)
                            acceptedNone: mergeDebugStats.tikhonovSolved,
                            acceptedLine: mergeDebugStats.contourLineSnaps,
                            acceptedCorner: mergeDebugStats.contourCornerSnaps,
                            acceptedSeam: mergeDebugStats.seamSnapped,
                            acceptedRing: 0,
                            rejected: 0,
                        },
                    },
                },
            }
        }
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
