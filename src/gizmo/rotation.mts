/**
 * Gizmo rotation helpers. Euler↔matrix math is the canonical
 * `scene/transform-math` (column-major flat 9, world-from-local `fwd`, Euler in
 * degrees) so gizmo writes reproduce the same matrices the SDF uses; this module
 * adds the small vector helpers the controller needs.
 */

export { eulerToFwd, fwdToEuler, matMul3 } from "../scene/transform-math.mjs"

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
