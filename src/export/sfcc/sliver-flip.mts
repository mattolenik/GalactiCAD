/**
 * Shape-improving edge flips for long-thin sliver triangles.
 *
 * Cell-loop triangulation occasionally emits "cap" slivers: a boundary vertex
 * lies micrometres from the opposite edge of a long triangle (measured: 0.4 mm
 * long, ~1 µm high, lying in a lattice face plane). They are geometrically
 * negligible but render as bead-chain streaks under flat shading, and no
 * vertex weld can touch them (no close vertex PAIRS — the small dimension is
 * vertex-to-edge). The classic repair: flip the sliver's longest edge into the
 * neighbor quad when that strictly improves the worse aspect ratio of the
 * pair. Flips preserve closure, winding consistency and the outer edges; the
 * geometric change is bounded by the sliver height (sub-tolerance).
 */

import type { PointTable } from "./point-table.mjs"

const SLIVER_ASPECT = 0.02 // height/longest-edge below this is a flip candidate

export function flipSliverTriangles(
    points: PointTable,
    tris: number[],
    maxSweeps = 4,
): { tris: number[]; flips: number } {
    const cur = tris.slice()
    const triCount = cur.length / 3
    const PACK = 0x200000
    let totalFlips = 0

    /** height / longest edge (0 for zero-area); also returns the longest edge's corner index. */
    const shape = (a: number, b: number, c: number): { q: number; longEdge: number } => {
        const ax = points.x(a)
        const ay = points.y(a)
        const az = points.z(a)
        const bx = points.x(b)
        const by = points.y(b)
        const bz = points.z(b)
        const cx = points.x(c)
        const cy = points.y(c)
        const cz = points.z(c)
        const e0 = Math.hypot(bx - ax, by - ay, bz - az) // a→b
        const e1 = Math.hypot(cx - bx, cy - by, cz - bz) // b→c
        const e2 = Math.hypot(ax - cx, ay - cy, az - cz) // c→a
        const ux = bx - ax, uy = by - ay, uz = bz - az
        const vx = cx - ax, vy = cy - ay, vz = cz - az
        const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        const lmax = Math.max(e0, e1, e2)
        if (lmax < 1e-20) return { q: 0, longEdge: 0 }
        const longEdge = e0 >= e1 && e0 >= e2 ? 0 : e1 >= e2 ? 1 : 2
        return { q: area2 / (lmax * lmax), longEdge }
    }

    for (let sweep = 0; sweep < maxSweeps; sweep++) {
        const dir = new Map<number, number>()
        for (let t = 0; t < triCount; t++) {
            for (let e = 0; e < 3; e++) {
                dir.set(cur[t * 3 + e]! * PACK + cur[t * 3 + ((e + 1) % 3)]!, t)
            }
        }
        const touched = new Uint8Array(triCount)
        const newEdges = new Set<number>()
        let flips = 0
        for (let t = 0; t < triCount; t++) {
            if (touched[t]) continue
            const sh = shape(cur[t * 3]!, cur[t * 3 + 1]!, cur[t * 3 + 2]!)
            if (sh.q >= SLIVER_ASPECT || sh.q <= 0) continue
            // Flip across the LONGEST edge (p→q), r opposite.
            const e = sh.longEdge
            const p = cur[t * 3 + e]!
            const q = cur[t * 3 + ((e + 1) % 3)]!
            const r = cur[t * 3 + ((e + 2) % 3)]!
            const o = dir.get(q * PACK + p)
            if (o === undefined || o === t || touched[o]) continue
            let d = -1
            for (let k = 0; k < 3; k++) {
                const v = cur[o * 3 + k]!
                if (v !== p && v !== q) d = v
            }
            if (d < 0 || d === r) continue
            if (
                dir.has(r * PACK + d) ||
                dir.has(d * PACK + r) ||
                newEdges.has(r * PACK + d) ||
                newEdges.has(d * PACK + r)
            ) {
                continue
            }
            const before = Math.min(sh.q, shape(cur[o * 3]!, cur[o * 3 + 1]!, cur[o * 3 + 2]!).q)
            // (p,q,r)+(q,p,d) ⇒ (r,p,d)+(d,q,r)
            const after = Math.min(shape(r, p, d).q, shape(d, q, r).q)
            if (after <= before * 2 || after <= 1e-6) continue
            newEdges.add(r * PACK + d)
            newEdges.add(d * PACK + r)
            cur[t * 3] = r
            cur[t * 3 + 1] = p
            cur[t * 3 + 2] = d
            cur[o * 3] = d
            cur[o * 3 + 1] = q
            cur[o * 3 + 2] = r
            touched[t] = 1
            touched[o] = 1
            flips++
            totalFlips++
        }
        if (flips === 0) break
    }
    return { tris: cur, flips: totalFlips }
}
