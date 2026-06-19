import assert from "node:assert/strict"
import test from "node:test"
import { Sphere } from "../../scene/primitives/sphere.mjs"
import { compileCpuSdf } from "./cpu-sdf.mjs"
import { canonicalEdgeRoot, findRoot } from "./face-contour.mjs"

const TOL = 1e-7

/** Deterministic LCG (Math.random is unavailable in this environment). */
function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 0x100000000
    }
}

function bitEqual(a: Float64Array, b: Float64Array): boolean {
    for (let i = 0; i < 6; i++) if (!Object.is(a[i]!, b[i]!)) return false
    return true
}

/**
 * The property the parallel weld depends on: the iso-crossing keyed by a sub-edge
 * is a PURE function of that edge — identical no matter which traversal direction
 * created it. `findRoot` alone is order-sensitive (bisection reconstructs A+(B−A)·t
 * with a direction-dependent FP path); `canonicalEdgeRoot` must remove that.
 */
test("canonicalEdgeRoot: iso-crossing is bit-identical from either traversal direction", t => {
    // Offset, non-round centre/radius so surface points land off power-of-two
    // boundaries — the regime where order-sensitive FP rounding can bite.
    const C: [number, number, number] = [0.31, -0.27, 0.19]
    const R = 7.3
    const tree = compileCpuSdf(new Sphere(C, { r: R }))
    const rnd = lcg(0xc0ffee)
    const h = 0.4

    const fwd = new Float64Array(6)
    const rev = new Float64Array(6)
    const rawFwd = new Float64Array(6)
    const rawRev = new Float64Array(6)

    let edges = 0
    let rawAsym = 0

    for (let n = 0; n < 5000; n++) {
        // Random unit direction → a point on the sphere surface.
        let dx = rnd() * 2 - 1
        let dy = rnd() * 2 - 1
        let dz = rnd() * 2 - 1
        const dl = Math.hypot(dx, dy, dz)
        if (dl < 1e-6) continue
        dx /= dl
        dy /= dl
        dz /= dl
        const sx = C[0] + R * dx
        const sy = C[1] + R * dy
        const sz = C[2] + R * dz

        for (let axis = 0; axis < 3; axis++) {
            const a: [number, number, number] = [sx, sy, sz]
            const b: [number, number, number] = [sx, sy, sz]
            a[axis] = a[axis]! - h
            b[axis] = b[axis]! + h
            const fa = tree.f(a[0], a[1], a[2])
            const fb = tree.f(b[0], b[1], b[2])
            if (fa < 0 === fb < 0) continue // edge does not straddle the surface
            edges++

            // Raw findRoot is order-sensitive; count how often (informational).
            findRoot(tree, a[0], a[1], a[2], b[0], b[1], b[2], fa, fb, TOL, rawFwd)
            findRoot(tree, b[0], b[1], b[2], a[0], a[1], a[2], fb, fa, TOL, rawRev)
            if (!bitEqual(rawFwd, rawRev)) rawAsym++

            // canonicalEdgeRoot must be invariant to argument order — the guarantee.
            canonicalEdgeRoot(tree, a[0], a[1], a[2], b[0], b[1], b[2], fa, fb, TOL, fwd)
            canonicalEdgeRoot(tree, b[0], b[1], b[2], a[0], a[1], a[2], fb, fa, TOL, rev)
            assert.ok(bitEqual(fwd, rev), `canonicalEdgeRoot direction-dependent (edge ${n}, axis ${axis})`)
        }
    }

    assert.ok(edges > 500, `swept enough straddling edges (got ${edges})`)
    t.diagnostic(`swept ${edges} straddling edges; raw findRoot was direction-asymmetric on ${rawAsym}`)
})
