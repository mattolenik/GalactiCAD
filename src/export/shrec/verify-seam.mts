/**
 * Per-operand seam/corner verification for SHREC's MergeSharp output.
 *
 * Background
 * ----------
 * MergeSharp's seam-aware path uses the rank-aware pseudo-inverse to place
 * a vertex at the intersection of the local SDF planes a CSG operator joins.
 * For "phantom" cells — cells whose own QEF picks up rank-2/rank-3
 * structure but whose geometric seam line is actually in a NEIGHBOUR cell —
 * the pseudo-inverse target lies outside the cell. The cell-bounds clamp
 * then drags the mesh vertex to a face, and the seam classification is
 * incorrect: the cell isn't really on the seam.
 *
 * The viewer's glyph-anchor trick (use the unclamped pseudo-inverse vertex
 * as the anchor) hides the misplaced glyph in the common case, but the
 * underlying "this cell is a seam cell" decision can still be wrong, which
 * matters for any downstream consumer (line-fit, simplify, etc.) and for
 * ensuring the actual mesh vertex isn't pinned at a misleading position.
 *
 * Verification
 * ------------
 * For each rank≥2 candidate cell, the SDF samples already include the
 * **per-operand distances at every voxel** — `seamSdfA`, `seamSdfB`, and
 * `seamGap = |sdfA − sdfB|` — written by `bestSeam` and exposed via the
 * new `seamVerify` buffer (see `sample_grid.wgsl` binding 4).
 *
 * To verify a candidate vertex `p`:
 *
 *   1. Trilinear-interpolate `(sdfA(p), sdfB(p), seamOp)` from the 8
 *      corner voxels of the cell containing `p`.
 *   2. Compute the seam residual based on `seamOp`:
 *        union (1) / intersection (2): `r₁ = sdfA(p) − sdfB(p)`
 *        difference (3):                `r₁ = sdfA(p) + sdfB(p)`
 *   3. The point is on the seam iff `|r₁| < seamTol` (operands meet there)
 *      AND `|sdfA(p)| < surfTol` (the point is on the operand surfaces).
 *
 * Newton refinement
 * -----------------
 * When verification fails by a small amount, we can iterate `p` onto the
 * seam: the residual `r₁` has gradient `gradA − gradB` (union/intersection)
 * or `gradA + gradB` (difference). The gradients are computed by
 * finite-differencing `sdfA(p)` and `sdfB(p)` along the world axes
 * (`±0.5·voxelSize`). One Newton step:
 *
 *     p ← p − r₁ · ∇r₁ / |∇r₁|²
 *
 * is taken per iteration. We iterate up to N times and accept if
 * `|r₁| < seamTol` AND `|sdfA(p)| < surfTol`. Otherwise the cell is
 * REJECTED — its `klass` falls back to 0 (no glyph) and its mesh vertex
 * is replaced by the pre-computed Tikhonov fallback (see
 * `merge-sharp.mts`'s `pendingTikhonovFallback`).
 *
 * The whole pass runs on already-sampled grid data — no additional GPU
 * round-trip is needed beyond what `GridSampler.sample()` already
 * produced.
 */

import { log as dbgLog } from "../../logging/debug-log.mjs"
import type { GridSampleResult } from "../grid-sample.mjs"

/** Floats per vertex (matches `SIZEOF_VERTEX / 4` in `mdc.mts`). */
const VERTEX_STRIDE = 8

/** Floats per debug sample (matches `MESH_MDC_DEBUG_SAMPLE_STRIDE`). */
const DEBUG_SAMPLE_STRIDE = 24

/**
 * One candidate cell that MergeSharp flagged as a seam (klass=3) or CSG
 * corner (klass=2). Verification confirms or rejects each one.
 */
export interface SeamVerifyCandidate {
    /** Vertex index in the SHREC mesh. */
    vi: number
    /** Cell coordinates (used for trilinear interpolation of grid data). */
    cx: number
    cy: number
    cz: number
    /** Unclamped pseudo-inverse vertex (the seam-path solver's true target). */
    px: number
    py: number
    pz: number
    /** Cell bounds (bare; no inset) — used to keep refined positions in-cell. */
    cellLoX: number
    cellLoY: number
    cellLoZ: number
    cellHiX: number
    cellHiY: number
    cellHiZ: number
    /** Tikhonov fallback vertex position, applied if verification fails. */
    tikhonovX: number
    tikhonovY: number
    tikhonovZ: number
    /** klass MergeSharp wanted to assign (2 = CSG corner, 3 = CSG seam). */
    klass: number
}

export interface VerifySeamOptions {
    /**
     * Tolerance for the seam residual `|sdfA − ±sdfB|` (mm). A point is
     * considered on the seam when below this. Default `0.5 × voxelSize`.
     */
    seamTol?: number
    /**
     * Tolerance for `|sdfA(p)|` (the point is on the operand surfaces
     * themselves). Default `0.5 × voxelSize`.
     */
    surfTol?: number
    /**
     * Maximum Newton iterations per cell. Default 4 — usually 1–2 is
     * enough; more than 4 indicates the cell isn't really on the seam.
     */
    maxIterations?: number
    /** Enable the Newton refinement step. Default `true`. */
    refineEnabled?: boolean
}

export interface VerifySeamStats {
    candidates: number
    /** Cells that passed verification on the first sample (no Newton needed). */
    acceptedDirect: number
    /** Cells that converged via Newton refinement. */
    acceptedRefined: number
    /** Cells rejected (no convergence, or out of cell bounds). */
    rejected: number
    /** Cells whose seamOp at the vertex was 0 (not on any seam) — auto-rejected. */
    rejectedNoSeamOp: number
    /** Total Newton iterations across all refined cells. */
    totalNewtonSteps: number
    /** Largest |residual| accepted. */
    maxAcceptedResidual: number
    /** Largest distance any cell's vertex moved during refinement (mm). */
    maxRefineDisplacement: number
    elapsedMs: number
}

export interface VerifySeamResult {
    /** Indexed by candidate position; true = accepted (klass kept), false = rejected (klass → 0). */
    accepted: boolean[]
    /** For accepted+refined cells, the new (refined) vertex position; otherwise unchanged. */
    refinedX: number[]
    refinedY: number[]
    refinedZ: number[]
    stats: VerifySeamStats
}

/**
 * Verify and (if enabled) refine the candidates produced by MergeSharp.
 *
 * Mutates nothing; returns per-candidate accept/reject + refined positions.
 * The caller (`shrec.mts`) is responsible for applying the result to the
 * mesh vertex buffer and the debug-overlay sample buffer.
 */
export function verifySeams(
    grid: GridSampleResult,
    candidates: SeamVerifyCandidate[],
    opts: VerifySeamOptions = {},
): VerifySeamResult {
    const t0 = perfNow()
    const seamTol = opts.seamTol ?? grid.voxelSize * 0.5
    const surfTol = opts.surfTol ?? grid.voxelSize * 0.5
    const maxIter = Math.max(0, opts.maxIterations ?? 4)
    const refine = opts.refineEnabled !== false

    const N = candidates.length
    const accepted: boolean[] = new Array(N).fill(false)
    const refinedX = new Array<number>(N)
    const refinedY = new Array<number>(N)
    const refinedZ = new Array<number>(N)

    const stats: VerifySeamStats = {
        candidates: N,
        acceptedDirect: 0,
        acceptedRefined: 0,
        rejected: 0,
        rejectedNoSeamOp: 0,
        totalNewtonSteps: 0,
        maxAcceptedResidual: 0,
        maxRefineDisplacement: 0,
        elapsedMs: 0,
    }

    // Finite-difference step for gradient approximation (Newton step). Half a
    // voxel keeps us inside neighbouring cells when the candidate is mid-cell,
    // and is small enough that the local SDF is approximately linear.
    const fdStep = grid.voxelSize * 0.5

    for (let i = 0; i < N; i++) {
        const c = candidates[i]!
        let px = c.px, py = c.py, pz = c.pz
        refinedX[i] = px
        refinedY[i] = py
        refinedZ[i] = pz

        const initial = sampleSeamVerify(grid, px, py, pz)
        if (initial.seamOp === 0) {
            // Trilinear interpolation says no seam at this point — the
            // candidate is in a region where no CSG operator declared a
            // seam. Reject.
            stats.rejectedNoSeamOp++
            stats.rejected++
            continue
        }

        if (verifyAt(initial, seamTol, surfTol)) {
            accepted[i] = true
            stats.acceptedDirect++
            const r = Math.abs(seamResidual(initial))
            if (r > stats.maxAcceptedResidual) stats.maxAcceptedResidual = r
            continue
        }

        if (!refine) {
            stats.rejected++
            continue
        }

        // Newton refinement loop.
        let lastSamp = initial
        let converged = false
        for (let it = 0; it < maxIter; it++) {
            stats.totalNewtonSteps++
            // Compute the residual gradient via finite differences on
            // sdfA - ±sdfB at the current point.
            const r0 = seamResidual(lastSamp)
            const sX = sampleSeamVerify(grid, px + fdStep, py, pz)
            const sXn = sampleSeamVerify(grid, px - fdStep, py, pz)
            const sY = sampleSeamVerify(grid, px, py + fdStep, pz)
            const sYn = sampleSeamVerify(grid, px, py - fdStep, pz)
            const sZ = sampleSeamVerify(grid, px, py, pz + fdStep)
            const sZn = sampleSeamVerify(grid, px, py, pz - fdStep)
            const inv = 1 / (2 * fdStep)
            const gx = (seamResidual(sX) - seamResidual(sXn)) * inv
            const gy = (seamResidual(sY) - seamResidual(sYn)) * inv
            const gz = (seamResidual(sZ) - seamResidual(sZn)) * inv
            const gMagSq = gx * gx + gy * gy + gz * gz
            if (gMagSq < 1e-20) break  // gradient too flat, can't improve

            const step = -r0 / gMagSq
            const dx = step * gx
            const dy = step * gy
            const dz = step * gz

            // Limit the step to half a voxel per iteration so an outlier
            // doesn't fly out of the cell on iteration 1 (subsequent
            // iterations will continue if needed).
            const dLen = Math.hypot(dx, dy, dz)
            const maxStep = grid.voxelSize * 0.75
            const k = dLen > maxStep ? maxStep / dLen : 1

            px += dx * k
            py += dy * k
            pz += dz * k

            lastSamp = sampleSeamVerify(grid, px, py, pz)
            if (lastSamp.seamOp === 0) break  // wandered off the seam network
            if (verifyAt(lastSamp, seamTol, surfTol)) {
                converged = true
                break
            }
        }

        if (converged) {
            // Reject the refined point if it landed outside the cell — keeping
            // the seam invariant inside DC's per-cell topology is essential.
            const inCell =
                px >= c.cellLoX && px <= c.cellHiX &&
                py >= c.cellLoY && py <= c.cellHiY &&
                pz >= c.cellLoZ && pz <= c.cellHiZ
            if (!inCell) {
                stats.rejected++
                continue
            }
            refinedX[i] = px
            refinedY[i] = py
            refinedZ[i] = pz
            const dispLen = Math.hypot(px - c.px, py - c.py, pz - c.pz)
            if (dispLen > stats.maxRefineDisplacement) stats.maxRefineDisplacement = dispLen
            const r = Math.abs(seamResidual(lastSamp))
            if (r > stats.maxAcceptedResidual) stats.maxAcceptedResidual = r
            accepted[i] = true
            stats.acceptedRefined++
        } else {
            stats.rejected++
        }
    }

    stats.elapsedMs = perfNow() - t0
    dbgLog("ShrecExport").debug(
        `verifySeams: candidates=${stats.candidates} ` +
        `acceptedDirect=${stats.acceptedDirect} acceptedRefined=${stats.acceptedRefined} ` +
        `rejected=${stats.rejected} rejectedNoSeamOp=${stats.rejectedNoSeamOp} ` +
        `newtonSteps=${stats.totalNewtonSteps} ` +
        `maxResidual=${stats.maxAcceptedResidual.toExponential(2)}mm ` +
        `maxRefineDisp=${stats.maxRefineDisplacement.toExponential(2)}mm ` +
        `seamTol=${seamTol.toFixed(4)}mm surfTol=${surfTol.toFixed(4)}mm ` +
        `elapsed=${stats.elapsedMs.toFixed(1)}ms`,
    )
    return { accepted, refinedX, refinedY, refinedZ, stats }
}

/**
 * Trilinear-interpolated seam-verify sample at world position `p`.
 * Returns `{ sdfA, sdfB, seamGap, seamOp }` — `seamOp` is the **mode**
 * across the 8 corner voxels (so ambiguous mixed-op cells round to the
 * dominant operator; if all 8 corners disagree, returns 0).
 */
interface SeamVerifySample {
    sdfA: number
    sdfB: number
    seamGap: number
    seamOp: number  // 0/1/2/3 — same encoding as the SDF
}

function sampleSeamVerify(grid: GridSampleResult, x: number, y: number, z: number): SeamVerifySample {
    const ox = grid.gridOffset[0]
    const oy = grid.gridOffset[1]
    const oz = grid.gridOffset[2]
    const vs = grid.voxelSize
    const [nx, ny, nz] = grid.dims

    // Voxel-local coords; `fx/fy/fz` are the trilinear weights.
    const xRel = (x - ox) / vs
    const yRel = (y - oy) / vs
    const zRel = (z - oz) / vs

    let ix0 = Math.floor(xRel)
    let iy0 = Math.floor(yRel)
    let iz0 = Math.floor(zRel)
    // Clamp to grid bounds — needed when Newton steps push p out of the
    // grid; we sample the boundary voxel rather than going OOB.
    if (ix0 < 0) ix0 = 0
    if (iy0 < 0) iy0 = 0
    if (iz0 < 0) iz0 = 0
    if (ix0 >= nx - 1) ix0 = nx - 2
    if (iy0 >= ny - 1) iy0 = ny - 2
    if (iz0 >= nz - 1) iz0 = nz - 2
    const fx = Math.max(0, Math.min(1, xRel - ix0))
    const fy = Math.max(0, Math.min(1, yRel - iy0))
    const fz = Math.max(0, Math.min(1, zRel - iz0))

    const verify = grid.seamVerify
    let sdfA = 0, sdfB = 0, gap = 0
    // Tally seamOp across corners — pick the most common non-zero value
    // (mode); fall back to 0 if no corner reports a seam.
    const opCounts = [0, 0, 0, 0]  // indexed by op (0..3)
    for (let dz = 0; dz < 2; dz++) {
        const wz = dz === 0 ? 1 - fz : fz
        const iz = iz0 + dz
        for (let dy = 0; dy < 2; dy++) {
            const wy = dy === 0 ? 1 - fy : fy
            const iy = iy0 + dy
            for (let dxi = 0; dxi < 2; dxi++) {
                const wx = dxi === 0 ? 1 - fx : fx
                const ix = ix0 + dxi
                const w = wx * wy * wz
                const idx = ((iz * ny) + iy) * nx + ix
                const base = idx * 4
                sdfA += verify[base]! * w
                sdfB += verify[base + 1]! * w
                gap += verify[base + 2]! * w
                const op = Math.round(verify[base + 3]!)
                if (op >= 0 && op <= 3) opCounts[op]! += w
            }
        }
    }
    let bestOp = 0
    let bestCount = opCounts[0]!  // weight of "no seam"
    for (let op = 1; op <= 3; op++) {
        if (opCounts[op]! > bestCount) {
            bestCount = opCounts[op]!
            bestOp = op
        }
    }
    return { sdfA, sdfB, seamGap: gap, seamOp: bestOp }
}

/** Compute the seam residual from a sample; sign convention matches the SDF op. */
function seamResidual(s: SeamVerifySample): number {
    // For union/intersection the seam is where `sdfA = sdfB`.
    // For difference the seam is where `sdfA = -sdfB`.
    if (s.seamOp === 3) return s.sdfA + s.sdfB
    return s.sdfA - s.sdfB
}

/** A point is on the seam iff residual and surface-distance are both small. */
function verifyAt(s: SeamVerifySample, seamTol: number, surfTol: number): boolean {
    return Math.abs(seamResidual(s)) < seamTol && Math.abs(s.sdfA) < surfTol
}

function perfNow(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}

// Stride constants exposed for the integration code in shrec.mts.
export const VERIFY_VERTEX_STRIDE = VERTEX_STRIDE
export const VERIFY_DEBUG_SAMPLE_STRIDE = DEBUG_SAMPLE_STRIDE
