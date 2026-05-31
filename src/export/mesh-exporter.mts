/**
 * Shared mesh-exporter contract.
 *
 * Each mesh exporter (`mdc`, `shrec`, `isoSimplicial`, `flexicubes`) is a
 * cohesive unit that owns its own tuning type, defaults, normalization, and
 * export logic, and implements {@link MeshExporter}. The worker hands every
 * exporter a {@link MeshExportContext} so its `run` never reaches into
 * `render-worker-core` internals. The single wiring point that assembles the
 * four implementations lives in `src/export/exporters.mts`.
 *
 * This module is deliberately runtime-light (only `import type`s of GPU/scene
 * classes) so the main thread can reference {@link ExporterKind} without
 * pulling any WebGPU export code into its bundle.
 */

import type { GPUHelper } from "../gpu/helper.mjs"
import type { SceneInfo } from "../scene/scene.mjs"
import type { ShaderCompiler } from "../shaders/shader.mjs"
import type { FeatureGraphBuildResult } from "../feature-graph/feature-graph-gpu.mjs"
import type { MeshData } from "./export.mjs"

/**
 * Selects which algorithm `handleRenderMesh` uses to extract a triangle mesh
 * from the scene SDF. Each member is implemented by a self-contained exporter
 * module; see `src/export/exporters.mts` for the wiring.
 *
 * - `"mdc"`: Manifold Dual Contouring on the GPU (`src/export/mdc.mts`).
 * - `"shrec"`: GPU grid samples + CPU dual contouring / MergeSharp
 *   (`src/export/shrec.mts`).
 * - `"isoSimplicial"`: GPU batched samples + CPU adaptive octree / Marching
 *   Tetrahedra (`src/export/iso-simplicial/`).
 * - `"flexicubes"`: GPU grid samples + CPU FlexiCubes dual extraction
 *   (`src/export/flexicubes.mts`).
 */
export type ExporterKind = "mdc" | "shrec" | "isoSimplicial" | "flexicubes"

/** All exporter kinds, in dropdown order. */
export const EXPORTER_KINDS = ["mdc", "shrec", "isoSimplicial", "flexicubes"] as const satisfies readonly ExporterKind[]

/** Type guard for a persisted/incoming exporter kind. */
export function isValidExporter(v: unknown): v is ExporterKind {
    return typeof v === "string" && (EXPORTER_KINDS as readonly string[]).includes(v)
}

/**
 * Default world-space voxel edge length (mm) used as the seed for each grid
 * exporter's per-tuning `voxelSizeMm` default, and as the worker's last-resort
 * fallback. Halving it → 8× more voxels (≈8× time/memory); doubling → 8×
 * cheaper but blockier corners.
 */
export const DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM = 0.5

/** Uniform grid sizing derived from a voxel size; see {@link MeshExportContext.computeUniformGrid}. */
export interface UniformGrid {
    gridDimX: number
    gridDimY: number
    gridDimZ: number
    gridOffsetX: number
    gridOffsetY: number
    gridOffsetZ: number
}

/** Axis-aligned world-space box. */
export interface WorldBox {
    min: [number, number, number]
    max: [number, number, number]
}

/**
 * Everything the worker provides to an exporter's `run`. The exporter sizes its
 * own grid (`computeUniformGrid`) or octree (`worldBoundsCube`) from its own
 * tuning — nothing outside an exporter needs to know its voxel size.
 */
export interface MeshExportContext {
    device: GPUDevice
    helper: GPUHelper
    uniformBuffers: {
        polygonVertices: GPUBuffer
        faceSelection: GPUBuffer
        mdcSceneParams: GPUBuffer
    }
    scene: SceneInfo
    /** Padded scene bounds (mm) used to size the sampling region. */
    bounds: WorldBox
    /** Smallest axis-aligned cube enclosing {@link bounds}; used by the iso octree. */
    worldBoundsCube(): WorldBox
    /** Uniform grid dims + offsets for a uniform-grid exporter at the given voxel size. */
    computeUniformGrid(voxelSizeMm: number): UniformGrid
    /** Build (or reuse) the survival-aware FeatureGraph at the given cell size. */
    buildFeatureGraph(scene: SceneInfo, cellSizeMm: number): Promise<FeatureGraphBuildResult | null>
    /** A `ShaderCompiler` pre-loaded with every standard `//:) insert <scene*>` substitution. */
    makeSceneCompiler(): ShaderCompiler
    /** Aborted when a newer export supersedes this one; thread it through long-running work. */
    signal: AbortSignal
}

/**
 * A self-contained mesh exporter. The light pieces (`displayName`,
 * `defaultTuning`, `normalizeTuning`) are also re-exported from the exporter's
 * `*-tuning.mts` so main-thread code can import them without the GPU `run`.
 */
export interface MeshExporter<T> {
    /** Dev Tools dropdown label. */
    readonly displayName: string
    readonly defaultTuning: T
    /** Validate/clamp a persisted-or-incoming partial tuning into a full one. */
    normalizeTuning(raw: unknown): T
    /** Extract a mesh. Sizes its own grid/octree from `tuning`; honors `ctx.signal`. */
    run(ctx: MeshExportContext, tuning: T): Promise<MeshData>
}
