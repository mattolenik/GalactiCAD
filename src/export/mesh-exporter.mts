/**
 * Shared mesh-exporter contract.
 *
 * Each mesh exporter (`mdc`, `shrec`, `isoSimplicial`, `sfcc-rs`) is a
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
 * - `"sfcc-rs"`: stratified feature-conforming contouring — symbolic CSG features
 *   + certified primal octree meshing — running in the gcad-wasm Rust kernel across
 *   the WASM boundary (`src/export/sfcc-rs/`). The default exporter.
 */
export type ExporterKind = "mdc" | "shrec" | "isoSimplicial" | "sfcc-rs"

/** All exporter kinds, in dropdown order. */
export const EXPORTER_KINDS = ["mdc", "shrec", "isoSimplicial", "sfcc-rs"] as const satisfies readonly ExporterKind[]

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
    /**
     * Optional sink for live phase-progress ticks during a long export. Exporters that
     * can report sub-phases (currently only sfcc-rs, via the wasm callback) call this at
     * each phase boundary; the worker forwards it to the main thread for the export
     * indicator. Exporters that can't report progress simply omit it.
     */
    onProgress?: (p: ExportProgress) => void
    /**
     * Optional user-cancel flag — `Int32Array` slot 0 goes nonzero when the user clicks
     * Cancel (written by the main thread to a `SharedArrayBuffer` shared with the worker).
     * A cancellable exporter polls it during long work and, on cancel, throws
     * [`MeshExportCancelledError`]. Absent when shared memory is unavailable.
     */
    cancelFlag?: Int32Array
}

/** Thrown by an exporter when the user cancelled the export (vs. a real failure or a
 *  newer export superseding this one). The worker reports it back as a cancelled result. */
export class MeshExportCancelledError extends Error {
    constructor() {
        super("Mesh export cancelled")
        this.name = "MeshExportCancelledError"
    }
}

/** One live phase-progress tick emitted during a mesh export. */
export interface ExportProgress {
    /** 0-based index of the phase now starting; equals `totalPhases` on the terminal "done" tick. */
    phaseIndex: number
    /** Human-readable phase label, e.g. "Building octree". */
    phase: string
    /** Total number of timed phases (so a bar can show `phaseIndex / totalPhases`). */
    totalPhases: number
    /** Milliseconds elapsed since this export started. */
    elapsedMs: number
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
