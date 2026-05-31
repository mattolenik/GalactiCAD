/**
 * MDC exporter tuning — the light half of the MDC exporter (type + default +
 * normalizer + display name), safe to import from main-thread code (settings,
 * dev-tools UI) without pulling in the GPU `MDCExport`. The `run` and the
 * assembled {@link MeshExporter} object live in `./mdc.mts`.
 *
 * Formerly `MdcExportLevers` in `render-worker-protocol.mts`.
 */
import { DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM } from "./mesh-exporter.mjs"

export const MDC_DISPLAY_NAME = "MDC"

/**
 * High-impact MDC mesh-export knobs exposed in Dev Tools and persisted in
 * global settings; passed to the worker on each `renderMesh` request.
 */
export interface MdcTuning {
    /** Voxel edge length in world units (mm). Smaller = finer mesh. */
    voxelSizeMm: number
    /** Isosurface level of the SDF; 0 is the nominal surface. */
    isoValue: number
    /** Crease angle (degrees) for vertex splitting; 180 disables; negative values skip the pass. */
    creaseAngleDeg: number
    /** Constrain MDC vertices onto explicit mid-tier line/corner/seam/ring feature loci. */
    featureConstrainedPlacement: boolean
    /** Fraction of triangles to keep after simplification (must be < 1 to simplify). */
    simplifyTargetRatio: number
    /** Max geometric error for simplifier (relative unless `simplifyErrorAbsolute` is set in worker). */
    simplifyTargetError: number
    /** Normal-aware simplification weight; 0 = position only. */
    simplifyNormalWeight: number
    /** Meshoptimizer regularize flag. */
    simplifyRegularize: boolean
}

export const DEFAULT_MDC_TUNING: MdcTuning = {
    voxelSizeMm: DEFAULT_MESH_EXPORT_VOXEL_SIZE_MM,
    isoValue: 0,
    creaseAngleDeg: 30,
    featureConstrainedPlacement: true,
    simplifyTargetRatio: 0.1,
    simplifyTargetError: 0.001,
    simplifyNormalWeight: 0,
    simplifyRegularize: false,
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback
    return Math.min(hi, Math.max(lo, v))
}

/** Validate/clamp persisted MDC tuning into a full {@link MdcTuning}. */
export function normalizeMdcTuning(raw: unknown): MdcTuning {
    const d = DEFAULT_MDC_TUNING
    const o = raw && typeof raw === "object" ? (raw as Partial<MdcTuning>) : {}
    return {
        voxelSizeMm: clampNumber(o.voxelSizeMm, 0.02, 1.0, d.voxelSizeMm),
        isoValue: clampNumber(o.isoValue, -0.5, 0.5, d.isoValue),
        creaseAngleDeg: clampNumber(o.creaseAngleDeg, -1, 180, d.creaseAngleDeg),
        featureConstrainedPlacement:
            typeof o.featureConstrainedPlacement === "boolean"
                ? o.featureConstrainedPlacement
                : typeof (o as { hermiteEdgeRefine?: unknown }).hermiteEdgeRefine === "boolean"
                  ? (o as { hermiteEdgeRefine: boolean }).hermiteEdgeRefine
                  : d.featureConstrainedPlacement,
        simplifyTargetRatio: clampNumber(o.simplifyTargetRatio, 0.01, 1, d.simplifyTargetRatio),
        simplifyTargetError: clampNumber(o.simplifyTargetError, 0, 0.1, d.simplifyTargetError),
        simplifyNormalWeight: clampNumber(o.simplifyNormalWeight, 0, 8, d.simplifyNormalWeight),
        simplifyRegularize: typeof o.simplifyRegularize === "boolean" ? o.simplifyRegularize : d.simplifyRegularize,
    }
}
