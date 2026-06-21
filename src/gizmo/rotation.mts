/**
 * Rotation helpers for the gizmo, in the SAME convention as
 * `Rotate.getWgslMatrices().fwd`: a 3×3 stored as a flat 9-array whose
 * consecutive triplets are COLUMNS (column-major, `m[col*3 + row]`). `fwd` is
 * the world-from-local rotation; Euler angles are XYZ in DEGREES.
 *
 * Keeping this identical to `getWgslMatrices` means a value we decompose here
 * and write into a `.rotate([rx,ry,rz])` reproduces the same matrix the SDF and
 * the feature graph use.
 */

const DEG = Math.PI / 180

/** Euler (deg, XYZ) → world-from-local `fwd` (column-major flat 9). */
export function eulerToFwd(rx: number, ry: number, rz: number): number[] {
    const cx = Math.cos(rx * DEG), sx = Math.sin(rx * DEG)
    const cy = Math.cos(ry * DEG), sy = Math.sin(ry * DEG)
    const cz = Math.cos(rz * DEG), sz = Math.sin(rz * DEG)
    // Matches Rotate.getWgslMatrices(): triplets are columns.
    return [
        cy * cz, cy * sz, -sy,
        sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy,
        cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy,
    ]
}

/** world-from-local `fwd` (column-major flat 9) → Euler (deg, XYZ). */
export function fwdToEuler(m: number[]): [number, number, number] {
    // m[c*3+r]; the decomposition inverts eulerToFwd.
    const syNeg = Math.max(-1, Math.min(1, m[2]!)) // m[2] = -sy
    const ry = Math.asin(-syNeg)
    const cy = Math.cos(ry)
    let rx: number
    let rz: number
    if (Math.abs(cy) > 1e-6) {
        rx = Math.atan2(m[5]!, m[8]!) // sx*cy, cx*cy
        rz = Math.atan2(m[1]!, m[0]!) // cy*sz, cy*cz
    } else {
        // Gimbal lock (ry ≈ ±90°): fold rz into rx.
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

/** Column-major 3×3 times a vector (m·v). */
export function matVec3(m: number[], v: readonly [number, number, number]): [number, number, number] {
    return [
        m[0]! * v[0] + m[3]! * v[1] + m[6]! * v[2],
        m[1]! * v[0] + m[4]! * v[1] + m[7]! * v[2],
        m[2]! * v[0] + m[5]! * v[1] + m[8]! * v[2],
    ]
}

/** Column i (the i-th local axis in world space) of a column-major 3×3. */
export function matColumn(m: number[], i: number): [number, number, number] {
    return [m[i * 3]!, m[i * 3 + 1]!, m[i * 3 + 2]!]
}
