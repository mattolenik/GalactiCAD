/**
 * SFCC exporter tuning — the light half of the exporter (type + defaults +
 * normalizer + display name), safe to import from main-thread code without
 * pulling in the meshing pipeline. The `run` and the assembled `MeshExporter`
 * object live in `./sfcc-exporter.mts`.
 *
 * SFCC (Stratified Feature-Conforming Contouring) is a CPU-side primal
 * contouring method driven by symbolic CSG features; see
 * `docs/research/sfcc-algorithm-design.md`.
 */

export const SFCC_DISPLAY_NAME = "SFCC"

export interface SfccTuning {
    // --- Octree -----------------------------------------------------------
    /** Minimum octree depth (uniform refinement floor). */
    depthMin: number
    /** Maximum octree depth; cells still failing certificates here are tagged degenerate. */
    depthMax: number
    /** Padding (mm) added to refined scene bounds when sizing the root cube. */
    boundsPaddingMm: number
    /** Enforce 2:1 balance across edge-adjacent (not just face-adjacent) neighbors. */
    enforceEdgeBalance: boolean

    // --- Refinement certificates -------------------------------------------
    /** Max surface-normal variation (deg) across an analytic-stratum cell before it splits (lower = smoother primitives). */
    normalVariationDeg: number
    /** Refine featureless smooth-blend regions (fillets) by their surface curvature. */
    blendCurvatureRefine: boolean
    /** Max surface-normal variation (deg) across a blend cell before it splits (anti-diamond on fillets). */
    blendCurvatureDeg: number
    /** |tangent·faceNormal| below this counts as a tangential face crossing → split. */
    tangentialEpsilon: number
    /** Feature query AABB inflation, in fractions of the cell size. */
    featureQueryInflate: number

    // --- Geometry tolerances ------------------------------------------------
    /** Surface accuracy anchor (mm): max |f| at emitted vertices. */
    surfaceTolMm: number
    /** Max chord deviation (mm) of in-cell feature polylines from the analytic curve. */
    curveChordTolMm: number
    /** Flank-probe offset for seam trimming, in multiples of surfaceTolMm. */
    probeDeltaFactor: number
    /** Below this dihedral angle (deg) two strata are not a crease (matches GPU seam threshold). */
    minDihedralDeg: number
    /** Seam tracer bails (with a diagnostic) when carrier gradients are within this angle (deg) of parallel. */
    minTangencyAngleDeg: number
    /** Corner merge tolerance, as a fraction of the scene diagonal. */
    cornerMergeTolDiagFraction: number
    /** Seam seed grid cell size (mm); 0 = auto from pair-overlap size. */
    seedCellSizeMm: number
    /** Hard cap on predictor–corrector steps per traced seam curve. */
    maxTraceSteps: number

    // --- Meshing ------------------------------------------------------------
    /** Edge iso-crossing root tolerance, in fractions of the max-depth cell size. */
    edgeRootTolFraction: number
    /** Snap an edge crossing into a pinned feature point within this fraction of the face size. */
    faceSnapEpsFraction: number
    /** Cap on sampled feature-polyline points per cell. */
    maxPolylinePointsPerCell: number
    /** Interior vertex placement for disk triangulation. */
    interiorVertexMode: "project" | "centroid" | "fan"
    /** Newton iterations for projecting interior vertices onto the surface. */
    projectMaxIters: number
    /** Featureless ambiguous face resolution: sample f at the face center, or refine instead. */
    ambiguityResolution: "centerSample" | "refine"

    // --- Driver ---------------------------------------------------------------
    /** Max global re-runs with forced splits after S4 audit failures. */
    reRefineMaxRounds: number
    /** Max root-cube jitter retries on exact lattice degeneracies. */
    jitterRetries: number
    /** On hard certification failure: return the partial mesh + diagnostics, or throw. */
    failurePolicy: "partial" | "throw"
    /** Crease angle (deg) for the shading vertex-split post-pass. */
    creaseAngleDeg: number
    /** Also verify each vertex's triangle fan is a single cycle in the S4 audit. */
    checkVertexLinks: boolean
    /** Emit debug overlays (feature polylines, face segments, failed cells) in MeshData.debug. */
    debugOutput: boolean
}

export const DEFAULT_SFCC_TUNING: SfccTuning = {
    depthMin: 5,
    depthMax: 8,
    boundsPaddingMm: 2.0,
    enforceEdgeBalance: true,

    normalVariationDeg: 50,
    blendCurvatureRefine: true,
    blendCurvatureDeg: 18,
    tangentialEpsilon: 0.05,
    featureQueryInflate: 0.25,

    surfaceTolMm: 0.01,
    curveChordTolMm: 0.02,
    probeDeltaFactor: 10,
    minDihedralDeg: 15,
    minTangencyAngleDeg: 2,
    cornerMergeTolDiagFraction: 1e-6,
    seedCellSizeMm: 0,
    maxTraceSteps: 20000,

    edgeRootTolFraction: 1e-3,
    faceSnapEpsFraction: 0.05,
    maxPolylinePointsPerCell: 16,
    interiorVertexMode: "project",
    projectMaxIters: 8,
    ambiguityResolution: "centerSample",

    reRefineMaxRounds: 2,
    jitterRetries: 3,
    failurePolicy: "partial",
    creaseAngleDeg: 30,
    checkVertexLinks: false,
    debugOutput: false,
}

/** Hard ceiling on octree depth — lattice keys must stay exact in f64 (see lattice.mts). */
export const SFCC_MAX_DEPTH = 14

function num(v: unknown, def: number, lo: number, hi: number, round = false): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return def
    const c = Math.min(hi, Math.max(lo, v))
    return round ? Math.round(c) : c
}

function bool(v: unknown, def: boolean): boolean {
    return typeof v === "boolean" ? v : def
}

/** Validate/clamp a persisted-or-incoming partial tuning into a full one. */
export function normalizeSfccTuning(raw: unknown): SfccTuning {
    const d = DEFAULT_SFCC_TUNING
    if (!raw || typeof raw !== "object") return { ...d }
    const o = raw as Record<string, unknown>
    const out: SfccTuning = {
        depthMin: num(o.depthMin, d.depthMin, 1, SFCC_MAX_DEPTH, true),
        depthMax: num(o.depthMax, d.depthMax, 1, SFCC_MAX_DEPTH, true),
        boundsPaddingMm: num(o.boundsPaddingMm, d.boundsPaddingMm, 0, 100),
        enforceEdgeBalance: bool(o.enforceEdgeBalance, d.enforceEdgeBalance),

        normalVariationDeg: num(o.normalVariationDeg, d.normalVariationDeg, 5, 90),
        blendCurvatureRefine: bool(o.blendCurvatureRefine, d.blendCurvatureRefine),
        blendCurvatureDeg: num(o.blendCurvatureDeg, d.blendCurvatureDeg, 1, 90),
        tangentialEpsilon: num(o.tangentialEpsilon, d.tangentialEpsilon, 0, 1),
        featureQueryInflate: num(o.featureQueryInflate, d.featureQueryInflate, 0, 4),

        surfaceTolMm: num(o.surfaceTolMm, d.surfaceTolMm, 1e-6, 10),
        curveChordTolMm: num(o.curveChordTolMm, d.curveChordTolMm, 1e-6, 10),
        probeDeltaFactor: num(o.probeDeltaFactor, d.probeDeltaFactor, 1, 1000),
        minDihedralDeg: num(o.minDihedralDeg, d.minDihedralDeg, 0, 90),
        minTangencyAngleDeg: num(o.minTangencyAngleDeg, d.minTangencyAngleDeg, 0.01, 45),
        cornerMergeTolDiagFraction: num(o.cornerMergeTolDiagFraction, d.cornerMergeTolDiagFraction, 1e-12, 1e-2),
        seedCellSizeMm: num(o.seedCellSizeMm, d.seedCellSizeMm, 0, 1000),
        maxTraceSteps: num(o.maxTraceSteps, d.maxTraceSteps, 100, 1_000_000, true),

        edgeRootTolFraction: num(o.edgeRootTolFraction, d.edgeRootTolFraction, 1e-9, 0.5),
        faceSnapEpsFraction: num(o.faceSnapEpsFraction, d.faceSnapEpsFraction, 0, 0.4),
        maxPolylinePointsPerCell: num(o.maxPolylinePointsPerCell, d.maxPolylinePointsPerCell, 2, 256, true),
        interiorVertexMode:
            o.interiorVertexMode === "project" || o.interiorVertexMode === "centroid" || o.interiorVertexMode === "fan"
                ? o.interiorVertexMode
                : d.interiorVertexMode,
        projectMaxIters: num(o.projectMaxIters, d.projectMaxIters, 0, 64, true),
        ambiguityResolution:
            o.ambiguityResolution === "centerSample" || o.ambiguityResolution === "refine"
                ? o.ambiguityResolution
                : d.ambiguityResolution,

        reRefineMaxRounds: num(o.reRefineMaxRounds, d.reRefineMaxRounds, 0, 10, true),
        jitterRetries: num(o.jitterRetries, d.jitterRetries, 0, 10, true),
        failurePolicy: o.failurePolicy === "partial" || o.failurePolicy === "throw" ? o.failurePolicy : d.failurePolicy,
        creaseAngleDeg: num(o.creaseAngleDeg, d.creaseAngleDeg, -1, 180),
        checkVertexLinks: bool(o.checkVertexLinks, d.checkVertexLinks),
        debugOutput: bool(o.debugOutput, d.debugOutput),
    }
    if (out.depthMin > out.depthMax) {
        const t = out.depthMin
        out.depthMin = out.depthMax
        out.depthMax = t
    }
    return out
}
