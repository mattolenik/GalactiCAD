/**
 * Symmetric matrix pseudoinverse via Jacobi eigen-decomposition (reference:
 * docs/reference_impl/isosurf/isosurf/qefnorm.h — `jacobi`, `matInverse`).
 * Used by iso-simplicial dual vertex QEF minimizers (cube / face / edge).
 */

/** Row-major `n×n`, symmetric. */
export type SymMat = Float64Array

/**
 * Max Jacobi sweeps before giving up. The float reference (`qefnorm.h`) uses 50;
 * double precision plus the indefinite augmented (saddle-point) systems used by
 * the constrained QEF cascade occasionally want a few more, so allow headroom.
 */
const JACOBI_MAX_SWEEPS = 100

/**
 * Relative off-diagonal convergence tolerance. The reference compares the
 * off-diagonal sum to exactly `0` in single precision, relying on the relative
 * per-element zeroing test to drive off-diagonals to a hard zero within a few
 * sweeps. In double precision that exact-zero never lands for large-magnitude
 * matrices, so we instead converge when the off-diagonal sum is negligible
 * *relative to the diagonal magnitude* — a scale-invariant criterion (a few
 * machine epsilons of slack).
 */
const JACOBI_OFFDIAG_REL_EPS = 1e-14

export function symMatZeros(n: number): SymMat {
    return new Float64Array(n * n)
}

/** Copy upper triangle from row-major symmetric matrix into flat packed upper triangle length `n*(n+1)/2`, row i cols j>=i. */
export function symMatPackUpper(a: SymMat, n: number, out: Float64Array): void {
    let k = 0
    for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
            out[k++] = a[i * n + j]
        }
    }
}

/**
 * Jacobi diagonalization: symmetric `a` (n×n row-major) → eigenvalues `d` in descending `|λ|` order,
 * eigenvectors as columns of `v` (n×n row-major) reordered to match `d`. The descending sort matches
 * reference `qefnorm.h::jacobi`, which is required for `matInverse`'s tolerance check `|w[i]/w[0]|`
 * (it assumes `w[0]` is the largest magnitude eigenvalue).
 */
export function jacobiSymmetric(aIn: SymMat, n: number, d: Float64Array, v: SymMat): void {
    const a = new Float64Array(n * n)
    a.set(aIn)

    for (let ip = 0; ip < n; ip++) {
        for (let iq = 0; iq < n; iq++) {
            v[ip * n + iq] = ip === iq ? 1 : 0
        }
    }

    const b = new Float64Array(n)
    const z = new Float64Array(n)
    for (let ip = 0; ip < n; ip++) {
        b[ip] = a[ip * n + ip]
        d[ip] = b[ip]
        z[ip] = 0
    }

    for (let iter = 1; iter <= JACOBI_MAX_SWEEPS; iter++) {
        let sm = 0
        for (let ip = 0; ip < n - 1; ip++) {
            for (let iq = ip + 1; iq < n; iq++) {
                sm += Math.abs(a[ip * n + iq])
            }
        }

        // Reference compares `sm == 0` exactly (single precision). In double we
        // converge when the off-diagonal sum is negligible relative to the
        // diagonal magnitude — a fixed absolute threshold is unreachable for
        // large-magnitude QEF matrices and spins out the sweep budget. `!(... >)`
        // also exits cleanly on a degenerate `sm` (e.g. NaN) rather than looping.
        let diagMag = 0
        for (let ip = 0; ip < n; ip++) diagMag += Math.abs(d[ip])
        if (!(sm > JACOBI_OFFDIAG_REL_EPS * diagMag)) {
            sortEigDescending(d, v, n)
            return
        }

        const tresh = iter < 4 ? (0.2 * sm) / (n * n) : 0

        for (let ip = 0; ip < n - 1; ip++) {
            for (let iq = ip + 1; iq < n; iq++) {
                let g = 100 * Math.abs(a[ip * n + iq])
                if (
                    iter > 4 &&
                    Math.abs(d[ip]) + g === Math.abs(d[ip]) &&
                    Math.abs(d[iq]) + g === Math.abs(d[iq])
                ) {
                    a[ip * n + iq] = 0
                } else if (Math.abs(a[ip * n + iq]) > tresh) {
                    let h = d[iq] - d[ip]
                    let t: number
                    if (Math.abs(h) + g === Math.abs(h)) {
                        t = a[ip * n + iq] / h
                    } else {
                        const theta = 0.5 * h / a[ip * n + iq]
                        t = 1 / (Math.abs(theta) + Math.sqrt(1 + theta * theta))
                        if (theta < 0) t = -t
                    }

                    const c = 1 / Math.sqrt(1 + t * t)
                    const s = t * c
                    const tau = s / (1 + c)
                    h = t * a[ip * n + iq]
                    z[ip] -= h
                    z[iq] += h
                    d[ip] -= h
                    d[iq] += h
                    a[ip * n + iq] = 0

                    for (let j = 0; j <= ip - 1; j++) {
                        rotate(a, n, j, ip, j, iq, s, tau)
                    }
                    for (let j = ip + 1; j <= iq - 1; j++) {
                        rotate(a, n, ip, j, j, iq, s, tau)
                    }
                    for (let j = iq + 1; j < n; j++) {
                        rotate(a, n, ip, j, iq, j, s, tau)
                    }
                    for (let j = 0; j < n; j++) {
                        rotate(v, n, j, ip, j, iq, s, tau)
                    }
                }
            }
        }

        for (let ip = 0; ip < n; ip++) {
            b[ip] += z[ip]
            d[ip] = b[ip]
            z[ip] = 0
        }
    }

    // Non-convergence within the sweep budget. The off-diagonals are tiny by
    // now, so return the best-effort decomposition rather than throwing — the
    // reference `exit(1)`s here, but in the browser one pathological cell must
    // not abort the entire mesh export. The constrained QEF cascade clamps the
    // resulting vertex to the cell bounds, so a slightly-imprecise solve for a
    // single cell is harmless.
    sortEigDescending(d, v, n)
}

function rotate(
    mat: Float64Array,
    n: number,
    i: number,
    j: number,
    k: number,
    l: number,
    s: number,
    tau: number,
): void {
    const g = mat[i * n + j]
    const h = mat[k * n + l]
    mat[i * n + j] = g - s * (h + g * tau)
    mat[k * n + l] = h + s * (g - h * tau)
}

/**
 * Sort eigenvalues `d` by `|λ|` descending and reorder eigenvector columns of `v` to match.
 * `matInverse`'s tolerance check `|w[i]/w[0]| < tol` requires `w[0]` to be the largest magnitude
 * eigenvalue; without this, rank-deficient QEFs (creases/corners) get a catastrophic `1/λ_min`
 * regularization instead of zeroing the small mode.
 */
function sortEigDescending(d: Float64Array, v: SymMat, n: number): void {
    for (let i = 0; i < n - 1; i++) {
        let maxIdx = i
        let maxAbs = Math.abs(d[i]!)
        for (let j = i + 1; j < n; j++) {
            const a = Math.abs(d[j]!)
            if (a > maxAbs) {
                maxAbs = a
                maxIdx = j
            }
        }
        if (maxIdx !== i) {
            const tmp = d[i]!
            d[i] = d[maxIdx]!
            d[maxIdx] = tmp
            for (let r = 0; r < n; r++) {
                const tv = v[r * n + i]!
                v[r * n + i] = v[r * n + maxIdx]!
                v[r * n + maxIdx] = tv
            }
        }
    }
}

/** Matches `matInverse` inverse eigenweights: zero small `λᵢ` vs `λ₀`, then `inv = Σ_k w_k u_k u_kᵀ`. */
function invertEigenWeightsRef(eig: Float64Array, n: number, tolerance: number): Float64Array {
    const w = new Float64Array(n)
    for (let i = 1; i < n; i++) {
        w[i] = Math.abs(eig[i] / eig[0]) < tolerance ? 0 : 1 / eig[i]
    }
    w[0] = 1 / eig[0]
    return w
}

/**
 * Symmetric pseudoinverse (reference `matInverse<double,n>` first overload).
 */
export function symMatPseudoinverse(a: SymMat, n: number, tolerance = 1e-6): SymMat {
    const eig = new Float64Array(n)
    const v = symMatZeros(n)
    jacobiSymmetric(a, n, eig, v)
    const w = invertEigenWeightsRef(eig, n, tolerance)
    const inv = symMatZeros(n)
    /** Columns of `v` are eigenvectors (`jacobiSymmetric` matches Numerical Recipes layout). */
    for (let ip = 0; ip < n; ip++) {
        for (let iq = 0; iq < n; iq++) {
            let s = 0
            for (let k = 0; k < n; k++) {
                s += w[k] * v[ip * n + k] * v[iq * n + k]
            }
            inv[ip * n + iq] = s
        }
    }
    return inv
}

/** `x[i] = sum_j inv[i,j]*b[j]` for row-major symmetric `inv`. */
export function symMatVec(inv: SymMat, n: number, b: Float64Array): Float64Array {
    const x = new Float64Array(n)
    for (let i = 0; i < n; i++) {
        let s = 0
        for (let j = 0; j < n; j++) {
            s += inv[i * n + j] * b[j]
        }
        x[i] = s
    }
    return x
}

