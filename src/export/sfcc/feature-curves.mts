/**
 * Analytic feature curves for SFCC.
 *
 * A feature curve is a sharp-edge locus with its two adjacent smooth strata.
 * v1 native kinds are exact closed forms: "segment" (straight edge between
 * two points) and "circle" (full or arc, e.g. cylinder rims, cone base).
 * Numerically traced boolean-seam curves arrive in P6 behind the same
 * interface.
 *
 * The exact-on-curve guarantee is load-bearing: `pointAt` returns points
 * exactly on the analytic locus, so every pinned face crossing and every
 * sampled polyline vertex has zero roundover by construction.
 *
 * Parameterization: segments t ∈ [0, 1]; circles θ ∈ [0, 2π) (radians).
 */

export interface CurveFaceCrossing {
    /** Curve parameter at the crossing. */
    t: number
    x: number
    y: number
    z: number
    /** |unit tangent · plane normal axis| — transversality measure. */
    tangentialDot: number
}

export interface SfccFeatureCurve {
    readonly id: number
    readonly kind: "segment" | "circle" | "traced"
    /** Stratum ids of the two adjacent smooth patches. */
    readonly adjacentStrata: readonly [number, number]
    readonly closed: boolean
    /** For closed curves: the parameter period (2π for circles, sample count for traced loops). */
    readonly paramWrap?: number
    /** Parameter domain (open curves and arcs): [tMin, tMax]. */
    readonly tMin: number
    readonly tMax: number
    /** Owning primitive's scene node id (−1 for boolean seams / unbuilt test scenes). */
    readonly ownerNodeId: number
    /** Compiled from modeled primitive geometry (set by compileFeatureSet; boolean seams stay unset). */
    native?: boolean
    /** Corner ids at the ends (open curves; −1 = free end). */
    cornerStart: number
    cornerEnd: number
    /** Coarse polyline (xyz triplets) for spatial indexing — NOT exact geometry. */
    readonly indexPolyline: Float64Array
    pointAt(t: number, out: Float64Array, off?: number): void
    /** Unit tangent (direction of increasing t). */
    tangentAt(t: number, out: Float64Array, off?: number): void
    /** Closest curve parameter/distance to a world point. */
    project(px: number, py: number, pz: number): { t: number; dist: number }
    /**
     * All crossings of the curve with the axis-aligned plane {p[axis] = coord},
     * exact (closed form for segment/circle; chord-bracketed + refined for
     * traced). Callers filter by face rectangle.
     */
    axisPlaneCrossings(axis: 0 | 1 | 2, coord: number): CurveFaceCrossing[]
    /** Arc length between two parameters along the (shorter direction of a closed) curve. */
    paramDistance(t0: number, t1: number): number
}

export function makeSegmentCurve(
    id: number,
    ownerNodeId: number,
    adjacentStrata: readonly [number, number],
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
): SfccFeatureCurve {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    const tx = dx / len
    const ty = dy / len
    const tz = dz / len
    const d = [dx, dy, dz] as const
    const a = [ax, ay, az] as const
    const indexPolyline = new Float64Array([ax, ay, az, bx, by, bz])
    return {
        id,
        kind: "segment",
        adjacentStrata,
        closed: false,
        tMin: 0,
        tMax: 1,
        ownerNodeId,
        cornerStart: -1,
        cornerEnd: -1,
        indexPolyline,
        pointAt: (t, out, off = 0) => {
            out[off] = ax + dx * t
            out[off + 1] = ay + dy * t
            out[off + 2] = az + dz * t
        },
        tangentAt: (_t, out, off = 0) => {
            out[off] = tx
            out[off + 1] = ty
            out[off + 2] = tz
        },
        project: (px, py, pz) => {
            let t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / (len * len)
            t = Math.max(0, Math.min(1, t))
            const qx = ax + dx * t
            const qy = ay + dy * t
            const qz = az + dz * t
            return { t, dist: Math.hypot(px - qx, py - qy, pz - qz) }
        },
        axisPlaneCrossings: (axis, coord) => {
            const da = d[axis]!
            if (da === 0) return [] // parallel (coplanar treated as no transversal crossing)
            const t = (coord - a[axis]!) / da
            if (t < 0 || t > 1) return []
            const out: CurveFaceCrossing[] = []
            const p = new Float64Array(3)
            p[0] = ax + dx * t
            p[1] = ay + dy * t
            p[2] = az + dz * t
            out.push({
                t,
                x: p[0]!,
                y: p[1]!,
                z: p[2]!,
                tangentialDot: Math.abs((axis === 0 ? tx : axis === 1 ? ty : tz)),
            })
            return out
        },
        paramDistance: (t0, t1) => Math.abs(t1 - t0) * len,
    }
}

export function makeCircleCurve(
    id: number,
    ownerNodeId: number,
    adjacentStrata: readonly [number, number],
    cx: number,
    cy: number,
    cz: number,
    // Unit circle axis (normal of the circle plane).
    wx: number,
    wy: number,
    wz: number,
    r: number,
    /** Optional arc range [t0, t1] (radians, t1 > t0, sweep < 2π) — a trimmed rim. */
    arc?: { t0: number; t1: number },
): SfccFeatureCurve {
    // Build an orthonormal in-plane basis (e1, e2) with e1 × e2 = w.
    let ex = Math.abs(wx) < 0.9 ? 1 : 0
    let ey = Math.abs(wx) < 0.9 ? 0 : 1
    const ez = 0
    // e1 = normalize(e − (e·w)w)
    const dotEw = ex * wx + ey * wy + ez * wz
    ex -= dotEw * wx
    ey -= dotEw * wy
    let e1z = ez - dotEw * wz
    const e1len = Math.hypot(ex, ey, e1z)
    const e1x = ex / e1len
    const e1y = ey / e1len
    e1z = e1z / e1len
    // e2 = w × e1
    const e2x = wy * e1z - wz * e1y
    const e2y = wz * e1x - wx * e1z
    const e2z = wx * e1y - wy * e1x

    const tMin = arc ? arc.t0 : 0
    const tMax = arc ? arc.t1 : 2 * Math.PI
    const INDEX_SEGS = Math.max(8, Math.ceil((64 * (tMax - tMin)) / (2 * Math.PI)))
    const indexPolyline = new Float64Array((INDEX_SEGS + 1) * 3)
    for (let i = 0; i <= INDEX_SEGS; i++) {
        const th = tMin + (i / INDEX_SEGS) * (tMax - tMin)
        indexPolyline[i * 3] = cx + r * (Math.cos(th) * e1x + Math.sin(th) * e2x)
        indexPolyline[i * 3 + 1] = cy + r * (Math.cos(th) * e1y + Math.sin(th) * e2y)
        indexPolyline[i * 3 + 2] = cz + r * (Math.cos(th) * e1z + Math.sin(th) * e2z)
    }

    const e1 = [e1x, e1y, e1z] as const
    const e2 = [e2x, e2y, e2z] as const
    const c = [cx, cy, cz] as const
    /** Normalize an angle into [tMin, tMin + 2π); in-arc iff ≤ tMax. */
    const intoRange = (th: number): number => {
        const TAU = 2 * Math.PI
        let v = (th - tMin) % TAU
        if (v < 0) v += TAU
        return tMin + v
    }

    return {
        id,
        kind: "circle",
        adjacentStrata,
        closed: !arc,
        paramWrap: arc ? undefined : 2 * Math.PI,
        tMin,
        tMax,
        ownerNodeId,
        cornerStart: -1,
        cornerEnd: -1,
        indexPolyline,
        pointAt: (t, out, off = 0) => {
            const co = Math.cos(t)
            const si = Math.sin(t)
            out[off] = cx + r * (co * e1x + si * e2x)
            out[off + 1] = cy + r * (co * e1y + si * e2y)
            out[off + 2] = cz + r * (co * e1z + si * e2z)
        },
        tangentAt: (t, out, off = 0) => {
            const co = Math.cos(t)
            const si = Math.sin(t)
            out[off] = -si * e1x + co * e2x
            out[off + 1] = -si * e1y + co * e2y
            out[off + 2] = -si * e1z + co * e2z
        },
        project: (px, py, pz) => {
            const vx = px - cx
            const vy = py - cy
            const vz = pz - cz
            const a1 = vx * e1x + vy * e1y + vz * e1z
            const a2 = vx * e2x + vy * e2y + vz * e2z
            let t = intoRange(Math.atan2(a2, a1))
            if (arc && t > tMax) {
                // Outside the arc: clamp to the nearer endpoint (by angle).
                t = t - tMax < tMin + 2 * Math.PI - t ? tMax : tMin
            }
            const qx = cx + r * (Math.cos(t) * e1x + Math.sin(t) * e2x)
            const qy = cy + r * (Math.cos(t) * e1y + Math.sin(t) * e2y)
            const qz = cz + r * (Math.cos(t) * e1z + Math.sin(t) * e2z)
            return { t, dist: Math.hypot(px - qx, py - qy, pz - qz) }
        },
        axisPlaneCrossings: (axis, coord) => {
            // p[axis](θ) = c[axis] + r(cosθ·e1[axis] + sinθ·e2[axis]) = coord
            const A = r * e1[axis]!
            const B = r * e2[axis]!
            const C = coord - c[axis]!
            const R = Math.hypot(A, B)
            if (R < 1e-30) return [] // circle parallel to the plane
            const ratio = C / R
            if (ratio < -1 || ratio > 1) return []
            const phi = Math.atan2(B, A)
            const alpha = Math.acos(Math.max(-1, Math.min(1, ratio)))
            const sols = alpha === 0 ? [phi] : [phi + alpha, phi - alpha]
            const out: CurveFaceCrossing[] = []
            const p = new Float64Array(3)
            const tg = new Float64Array(3)
            for (let th of sols) {
                th = intoRange(th)
                if (arc && th > tMax) continue
                const co = Math.cos(th)
                const si = Math.sin(th)
                p[0] = cx + r * (co * e1x + si * e2x)
                p[1] = cy + r * (co * e1y + si * e2y)
                p[2] = cz + r * (co * e1z + si * e2z)
                tg[0] = -si * e1x + co * e2x
                tg[1] = -si * e1y + co * e2y
                tg[2] = -si * e1z + co * e2z
                out.push({ t: th, x: p[0]!, y: p[1]!, z: p[2]!, tangentialDot: Math.abs(tg[axis]!) })
            }
            return out
        },
        paramDistance: (t0, t1) => {
            let d = Math.abs(t1 - t0) % (2 * Math.PI)
            if (d > Math.PI) d = 2 * Math.PI - d
            return d * r
        },
    }
}

/**
 * Numerically traced curve (boolean seams): a polyline of samples, every one
 * exactly on the carrier-pair locus, with a refinement callback restoring
 * exactness after interpolation. Parameter = continuous polyline index
 * t ∈ [0, n−1]; closed loops have samples[0] ≅ samples[n−1] and wrap at n−1.
 */
export function makeTracedCurve(
    id: number,
    adjacentStrata: readonly [number, number],
    samples: Float64Array,
    closed: boolean,
    /** Newton re-projection onto the carrier pair; writes xyz into out. Returns false on divergence (caller keeps the lerp). */
    refine: (x: number, y: number, z: number, out: Float64Array, off?: number) => boolean,
    /** Unit tangent of the locus at a point (∇A×∇B normalized). */
    tangent: (x: number, y: number, z: number, out: Float64Array, off?: number) => void,
    /** Owning primitive's node id for NATIVE traced curves (−1 = boolean seam). */
    ownerNodeId = -1,
): SfccFeatureCurve {
    const n = samples.length / 3
    const tMax = n - 1
    const sx = (i: number): number => samples[i * 3]!
    const sy = (i: number): number => samples[i * 3 + 1]!
    const sz = (i: number): number => samples[i * 3 + 2]!

    const pointAt = (t: number, out: Float64Array, off = 0): void => {
        let tc = t
        if (closed) {
            tc = tc % tMax
            if (tc < 0) tc += tMax
        } else {
            tc = Math.max(0, Math.min(tMax, tc))
        }
        const i = Math.min(Math.floor(tc), tMax - 1)
        const fr = tc - i
        const lx = sx(i) * (1 - fr) + sx(i + 1) * fr
        const ly = sy(i) * (1 - fr) + sy(i + 1) * fr
        const lz = sz(i) * (1 - fr) + sz(i + 1) * fr
        if (fr === 0 || fr === 1 || !refine(lx, ly, lz, out, off)) {
            out[off] = lx
            out[off + 1] = ly
            out[off + 2] = lz
        }
    }

    const p = new Float64Array(3)
    return {
        id,
        kind: "traced",
        adjacentStrata,
        closed,
        paramWrap: closed ? tMax : undefined,
        tMin: 0,
        tMax,
        ownerNodeId,
        cornerStart: -1,
        cornerEnd: -1,
        indexPolyline: samples,
        pointAt,
        tangentAt: (t, out, off = 0) => {
            pointAt(t, p)
            tangent(p[0]!, p[1]!, p[2]!, out, off)
            // Orient along increasing t (the tracer's direction may differ).
            const i = Math.max(0, Math.min(tMax - 1, Math.floor(t)))
            const dx = sx(i + 1) - sx(i)
            const dy = sy(i + 1) - sy(i)
            const dz = sz(i + 1) - sz(i)
            if (out[off]! * dx + out[off + 1]! * dy + out[off + 2]! * dz < 0) {
                out[off] = -out[off]!
                out[off + 1] = -out[off + 1]!
                out[off + 2] = -out[off + 2]!
            }
        },
        project: (px, py, pz) => {
            // Nearest polyline segment, then parabolic-free chord projection.
            let bestT = 0
            let bestD2 = Infinity
            for (let i = 0; i < n - 1; i++) {
                const dx = sx(i + 1) - sx(i)
                const dy = sy(i + 1) - sy(i)
                const dz = sz(i + 1) - sz(i)
                const l2 = dx * dx + dy * dy + dz * dz
                let u = l2 > 0 ? ((px - sx(i)) * dx + (py - sy(i)) * dy + (pz - sz(i)) * dz) / l2 : 0
                u = Math.max(0, Math.min(1, u))
                const qx = sx(i) + dx * u
                const qy = sy(i) + dy * u
                const qz = sz(i) + dz * u
                const d2 = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2
                if (d2 < bestD2) {
                    bestD2 = d2
                    bestT = i + u
                }
            }
            pointAt(bestT, p)
            return { t: bestT, dist: Math.hypot(px - p[0]!, py - p[1]!, pz - p[2]!) }
        },
        axisPlaneCrossings: (axis, coord) => {
            const out: CurveFaceCrossing[] = []
            const tg = new Float64Array(3)
            for (let i = 0; i < n - 1; i++) {
                const a = (axis === 0 ? sx(i) : axis === 1 ? sy(i) : sz(i)) - coord
                const b = (axis === 0 ? sx(i + 1) : axis === 1 ? sy(i + 1) : sz(i + 1)) - coord
                if (a === 0 && b === 0) continue
                if (a < 0 === b < 0 && a !== 0) continue
                // Bisect on the exact curve for the crossing parameter.
                let lo = i
                let hi = i + 1
                for (let k = 0; k < 40; k++) {
                    const mid = (lo + hi) / 2
                    pointAt(mid, p)
                    const v = p[axis]! - coord
                    if (v < 0 === a < 0 && v !== 0) lo = mid
                    else hi = mid
                }
                const t = (lo + hi) / 2
                pointAt(t, p)
                tangent(p[0]!, p[1]!, p[2]!, tg)
                out.push({ t, x: p[0]!, y: p[1]!, z: p[2]!, tangentialDot: Math.abs(tg[axis]!) })
            }
            return out
        },
        paramDistance: (t0, t1) => {
            // Average chord length scales param distance well enough for
            // sampling decisions (the polyline is near-uniformly spaced).
            let total = 0
            for (let i = 0; i < n - 1; i++) {
                total += Math.hypot(sx(i + 1) - sx(i), sy(i + 1) - sy(i), sz(i + 1) - sz(i))
            }
            const avg = total / (n - 1)
            let d = Math.abs(t1 - t0)
            if (closed) {
                d = d % tMax
                if (d > tMax / 2) d = tMax - d
            }
            return d * avg
        },
    }
}
