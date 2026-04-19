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
import { MESH_MDC_DEBUG_SAMPLE_STRIDE, type MeshData } from "../export.mjs"
import type { GridSampleResult } from "../grid-sample.mjs"
import type { DualContourMesh } from "./dc-cpu.mjs"
import {
    type ContourSpatialIndex,
    type ContourSnapResult,
    type SnapScratch,
    makeSnapScratch,
    trySnapToContours,
} from "./contour-snap.mjs"
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

/** The 8 cube-corner offsets in cell-local voxel coordinates. */
const CELL_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
]

/**
 * Decide whether the cell at `(cx, cy, cz)` sits on a coherent CSG seam
 * line. Reads the seam tangent at each of the cell's 8 corner voxels from
 * `seamTangent` (vec4 per voxel: xyz = unit tangent, w = validity). If at
 * least 2 corners report a usable tangent and all of them agree within
 * `cosThreshold` (after sign-disambiguation), writes the unit average
 * direction into `outT` and returns `true`.
 *
 * Rationale: each voxel reports a seam tangent independently, so along a
 * straight CSG edge every corner sees the same direction (up to sign).
 * Disagreement signals either a corner where multiple seams meet (better
 * solved by the unconstrained QEF, which can pin a 3D point) or that the
 * cell is on a smooth blend / single primitive surface where seam metadata
 * is meaningless and the standard QEF should run.
 */
function classifyCellSeam(
    seamTangent: Float32Array,
    nx: number,
    ny: number,
    cx: number,
    cy: number,
    cz: number,
    cosThreshold: number,
    outT: [number, number, number],
): boolean {
    let sumX = 0, sumY = 0, sumZ = 0
    let firstX = 0, firstY = 0, firstZ = 0
    let count = 0

    // First pass: collect valid tangents and accumulate them with consistent
    // sign relative to the first one we find. (Tangents define a line, not a
    // direction — `+T` and `−T` describe the same edge.)
    for (let i = 0; i < 8; i++) {
        const off = CELL_CORNERS[i]!
        const vidx = ((cz + off[2]) * ny + (cy + off[1])) * nx + (cx + off[0])
        const k = vidx * 4
        if (seamTangent[k + 3]! < 0.5) continue
        let tx = seamTangent[k]!, ty = seamTangent[k + 1]!, tz = seamTangent[k + 2]!
        if (count === 0) {
            firstX = tx; firstY = ty; firstZ = tz
        } else if (tx * firstX + ty * firstY + tz * firstZ < 0) {
            tx = -tx; ty = -ty; tz = -tz
        }
        sumX += tx; sumY += ty; sumZ += tz
        count++
    }
    if (count < 2) return false

    const len = Math.hypot(sumX, sumY, sumZ)
    if (len < 1e-12) return false
    const Tx = sumX / len, Ty = sumY / len, Tz = sumZ / len

    // Second pass: every contributing tangent must agree with the average
    // within `cosThreshold` (sign-corrected via |dot|). Any single corner
    // disagreement means the cell straddles two seams and should fall
    // through to the unconstrained Tikhonov path.
    for (let i = 0; i < 8; i++) {
        const off = CELL_CORNERS[i]!
        const vidx = ((cz + off[2]) * ny + (cy + off[1])) * nx + (cx + off[0])
        const k = vidx * 4
        if (seamTangent[k + 3]! < 0.5) continue
        const tx = seamTangent[k]!, ty = seamTangent[k + 1]!, tz = seamTangent[k + 2]!
        const agreement = Math.abs(tx * Tx + ty * Ty + tz * Tz)
        if (agreement < cosThreshold) return false
    }

    outT[0] = Tx; outT[1] = Ty; outT[2] = Tz
    return true
}

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

    /**
     * Enable the seam-aware QEF path. When true and the cell's corner voxels
     * report consistent CSG seam tangents (from `grid.seamTangent`), the
     * per-cell QEF collapses to a 1D least-squares along the seam line —
     * eliminating residual sub-voxel jitter that the unconstrained Tikhonov
     * solve leaves on long sharp edges. Cells without a usable seam tangent
     * fall through to the existing Tikhonov path. Default `true`.
     */
    seamAwareEnabled?: boolean

    /**
     * Cosine of the angle threshold the seam-aware path uses to decide that
     * a cell's corner tangents agree closely enough to constrain the QEF
     * along a single line. Default `cos(15°) ≈ 0.97`. Lower values (e.g.
     * `0.85` ≈ cos(32°)) admit more cells into the seam path; higher values
     * are stricter.
     */
    seamAgreementCosThreshold?: number

    /**
     * Optional spatial index over the scene's explicit contour features
     * (corners, edges, cap rings — produced by `accumulateContours` per
     * primitive). When supplied, MergeSharp tries to snap each cell's
     * vertex to the nearest valid contour feature **before** running the
     * gradient-based QEF. Snaps are SDF-validated, so contours that have
     * been cut away by CSG operations correctly fall through. When
     * undefined or empty, the contour-snap path is skipped and behaviour
     * is identical to the previous SHREC pipeline.
     */
    contourIndex?: ContourSpatialIndex
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
    /** Cells solved with the seam-aware 1D constrained QEF (along seam tangent). */
    seamConstrained: number
    /** Cells solved with the unconstrained Tikhonov 3D QEF (the fallback path). */
    tikhonovSolved: number
    /** Cells where the seam tangent was in the QEF's null space; mass-point fallback. */
    seamDegenerate: number
    /** Cells whose vertex was snapped to a contour line (klass=1). */
    contourLineSnaps: number
    /** Cells whose vertex was snapped to a contour corner / point (klass=2). */
    contourCornerSnaps: number
    elapsedMs: number
    /**
     * Per-cell debug samples in `MeshMdcDebugData` format
     * (`MESH_MDC_DEBUG_SAMPLE_STRIDE = 24` floats per record). Always
     * populated; the mesh viewer toggles control whether it's drawn, not
     * whether it's emitted. Same shape MDC uses, so it flows through
     * `mesh.debug.mdc.samples` to the existing mesh-viewer checkboxes.
     */
    debugSamples: Float32Array<ArrayBuffer>
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
    const seamAwareEnabled = params.seamAwareEnabled ?? true
    const seamAgreementCos = params.seamAgreementCosThreshold ?? 0.97
    const contourIndex = params.contourIndex
    const contourSnapEnabled = !!contourIndex && !contourIndex.isEmpty
    const snapScratch: SnapScratch | null = contourSnapEnabled ? makeSnapScratch() : null

    const [nx, ny, nz] = grid.dims
    const ox = grid.gridOffset[0]
    const oy = grid.gridOffset[1]
    const oz = grid.gridOffset[2]
    const vs = grid.voxelSize
    const scalar = grid.scalar
    const gradient = grid.gradient
    const seamTangent = grid.seamTangent

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
    // Scratch for the seam-aware path: classified tangent + the
    // M·T product needed for the 1D constrained solve.
    const seamT: [number, number, number] = [0, 0, 0]
    const MseamT: [number, number, number] = [0, 0, 0]

    let pointFeatures = 0
    let edgeFeatures = 0
    let flatFeatures = 0
    let emptyCells = 0
    let relocated = 0
    let clampedByCell = 0
    let clampedByMaxDisplacement = 0
    let seamConstrained = 0
    let tikhonovSolved = 0
    let seamDegenerate = 0
    let contourLineSnaps = 0
    let contourCornerSnaps = 0
    // Per-feature-index snap counts — one bucket per contour element. Lets
    // us see at a glance which specific corners/edges are getting snapped
    // (e.g., for an axis-aligned box: 8 distinct corner indices, 12 distinct
    // segment indices). If counts are missing for some indices, the bug is
    // on the snap side; if all indices have counts but only some glyphs
    // appear, the bug is in the mesh-viewer dedup.
    const cornerSnapHits = new Map<number, number>()
    const lineSnapHits = new Map<number, number>()

    // Per-cell debug samples in the same packed format MDC uses. Mesh viewer
    // reads this from `mesh.debug.mdc.samples` and renders glyphs based on
    // each record's `klass` field. We use:
    //   klass = 1 (line)     → seam-aware path took it; tangent packed below
    //   klass = 5 (rejected) → seam-aware solve was degenerate
    //   klass = 0 (none)     → Tikhonov fallback path took it
    // Always allocated; the cost is `vertCount × 24 × 4` bytes (~1 MB per
    // 10k cells), and the postMessage transfers the buffer rather than copies.
    const debugSamples = new Float32Array(vertCount * MESH_MDC_DEBUG_SAMPLE_STRIDE)

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

        // ---- Cell solve: seam-aware constrained path (preferred) or
        //      unconstrained Tikhonov fallback. -------------------------------
        //
        // The seam-aware path uses the per-voxel CSG seam tangent that
        // sample_grid.wgsl writes when a voxel sits on a hard CSG seam. If
        // the cell's 8 corner voxels report mutually-consistent tangents,
        // we know the cell sits on a single sharp edge whose direction T is
        // exactly known from the SDF — and the QEF collapses to a 1D
        // least-squares along that line:
        //
        //   x = mass + t·T,    t = (T · (b − A·mass)) / (T · A · T)
        //
        // Adjacent cells along the same edge use the **same T** (sourced
        // from the same SDF seam), so their vertices automatically lie on
        // one straight line — no Tikhonov regularization needed, no rank
        // classification, no residual sub-voxel zigzag.
        //
        // Cells without consistent corner tangents (smooth blends, sharp
        // corners where 3+ surfaces meet, single-primitive surfaces) fall
        // through to the existing Tikhonov path.

        sym3Mul(M, massVec[0], massVec[1], massVec[2], Mmass)
        const rhsX = bvec[0] - Mmass[0]
        const rhsY = bvec[1] - Mmass[1]
        const rhsZ = bvec[2] - Mmass[2]

        let nxv: number, nyv: number, nzv: number
        // Track which solve path this cell took so the debug emission below
        // can flag it. Klass map:
        //   0 = Tikhonov fallback (no seam, no contour) — record skipped
        //   1 = seam-line OR contour-line snap        (debug viz: line glyph)
        //   2 = contour-corner snap (point or intersection)  (debug viz: corner glyph)
        //   5 = seam-degenerate                         (debug viz: red square)
        let cellKlass = 0
        // Track the snap result so the debug emission downstream can pack
        // its tangent into N1/N2 the same way the seam-tangent path does.
        let snapResult: ContourSnapResult | null = null

        // ---- Pass 0: explicit-contour snap -------------------------------
        // Try snapping the cell's vertex onto a known scene-tree contour
        // (box edge, box corner, cylinder cap ring, etc.) before falling
        // back to gradient-only QEF. The snap function validates each
        // candidate against the iso-surface so contours that have been
        // cut away by CSG (`difference`, etc.) correctly reject and the
        // cell falls through to the QEF path.
        if (contourSnapEnabled && snapScratch) {
            const cellLoX = ox + cx * vs
            const cellLoY = oy + cy * vs
            const cellLoZ = oz + cz * vs
            const cellHiX = cellLoX + vs
            const cellHiY = cellLoY + vs
            const cellHiZ = cellLoZ + vs
            snapResult = trySnapToContours(
                contourIndex!,
                grid,
                cx, cy, cz,
                cellLoX, cellLoY, cellLoZ,
                cellHiX, cellHiY, cellHiZ,
                px0, py0, pz0,                // query: original DC vertex pos
                snapScratch,
            )
        }

        if (snapResult) {
            nxv = snapResult.x
            nyv = snapResult.y
            nzv = snapResult.z
            cellKlass = snapResult.klass
            if (cellKlass === 1) {
                contourLineSnaps++
                lineSnapHits.set(snapResult.featureIdx, (lineSnapHits.get(snapResult.featureIdx) ?? 0) + 1)
            } else {
                contourCornerSnaps++
                cornerSnapHits.set(snapResult.featureIdx, (cornerSnapHits.get(snapResult.featureIdx) ?? 0) + 1)
            }
        } else {
        const seamPath = seamAwareEnabled
            ? classifyCellSeam(seamTangent, nx, ny, cx, cy, cz, seamAgreementCos, seamT)
            : false
        if (seamPath) {
            // Constrained 1D solve along T.
            sym3Mul(M, seamT[0], seamT[1], seamT[2], MseamT)
            const denom = seamT[0] * MseamT[0] + seamT[1] * MseamT[1] + seamT[2] * MseamT[2]
            // Reject when T lies in (or very near) the QEF's null space —
            // happens only when every contributing edge-crossing normal is
            // perpendicular to T (no positional info along the line). In
            // that case fall back to the mass point in the T direction.
            if (denom > 1e-9 * Math.abs(eig.values[0])) {
                const t = (seamT[0] * rhsX + seamT[1] * rhsY + seamT[2] * rhsZ) / denom
                nxv = massVec[0] + t * seamT[0]
                nyv = massVec[1] + t * seamT[1]
                nzv = massVec[2] + t * seamT[2]
                seamConstrained++
                cellKlass = 1
            } else {
                nxv = massVec[0]; nyv = massVec[1]; nzv = massVec[2]
                seamDegenerate++
                cellKlass = 5
            }
        } else {
            // Tikhonov-regularized 3D solve in mass-point-shifted coordinates:
            //   x = mass + (A + λI)⁻¹ (b - A·mass),  λ = relCutoff · |λmax|
            const lambdaReg = relCutoff * Math.abs(eig.values[0])
            sym3SolveTikhonov(eig, rhsX, rhsY, rhsZ, lambdaReg, correction)
            nxv = massVec[0] + correction[0]
            nyv = massVec[1] + correction[1]
            nzv = massVec[2] + correction[2]
            tikhonovSolved++
            cellKlass = 0
        }
        }   // end of `if (snapResult) … else { … }`

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
        let outNx: number, outNy: number, outNz: number
        if (nl > 1e-20) {
            const k = 1 / nl
            outNx = sumNx * k
            outNy = sumNy * k
            outNz = sumNz * k
            outVerts[base + 4] = outNx
            outVerts[base + 5] = outNy
            outVerts[base + 6] = outNz
        } else {
            outNx = inVerts[base + 4]!
            outNy = inVerts[base + 5]!
            outNz = inVerts[base + 6]!
            outVerts[base + 4] = outNx
            outVerts[base + 5] = outNy
            outVerts[base + 6] = outNz
        }
        outVerts[base + 7] = 0

        // ---- Debug-sample emission ---------------------------------------
        // Only emit a record for cells that produced something interesting:
        // the seam-aware constrained solve (klass=1) or the seam-degenerate
        // fallback (klass=5). Cells that took the plain Tikhonov path
        // (klass=0) are skipped entirely — emitting them would carpet a
        // single-primitive box (which has no CSG seams and therefore no
        // klass=1 cells) in gray dots. Once contour-awareness lands, the
        // box's intrinsic edges will produce klass=1 (or klass=2) records
        // and the overlay will populate with line/corner glyphs.
        if (cellKlass === 0) continue
        // Layout matches `MeshMdcDebugData.samples` so the existing mesh
        // viewer renders SHREC's records with the same point + glyph code.
        // Layout reminder (24 floats):
        //   0..2: position    3:    klass    4..6: normal    7: 0
        //   8..10: feature point (here = vertex pos)         11: 0
        //   12..14: N1 plane normal  15: ownerA (0)
        //   16..18: N2 plane normal  19: ownerB (0)
        //   20..22: ring axisCenter (unused)  23: reserved
        const dbg = vi * MESH_MDC_DEBUG_SAMPLE_STRIDE
        debugSamples[dbg + 0] = cxNew
        debugSamples[dbg + 1] = cyNew
        debugSamples[dbg + 2] = czNew
        debugSamples[dbg + 3] = cellKlass
        debugSamples[dbg + 4] = outNx
        debugSamples[dbg + 5] = outNy
        debugSamples[dbg + 6] = outNz
        // Feature point = vertex position (SHREC has no separate "feature
        // point" — the vertex IS the feature). Same value at 8..10 and 0..2
        // is what the viewer expects when there's no MDC-style snap target.
        debugSamples[dbg + 8] = cxNew
        debugSamples[dbg + 9] = cyNew
        debugSamples[dbg + 10] = czNew

        // For "line" cells (klass=1) — both seam-tangent and contour-segment
        // snaps — pack the line direction `T` into N1/N2 such that the
        // viewer's `tangentFromNormals(N1, N2)` recovers T:
        //   pick world axis least aligned with T
        //   N1 = unit(T × axis)         (perpendicular to T)
        //   N2 = T × N1                  (perpendicular to T and N1)
        //   N1 × N2 = T                  ← what the viewer extracts
        // For "corner" cells (klass=2) the viewer draws a diamond glyph at
        // the position; no tangent direction needed.
        if (cellKlass === 1) {
            // Source the line direction: contour snap took priority and
            // already carries the segment tangent; the seam-aware path
            // populated `seamT` instead.
            const Tx = snapResult ? snapResult.tx : seamT[0]
            const Ty = snapResult ? snapResult.ty : seamT[1]
            const Tz = snapResult ? snapResult.tz : seamT[2]
            const ax = Math.abs(Tx), ay = Math.abs(Ty), az = Math.abs(Tz)
            // World axis least aligned with T (smallest component magnitude).
            let axisX = 0, axisY = 0, axisZ = 0
            if (ax <= ay && ax <= az) axisX = 1
            else if (ay <= az) axisY = 1
            else axisZ = 1
            // N1 = T × worldAxis, normalised.
            let n1x = Ty * axisZ - Tz * axisY
            let n1y = Tz * axisX - Tx * axisZ
            let n1z = Tx * axisY - Ty * axisX
            const n1len = Math.hypot(n1x, n1y, n1z)
            if (n1len > 1e-12) {
                const k = 1 / n1len
                n1x *= k; n1y *= k; n1z *= k
                // N2 = T × N1 (already unit-length: T and N1 are unit and orthogonal).
                const n2x = Ty * n1z - Tz * n1y
                const n2y = Tz * n1x - Tx * n1z
                const n2z = Tx * n1y - Ty * n1x
                debugSamples[dbg + 12] = n1x
                debugSamples[dbg + 13] = n1y
                debugSamples[dbg + 14] = n1z
                debugSamples[dbg + 16] = n2x
                debugSamples[dbg + 17] = n2y
                debugSamples[dbg + 18] = n2z
            }
            if (snapResult) {
                // ownerA = scene-node id; ownerB = stable per-feature index.
                // The mesh viewer's feature-glyph dedup keys on
                // `(klass, ownerA, ownerB)` plus a spatial filter, so
                // distinct edges of the same primitive (same ownerA, same
                // klass) need distinct ownerB to avoid being merged into a
                // single glyph by camera-zoom-dependent dedup radius.
                debugSamples[dbg + 15] = snapResult.ownerId
                debugSamples[dbg + 19] = snapResult.featureIdx
            }
        } else if (cellKlass === 2 && snapResult) {
            debugSamples[dbg + 15] = snapResult.ownerId
            debugSamples[dbg + 19] = snapResult.featureIdx
        }
        // (Other slots — featureDist, ownerA/B, ringAxis, reserved — left at 0
        // by the Float32Array initialisation. Mesh viewer treats them as defaults.)
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
        seamConstrained,
        tikhonovSolved,
        seamDegenerate,
        contourLineSnaps,
        contourCornerSnaps,
        elapsedMs: perfNow() - t0,
        debugSamples,
    }
    dbgLog("ShrecExport").debug(
        `mergeSharpRelocate: vertices=${stats.vertexCount} relocated=${stats.relocated} ` +
        `point=${stats.pointFeatures} edge=${stats.edgeFeatures} flat=${stats.flatFeatures} ` +
        `empty=${stats.emptyCells} cellClamped=${stats.clampedByCell} ` +
        `maxDispClamped=${stats.clampedByMaxDisplacement} ` +
        `contourLine=${stats.contourLineSnaps} contourCorner=${stats.contourCornerSnaps} ` +
        `seamConstrained=${stats.seamConstrained} tikhonov=${stats.tikhonovSolved} seamDegenerate=${stats.seamDegenerate} ` +
        `elapsed=${stats.elapsedMs.toFixed(1)}ms`,
    )
    // Per-feature-index hit table: shows which contour elements actually got
    // snaps. For an axis-aligned box at the origin we expect 8 corner
    // indices (0..7) each with several cell-snaps, and 12 line indices
    // (0..11) each with `~edgeLength/voxelSize` snaps. Missing indices ⇒
    // the snap-side bug; uniform indices ⇒ a viewer-side dedup bug.
    if (cornerSnapHits.size > 0 || lineSnapHits.size > 0) {
        const fmt = (m: Map<number, number>) =>
            Array.from(m.entries()).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(", ")
        dbgLog("ShrecExport").debug(
            `contour-snap by featureIdx: corners {${fmt(cornerSnapHits)}} (${cornerSnapHits.size} distinct), ` +
            `lines {${fmt(lineSnapHits)}} (${lineSnapHits.size} distinct)`,
        )
    }

    return {
        mesh: { verts: outVerts, tris: dcMesh.tris },
        stats,
    }
}

function perfNow(): number {
    return globalThis.performance?.now ? globalThis.performance.now() : Date.now()
}
