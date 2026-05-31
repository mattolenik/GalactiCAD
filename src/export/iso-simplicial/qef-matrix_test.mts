import assert from "node:assert/strict"
import test from "node:test"
import { jacobiSymmetric, symMatPseudoinverse, type SymMat } from "./qef-matrix.mjs"

/** Sum of `k` rank-1 outer products `scale²·vᵥᵀ` — mimics an accumulated QEF normal-equation block. */
function accumulatedNormalEquations(n: number, scale: number, k = 400): SymMat {
    const a = new Float64Array(n * n)
    for (let s = 0; s < k; s++) {
        const v = new Float64Array(n)
        for (let i = 0; i < n; i++) v[i] = Math.sin(1.7 * s + 2.3 * i + 0.5) * scale
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) a[i * n + j] += v[i]! * v[j]!
    }
    return a
}

/** max|A − V·diag(d)·Vᵀ| relative to the dominant eigenvalue. */
function eigenReconstructionRelError(a: SymMat, n: number, d: Float64Array, v: SymMat): number {
    let maxErr = 0
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            let s = 0
            for (let k = 0; k < n; k++) s += v[i * n + k]! * d[k]! * v[j * n + k]!
            maxErr = Math.max(maxErr, Math.abs(s - a[i * n + j]!))
        }
    }
    return maxErr / (Math.abs(d[0]!) || 1)
}

// Regression: the float reference's absolute `sm == 0` convergence test was ported
// as a fixed absolute threshold, which is unreachable in double precision for
// large-magnitude matrices — the solver exhausted its sweep budget and threw
// ("too many iterations"), aborting the entire iso-simplicial mesh export. The
// relative convergence criterion must diagonalize these without throwing.
test("jacobiSymmetric: converges on large-magnitude QEF matrices (no throw)", () => {
    for (const [n, scale] of [[3, 1], [4, 10], [7, 100]] as const) {
        const a = accumulatedNormalEquations(n, scale)
        const d = new Float64Array(n)
        const v = new Float64Array(n * n)
        assert.doesNotThrow(() => jacobiSymmetric(a, n, d, v))
        assert.ok(d.every(Number.isFinite), `n=${n}: eigenvalues finite`)
        const relErr = eigenReconstructionRelError(a, n, d, v)
        assert.ok(relErr < 1e-12, `n=${n}: eigen reconstruction rel error ${relErr} should be ~machine precision`)
        const inv = symMatPseudoinverse(a, n)
        assert.ok(inv.every(Number.isFinite), `n=${n}: pseudoinverse finite`)
    }
})

test("jacobiSymmetric: eigenvalues sorted by descending magnitude", () => {
    const n = 4
    const a = accumulatedNormalEquations(n, 5)
    const d = new Float64Array(n)
    const v = new Float64Array(n * n)
    jacobiSymmetric(a, n, d, v)
    for (let i = 1; i < n; i++) {
        assert.ok(Math.abs(d[i - 1]!) >= Math.abs(d[i]!), `|d[${i - 1}]| >= |d[${i}]|`)
    }
})

test("jacobiSymmetric: diagonal matrix is already converged", () => {
    const n = 3
    const a = new Float64Array([5, 0, 0, 0, 2, 0, 0, 0, 9])
    const d = new Float64Array(n)
    const v = new Float64Array(n * n)
    jacobiSymmetric(a, n, d, v)
    // descending magnitude: 9, 5, 2
    assert.deepEqual([...d], [9, 5, 2])
})
