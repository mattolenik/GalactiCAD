/**
 * Canonical Euler↔matrix helpers, in the convention `Rotate.getWgslMatrices`
 * uses: a 3×3 stored as a flat 9-array whose consecutive triplets are COLUMNS
 * (column-major, `m[col*3 + row]`), so `mat3x3Wgsl` packs them directly. `fwd`
 * is world-from-local; `inv` is its transpose (local-from-world). Euler is XYZ
 * in DEGREES.
 *
 * Shared by the `Rotate` operator, the primitive `rot` field, and the gizmo so
 * a value decomposed here reproduces the same matrix everywhere.
 */

const DEG = Math.PI / 180

/** Euler (deg) → `{ fwd, inv }` (both column-major flat 9). */
export function eulerMatrices(rx: number, ry: number, rz: number): { fwd: number[]; inv: number[] } {
    const cx = Math.cos(rx * DEG), sx = Math.sin(rx * DEG)
    const cy = Math.cos(ry * DEG), sy = Math.sin(ry * DEG)
    const cz = Math.cos(rz * DEG), sz = Math.sin(rz * DEG)
    const fwd = [
        cy * cz, cy * sz, -sy,
        sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy,
        cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy,
    ]
    const inv = [
        cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
        cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
        -sy, sx * cy, cx * cy,
    ]
    return { fwd, inv }
}

/** Euler (deg) → world-from-local `fwd` (column-major flat 9). */
export function eulerToFwd(rx: number, ry: number, rz: number): number[] {
    return eulerMatrices(rx, ry, rz).fwd
}

/** world-from-local `fwd` (column-major flat 9) → Euler (deg, XYZ). */
export function fwdToEuler(m: number[]): [number, number, number] {
    const ry = Math.asin(Math.max(-1, Math.min(1, -m[2]!))) // m[2] = -sy
    const cy = Math.cos(ry)
    let rx: number
    let rz: number
    if (Math.abs(cy) > 1e-6) {
        rx = Math.atan2(m[5]!, m[8]!)
        rz = Math.atan2(m[1]!, m[0]!)
    } else {
        rx = Math.atan2(-m[7]!, m[4]!)
        rz = 0
    }
    return [rx / DEG, ry / DEG, rz / DEG]
}

/** Column-major 3×3 product a·b. */
export function matMul3(a: number[], b: number[]): number[] {
    const r = new Array<number>(9)
    for (let c = 0; c < 3; c++) {
        for (let row = 0; row < 3; row++) {
            r[c * 3 + row] = a[row]! * b[c * 3]! + a[3 + row]! * b[c * 3 + 1]! + a[6 + row]! * b[c * 3 + 2]!
        }
    }
    return r
}

/** Compose Euler `base` then body-frame `delta` (deg) → Euler (deg). */
export function composeEuler(base: readonly [number, number, number], delta: readonly [number, number, number]): [number, number, number] {
    return fwdToEuler(matMul3(eulerToFwd(base[0], base[1], base[2]), eulerToFwd(delta[0], delta[1], delta[2])))
}
