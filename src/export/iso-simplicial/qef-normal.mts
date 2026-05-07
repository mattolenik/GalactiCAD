/**
 * Packed QEF accumulation (`QEFNormal::combineSelf`) and unpack to normal equations
 * (`A`, `B`) — reference: docs/reference_impl/isosurf/isosurf/qefnorm.h.
 *
 * Hermite samples must use the same equation ordering as `iso_method_ours.h`
 * (`vertNode` / `vertFace` / `vertEdge`).
 */

import type { SymMat } from "./qef-matrix.mjs"
import { symMatZeros } from "./qef-matrix.mjs"

/** Length `(unknownDim+1)*(unknownDim+2)/2` upper triangle of outer products Σ eqᵢ eqⱼ. */
export function qefPackedLength(unknownDim: number): number {
    return ((unknownDim + 1) * (unknownDim + 2)) / 2
}

export function zeroQefPacked(unknownDim: number): Float64Array {
    return new Float64Array(qefPackedLength(unknownDim))
}

/**
 * Add one Hermite plane equation to the packed QEF.
 * `eqn` has length `unknownDim + 1` (e.g. cube: 5 coeffs `[nx,ny,nz,-1,d]`).
 */
export function qefAccumulatePlane(eqn: ArrayLike<number>, packed: Float64Array): void {
    const m = eqn.length
    let idx = 0
    for (let i = 0; i < m; i++) {
        const ei = eqn[i]!
        for (let j = i; j < m; j++) {
            packed[idx++] += ei * eqn[j]!
        }
    }
}

/**
 * Build symmetric `A` (unknownDim×unknownDim) and rhs `B` from packed QEF data.
 * Reference unpack in `TNode::vertNode` / `vertFace` / `vertEdge`.
 */
export function unpackNormalEquations(packed: Float64Array, unknownDim: number): { a: SymMat; b: Float64Array } {
    const n = unknownDim
    const a = symMatZeros(n)
    const b = new Float64Array(n)
    for (let i = 0; i < n; i++) {
        const index = ((2 * n + 3 - i) * i) / 2
        for (let j = i; j < n; j++) {
            const v = packed[index + j - i]!
            a[i * n + j] = v
            a[j * n + i] = v
        }
        b[i] = -packed[index + n - i]!
    }
    return { a, b }
}
