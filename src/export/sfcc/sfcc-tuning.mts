/**
 * SFCC exporter tuning — the light half of the exporter (type + defaults +
 * normalizer + display name), safe to import from main-thread code without
 * pulling in the meshing pipeline. The `run` and the assembled `MeshExporter`
 * object live in `../sfcc-rs/sfcc-rs-exporter.mts`.
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
    /** Normal refinement ceiling; unresolved sheet handling can use up to two extra levels (capped at 14). */
    depthMax: number
    /** Padding (mm) added to refined scene bounds when sizing the root cube. */
    boundsPaddingMm: number
    /** Enforce 2:1 balance across edge-adjacent (not just face-adjacent) neighbors. */
    enforceEdgeBalance: boolean

    // --- Refinement certificates -------------------------------------------
    /**
     * Max surface-normal variation (deg) across an analytic-stratum cell before
     * it splits (lower = smoother primitives: sphere/cylinder/cone/extrude/
     * lathe/loft). This — not `depthMax` — is what makes refinement adaptive on
     * stratum-backed geometry: `depthMax` is only the ceiling a cell reaches
     * once it keeps failing this test, so a loose value leaves smooth cells
     * passing at `depthMin` and `depthMax` has no visible effect. Featureless
     * blend bulges (fillets) have zero strata and are driven by
     * `blendCurvatureDeg` instead, not this knob.
     */
    normalVariationDeg: number
    /** Refine featureless smooth-blend regions (fillets) by their surface curvature. */
    blendCurvatureRefine: boolean
    /** Max surface-normal variation (deg) across a blend cell before it splits (anti-diamond on fillets). */
    blendCurvatureDeg: number
    /**
     * Use the per-stratum κ·cellSize heuristic instead of the sampled normal cone.
     * Cell-edge length is not a certified surface-path bound.
     * Ships OFF by default; only the Rust (`sfcc-rs`) kernel reads it.
     */
    normalVariationAnalytic: boolean
    /** |tangent·faceNormal| below this counts as a tangential face crossing → split. */
    tangentialEpsilon: number
    /** Feature query AABB inflation, in fractions of the cell size. */
    featureQueryInflate: number

    // --- Geometry tolerances ------------------------------------------------
    /** Field-residual target for projection/validation and sampled refinement; not a global distance bound. */
    surfaceTolMm: number
    /** Experimental edge collapse: sampled field-deviation allowance (mm), not a global bound. 0 = off. */
    decimateTolMm: number
    /** Experimental coarse multi-sheet handling; may miss enclosed components. Default off. */
    multiSheetCells: boolean
    /** Max chord deviation (mm) of in-cell feature polylines from the analytic curve. */
    curveChordTolMm: number
    /** Flank-probe offset for seam trimming, in multiples of surfaceTolMm. */
    probeDeltaFactor: number
    /** Seam tracer bails (with a diagnostic) when carrier gradients are within this angle (deg) of parallel. */
    minTangencyAngleDeg: number
    /** Corner merge tolerance, as a fraction of the scene diagonal. */
    cornerMergeTolDiagFraction: number
    /** Seam seed grid cell size (mm); 0 = auto from pair-overlap size. */
    seedCellSizeMm: number
    /** Hard cap on predictor–corrector steps per traced seam curve. */
    maxTraceSteps: number

    // --- Meshing ------------------------------------------------------------
    /** Edge root tolerance as a fraction of the finest lattice spacing (up to depthMax + 2). */
    edgeRootTolFraction: number
    /** Cap on sampled feature-polyline points per cell. */
    maxPolylinePointsPerCell: number
    /** Interior vertex placement for disk triangulation. */
    interiorVertexMode: "project" | "centroid" | "fan"
    /** Experimental construction stages; defaults stay off until real-scene acceptance. */
    qualityTriangulation: boolean
    /** Adds final triangle-quality measurements; does not establish complete mesh acceptance. */
    qualityAudit: boolean
    qualityRefinement: boolean
    qualityRemeshing: boolean
    qualityMaxEditTrials: number
    /** Newton iterations for projecting interior vertices onto the surface. */
    projectMaxIters: number
    /**
     * Lipschitz pre-cull for hidden-arc recovery: before the SUBDIV detection
     * scan, one carrier eval at the sub-edge midpoint skips the whole scan when
     * the carrier provably can't reach zero on the edge (|st.f(mid)| >
     * halfLen·gradBound — the same Lipschitz bound the octree's certified-empty
     * cull uses). Sound ⇒ byte-identical (only skips scans that find nothing);
     * 96% of recovery scans find nothing on twisted scenes, so this is the main
     * `recoveredCrossingsFor` lever. Off restores the exhaustive scan.
     */
    recoveryCull: boolean

    // --- Driver ---------------------------------------------------------------
    /** Max global re-runs with forced splits after loop failures or initial feature fallbacks. */
    reRefineMaxRounds: number
    /** Verify each vertex fan is a single cycle (default on). Disabling leaves validation incomplete. */
    checkVertexLinks: boolean
}

/** Checked against native PipelineTuning::default() by the shared defaults fixture tests. */
export const DEFAULT_SFCC_TUNING: SfccTuning = {
    depthMin: 5,
    depthMax: 8,
    boundsPaddingMm: 2.0,
    enforceEdgeBalance: true,

    normalVariationDeg: 18,
    blendCurvatureRefine: true,
    blendCurvatureDeg: 18,
    normalVariationAnalytic: false,
    tangentialEpsilon: 0.05,
    featureQueryInflate: 0.25,

    surfaceTolMm: 0.01,
    decimateTolMm: 0,
    multiSheetCells: false,
    curveChordTolMm: 0.02,
    probeDeltaFactor: 10,
    minTangencyAngleDeg: 2,
    cornerMergeTolDiagFraction: 1e-6,
    seedCellSizeMm: 0,
    maxTraceSteps: 20000,

    edgeRootTolFraction: 1e-3,
    maxPolylinePointsPerCell: 16,
    interiorVertexMode: "project",
    qualityTriangulation: false,
    qualityAudit: false,
    qualityRefinement: false,
    qualityRemeshing: false,
    qualityMaxEditTrials: 10_000,
    projectMaxIters: 8,
    recoveryCull: true,

    reRefineMaxRounds: 2,
    checkVertexLinks: true,
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

        normalVariationDeg: num(o.normalVariationDeg, d.normalVariationDeg, 1, 90),
        blendCurvatureRefine: bool(o.blendCurvatureRefine, d.blendCurvatureRefine),
        blendCurvatureDeg: num(o.blendCurvatureDeg, d.blendCurvatureDeg, 1, 90),
        normalVariationAnalytic: bool(o.normalVariationAnalytic, d.normalVariationAnalytic),
        tangentialEpsilon: num(o.tangentialEpsilon, d.tangentialEpsilon, 0, 1),
        featureQueryInflate: num(o.featureQueryInflate, d.featureQueryInflate, 0, 4),

        surfaceTolMm: num(o.surfaceTolMm, d.surfaceTolMm, 1e-6, 10),
        decimateTolMm: num(o.decimateTolMm, d.decimateTolMm, 0, 10),
        multiSheetCells: bool(o.multiSheetCells, d.multiSheetCells),
        curveChordTolMm: num(o.curveChordTolMm, d.curveChordTolMm, 1e-6, 10),
        probeDeltaFactor: num(o.probeDeltaFactor, d.probeDeltaFactor, 1, 1000),
        minTangencyAngleDeg: num(o.minTangencyAngleDeg, d.minTangencyAngleDeg, 0.01, 45),
        cornerMergeTolDiagFraction: num(o.cornerMergeTolDiagFraction, d.cornerMergeTolDiagFraction, 1e-12, 1e-2),
        seedCellSizeMm: num(o.seedCellSizeMm, d.seedCellSizeMm, 0, 1000),
        maxTraceSteps: num(o.maxTraceSteps, d.maxTraceSteps, 100, 1_000_000, true),

        edgeRootTolFraction: num(o.edgeRootTolFraction, d.edgeRootTolFraction, 1e-9, 0.5),
        maxPolylinePointsPerCell: num(o.maxPolylinePointsPerCell, d.maxPolylinePointsPerCell, 2, 256, true),
        interiorVertexMode:
            o.interiorVertexMode === "project" || o.interiorVertexMode === "centroid" || o.interiorVertexMode === "fan"
                ? o.interiorVertexMode
                : d.interiorVertexMode,
        projectMaxIters: num(o.projectMaxIters, d.projectMaxIters, 0, 64, true),
        recoveryCull: bool(o.recoveryCull, d.recoveryCull),

        reRefineMaxRounds: num(o.reRefineMaxRounds, d.reRefineMaxRounds, 0, 10, true),
        checkVertexLinks: bool(o.checkVertexLinks, d.checkVertexLinks),
        qualityTriangulation: bool(o.qualityTriangulation, d.qualityTriangulation),
        qualityAudit: bool(o.qualityAudit, d.qualityAudit),
        qualityRefinement: bool(o.qualityRefinement, d.qualityRefinement),
        qualityRemeshing: bool(o.qualityRemeshing, d.qualityRemeshing),
        qualityMaxEditTrials: num(o.qualityMaxEditTrials, d.qualityMaxEditTrials, 0, 100_000, true),
    }
    if (out.depthMin > out.depthMax) {
        const t = out.depthMin
        out.depthMin = out.depthMax
        out.depthMax = t
    }
    return out
}
