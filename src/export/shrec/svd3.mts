/**
 * 3x3 symmetric eigendecomposition + regularized pseudo-inverse.
 *
 * Used by MergeSharp to solve the per-vertex QEF
 *   minimise Σ‖n_i · (x - p_i) - d_i‖²
 * which reduces to the 3x3 normal equations  A x = b  where
 *   A = Σ n_i n_iᵀ   (symmetric positive semi-definite, 3x3)
 *   b = Σ (n_i · p_i + d_i) n_i
 *
 * MergeSharp needs the **rank-aware** pseudo-inverse of `A` so it can
 * distinguish:
 *   - rank 3 → sharp corner (point feature)
 *   - rank 2 → sharp edge   (line feature; one direction is unconstrained)
 *   - rank 1 → flat surface (two directions are unconstrained)
 * Singular values below a threshold are zeroed out in the inverse, which
 * snaps the solution onto the strongest constraint subspace and keeps
 * unconstrained directions at the mass-point fallback (see merge-sharp.mts).
 *
 * Algorithm: cyclic Jacobi rotations on a symmetric 3x3 matrix. Converges in
 * ~6–10 sweeps for any 3x3 input; we cap at 32 to be safe. This is the same
 * approach used by virtually every textbook DC / sharp-feature implementation
 * (e.g. Wenger's IJK code paths and the various open-source DC ports).
 */

/** Eigendecomposition of a 3x3 symmetric matrix. */
export interface Sym3Eigen {
    /** Eigenvalues, **sorted descending by absolute value**. */
    values: [number, number, number]
    /** Eigenvector columns, in the same order as `values`; orthonormal. */
    vectors: [
        [number, number, number],
        [number, number, number],
        [number, number, number],
    ]
}

/** A 3x3 symmetric matrix laid out by lower-triangle entries. */
export interface Sym3 {
    a00: number; a01: number; a02: number
    /***/        a11: number; a12: number
    /***/        /***/        a22: number
}

export function sym3Zero(): Sym3 {
    return { a00: 0, a01: 0, a02: 0, a11: 0, a12: 0, a22: 0 }
}

/** In-place add `n nᵀ` (rank-1 outer product of `n` with itself, weighted). */
export function sym3AddOuter(m: Sym3, nx: number, ny: number, nz: number, w = 1): void {
    m.a00 += w * nx * nx
    m.a01 += w * nx * ny
    m.a02 += w * nx * nz
    m.a11 += w * ny * ny
    m.a12 += w * ny * nz
    m.a22 += w * nz * nz
}

/** `dst = m * v`, where `v` is a 3-vector. */
export function sym3Mul(m: Sym3, vx: number, vy: number, vz: number, dst: [number, number, number]): void {
    dst[0] = m.a00 * vx + m.a01 * vy + m.a02 * vz
    dst[1] = m.a01 * vx + m.a11 * vy + m.a12 * vz
    dst[2] = m.a02 * vx + m.a12 * vy + m.a22 * vz
}

/**
 * Cyclic Jacobi eigendecomposition of a 3x3 symmetric matrix.
 *
 * Returns eigenvalues sorted by descending **absolute** value with matching
 * orthonormal eigenvector columns. Always succeeds; for ill-conditioned
 * inputs (zero matrix, rank-deficient) the smaller eigenvalues simply come
 * out near zero, which is exactly what the rank-aware pseudo-inverse needs.
 */
export function sym3Eigen(m: Sym3): Sym3Eigen {
    // Working symmetric matrix (mutated in place).
    let a00 = m.a00, a01 = m.a01, a02 = m.a02
    let a11 = m.a11, a12 = m.a12
    let a22 = m.a22

    // Accumulated rotation matrix V; columns are eigenvectors at convergence.
    let v00 = 1, v01 = 0, v02 = 0
    let v10 = 0, v11 = 1, v12 = 0
    let v20 = 0, v21 = 0, v22 = 1

    const TOL = 1e-12
    const MAX_SWEEPS = 32

    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
        const off = Math.abs(a01) + Math.abs(a02) + Math.abs(a12)
        if (off < TOL) break

        // Rotate (0,1), (0,2), (1,2) in turn — one full Jacobi sweep.
        // Each rotation zeros the targeted off-diagonal entry exactly.
        // Rotation (0,1):
        if (Math.abs(a01) > TOL) {
            const theta = (a11 - a00) / (2 * a01)
            const t = theta >= 0
                ? 1 / (theta + Math.sqrt(1 + theta * theta))
                : 1 / (theta - Math.sqrt(1 + theta * theta))
            const c = 1 / Math.sqrt(1 + t * t)
            const s = t * c

            const newA00 = a00 - t * a01
            const newA11 = a11 + t * a01
            const newA02 = c * a02 - s * a12
            const newA12 = s * a02 + c * a12
            a00 = newA00; a11 = newA11; a01 = 0
            a02 = newA02; a12 = newA12

            // Update V: V := V * R(0,1; c,s)
            const nv00 = c * v00 - s * v01
            const nv01 = s * v00 + c * v01
            v00 = nv00; v01 = nv01
            const nv10 = c * v10 - s * v11
            const nv11 = s * v10 + c * v11
            v10 = nv10; v11 = nv11
            const nv20 = c * v20 - s * v21
            const nv21 = s * v20 + c * v21
            v20 = nv20; v21 = nv21
        }

        // Rotation (0,2):
        if (Math.abs(a02) > TOL) {
            const theta = (a22 - a00) / (2 * a02)
            const t = theta >= 0
                ? 1 / (theta + Math.sqrt(1 + theta * theta))
                : 1 / (theta - Math.sqrt(1 + theta * theta))
            const c = 1 / Math.sqrt(1 + t * t)
            const s = t * c

            const newA00 = a00 - t * a02
            const newA22 = a22 + t * a02
            const newA01 = c * a01 - s * a12
            const newA12 = s * a01 + c * a12
            a00 = newA00; a22 = newA22; a02 = 0
            a01 = newA01; a12 = newA12

            const nv00 = c * v00 - s * v02
            const nv02 = s * v00 + c * v02
            v00 = nv00; v02 = nv02
            const nv10 = c * v10 - s * v12
            const nv12 = s * v10 + c * v12
            v10 = nv10; v12 = nv12
            const nv20 = c * v20 - s * v22
            const nv22 = s * v20 + c * v22
            v20 = nv20; v22 = nv22
        }

        // Rotation (1,2):
        if (Math.abs(a12) > TOL) {
            const theta = (a22 - a11) / (2 * a12)
            const t = theta >= 0
                ? 1 / (theta + Math.sqrt(1 + theta * theta))
                : 1 / (theta - Math.sqrt(1 + theta * theta))
            const c = 1 / Math.sqrt(1 + t * t)
            const s = t * c

            const newA11 = a11 - t * a12
            const newA22 = a22 + t * a12
            const newA01 = c * a01 - s * a02
            const newA02 = s * a01 + c * a02
            a11 = newA11; a22 = newA22; a12 = 0
            a01 = newA01; a02 = newA02

            const nv01 = c * v01 - s * v02
            const nv02 = s * v01 + c * v02
            v01 = nv01; v02 = nv02
            const nv11 = c * v11 - s * v12
            const nv12 = s * v11 + c * v12
            v11 = nv11; v12 = nv12
            const nv21 = c * v21 - s * v22
            const nv22 = s * v21 + c * v22
            v21 = nv21; v22 = nv22
        }
    }

    // Eigenvalues live on the diagonal at convergence.
    const e0 = a00, e1 = a11, e2 = a22
    const cols: [
        [number, number, number],
        [number, number, number],
        [number, number, number],
    ] = [
        [v00, v10, v20],
        [v01, v11, v21],
        [v02, v12, v22],
    ]
    const vals: [number, number, number] = [e0, e1, e2]

    // Sort by descending |eigenvalue| (paired sort with eigenvector columns).
    const order: [number, number, number] = [0, 1, 2]
    order.sort((a, b) => Math.abs(vals[b]!) - Math.abs(vals[a]!)) as unknown
    return {
        values: [vals[order[0]]!, vals[order[1]]!, vals[order[2]]!],
        vectors: [cols[order[0]]!, cols[order[1]]!, cols[order[2]]!],
    }
}

/**
 * Apply the rank-aware pseudo-inverse of a symmetric 3x3 matrix to a vector.
 *
 * `eig` is the eigendecomposition of `A`. Singular values smaller than
 * `relCutoff * |λmax|` are dropped (treated as zero), so the solution is
 * confined to the subspace spanned by the dominant eigenvectors.
 *
 * Returns `Σ_{|λi|>cut} (eᵢ · v) eᵢ / λᵢ`.
 */
export function sym3SolvePInv(
    eig: Sym3Eigen,
    vx: number, vy: number, vz: number,
    relCutoff: number,
    dst: [number, number, number],
): void {
    const lmax = Math.abs(eig.values[0])
    const cut = relCutoff * lmax
    let rx = 0, ry = 0, rz = 0
    for (let i = 0; i < 3; i++) {
        const lam = eig.values[i]!
        if (Math.abs(lam) <= cut) continue
        const e = eig.vectors[i]!
        const dot = e[0] * vx + e[1] * vy + e[2] * vz
        const k = dot / lam
        rx += k * e[0]
        ry += k * e[1]
        rz += k * e[2]
    }
    dst[0] = rx
    dst[1] = ry
    dst[2] = rz
}

/**
 * Estimate the geometric "rank" of the constraint system implied by `eig`,
 * given the relative cutoff. Returns 0..3.
 *
 * - 0 → no usable constraints (vertex on a degenerate region; should fall back to mass point).
 * - 1 → flat surface (snapping in the strongest gradient direction; tangent plane).
 * - 2 → sharp edge (line feature; one direction is unconstrained).
 * - 3 → sharp corner (point feature; fully constrained).
 *
 * Used **for diagnostic / logging purposes only**. The actual vertex
 * placement uses `sym3SolveTikhonov`, which has a soft transition between
 * ranks and does not depend on this hard classification.
 */
export function sym3Rank(eig: Sym3Eigen, relCutoff: number): 0 | 1 | 2 | 3 {
    const lmax = Math.abs(eig.values[0])
    if (lmax <= 0) return 0
    const cut = relCutoff * lmax
    let rank = 0
    for (let i = 0; i < 3; i++) {
        if (Math.abs(eig.values[i]!) > cut) rank++
    }
    return rank as 0 | 1 | 2 | 3
}

/**
 * Tikhonov-regularized solve of the symmetric 3x3 system `(A + λI) x = v`,
 * where `eig` is the eigendecomposition of `A`.
 *
 * This is the **smooth alternative** to the rank-aware pseudo-inverse:
 * instead of binarily dropping eigenvalues below a cutoff (which causes
 * adjacent cells along a sharp feature to classify into different ranks
 * and snap to slightly different positions, producing wavy / spiky
 * contours), every eigenvalue contribution is scaled by `1 / (λ_i + λ)`.
 *
 * - For `|λ_i| ≫ λ`  (strong feature direction):  contribution ≈ `1/λ_i`
 *   — same as the QEF solution, full sharpness preserved.
 * - For `|λ_i| ≪ λ`  (unconstrained direction):  contribution ≈ `1/λ`
 *   — bounded, small, smoothly damped.
 * - For `|λ_i| ~ λ`  (marginal feature):  contribution smoothly between
 *   the two regimes — no rank-classification discontinuity.
 *
 * The caller normally pairs this with a mass-point shift so the residual
 * `v = b - A·mass` is small and the solution lives near the mass point
 * for poorly-constrained directions:
 *
 *     correction = (A + λI)⁻¹ (b - A·mass)
 *     x          = mass + correction
 *
 * `lambdaReg` should be chosen as a small fraction of `|λmax|` (e.g.
 * `0.05 * eig.values[0]`), so the regularization scales with the QEF's
 * strength and stays meaningful at any geometric scale.
 */
export function sym3SolveTikhonov(
    eig: Sym3Eigen,
    vx: number, vy: number, vz: number,
    lambdaReg: number,
    dst: [number, number, number],
): void {
    let rx = 0, ry = 0, rz = 0
    for (let i = 0; i < 3; i++) {
        const denom = eig.values[i]! + lambdaReg
        if (Math.abs(denom) < 1e-30) continue
        const e = eig.vectors[i]!
        const dot = e[0] * vx + e[1] * vy + e[2] * vz
        const k = dot / denom
        rx += k * e[0]
        ry += k * e[1]
        rz += k * e[2]
    }
    dst[0] = rx
    dst[1] = ry
    dst[2] = rz
}
