/**
 * Iso-simplicial exporter tuning — the light half of the exporter (type +
 * default + normalizer + display name), safe to import from main-thread code
 * without pulling in the GPU octree pipeline. The `run` and the assembled
 * {@link MeshExporter} object live in `./iso-exporter.mts`.
 *
 * Optional overrides for the iso-simplicial export (`IsoSimplicialConstants` in
 * `./constants.mts`). Omitted fields use frozen defaults.
 */

export const ISO_SIMPLICIAL_DISPLAY_NAME = "Iso-simplicial"

/** Padding (mm) added to refined scene bounds when sizing the iso-simplicial sampling cube. */
export const DEFAULT_ISO_SIMPLICIAL_BOUNDS_PADDING_MM = 3.2

export interface IsoSimplicialTuning {
    depthMin?: number
    depthMax?: number
    oversampleQef?: number
    dualVertexBorderFraction?: number
    findRootDepth?: number
    qefRelativeErrorRefineThreshold?: number
    /** When true, run async Phase 5 GPU bisection on MT edge crossings. When false, linear edge intersection only. */
    phase5Snap?: boolean
    /** Extra margin (mm) applied symmetrically when expanding refined scene bounds into the iso-simplicial world cube. */
    boundingBoxPaddingMm?: number
    /**
     * Feature-aware subdivision (Path I — explicit primitive features from `sceneSDF_mid`).
     * - `"off"` (default): subdivision uses only `isbig`/`signchange`/`badqef`.
     * - `"signchangeGated"`: additionally subdivide cells where `signchange && !badqef` and any of
     *   the cell's 8 corners are within {@link featureRefineProximityFactor} cell-widths of a feature.
     */
    featureRefineMode?: "off" | "signchangeGated"
    /** Proximity threshold for `featureRefineMode === "signchangeGated"`. Default 2.0. */
    featureRefineProximityFactor?: number
    /** Augment the cube-QEF normal equations with extra Hermite planes from inherited `SDFResultMid`. Default `false`. */
    featurePlaneEnabled?: boolean
    /** Distance gate for `featurePlaneEnabled` (world units factor of cell size). Default 1.0. */
    featurePlaneDistFactor?: number
    /** Inject FeatureGraph corners + creases as additional Hermite planes in the per-cell QEF. Default `false`. */
    featureGraphPlanesEnabled?: boolean
    /** Distance gate for `featureGraphPlanesEnabled`. Default 0 — inject an FG feature only into cells it passes through. */
    featureGraphPlaneDistFactor?: number
    /** Also inject FG planes into the sub-dimensional edge & face QEFs, not just the cube QEF. Default false. */
    featureGraphEdgeFacePlanes?: boolean
}

/** Default iso-simplicial tuning: all fields omitted → worker uses `IsoSimplicialConstants`. */
export const DEFAULT_ISO_SIMPLICIAL_TUNING: IsoSimplicialTuning = {}

/** Validate/clamp persisted iso-simplicial overrides (depth clamps, finite checks). */
export function normalizeIsoSimplicialTuning(raw: unknown): IsoSimplicialTuning {
    const out: IsoSimplicialTuning = {}
    if (!raw || typeof raw !== "object") return out
    const o = raw as Record<string, unknown>
    if (typeof o.phase5Snap === "boolean") out.phase5Snap = o.phase5Snap
    const clampDepth = (v: unknown): number | undefined => {
        if (typeof v !== "number" || !Number.isFinite(v)) return undefined
        return Math.min(16, Math.max(1, Math.round(v)))
    }
    const dMin = clampDepth(o.depthMin)
    const dMax = clampDepth(o.depthMax)
    if (dMin !== undefined) out.depthMin = dMin
    if (dMax !== undefined) out.depthMax = dMax
    if (out.depthMin !== undefined && out.depthMax !== undefined && out.depthMin > out.depthMax) {
        const t = out.depthMin
        out.depthMin = out.depthMax
        out.depthMax = t
    }
    if (typeof o.oversampleQef === "number" && Number.isFinite(o.oversampleQef) && o.oversampleQef >= 1 && o.oversampleQef <= 8) {
        out.oversampleQef = Math.round(o.oversampleQef)
    }
    if (typeof o.dualVertexBorderFraction === "number" && Number.isFinite(o.dualVertexBorderFraction) && o.dualVertexBorderFraction > 0 && o.dualVertexBorderFraction <= 0.5) {
        out.dualVertexBorderFraction = o.dualVertexBorderFraction
    }
    if (typeof o.findRootDepth === "number" && Number.isFinite(o.findRootDepth) && o.findRootDepth >= 0 && o.findRootDepth <= 24) {
        out.findRootDepth = Math.round(o.findRootDepth)
    }
    if (typeof o.qefRelativeErrorRefineThreshold === "number" && Number.isFinite(o.qefRelativeErrorRefineThreshold) && o.qefRelativeErrorRefineThreshold > 0) {
        out.qefRelativeErrorRefineThreshold = o.qefRelativeErrorRefineThreshold
    }
    if (typeof o.boundingBoxPaddingMm === "number" && Number.isFinite(o.boundingBoxPaddingMm) && o.boundingBoxPaddingMm >= 0 && o.boundingBoxPaddingMm <= 100) {
        out.boundingBoxPaddingMm = o.boundingBoxPaddingMm
    }
    if (o.featureRefineMode === "off" || o.featureRefineMode === "signchangeGated") {
        out.featureRefineMode = o.featureRefineMode
    }
    if (
        typeof o.featureRefineProximityFactor === "number" &&
        Number.isFinite(o.featureRefineProximityFactor) &&
        o.featureRefineProximityFactor > 0 &&
        o.featureRefineProximityFactor <= 16
    ) {
        out.featureRefineProximityFactor = o.featureRefineProximityFactor
    }
    if (typeof o.featurePlaneEnabled === "boolean") {
        out.featurePlaneEnabled = o.featurePlaneEnabled
    }
    if (
        typeof o.featurePlaneDistFactor === "number" &&
        Number.isFinite(o.featurePlaneDistFactor) &&
        o.featurePlaneDistFactor > 0 &&
        o.featurePlaneDistFactor <= 16
    ) {
        out.featurePlaneDistFactor = o.featurePlaneDistFactor
    }
    if (typeof o.featureGraphPlanesEnabled === "boolean") {
        out.featureGraphPlanesEnabled = o.featureGraphPlanesEnabled
    }
    if (
        typeof o.featureGraphPlaneDistFactor === "number" &&
        Number.isFinite(o.featureGraphPlaneDistFactor) &&
        o.featureGraphPlaneDistFactor >= 0 &&
        o.featureGraphPlaneDistFactor <= 16
    ) {
        out.featureGraphPlaneDistFactor = o.featureGraphPlaneDistFactor
    }
    if (typeof o.featureGraphEdgeFacePlanes === "boolean") {
        out.featureGraphEdgeFacePlanes = o.featureGraphEdgeFacePlanes
    }
    return out
}
