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
    /** Fold authoritative FeatureGraph corners/creases into the per-cell QEF as extra constraints. Default true. */
    featureConstrainedPlacement: boolean
    /** Feature-vs-surface constraint strength in the QEF (scale-invariant). Higher → harder features. Default 4. */
    featureWeight: number
    /** SDF-validation tolerance for accepting a feature, as a fraction of voxel size. Lower → fewer/more-confident snaps; higher → catches more. Default 0.75. */
    featureValidationTol: number
}

export const DEFAULT_FLEXICUBES_TUNING: FlexiCubesTuning = {
    voxelSizeMm: DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
    isoValue: 0,
    creaseAngleDeg: 30,
    qefRelCutoff: 0.1,
    featureConstrainedPlacement: true,
    featureWeight: 4,
    featureValidationTol: 0.75,
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
    if (typeof cur.featureConstrainedPlacement !== "boolean") {
        cur.featureConstrainedPlacement = d.featureConstrainedPlacement
    }
    if (typeof cur.featureWeight !== "number" || !isFinite(cur.featureWeight) || cur.featureWeight < 0 || cur.featureWeight > 64) {
        cur.featureWeight = d.featureWeight
    }
    if (typeof cur.featureValidationTol !== "number" || !isFinite(cur.featureValidationTol) || cur.featureValidationTol < 0 || cur.featureValidationTol > 2) {
        cur.featureValidationTol = d.featureValidationTol
    }
    return cur
}
