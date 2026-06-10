/**
 * Newton projections for SFCC seam work (f64 scalars; analytic carrier
 * gradients — never finite differences). The 2-constraint minimum-norm step is
 * the same math as `src/export/shrec/verify-seam.mts`, lifted to closed-form
 * carrier fields.
 */

import type { SfccStratum } from "./strata.mjs"

const gA = new Float64Array(3)
const gB = new Float64Array(3)

/**
 * Project a point onto the carrier-pair locus {fA = fB = 0} via min-norm
 * Newton (dp = −Jᵀ(JJᵀ)⁻¹r). Returns false when the carriers are near-parallel
 * (‖∇A×∇B‖ < minCross) or the iteration diverges. On success writes the
 * converged point into out (xyz at off).
 */
export function projectToCarrierPair(
    sA: SfccStratum,
    sB: SfccStratum,
    px: number,
    py: number,
    pz: number,
    eps: number,
    minCross: number,
    maxDisplacement: number,
    out: Float64Array,
    off = 0,
): boolean {
    let x = px
    let y = py
    let z = pz
    for (let it = 0; it < 24; it++) {
        const fa = sA.f(x, y, z)
        const fb = sB.f(x, y, z)
        if (Math.abs(fa) <= eps && Math.abs(fb) <= eps) {
            out[off] = x
            out[off + 1] = y
            out[off + 2] = z
            return true
        }
        sA.normal(x, y, z, gA)
        sB.normal(x, y, z, gB)
        // Carrier fields are unit-gradient: J rows are the unit normals.
        const c = gA[0]! * gB[0]! + gA[1]! * gB[1]! + gA[2]! * gB[2]!
        const det = 1 - c * c // = ‖∇A×∇B‖²
        if (det < minCross * minCross) return false
        // Solve [[1, c], [c, 1]] [a, b]ᵀ = [fa, fb]ᵀ
        const a = (fa - c * fb) / det
        const b = (fb - c * fa) / det
        x -= a * gA[0]! + b * gB[0]!
        y -= a * gA[1]! + b * gB[1]!
        z -= a * gA[2]! + b * gB[2]!
        if (Math.hypot(x - px, y - py, z - pz) > maxDisplacement) return false
    }
    return false
}

const gC = new Float64Array(3)

/**
 * Refine a triple point {fA = fB = fC = 0} by 3×3 Newton with analytic
 * carrier gradients. Returns false on a singular Jacobian (three dependent
 * normals) or divergence — callers keep their seed point.
 */
export function projectToTriple(
    sA: SfccStratum,
    sB: SfccStratum,
    sC: SfccStratum,
    px: number,
    py: number,
    pz: number,
    eps: number,
    maxDisplacement: number,
    out: Float64Array,
    off = 0,
): boolean {
    let x = px
    let y = py
    let z = pz
    for (let it = 0; it < 16; it++) {
        const fa = sA.f(x, y, z)
        const fb = sB.f(x, y, z)
        const fc = sC.f(x, y, z)
        if (Math.abs(fa) <= eps && Math.abs(fb) <= eps && Math.abs(fc) <= eps) {
            out[off] = x
            out[off + 1] = y
            out[off + 2] = z
            return true
        }
        sA.normal(x, y, z, gA)
        sB.normal(x, y, z, gB)
        sC.normal(x, y, z, gC)
        // Solve J·dp = r by Cramer (J rows = unit normals).
        const det =
            gA[0]! * (gB[1]! * gC[2]! - gB[2]! * gC[1]!) -
            gA[1]! * (gB[0]! * gC[2]! - gB[2]! * gC[0]!) +
            gA[2]! * (gB[0]! * gC[1]! - gB[1]! * gC[0]!)
        if (Math.abs(det) < 1e-6) return false
        const dx =
            (fa * (gB[1]! * gC[2]! - gB[2]! * gC[1]!) -
                gA[1]! * (fb * gC[2]! - gB[2]! * fc) +
                gA[2]! * (fb * gC[1]! - gB[1]! * fc)) /
            det
        const dy =
            (gA[0]! * (fb * gC[2]! - gB[2]! * fc) -
                fa * (gB[0]! * gC[2]! - gB[2]! * gC[0]!) +
                gA[2]! * (gB[0]! * fc - fb * gC[0]!)) /
            det
        const dz =
            (gA[0]! * (gB[1]! * fc - fb * gC[1]!) -
                gA[1]! * (gB[0]! * fc - fb * gC[0]!) +
                fa * (gB[0]! * gC[1]! - gB[1]! * gC[0]!)) /
            det
        x -= dx
        y -= dy
        z -= dz
        if (Math.hypot(x - px, y - py, z - pz) > maxDisplacement) return false
    }
    return false
}

/** Unit tangent of the {fA = fB = 0} locus: normalize(∇A × ∇B). Returns its magnitude (pre-normalization). */
export function carrierPairTangent(
    sA: SfccStratum,
    sB: SfccStratum,
    x: number,
    y: number,
    z: number,
    out: Float64Array,
    off = 0,
): number {
    sA.normal(x, y, z, gA)
    sB.normal(x, y, z, gB)
    const tx = gA[1]! * gB[2]! - gA[2]! * gB[1]!
    const ty = gA[2]! * gB[0]! - gA[0]! * gB[2]!
    const tz = gA[0]! * gB[1]! - gA[1]! * gB[0]!
    const len = Math.hypot(tx, ty, tz)
    if (len > 1e-30) {
        out[off] = tx / len
        out[off + 1] = ty / len
        out[off + 2] = tz / len
    } else {
        out[off] = 1
        out[off + 1] = 0
        out[off + 2] = 0
    }
    return len
}
