/**
 * Per-operand seam/corner verification for SHREC's MergeSharp output.
 *
 * Background
 * ----------
 * MergeSharp's seam-aware path uses the rank-aware pseudo-inverse to place
 * a vertex at the intersection of the local SDF planes a CSG operator joins.
 * For "phantom" cells — cells whose own QEF picks up rank-2/rank-3
 * structure but whose geometric seam line is actually in a NEIGHBOUR cell
 * (typically because the seam is exactly aligned with a cell boundary) —
 * the pseudo-inverse target ends up somewhere inside the wrong cell, half
 * a voxel or more from the true seam line.
 *
 * Verification — two scalar constraints
 * --------------------------------------
 * The seam line of *any* CSG operator is the locus where BOTH operand
 * surfaces simultaneously cross zero:
 *
 *     seamSdfA(p) = 0   AND   seamSdfB(p) = 0
 *
 * (For `opDifferenceEx` the operator stores `seamSdfB = -b.d` because
 * `opDifferenceEx = opIntersectionEx(a, sdfNeg(b))`; the negation makes
 * the same `=0 AND =0` pair work uniformly across union, intersection
 * and difference.)
 *
 * To verify a candidate vertex `p`:
 *
 *   1. Trilinear-interpolate `(sdfA(p), sdfB(p))` from the 8 corner
 *      voxels of the cell containing `p`.
 *   2. Accept iff `|sdfA(p)| < tol` AND `|sdfB(p)| < tol`.
 *
 * Newton refinement — 2-constraint pseudo-inverse step
 * ----------------------------------------------------
 * A single scalar Newton step (`dp = -r·∇r / |∇r|²`) collapses the seam to
 * a 2-D level set, not the 1-D line we want. To project onto the seam
 * line we use the 2-constraint linearised step
 *
 *     J · dp = -(sdfA(p), sdfB(p))   where J = (∇sdfA; ∇sdfB)
 *
 * which has 3 unknowns (xyz) and 2 equations — underdetermined, so we
 * take the minimum-norm solution
 *
 *     dp = -J⁺·r  =  -Jᵀ · (J·Jᵀ)⁻¹ · r
 *
 * where `J·Jᵀ` is a 2×2 matrix we invert in closed form. After at most
 * `maxIterations` steps we accept if both `|sdfA|` and `|sdfB|` fall
 * under tolerance AND the refined point is still inside the cell;
 * otherwise the cell is REJECTED.
 *
 * Rejection action
 * ----------------
 *   - mesh vertex reverts to the Tikhonov fallback solve (smooth,
 *     guaranteed in-cell);
 *   - debug-overlay klass is reset to 0 (no glyph);
 *   - the cell is dropped from the line-fit chain so downstream
 *     Laplacian smoothing isn't pulled toward an invalid seam point.
 *
 * The whole pass runs on already-sampled grid data — no additional GPU
 * round-trip is needed beyond what `GridSampler.sample()` already
 * produced.
 */

import { log as dbgLog } from "../../logging/debug-log.mjs"
import type { ContourBufferView } from "../../scene/contour-buffer.mjs"
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
     * Tolerance on `|sdfA(p)|` AND `|sdfB(p)|` (both operands' distance
     * to the candidate vertex). A point is on the seam when both are
     * below this. Default `0.1 × voxelSize` — tight enough to reject a
     * "phantom cell" half-voxel-off-seam vertex, loose enough to absorb
     * sub-voxel pseudo-inverse placement noise on legitimate seam cells.
     */
    seamTol?: number
    /**
     * Maximum 2-constraint Newton iterations per cell. Default 6 —
     * usually 1–2 suffice for a true seam cell; more than ~4 indicates
     * the cell isn't really on the seam line.
     */
    maxIterations?: number
    /** Enable the Newton refinement step. Default `true`. */
    refineEnabled?: boolean
    /**
     * Optional contour buffer. When supplied, each accepted klass=2
     * (CSG corner) candidate is post-processed by finding the nearest
     * contour edge and intersecting it with operand-A's surface (where
     * `sdfA(p) = 0`). The intersection is the **true** geometric
     * corner — useful when the corner involves 3 surfaces of only 2
     * SDF operands (e.g. an outer face meeting two faces of the same
     * cutter primitive), where the 2-constraint Newton can only land
     * on the (A, B) seam line, not the corner endpoint.
     */
    contours?: ContourBufferView
}

export interface VerifySeamStats {
    candidates: number
    /** Cells that passed verification on the first sample (no Newton needed) AND whose refined position is in the cell. */
    acceptedDirect: number
    /** Cells that converged via Newton refinement AND whose refined position is in the cell. */
    acceptedRefined: number
    /**
     * Cells whose Newton converged to a true seam point but whose
     * refined position lies *outside* the cell (boundary-coincident
     * seam — typically when the geometric seam is exactly aligned with
     * a voxel grid line). The glyph is emitted at the refined position
     * (multiple such cells dedup to one glyph), but the mesh vertex
     * stays at the Tikhonov fallback to preserve DC topology.
     */
    acceptedBoundary: number
    /** Cells rejected for any reason (no glyph, Tikhonov fallback for the mesh vertex). */
    rejected: number
    /** Cells whose seamOp at the vertex was 0 (not on any seam) — auto-rejected. */
    rejectedNoSeamOp: number
    /** Cells where Newton couldn't converge in `maxIterations` steps. */
    rejectedNoConverge: number
    /** Cells where the Jacobian determinant was singular (gradients parallel — geometric ambiguity). */
    rejectedSingular: number
    /** Total Newton iterations across all refined cells. */
    totalNewtonSteps: number
    /** Largest `max(|sdfA|, |sdfB|)` accepted (mm). */
    maxAcceptedResidual: number
    /** Largest distance any cell's vertex moved during refinement (mm). */
    maxRefineDisplacement: number
    /**
     * Klass=2 (CSG corner) candidates whose glyph anchor was snapped
     * to the intersection of the nearest contour edge with operand-A's
     * surface. This recovers true corner positions even when the corner
     * involves 3 surfaces but only 2 SDF operands (e.g. outer's face
     * meeting two faces of the same cutter primitive).
     */
    cornerEdgeSnaps: number
    /** Largest distance a corner glyph anchor was moved by the contour-edge snap (mm). */
    maxCornerEdgeSnap: number
    elapsedMs: number
}

export interface VerifySeamResult {
    /**
     * Indexed by candidate position; `true` = the candidate's
     * Newton-refined position lies on the geometric seam line (within
     * `seamTol`), so the cell **gets a debug glyph** at the refined
     * position. The mesh-vertex update depends on `inCellAfterRefine`.
     */
    accepted: boolean[]
    /**
     * For accepted candidates, true iff the refined position is inside
     * the cell's bounds. When false, the cell is "boundary-coincident"
     * — the geometric seam is at a cell face/corner that this cell
     * touches but doesn't strictly contain. The glyph is still emitted
     * (multiple such cells around the seam dedup to one glyph) but the
     * mesh vertex stays at the Tikhonov fallback so DC topology is
     * preserved. When `accepted[i] === false`, this is also `false`.
     */
    inCellAfterRefine: boolean[]
    /**
     * For accepted candidates, the position the cell was refined to
     * (the actual geometric seam point). Used as both the mesh vertex
     * (when in-cell) and the debug glyph anchor.
     */
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
    const seamTol = opts.seamTol ?? grid.voxelSize * 0.1
    const maxIter = Math.max(0, opts.maxIterations ?? 6)
    const refine = opts.refineEnabled !== false
    const contours = opts.contours

    const N = candidates.length
    const accepted: boolean[] = new Array(N).fill(false)
    const inCellAfterRefine: boolean[] = new Array(N).fill(false)
    const refinedX = new Array<number>(N)
    const refinedY = new Array<number>(N)
    const refinedZ = new Array<number>(N)

    const stats: VerifySeamStats = {
        candidates: N,
        acceptedDirect: 0,
        acceptedRefined: 0,
        acceptedBoundary: 0,
        rejected: 0,
        rejectedNoSeamOp: 0,
        rejectedNoConverge: 0,
        rejectedSingular: 0,
        totalNewtonSteps: 0,
        maxAcceptedResidual: 0,
        maxRefineDisplacement: 0,
        cornerEdgeSnaps: 0,
        maxCornerEdgeSnap: 0,
        elapsedMs: 0,
    }

    for (let i = 0; i < N; i++) {
        const c = candidates[i]!
        const r = refineSeamVertexFromSeed(grid, c.px, c.py, c.pz, {
            seamTol,
            maxIterations: maxIter,
            refineEnabled: refine,
            cellLoX: c.cellLoX,
            cellLoY: c.cellLoY,
            cellLoZ: c.cellLoZ,
            cellHiX: c.cellHiX,
            cellHiY: c.cellHiY,
            cellHiZ: c.cellHiZ,
            requireInCell: false,
        })

        stats.totalNewtonSteps += r.newtonSteps
        refinedX[i] = r.x
        refinedY[i] = r.y
        refinedZ[i] = r.z

        if (!r.accepted) {
            stats.rejected++
            if (r.rejectReason === "noSeamOp") stats.rejectedNoSeamOp++
            else if (r.rejectReason === "singular") stats.rejectedSingular++
            else stats.rejectedNoConverge++
            continue
        }

        accepted[i] = true
        inCellAfterRefine[i] = r.inCell
        const samp = sampleSeamVerify(grid, r.x, r.y, r.z)
        const res = Math.max(Math.abs(samp.sdfA), Math.abs(samp.sdfB))
        if (res > stats.maxAcceptedResidual) stats.maxAcceptedResidual = res

        if (r.newtonSteps === 0) {
            if (r.inCell) stats.acceptedDirect++
            else stats.acceptedBoundary++
        } else {
            if (r.inCell) stats.acceptedRefined++
            else stats.acceptedBoundary++
            const dispLen = Math.hypot(r.x - c.px, r.y - c.py, r.z - c.pz)
            if (dispLen > stats.maxRefineDisplacement) stats.maxRefineDisplacement = dispLen
        }
    }

    // ---------------- Corner contour-edge snap (klass=2 only) ------------
    //
    // The 2-constraint Newton above projects each corner candidate onto an
    // (A, B) seam LINE — but a 3-surface CSG corner where the cutter has
    // two faces meeting (e.g. outer Z face × cutter X face × cutter Y face)
    // involves only 2 SDF *operands*. Newton's solution is anywhere on the
    // (outer, cutter) seam, not specifically the corner endpoint.
    //
    // Recovery uses the **contour-edge data** the scene already exposes
    // (every box primitive contributes its 12 edges as line segments via
    // `accumulateContours`). For each accepted corner candidate:
    //
    //   1. Find the nearest contour edge to the refined position.
    //   2. Project the position onto the edge to get an initial parameter.
    //   3. Walk the parameter ±direction sampling `sdfA(p(t))` from the
    //      grid (operand A of the cell's seam — typically the outer
    //      primitive when the corner is a hole rim corner).
    //   4. Bisect to find `t*` where `sdfA(p(t*)) = 0` — this is the
    //      intersection of the contour edge with operand A's surface,
    //      i.e. the actual geometric corner.
    //
    // The snap is gated on a max-distance check so candidates whose
    // nearest edge is far away aren't dragged off to spurious corners.
    if (contours && contours.segmentCount > 0) {
        const maxSnapDist = grid.voxelSize * 2.5
        for (let i = 0; i < N; i++) {
            const c = candidates[i]!
            if (c.klass !== 2 || !accepted[i]) continue
            const px = refinedX[i]!, py = refinedY[i]!, pz = refinedZ[i]!

            // 1+2. Find nearest segment + projection parameter.
            const nearest = findNearestContourEdge(contours, px, py, pz, maxSnapDist)
            if (!nearest) continue

            // 3+4. Bisect along the segment for sdfA = 0.
            const intersect = findEdgeSurfaceIntersection(
                grid, contours, nearest.segIdx, nearest.t,
            )
            if (!intersect) continue

            const moveDist = Math.hypot(intersect.x - px, intersect.y - py, intersect.z - pz)
            if (moveDist > maxSnapDist) continue
            // Tiny moves (<5% voxel) are noise; skip to avoid jiggling
            // already-correct glyphs.
            if (moveDist < grid.voxelSize * 0.05) continue

            refinedX[i] = intersect.x
            refinedY[i] = intersect.y
            refinedZ[i] = intersect.z
            inCellAfterRefine[i] = inCell(c, intersect.x, intersect.y, intersect.z)
            stats.cornerEdgeSnaps++
            if (moveDist > stats.maxCornerEdgeSnap) stats.maxCornerEdgeSnap = moveDist
            if (moveDist > stats.maxRefineDisplacement) stats.maxRefineDisplacement = moveDist
            if (stats.cornerEdgeSnaps <= 8) {
                dbgLog("ShrecExport").debug(
                    `cornerEdgeSnap#${stats.cornerEdgeSnaps} ` +
                    `before=(${px.toFixed(4)},${py.toFixed(4)},${pz.toFixed(4)}) ` +
                    `after=(${intersect.x.toFixed(4)},${intersect.y.toFixed(4)},${intersect.z.toFixed(4)}) ` +
                    `move=${moveDist.toFixed(4)}mm segIdx=${nearest.segIdx}`,
                )
            }
        }
    }

    stats.elapsedMs = perfNow() - t0
    dbgLog("ShrecExport").debug(
        `verifySeams: candidates=${stats.candidates} ` +
        `acceptedDirect=${stats.acceptedDirect} acceptedRefined=${stats.acceptedRefined} ` +
        `acceptedBoundary=${stats.acceptedBoundary} ` +
        `rejected=${stats.rejected} ` +
        `(noSeamOp=${stats.rejectedNoSeamOp} noConverge=${stats.rejectedNoConverge} ` +
        `singular=${stats.rejectedSingular}) ` +
        `newtonSteps=${stats.totalNewtonSteps} ` +
        `cornerEdgeSnaps=${stats.cornerEdgeSnaps} ` +
        `maxCornerEdgeSnap=${stats.maxCornerEdgeSnap.toExponential(2)}mm ` +
        `maxResidual=${stats.maxAcceptedResidual.toExponential(2)}mm ` +
        `maxRefineDisp=${stats.maxRefineDisplacement.toExponential(2)}mm ` +
        `seamTol=${seamTol.toFixed(4)}mm ` +
        `elapsed=${stats.elapsedMs.toFixed(1)}ms`,
    )
    return { accepted, inCellAfterRefine, refinedX, refinedY, refinedZ, stats }
}

function inCell(c: SeamVerifyCandidate, px: number, py: number, pz: number): boolean {
    return (
        px >= c.cellLoX && px <= c.cellHiX &&
        py >= c.cellLoY && py <= c.cellHiY &&
        pz >= c.cellLoZ && pz <= c.cellHiZ
    )
}

const SEGMENT_STRIDE = 6

/**
 * Brute-force scan over `contours.segments` for the segment whose closest
 * point to `p` lies within `maxDistance`. Returns the segment index and
 * the parameter `t ∈ [0,1]` along it of the closest point. Brute-force is
 * fine because corner candidates are few (typically <20) and segments per
 * scene are also few hundred at most.
 */
function findNearestContourEdge(
    contours: ContourBufferView,
    px: number, py: number, pz: number,
    maxDistance: number,
): { segIdx: number, t: number, x: number, y: number, z: number } | null {
    const segs = contours.segments
    const n = contours.segmentCount
    let bestIdx = -1
    let bestDistSq = maxDistance * maxDistance
    let bestT = 0, bestX = 0, bestY = 0, bestZ = 0
    for (let s = 0; s < n; s++) {
        const o = s * SEGMENT_STRIDE
        const ax = segs[o]!, ay = segs[o + 1]!, az = segs[o + 2]!
        const bx = segs[o + 3]!, by = segs[o + 4]!, bz = segs[o + 5]!
        const dx = bx - ax, dy = by - ay, dz = bz - az
        const lenSq = dx * dx + dy * dy + dz * dz
        if (lenSq < 1e-20) continue
        // Project p onto the segment.
        const tRaw = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / lenSq
        const t = Math.max(0, Math.min(1, tRaw))
        const cx = ax + t * dx, cy = ay + t * dy, cz = az + t * dz
        const ex = px - cx, ey = py - cy, ez = pz - cz
        const distSq = ex * ex + ey * ey + ez * ez
        if (distSq < bestDistSq) {
            bestDistSq = distSq
            bestIdx = s
            bestT = t
            bestX = cx; bestY = cy; bestZ = cz
        }
    }
    if (bestIdx < 0) return null
    return { segIdx: bestIdx, t: bestT, x: bestX, y: bestY, z: bestZ }
}

/**
 * Walk along contour segment `segIdx` starting at parameter `tStart`
 * (the projection of the candidate vertex onto the edge) looking for
 * the parameter `t*` where `sdfA(p(t*)) = 0` — i.e. where the contour
 * edge crosses operand-A's iso-surface. Bisects between a `+sdfA` and
 * `−sdfA` sample once a sign change is detected.
 *
 * Returns the world position of the intersection, or `null` if no sign
 * change was found within the edge's range.
 */
function findEdgeSurfaceIntersection(
    grid: GridSampleResult,
    contours: ContourBufferView,
    segIdx: number,
    tStart: number,
): { x: number, y: number, z: number } | null {
    const segs = contours.segments
    const o = segIdx * SEGMENT_STRIDE
    const ax = segs[o]!, ay = segs[o + 1]!, az = segs[o + 2]!
    const bx = segs[o + 3]!, by = segs[o + 4]!, bz = segs[o + 5]!
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const segLen = Math.hypot(dx, dy, dz)
    if (segLen < 1e-20) return null

    // Sample sdfA at a position parameterised by t ∈ [0,1] along the edge.
    const sampleAt = (t: number): number => {
        const x = ax + t * dx, y = ay + t * dy, z = az + t * dz
        return sampleSeamVerify(grid, x, y, z).sdfA
    }
    // Position on the segment for parameter t.
    const posAt = (t: number): { x: number, y: number, z: number } => ({
        x: ax + t * dx, y: ay + t * dy, z: az + t * dz,
    })

    const s0 = sampleAt(tStart)
    if (Math.abs(s0) < grid.voxelSize * 0.05) return posAt(tStart)  // already on surface

    // Walk in ±t direction from tStart looking for a sign change. Step
    // size = ~half a voxel along the segment.
    const stepInT = (grid.voxelSize * 0.5) / segLen
    if (stepInT > 1) return null  // segment shorter than half a voxel — bail

    for (const sign of [+1, -1]) {
        let prevT = tStart
        let prevS = s0
        for (let k = 1; k <= 16; k++) {
            const t = tStart + sign * k * stepInT
            if (t < 0 || t > 1) break
            const s = sampleAt(t)
            if (s * prevS < 0) {
                // Sign change between prevT and t. Bisect.
                let lo = prevT, hi = t
                let loS = prevS, hiS = s
                for (let iter = 0; iter < 8; iter++) {
                    const mid = 0.5 * (lo + hi)
                    const midS = sampleAt(mid)
                    if (midS * loS < 0) {
                        hi = mid; hiS = midS
                    } else {
                        lo = mid; loS = midS
                    }
                }
                // Linear interpolation for the final root within [lo, hi].
                const denom = hiS - loS
                const tRoot = Math.abs(denom) < 1e-12 ? 0.5 * (lo + hi) : lo - loS * (hi - lo) / denom
                return posAt(tRoot)
            }
            // Stop if we've wandered into a region with no seam metadata
            // (sampleSeamVerify returns 0 there) — the trilinear sdfA
            // is meaningless past the seam envelope.
            if (s === 0 && prevS === 0) break
            prevT = t
            prevS = s
        }
    }
    return null
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

/**
 * Trilinear-interpolated seam tangent (xyz) at world position `p`.
 * (Currently unused — was used by an earlier "walk along tangent for
 * corner endpoint" experiment that wandered sideways at true corners
 * because converging-seam tangents average to a meaningless direction
 * in trilinear interpolation. Kept for future per-operand-C work.)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function sampleSeamTangent(grid: GridSampleResult, x: number, y: number, z: number): { tx: number, ty: number, tz: number, validity: number } {
    const ox = grid.gridOffset[0], oy = grid.gridOffset[1], oz = grid.gridOffset[2]
    const vs = grid.voxelSize
    const [nx, ny, nz] = grid.dims
    const xRel = (x - ox) / vs, yRel = (y - oy) / vs, zRel = (z - oz) / vs
    let ix0 = Math.floor(xRel), iy0 = Math.floor(yRel), iz0 = Math.floor(zRel)
    if (ix0 < 0) ix0 = 0; if (iy0 < 0) iy0 = 0; if (iz0 < 0) iz0 = 0
    if (ix0 >= nx - 1) ix0 = nx - 2; if (iy0 >= ny - 1) iy0 = ny - 2; if (iz0 >= nz - 1) iz0 = nz - 2
    const fx = Math.max(0, Math.min(1, xRel - ix0))
    const fy = Math.max(0, Math.min(1, yRel - iy0))
    const fz = Math.max(0, Math.min(1, zRel - iz0))
    const buf = grid.seamTangent
    let tx = 0, ty = 0, tz = 0, validity = 0
    // Sign-correct interpolation: tangents are line directions (±T are
    // the same line), so we sign-flip each corner's tangent to match
    // the first non-zero one before averaging. Otherwise opposing-sign
    // tangents on adjacent voxels would cancel.
    let refX = 0, refY = 0, refZ = 0, haveRef = false
    for (let dz = 0; dz < 2; dz++) {
        const wz = dz === 0 ? 1 - fz : fz
        for (let dy = 0; dy < 2; dy++) {
            const wy = dy === 0 ? 1 - fy : fy
            for (let dxi = 0; dxi < 2; dxi++) {
                const wx = dxi === 0 ? 1 - fx : fx
                const w = wx * wy * wz
                const idx = ((iz0 + dz) * ny + (iy0 + dy)) * nx + (ix0 + dxi)
                const base = idx * 4
                let cx = buf[base]!, cy = buf[base + 1]!, cz = buf[base + 2]!
                const cv = buf[base + 3]!
                if (!haveRef && (cx * cx + cy * cy + cz * cz) > 1e-6) {
                    refX = cx; refY = cy; refZ = cz; haveRef = true
                } else if (haveRef && (cx * refX + cy * refY + cz * refZ) < 0) {
                    cx = -cx; cy = -cy; cz = -cz
                }
                tx += cx * w
                ty += cy * w
                tz += cz * w
                validity += cv * w
            }
        }
    }
    return { tx, ty, tz, validity }
}

/**
 * (Currently unused — was used by the corner-endpoint walk that wandered
 * sideways at true 3-plane corners because the multiple converging
 * seams' tangents average to a meaningless direction. Kept for future
 * work that would need the third-operand SDF on the CPU.)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function findCornerEndpoint(
    grid: GridSampleResult,
    px: number, py: number, pz: number,
    t0x: number, t0y: number, t0z: number,
): { x: number, y: number, z: number } | null {
    const t0Len = Math.hypot(t0x, t0y, t0z)
    if (t0Len < 1e-6) return null
    const Tx = t0x / t0Len, Ty = t0y / t0Len, Tz = t0z / t0Len
    const stepSize = grid.voxelSize * 0.3  // small enough to catch transitions, large enough to walk fast
    const maxSteps = 12  // ~3.6 voxels in each direction
    const tangentTol = 0.85  // |cos(T0, T')| < 0.85 = >32° change — clear corner indicator

    let bestEndpoint: { x: number, y: number, z: number } | null = null
    let bestDist = Infinity

    for (const sign of [+1, -1]) {
        let lastGoodS = 0  // step where tangent still matches T0
        let firstBadS = 0  // first step where tangent diverges
        let foundBad = false
        for (let s = 1; s <= maxSteps; s++) {
            const dx = sign * s * stepSize * Tx
            const dy = sign * s * stepSize * Ty
            const dz = sign * s * stepSize * Tz
            const samp = sampleSeamTangent(grid, px + dx, py + dy, pz + dz)
            // No tangent at this point = off the seam network = transition.
            if (samp.validity < 0.5) {
                firstBadS = s
                foundBad = true
                break
            }
            const sLen = Math.hypot(samp.tx, samp.ty, samp.tz)
            if (sLen < 1e-6) {
                firstBadS = s
                foundBad = true
                break
            }
            const cosT = Math.abs(samp.tx * Tx + samp.ty * Ty + samp.tz * Tz) / sLen
            if (cosT < tangentTol) {
                firstBadS = s
                foundBad = true
                break
            }
            lastGoodS = s
        }
        if (!foundBad) continue  // walked the full distance without hitting a corner

        // Bisect between lastGoodS and firstBadS (already in step units).
        let lo = lastGoodS, hi = firstBadS
        for (let iter = 0; iter < 8; iter++) {
            const mid = 0.5 * (lo + hi)
            const dx = sign * mid * stepSize * Tx
            const dy = sign * mid * stepSize * Ty
            const dz = sign * mid * stepSize * Tz
            const samp = sampleSeamTangent(grid, px + dx, py + dy, pz + dz)
            const sLen = Math.hypot(samp.tx, samp.ty, samp.tz)
            const cosT = (samp.validity >= 0.5 && sLen > 1e-6)
                ? Math.abs(samp.tx * Tx + samp.ty * Ty + samp.tz * Tz) / sLen
                : 0
            if (cosT >= tangentTol) lo = mid
            else hi = mid
        }
        // The corner is approximately at the bad-side bisection bound (where
        // the tangent has just flipped). Use that as the endpoint position.
        const cornerS = hi
        const cx = px + sign * cornerS * stepSize * Tx
        const cy = py + sign * cornerS * stepSize * Ty
        const cz = pz + sign * cornerS * stepSize * Tz
        const dist = cornerS * stepSize
        if (dist < bestDist) {
            bestDist = dist
            bestEndpoint = { x: cx, y: cy, z: cz }
        }
    }

    return bestEndpoint
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

function inCellBounds(
    cellLoX: number, cellLoY: number, cellLoZ: number,
    cellHiX: number, cellHiY: number, cellHiZ: number,
    px: number, py: number, pz: number,
): boolean {
    return (
        px >= cellLoX && px <= cellHiX &&
        py >= cellLoY && py <= cellHiY &&
        pz >= cellLoZ && pz <= cellHiZ
    )
}

export interface RefineSeamVertexFromSeedOpts {
    seamTol?: number
    maxIterations?: number
    refineEnabled?: boolean
    cellLoX: number
    cellLoY: number
    cellLoZ: number
    cellHiX: number
    cellHiY: number
    cellHiZ: number
    /**
     * Pre-DC: only return `accepted: true` when the final point lies inside
     * the cell. `verifySeams` passes `false` so boundary seam points still
     * count as accepted (glyph path).
     */
    requireInCell?: boolean
}

export interface RefineSeamVertexFromSeedResult {
    accepted: boolean
    inCell: boolean
    x: number
    y: number
    z: number
    /** Number of Newton iterations executed (0 when direct-accept). */
    newtonSteps: number
    rejectReason?: "noSeamOp" | "skippedRefine" | "singular" | "noConverge" | "outOfCell"
}

/**
 * Project `seed` onto the CSG seam line (`sdfA = 0` ∧ `sdfB = 0`) using the
 * same trilinear samples + 2-constraint Newton step as `verifySeams`.
 */
export function refineSeamVertexFromSeed(
    grid: GridSampleResult,
    seedX: number,
    seedY: number,
    seedZ: number,
    opts: RefineSeamVertexFromSeedOpts,
): RefineSeamVertexFromSeedResult {
    const seamTol = opts.seamTol ?? grid.voxelSize * 0.1
    const maxIter = Math.max(0, opts.maxIterations ?? 6)
    const refine = opts.refineEnabled !== false
    const requireInCell = opts.requireInCell === true
    const {
        cellLoX, cellLoY, cellLoZ, cellHiX, cellHiY, cellHiZ,
    } = opts

    let px = seedX, py = seedY, pz = seedZ

    const initial = sampleSeamVerify(grid, px, py, pz)
    if (initial.seamOp === 0) {
        return {
            accepted: false,
            inCell: false,
            x: px, y: py, z: pz,
            newtonSteps: 0,
            rejectReason: "noSeamOp",
        }
    }

    if (Math.abs(initial.sdfA) < seamTol && Math.abs(initial.sdfB) < seamTol) {
        const inside = inCellBounds(cellLoX, cellLoY, cellLoZ, cellHiX, cellHiY, cellHiZ, px, py, pz)
        if (requireInCell && !inside) {
            return {
                accepted: false,
                inCell: false,
                x: px, y: py, z: pz,
                newtonSteps: 0,
                rejectReason: "outOfCell",
            }
        }
        return { accepted: true, inCell: inside, x: px, y: py, z: pz, newtonSteps: 0 }
    }

    if (!refine) {
        return {
            accepted: false,
            inCell: false,
            x: px, y: py, z: pz,
            newtonSteps: 0,
            rejectReason: "skippedRefine",
        }
    }

    const fdStep = grid.voxelSize * 0.5
    const maxStep = grid.voxelSize * 0.75
    let lastSamp = initial
    let converged = false
    let singular = false
    let newtonSteps = 0

    for (let it = 0; it < maxIter; it++) {
        newtonSteps++
        const sXp = sampleSeamVerify(grid, px + fdStep, py, pz)
        const sXn = sampleSeamVerify(grid, px - fdStep, py, pz)
        const sYp = sampleSeamVerify(grid, px, py + fdStep, pz)
        const sYn = sampleSeamVerify(grid, px, py - fdStep, pz)
        const sZp = sampleSeamVerify(grid, px, py, pz + fdStep)
        const sZn = sampleSeamVerify(grid, px, py, pz - fdStep)
        const invFD = 1 / (2 * fdStep)
        const gAx = (sXp.sdfA - sXn.sdfA) * invFD
        const gAy = (sYp.sdfA - sYn.sdfA) * invFD
        const gAz = (sZp.sdfA - sZn.sdfA) * invFD
        const gBx = (sXp.sdfB - sXn.sdfB) * invFD
        const gBy = (sYp.sdfB - sYn.sdfB) * invFD
        const gBz = (sZp.sdfB - sZn.sdfB) * invFD

        const M11 = gAx * gAx + gAy * gAy + gAz * gAz
        const M22 = gBx * gBx + gBy * gBy + gBz * gBz
        const M12 = gAx * gBx + gAy * gBy + gAz * gBz
        const det = M11 * M22 - M12 * M12
        if (Math.abs(det) < 1e-20) {
            singular = true
            break
        }
        const invDet = 1 / det

        const r1 = lastSamp.sdfA
        const r2 = lastSamp.sdfB
        const u1 = -(M22 * r1 - M12 * r2) * invDet
        const u2 = -(-M12 * r1 + M11 * r2) * invDet

        let dx = gAx * u1 + gBx * u2
        let dy = gAy * u1 + gBy * u2
        let dz = gAz * u1 + gBz * u2
        const dLen = Math.hypot(dx, dy, dz)
        if (dLen > maxStep) {
            const k = maxStep / dLen
            dx *= k; dy *= k; dz *= k
        }

        px += dx
        py += dy
        pz += dz
        lastSamp = sampleSeamVerify(grid, px, py, pz)
        if (lastSamp.seamOp === 0) break
        if (Math.abs(lastSamp.sdfA) < seamTol && Math.abs(lastSamp.sdfB) < seamTol) {
            converged = true
            break
        }
    }

    if (singular) {
        return {
            accepted: false,
            inCell: false,
            x: px, y: py, z: pz,
            newtonSteps,
            rejectReason: "singular",
        }
    }
    if (!converged) {
        return {
            accepted: false,
            inCell: false,
            x: px, y: py, z: pz,
            newtonSteps,
            rejectReason: "noConverge",
        }
    }

    const inside = inCellBounds(cellLoX, cellLoY, cellLoZ, cellHiX, cellHiY, cellHiZ, px, py, pz)
    if (requireInCell && !inside) {
        return {
            accepted: false,
            inCell: false,
            x: px, y: py, z: pz,
            newtonSteps,
            rejectReason: "outOfCell",
        }
    }

    return { accepted: true, inCell: inside, x: px, y: py, z: pz, newtonSteps }
}

function perfNow(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}

// Stride constants exposed for the integration code in shrec.mts.
export const VERIFY_VERTEX_STRIDE = VERTEX_STRIDE
export const VERIFY_DEBUG_SAMPLE_STRIDE = DEBUG_SAMPLE_STRIDE
