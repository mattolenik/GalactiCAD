/**
 * Resolved SFCC tolerances: the tuning knobs (mm / factors) turned into the
 * absolute world-space values the pipeline consumes, with scene-diagonal-
 * relative defaults applied. Resolved once per export run.
 */

import type { SfccTuning } from "./sfcc-tuning.mjs"

export interface ResolvedTolerances {
    /** Max |f| at emitted vertices (mm) — the export accuracy anchor. */
    surfaceTol: number
    /** Max chord deviation of feature polylines from the analytic curve (mm). */
    maxChordError: number
    /** Newton on-curve residual (mm): every "exact-on-curve" point satisfies |fA|,|fB| ≤ curveEps. */
    curveEps: number
    /** Flank-probe offset for seam trimming (mm). */
    probeDelta: number
    /** cos(minDihedralDeg): above this normal agreement two strata are not a crease (boolean seams). */
    minDihedralCos: number
    /**
     * cos(minTangencyAngleDeg): the crease gate for NATIVE modeled curves.
     * A drawn polygon vertex is design intent at any angle — gating native
     * edges by minDihedralDeg silently un-features shallow creases (a 13°
     * profile vertex at twist 500° loses its helical edge and the smooth
     * contour chord-cuts visible notches into the silhouette). Only
     * essentially-collinear vertices (below the tracer's tangency floor)
     * are dropped.
     */
    nativeCreaseCos: number
    /** sin(minTangencyAngleDeg): tracer bails when ‖∇fA×∇fB‖ falls below this. */
    minTangencySin: number
    /** Corner merge radius (mm). */
    cornerMergeTol: number
    /** Seam seed grid cell size (mm); 0 = auto from each pair's overlap box. */
    seedCellSize: number
    /** Hard cap on predictor–corrector steps per traced curve. */
    maxTraceSteps: number
}

export function resolveTolerances(tuning: SfccTuning, sceneDiag: number): ResolvedTolerances {
    const deg = Math.PI / 180
    return {
        surfaceTol: tuning.surfaceTolMm,
        maxChordError: tuning.curveChordTolMm,
        curveEps: Math.max(1e-9 * sceneDiag, 1e-12),
        probeDelta: tuning.probeDeltaFactor * tuning.surfaceTolMm,
        minDihedralCos: Math.cos(tuning.minDihedralDeg * deg),
        nativeCreaseCos: Math.cos(tuning.minTangencyAngleDeg * deg),
        minTangencySin: Math.sin(tuning.minTangencyAngleDeg * deg),
        cornerMergeTol: tuning.cornerMergeTolDiagFraction * sceneDiag,
        seedCellSize: tuning.seedCellSizeMm,
        maxTraceSteps: tuning.maxTraceSteps,
    }
}
