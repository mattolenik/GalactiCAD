/**
 * Similarity-transform baking for the SFCC CPU evaluator.
 *
 * The v1 transform subset (Translate / Rotate / uniform positive Scale)
 * composes into a similarity `world = s·(R·local) + t`, which keeps analytic
 * carriers exact: planes stay planes, cylinders stay circular cylinders, cone
 * half-angles are preserved. This is the reason SFCC v1 rejects non-uniform
 * scale.
 *
 * Rotation convention (the repo's historical transpose-bug hotspot): the WGSL
 * side packs flat arrays as *columns* (`mat3x3Wgsl`), so `Rotate.getWgslMatrices().fwd`
 * read **row-major is the world-to-local map**, and world-from-local is its
 * transpose. {@link similarityFromRotationWgslFwd} bakes that transpose. The
 * regression test pins this against `applyTransformsCpu` /
 * `mat4FromRotationFwd`, the canonical FeatureGraph transform path.
 *
 * All math is f64 scalars / Float64Array — never Vec3f (f32-backed).
 */

export interface Similarity {
    /** 3×3 world-from-local rotation, row-major, proper (det +1). */
    readonly r: Float64Array
    /** World-space translation. */
    readonly t: Float64Array
    /** Uniform scale factor, > 0. */
    readonly s: number
}

export function identitySimilarity(): Similarity {
    return {
        r: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        t: new Float64Array(3),
        s: 1,
    }
}

export function similarityFromTranslation(dx: number, dy: number, dz: number): Similarity {
    return {
        r: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        t: new Float64Array([dx, dy, dz]),
        s: 1,
    }
}

/**
 * From `Rotate.getWgslMatrices().fwd` (flat, row-major = world-to-local): the
 * world-from-local rotation is its transpose.
 */
export function similarityFromRotationWgslFwd(fwdFlat: readonly number[]): Similarity {
    const f = fwdFlat
    return {
        // transpose of row-major fwd
        r: new Float64Array([f[0]!, f[3]!, f[6]!, f[1]!, f[4]!, f[7]!, f[2]!, f[5]!, f[8]!]),
        t: new Float64Array(3),
        s: 1,
    }
}

export function similarityFromUniformScale(s: number): Similarity {
    if (!(s > 0)) throw new Error(`sfcc: uniform scale must be > 0, got ${s}`)
    return {
        r: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        t: new Float64Array(3),
        s,
    }
}

/**
 * Compose: `out(x) = parent(local(x))`, i.e. `local` is applied first (it sits
 * *below* `parent` in the scene tree).
 */
export function composeSimilarity(parent: Similarity, local: Similarity): Similarity {
    const pr = parent.r
    const lr = local.r
    const r = new Float64Array(9)
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            r[i * 3 + j] = pr[i * 3]! * lr[j]! + pr[i * 3 + 1]! * lr[3 + j]! + pr[i * 3 + 2]! * lr[6 + j]!
        }
    }
    // t = s_p·R_p·t_l + t_p
    const t = new Float64Array(3)
    for (let i = 0; i < 3; i++) {
        t[i] =
            parent.s * (pr[i * 3]! * local.t[0]! + pr[i * 3 + 1]! * local.t[1]! + pr[i * 3 + 2]! * local.t[2]!) +
            parent.t[i]!
    }
    return { r, t, s: parent.s * local.s }
}

/** world = s·R·local + t; writes x,y,z into `out` at `off`. */
export function applyPoint(sim: Similarity, x: number, y: number, z: number, out: Float64Array, off = 0): void {
    const r = sim.r
    out[off] = sim.s * (r[0]! * x + r[1]! * y + r[2]! * z) + sim.t[0]!
    out[off + 1] = sim.s * (r[3]! * x + r[4]! * y + r[5]! * z) + sim.t[1]!
    out[off + 2] = sim.s * (r[6]! * x + r[7]! * y + r[8]! * z) + sim.t[2]!
}

/** local = Rᵀ·(world − t)/s; writes into `out` at `off`. */
export function invApplyPoint(sim: Similarity, x: number, y: number, z: number, out: Float64Array, off = 0): void {
    const r = sim.r
    const dx = (x - sim.t[0]!) / sim.s
    const dy = (y - sim.t[1]!) / sim.s
    const dz = (z - sim.t[2]!) / sim.s
    out[off] = r[0]! * dx + r[3]! * dy + r[6]! * dz
    out[off + 1] = r[1]! * dx + r[4]! * dy + r[7]! * dz
    out[off + 2] = r[2]! * dx + r[5]! * dy + r[8]! * dz
}

/**
 * Rotate a local-space direction into world space (no translation, no scale —
 * correct for unit normals and tangents under a similarity).
 */
export function rotateVector(sim: Similarity, x: number, y: number, z: number, out: Float64Array, off = 0): void {
    const r = sim.r
    out[off] = r[0]! * x + r[1]! * y + r[2]! * z
    out[off + 1] = r[3]! * x + r[4]! * y + r[5]! * z
    out[off + 2] = r[6]! * x + r[7]! * y + r[8]! * z
}

/** Rotate a world-space direction into local space (Rᵀ). */
export function invRotateVector(sim: Similarity, x: number, y: number, z: number, out: Float64Array, off = 0): void {
    const r = sim.r
    out[off] = r[0]! * x + r[3]! * y + r[6]! * z
    out[off + 1] = r[1]! * x + r[4]! * y + r[7]! * z
    out[off + 2] = r[2]! * x + r[5]! * y + r[8]! * z
}
