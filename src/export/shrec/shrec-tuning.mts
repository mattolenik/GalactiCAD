/**
 * SHREC exporter tuning — the light half of the SHREC exporter (type + default
 * + normalizer + display name), safe to import from main-thread code without
 * pulling in the GPU `ShrecExport`. The `run` and the assembled
 * {@link MeshExporter} object live in `../shrec.mts`.
 *
 * Mirrors the merge-related subset of `ShrecParams`; grid-sizing fields stay
 * computed in the worker.
 */
import { DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM } from "../mesh-exporter.mjs"

export const SHREC_DISPLAY_NAME = "SHREC"

export interface ShrecTuning {
    /** Whether to run the MergeSharp relocation pass. When false, plain DC mass-point output is returned. */
    mergeSharpEnabled: boolean
    /** Singular-value cutoff for the rank-aware QEF pseudo-inverse (fraction of largest eigenvalue). Smaller → more vertices snap to features. */
    mergeRelCutoff: number
    /** Optional extra clamp on per-vertex displacement (mm), in addition to the always-on cell-bounds clamp. `0` disables this extra clamp. */
    mergeMaxDisplacement: number
    /**
     * Crease angle threshold in degrees for the post-relocation vertex split.
     * 180 disables splitting; 0 makes every triangle its own face; `< 0` skips
     * the crease-split pass entirely. Default 30.
     */
    creaseAngleDeg: number
    /** Enable the seam-aware QEF path (1D constrained least-squares along coherent CSG seam lines). */
    seamAwareEnabled: boolean
    /** Cosine of the per-cell tangent-agreement threshold the seam-aware path uses. Default `0.97` ≈ `cos(15°)`. */
    seamAgreementCosThreshold: number
    /** Run the post-MergeSharp chain Laplacian smoothing for rank-2 pseudo-inverse cells. */
    edgeFitEnabled: boolean
    /** Vertex deduplication radius as a fraction of `voxelSize`, applied after MergeSharp relocation. `0` skips the dedup pass. */
    dedupRadiusVoxels: number
    /** Exponent applied to the SDF gradient magnitude when weighting each cube-edge crossing in the QEF. `0` = uniform. */
    mergeGradientWeightPower: number
    /** Project MergeSharp QEF Hermite crossings onto explicit / inferred feature loci when the cell has one iso component. */
    featureConstrainedPlacement: boolean
    /** Feed SHREC's snap pass from the FeatureGraph (CSG-survival-aware) instead of the legacy `accumulateContours` walk. */
    featureGraphContours: boolean
    /** Voxel edge length in world units (mm). SHREC's own value; independent of MDC. */
    voxelSizeMm: number
}

export const DEFAULT_SHREC_TUNING: ShrecTuning = {
    mergeSharpEnabled: true,
    mergeRelCutoff: 0.05,
    mergeMaxDisplacement: 0,
    creaseAngleDeg: 30,
    mergeGradientWeightPower: 0,
    dedupRadiusVoxels: 0,
    seamAwareEnabled: true,
    seamAgreementCosThreshold: 0.97,
    edgeFitEnabled: false,
    featureConstrainedPlacement: true,
    featureGraphContours: true,
    voxelSizeMm: DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
}

/** Validate/clamp persisted SHREC tuning into a full {@link ShrecTuning}. */
export function normalizeShrecTuning(raw: unknown): ShrecTuning {
    const d = DEFAULT_SHREC_TUNING
    const t = raw && typeof raw === "object" ? (raw as Partial<ShrecTuning>) : {}
    const cur = { ...d, ...t }
    if (typeof cur.mergeSharpEnabled !== "boolean") cur.mergeSharpEnabled = d.mergeSharpEnabled
    if (typeof cur.mergeRelCutoff !== "number" || !isFinite(cur.mergeRelCutoff)) cur.mergeRelCutoff = d.mergeRelCutoff
    if (typeof cur.mergeMaxDisplacement !== "number" || !isFinite(cur.mergeMaxDisplacement) || cur.mergeMaxDisplacement < 0) {
        cur.mergeMaxDisplacement = d.mergeMaxDisplacement
    }
    if (typeof cur.creaseAngleDeg !== "number" || !isFinite(cur.creaseAngleDeg) || cur.creaseAngleDeg < -1 || cur.creaseAngleDeg > 180) {
        cur.creaseAngleDeg = d.creaseAngleDeg
    }
    if (typeof cur.mergeGradientWeightPower !== "number" || !isFinite(cur.mergeGradientWeightPower) || cur.mergeGradientWeightPower < 0) {
        cur.mergeGradientWeightPower = d.mergeGradientWeightPower
    }
    if (typeof cur.dedupRadiusVoxels !== "number" || !isFinite(cur.dedupRadiusVoxels) || cur.dedupRadiusVoxels < 0) {
        cur.dedupRadiusVoxels = d.dedupRadiusVoxels
    }
    if (typeof cur.seamAwareEnabled !== "boolean") cur.seamAwareEnabled = d.seamAwareEnabled
    if (
        typeof cur.seamAgreementCosThreshold !== "number" ||
        !isFinite(cur.seamAgreementCosThreshold) ||
        cur.seamAgreementCosThreshold < 0 ||
        cur.seamAgreementCosThreshold > 1
    ) {
        cur.seamAgreementCosThreshold = d.seamAgreementCosThreshold
    }
    if (typeof cur.edgeFitEnabled !== "boolean") cur.edgeFitEnabled = d.edgeFitEnabled
    if (typeof cur.featureConstrainedPlacement !== "boolean") cur.featureConstrainedPlacement = d.featureConstrainedPlacement
    if (typeof cur.featureGraphContours !== "boolean") cur.featureGraphContours = d.featureGraphContours
    if (typeof cur.voxelSizeMm !== "number" || !isFinite(cur.voxelSizeMm) || cur.voxelSizeMm <= 0) {
        cur.voxelSizeMm = d.voxelSizeMm
    }
    return cur
}
