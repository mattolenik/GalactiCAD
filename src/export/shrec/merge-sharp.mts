/**
 * MergeSharp vertex relocation (textbook Dual Contouring with QEF).
 *
 * Refines each DC vertex by solving a per-cell quadratic error function
 * (QEF) over the cell's own cube edge crossings — the same approach
 * introduced by Ju, Losasso, Schaefer & Warren ("Dual Contouring of Hermite
 * Data", 2002), which is also what Wenger's IJK / MergeSharp work builds on.
 *
 * Why use cube edge crossings (not voxel-grid samples)?
 *
 *   - Edge crossings are **exact iso-surface points** by construction
 *     (linearly interpolated zero-crossings of the scalar field). Their
 *     interpolated normals are good local surface-normal estimates.
 *   - Voxel-grid samples are NOT on the iso-surface, so using their tangent
 *     planes (1st-order Taylor extrapolation `n·X = n·pos - d`) accumulates
 *     extrapolation error that grows with `|d|`. Far-from-surface samples
 *     contribute nonsense planes that pull the QEF away from the true
 *     feature — which is exactly the precision loss we observed.
 *
 * For each vertex we therefore:
 *
 *   1. Look up the cell `(cx, cy, cz)` it came from (carried through from
 *      `dc-cpu.mts` via `cellCoords`).
 *   2. Enumerate the cell's 12 cube edges; for each crossing, compute its
 *      world-space position `p` and interpolated unit normal `n`.
 *   3. Build the QEF
 *          A = Σ n n^T     (3x3 symmetric)
 *          b = Σ (n · p) n  (the right-hand side for `n · X = n · p`)
 *      with mass-point shift for numerical stability.
 *   4. Solve `A x = b` via the rank-aware pseudo-inverse from `svd3.mts`:
 *      - rank 1 → flat surface, snap onto tangent plane
 *      - rank 2 → sharp edge,  snap onto feature line
 *      - rank 3 → sharp corner, snap onto feature point
 *      Unconstrained directions stay at the mass point.
 *   5. **Clamp the result to the cell bounds.** This is what keeps DC
 *      topology valid — every vertex must remain inside its own cube — and
 *      it's also what prevents a near-singular QEF from launching a vertex
 *      across the model.
 *
 * No multi-iteration loop and no neighbourhood radius: the inputs (edge
 * crossings of a single cube) are independent of the vertex position, so
 * one solve is exact.
 */

import { log as dbgLog } from "../../logging/debug-log.mjs"
import type { MeshData } from "../export.mjs"
import type { GridSampleResult } from "../grid-sample.mjs"
import type { DualContourMesh } from "./dc-cpu.mjs"
import {
    sym3AddOuter,
    sym3Eigen,
    sym3Mul,
    sym3SolveTikhonov,
    sym3Rank,
    sym3Zero,
    type Sym3,
} from "./svd3.mjs"

/** Floats per vertex (matches `SIZEOF_VERTEX / 4` in `mdc.mts`). */
const VERTEX_STRIDE = 8

/**
 * The 12 edges of a cube cell, expressed as `[axis, lowCornerOffset]`.
 *
 * `axis ∈ {0,1,2}` is the edge direction (x/y/z).
 * `lowCornerOffset` is the cell-local offset of the edge's lower-coordinate
 * voxel; the higher endpoint is at `offset + axisDelta`. This enumeration
 * matches the cube-edge ordering used implicitly by `dc-cpu.mts` (each cube
 * cell touches 12 edges; pass-1 enumerates them axis-by-axis).
 */
const CUBE_EDGES: ReadonlyArray<{
    axis: 0 | 1 | 2
    lo: readonly [number, number, number]
}> = [
    // 4 x-axis edges
    { axis: 0, lo: [0, 0, 0] }, { axis: 0, lo: [0, 1, 0] }, { axis: 0, lo: [0, 0, 1] }, { axis: 0, lo: [0, 1, 1] },
    // 4 y-axis edges
    { axis: 1, lo: [0, 0, 0] }, { axis: 1, lo: [1, 0, 0] }, { axis: 1, lo: [0, 0, 1] }, { axis: 1, lo: [1, 0, 1] },
    // 4 z-axis edges
    { axis: 2, lo: [0, 0, 0] }, { axis: 2, lo: [1, 0, 0] }, { axis: 2, lo: [0, 1, 0] }, { axis: 2, lo: [1, 1, 0] },
]

export interface MergeSharpParams {
    /**
     * Tikhonov regularization strength for the QEF solve, expressed as a
     * fraction of the QEF matrix's largest eigenvalue. Smaller → less
     * regularization → sharper feature snapping but noisier near-marginal
     * cells. Larger → more regularization → smoother contours, blunter
     * features. Default 0.05.
     *
     * (Named `relCutoff` for backwards compatibility with the earlier
     * rank-aware pseudo-inverse formulation; the math is now Tikhonov, but
     * the UI semantic is similar — smaller = sharper.)
     */
    relCutoff?: number

    /**
     * Optional **additional** clamp on how far a vertex may move from its
     * original DC position, on top of the always-on cell-bounds clamp. When
     * undefined, only the cell-bounds clamp applies. Useful for very
     * conservative relocation (e.g. `0.5 * voxelSize`).
     */
    maxDisplacement?: number

    /** Inset (in fraction of voxelSize) applied to the cell-bounds clamp; keeps vertices off cell faces to avoid duplicate positions. Default 0.001. */
    cellBoundsInset?: number

    /**
     * Exponent applied to the gradient magnitude `g = |∇SDF|` when weighting
     * each cube-edge crossing in the QEF. `0` → uniform weight (current
     * default; every crossing counts equally). `1` → linear weight. `2` →
     * IJK-reference value, more aggressive at de-weighting smooth-blend
     * regions where `g < 1`. Has no effect for true SDFs (where `g ≡ 1`).
     */
    gradientWeightPower?: number
}

interface RelocationStats {
    vertexCount: number
    relocated: number
    pointFeatures: number
    edgeFeatures: number
    flatFeatures: number
    emptyCells: number
    clampedByCell: number
    clampedByMaxDisplacement: number
    elapsedMs: number
}

/**
 * Relocate the vertices of a DC mesh onto the underlying iso-surface's
 * sharp features using a per-cell QEF over the cube's edge crossings.
 *
 * Returns a new MeshData with updated positions and re-derived normals; the
 * triangle index buffer is reused as-is.
 */
export function mergeSharpRelocate(
    dcMesh: DualContourMesh,
    grid: GridSampleResult,
    params: MergeSharpParams = {},
): { mesh: MeshData; stats: RelocationStats } {
    const t0 = perfNow()

    const relCutoff = params.relCutoff ?? 0.05
    const maxDisp = params.maxDisplacement
    const inset = params.cellBoundsInset ?? 0.001
    const gradWeightPower = Math.max(0, params.gradientWeightPower ?? 0)
    // Pre-compute the weighting kernel: `0` → constant 1 (no math), otherwise
    // raise the interpolated `g` to the power. Hot-path branch elision below.
    const useGradWeight = gradWeightPower > 0

    const [nx, ny, nz] = grid.dims
    const ox = grid.gridOffset[0]
    const oy = grid.gridOffset[1]
    const oz = grid.gridOffset[2]
    const vs = grid.voxelSize
    const scalar = grid.scalar
    const gradient = grid.gradient

    const inVerts = dcMesh.verts
    const cellCoords = dcMesh.cellCoords
    const vertCount = (inVerts.length / VERTEX_STRIDE) | 0
    const outVerts = new Float32Array(inVerts.length)
    outVerts.set(inVerts)

    // Reusable scratch — avoid per-vertex allocation in the hot loop.
    const M: Sym3 = sym3Zero()
    const bvec: [number, number, number] = [0, 0, 0]
    const massVec: [number, number, number] = [0, 0, 0]
    const Mmass: [number, number, number] = [0, 0, 0]
    const correction: [number, number, number] = [0, 0, 0]

    let pointFeatures = 0
    let edgeFeatures = 0
    let flatFeatures = 0
    let emptyCells = 0
    let relocated = 0
    let clampedByCell = 0
    let clampedByMaxDisplacement = 0

    const insetAbs = inset * vs

    for (let vi = 0; vi < vertCount; vi++) {
        const base = vi * VERTEX_STRIDE
        const px0 = inVerts[base]!
        const py0 = inVerts[base + 1]!
        const pz0 = inVerts[base + 2]!

        const cx = cellCoords[vi * 3]!
        const cy = cellCoords[vi * 3 + 1]!
        const cz = cellCoords[vi * 3 + 2]!

        // World-space cube bounds for this cell, with a small inset so a
        // clamped vertex doesn't land exactly on a cell face (which would
        // make adjacent-cell vertices co-located).
        const bxLo = ox + cx * vs + insetAbs
        const byLo = oy + cy * vs + insetAbs
        const bzLo = oz + cz * vs + insetAbs
        const bxHi = ox + (cx + 1) * vs - insetAbs
        const byHi = oy + (cy + 1) * vs - insetAbs
        const bzHi = oz + (cz + 1) * vs - insetAbs

        // Reset per-vertex accumulators.
        M.a00 = M.a01 = M.a02 = M.a11 = M.a12 = M.a22 = 0
        bvec[0] = bvec[1] = bvec[2] = 0
        massVec[0] = massVec[1] = massVec[2] = 0
        let sumNx = 0, sumNy = 0, sumNz = 0
        let nCrossings = 0
        let weightSum = 0

        // Enumerate the 12 cube edges; for each crossing accumulate its
        // tangent plane (n · X = n · p) into the QEF.
        for (let ei = 0; ei < 12; ei++) {
            const edge = CUBE_EDGES[ei]!
            const lx = cx + edge.lo[0]
            const ly = cy + edge.lo[1]
            const lz = cz + edge.lo[2]
            // The cell's corner voxels are guaranteed in-grid (DC only emits
            // cells whose corners are valid voxel coords), so no bounds
            // check needed for the lower endpoint. The upper endpoint is at
            // (lx + dx, ly + dy, lz + dz) and is also in-grid for the same
            // reason. (Defensive guard kept below for safety.)
            let hx = lx, hy = ly, hz = lz
            if (edge.axis === 0) hx = lx + 1
            else if (edge.axis === 1) hy = ly + 1
            else hz = lz + 1
            if (hx >= nx || hy >= ny || hz >= nz) continue

            const idxA = (lz * ny + ly) * nx + lx
            const idxB = (hz * ny + hy) * nx + hx
            const sA = scalar[idxA]!
            const sB = scalar[idxB]!
            const insideA = sA <= 0
            const insideB = sB <= 0
            if (insideA === insideB) continue

            // Linear interp of the zero-crossing along the edge.
            let t = (0 - sA) / (sB - sA)
            if (!isFinite(t)) t = 0.5
            if (t < 0) t = 0
            else if (t > 1) t = 1

            const pAx = ox + lx * vs
            const pAy = oy + ly * vs
            const pAz = oz + lz * vs
            const pBx = ox + hx * vs
            const pBy = oy + hy * vs
            const pBz = oz + hz * vs
            const px = pAx + t * (pBx - pAx)
            const py = pAy + t * (pBy - pAy)
            const pz = pAz + t * (pBz - pAz)

            const gA = idxA * 4
            const gB = idxB * 4
            let nx_ = gradient[gA]! + t * (gradient[gB]! - gradient[gA]!)
            let ny_ = gradient[gA + 1]! + t * (gradient[gB + 1]! - gradient[gA + 1]!)
            let nz_ = gradient[gA + 2]! + t * (gradient[gB + 2]! - gradient[gA + 2]!)
            const nLen = Math.hypot(nx_, ny_, nz_)
            if (nLen < 1e-12) continue
            const ninv = 1 / nLen
            nx_ *= ninv
            ny_ *= ninv
            nz_ *= ninv

            // Per-crossing weight from the SDF gradient magnitude. Stored at
            // `gradient[idx*4 + 3]` by `sample_grid.wgsl` as `r.g = |∇SDF|`;
            // ≈ 1 for true SDFs, < 1 in CSG smooth-blend regions where the
            // linearised iso-surface model is less reliable.
            let w = 1
            if (useGradWeight) {
                const gAv = gradient[gA + 3]!
                const gBv = gradient[gB + 3]!
                const gInterp = gAv + t * (gBv - gAv)
                // Clamp to a sensible range; gradient magnitudes can briefly
                // exceed 1 in some smooth-CSG corners due to the analytical
                // normal computation. The clamp keeps the QEF condition
                // bounded and the weight monotone in `g`.
                const gClamped = gInterp < 0 ? 0 : (gInterp > 2 ? 2 : gInterp)
                w = gradWeightPower === 1 ? gClamped : Math.pow(gClamped, gradWeightPower)
                // Below ~1e-6 the weight contributes nothing useful and may
                // pollute Σw with floating-point noise; skip outright.
                if (w < 1e-6) continue
            }

            // Plane: n · X = n · p   (since p is on the iso-surface, d=0).
            // Weighted least squares: each plane contributes `w · (n·x − c)²`.
            const c = nx_ * px + ny_ * py + nz_ * pz
            sym3AddOuter(M, nx_, ny_, nz_, w)
            bvec[0] += w * c * nx_
            bvec[1] += w * c * ny_
            bvec[2] += w * c * nz_
            massVec[0] += w * px
            massVec[1] += w * py
            massVec[2] += w * pz
            sumNx += nx_
            sumNy += ny_
            sumNz += nz_
            nCrossings++
            weightSum += w
        }

        if (nCrossings === 0) {
            // Active cell with no crossings? Shouldn't happen — leave the DC
            // mass-point position alone and count it.
            emptyCells++
            continue
        }

        // Weighted mass-point: Σ(w·p) / Σw. Equivalent to plain mean when all
        // weights are 1 (`useGradWeight === false`).
        const inv = 1 / weightSum
        massVec[0] *= inv
        massVec[1] *= inv
        massVec[2] *= inv

        const eig = sym3Eigen(M)

        // Diagnostic only — actual placement uses the smooth Tikhonov solve
        // below, which has no rank-classification discontinuity. The rank
        // breakdown remains useful for "how many sharp features did we
        // detect?" telemetry in the dev log.
        const rank = sym3Rank(eig, relCutoff)
        if (rank === 3) pointFeatures++
        else if (rank === 2) edgeFeatures++
        else if (rank === 1) flatFeatures++
        else emptyCells++

        // Tikhonov-regularized QEF solve in mass-point-shifted coordinates:
        //   x = mass + (A + λI)⁻¹ (b - A·mass),  λ = relCutoff · |λmax|
        // The regularization is what keeps adjacent cells along a single
        // sharp feature from solving to slightly different points (which
        // shows up as wavy/spiky contours along the feature). It also
        // bounds the unconstrained-direction contribution at 1/λ rather
        // than 1/0 → ∞, eliminating cell-bounds-clamp wall-hugging.
        const lambdaReg = relCutoff * Math.abs(eig.values[0])
        sym3Mul(M, massVec[0], massVec[1], massVec[2], Mmass)
        sym3SolveTikhonov(
            eig,
            bvec[0] - Mmass[0],
            bvec[1] - Mmass[1],
            bvec[2] - Mmass[2],
            lambdaReg,
            correction,
        )
        let nxv = massVec[0] + correction[0]
        let nyv = massVec[1] + correction[1]
        let nzv = massVec[2] + correction[2]

        // Cell-bounds clamp (always on). This is the topological invariant.
        let cxNew = nxv, cyNew = nyv, czNew = nzv
        let cellClamped = false
        if (cxNew < bxLo) { cxNew = bxLo; cellClamped = true }
        else if (cxNew > bxHi) { cxNew = bxHi; cellClamped = true }
        if (cyNew < byLo) { cyNew = byLo; cellClamped = true }
        else if (cyNew > byHi) { cyNew = byHi; cellClamped = true }
        if (czNew < bzLo) { czNew = bzLo; cellClamped = true }
        else if (czNew > bzHi) { czNew = bzHi; cellClamped = true }
        if (cellClamped) clampedByCell++

        // Optional extra clamp against displacement from the original DC
        // position (e.g. when the user asks for very conservative motion).
        if (maxDisp !== undefined && maxDisp > 0) {
            let dxv = cxNew - px0
            let dyv = cyNew - py0
            let dzv = czNew - pz0
            const distSq = dxv * dxv + dyv * dyv + dzv * dzv
            if (distSq > maxDisp * maxDisp) {
                const k = maxDisp / Math.sqrt(distSq)
                dxv *= k; dyv *= k; dzv *= k
                cxNew = px0 + dxv
                cyNew = py0 + dyv
                czNew = pz0 + dzv
                clampedByMaxDisplacement++
            }
        }

        if (cxNew !== px0 || cyNew !== py0 || czNew !== pz0) relocated++

        outVerts[base] = cxNew
        outVerts[base + 1] = cyNew
        outVerts[base + 2] = czNew
        outVerts[base + 3] = 0

        // Re-derive vertex normal from the mean of edge-crossing normals.
        const nl = Math.hypot(sumNx, sumNy, sumNz)
        if (nl > 1e-20) {
            const k = 1 / nl
            outVerts[base + 4] = sumNx * k
            outVerts[base + 5] = sumNy * k
            outVerts[base + 6] = sumNz * k
        } else {
            outVerts[base + 4] = inVerts[base + 4]!
            outVerts[base + 5] = inVerts[base + 5]!
            outVerts[base + 6] = inVerts[base + 6]!
        }
        outVerts[base + 7] = 0
    }

    const stats: RelocationStats = {
        vertexCount: vertCount,
        relocated,
        pointFeatures,
        edgeFeatures,
        flatFeatures,
        emptyCells,
        clampedByCell,
        clampedByMaxDisplacement,
        elapsedMs: perfNow() - t0,
    }
    dbgLog("ShrecExport").debug(
        `mergeSharpRelocate: vertices=${stats.vertexCount} relocated=${stats.relocated} ` +
        `point=${stats.pointFeatures} edge=${stats.edgeFeatures} flat=${stats.flatFeatures} ` +
        `empty=${stats.emptyCells} cellClamped=${stats.clampedByCell} ` +
        `maxDispClamped=${stats.clampedByMaxDisplacement} elapsed=${stats.elapsedMs.toFixed(1)}ms`,
    )

    return {
        mesh: { verts: outVerts, tris: dcMesh.tris },
        stats,
    }
}

function perfNow(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}
