/**
 * FlexiCubes exporter tuning — the light half of the FlexiCubes exporter (type
 * + default + normalizer + display name), safe to import from main-thread code
 * without pulling in the GPU `FlexiCubesExport`. The `run` and the assembled
 * {@link MeshExporter} object live in `../flexicubes.mts`.
 *
 * Subset of `FlexiCubesParams`; grid-sizing fields stay computed in the worker.
 * Non-ML mode only (QEF-based vertex placement from analytic SDF gradients).
 */
import { DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM } from "../mesh-exporter.mjs"

export const FLEXICUBES_DISPLAY_NAME = "FlexiCubes"

export interface FlexiCubesTuning {
    /** Voxel edge length in world units (mm). FlexiCubes's own value; independent of MDC/SHREC. */
    voxelSizeMm: number
    /** Isosurface level of the SDF; 0 is the nominal surface. */
    isoValue: number
    /** Crease angle (degrees) for the post-extraction normal derivation / vertex split. 180 disables; < 0 skips. Default 30. */
    creaseAngleDeg: number
    /** QEF singular-value cutoff as a fraction of the largest eigenvalue. Smaller → sharper features. Default 0.1. */
    qefRelCutoff: number
}

export const DEFAULT_FLEXICUBES_TUNING: FlexiCubesTuning = {
    voxelSizeMm: DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
    isoValue: 0,
    creaseAngleDeg: 30,
    qefRelCutoff: 0.1,
}

/** Validate/clamp persisted FlexiCubes tuning into a full {@link FlexiCubesTuning}. */
export function normalizeFlexiCubesTuning(raw: unknown): FlexiCubesTuning {
    const d = DEFAULT_FLEXICUBES_TUNING
    const t = raw && typeof raw === "object" ? (raw as Partial<FlexiCubesTuning>) : {}
    const cur = { ...d, ...t }
    if (typeof cur.voxelSizeMm !== "number" || !isFinite(cur.voxelSizeMm) || cur.voxelSizeMm <= 0) {
        cur.voxelSizeMm = d.voxelSizeMm
    }
    if (typeof cur.isoValue !== "number" || !isFinite(cur.isoValue)) cur.isoValue = d.isoValue
    if (typeof cur.creaseAngleDeg !== "number" || !isFinite(cur.creaseAngleDeg) || cur.creaseAngleDeg < -1 || cur.creaseAngleDeg > 180) {
        cur.creaseAngleDeg = d.creaseAngleDeg
    }
    if (typeof cur.qefRelCutoff !== "number" || !isFinite(cur.qefRelCutoff) || cur.qefRelCutoff < 0) {
        cur.qefRelCutoff = d.qefRelCutoff
    }
    return cur
}
