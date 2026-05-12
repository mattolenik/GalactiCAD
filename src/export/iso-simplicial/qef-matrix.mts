/**
 * Symmetric matrix pseudoinverse via Jacobi eigen-decomposition (reference:
 * docs/reference_impl/isosurf/isosurf/qefnorm.h — `jacobi`, `matInverse`).
 * Used by iso-simplicial dual vertex QEF minimizers (cube / face / edge).
 */

/** Row-major `n×n`, symmetric. */
export type SymMat = Float64Array

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
 * Jacobi diagonalization: symmetric `a` (n×n row-major) → eigenvalues `d`, eigenvectors as rows of `v` (n×n row-major),
 * matching the reference `jacobi` / `matInverse` reconstruction (`w[k] * u[k][i] * u[k][j]`).
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

    for (let iter = 1; iter <= 50; iter++) {
        let sm = 0
        for (let ip = 0; ip < n - 1; ip++) {
            for (let iq = ip + 1; iq < n; iq++) {
                sm += Math.abs(a[ip * n + iq])
            }
        }

        /** Reference compares `sm == 0` exactly; double arithmetic needs a tolerance. */
        if (sm < 1e-14 * n * n) {
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

    throw new Error("jacobiSymmetric: too many iterations")
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

/**
 * Solve `A x = b` for dense row-major `A` via Gaussian elimination with partial pivoting.
 * Reference Jacobi+pseudoinverse is parity-sensitive; unconstrained/constrained QEF systems use this for stability.
 */
export function solveLinearSystem(aIn: SymMat, n: number, bIn: Float64Array, pivotEps = 1e-12): Float64Array {
    const A = new Float64Array(aIn)
    const b = Float64Array.from(bIn)

    for (let k = 0; k < n; k++) {
        let piv = k
        let maxAbs = Math.abs(A[k * n + k])
        for (let r = k + 1; r < n; r++) {
            const v = Math.abs(A[r * n + k])
            if (v > maxAbs) {
                maxAbs = v
                piv = r
            }
        }
        if (maxAbs < pivotEps) {
            throw new Error(`solveLinearSystem: singular or ill-conditioned (pivot ${maxAbs} at column ${k})`)
        }
        if (piv !== k) {
            for (let c = 0; c < n; c++) {
                const t = A[piv * n + c]
                A[piv * n + c] = A[k * n + c]
                A[k * n + c] = t
            }
            const tb = b[piv]!
            b[piv] = b[k]!
            b[k] = tb
        }

        const akk = A[k * n + k]!
        for (let r = k + 1; r < n; r++) {
            const f = A[r * n + k]! / akk
            A[r * n + k] = 0
            for (let c = k + 1; c < n; c++) {
                A[r * n + c]! -= f * A[k * n + c]!
            }
            b[r]! -= f * b[k]!
        }
    }

    const x = new Float64Array(n)
    for (let i = n - 1; i >= 0; i--) {
        let s = b[i]!
        for (let j = i + 1; j < n; j++) {
            s -= A[i * n + j]! * x[j]!
        }
        x[i] = s / A[i * n + i]!
    }
    return x
}
