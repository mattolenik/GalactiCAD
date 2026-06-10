/**
 * Smooth strata: a stratum is one smooth surface patch of a primitive (box
 * face, cylinder side/cap, cone mantle/base, sphere), represented by its
 * unbounded analytic *carrier* in world space. S1 never restricts the carrier
 * to the actual face — CSG trimming against the full tree does that — so the
 * carrier's smooth f/normal/project are globally defined and Newton-friendly.
 *
 * `sign` bakes CSG orientation: −1 iff the owning primitive sits under an odd
 * number of Subtract right-hand ancestors, so `f`/`normal` always describe the
 * FINAL solid (outward normal, negative inside) and downstream code never
 * thinks about difference orientation again.
 *
 * All math f64 scalars / Float64Array — never Vec3f (f32-backed).
 */

export type CarrierKind = "plane" | "cylinder" | "cone" | "sphere"

export interface SfccStratum {
    /** Dense global stratum id (index into CpuSdfTree.strata). */
    readonly id: number
    /** Scene node id of the owning primitive (−1 when unbuilt, e.g. in unit tests). */
    readonly ownerNodeId: number
    /** Index of the owning leaf in CpuSdfTree.leaves. */
    readonly leafIndex: number
    /** Patch index within the primitive (box: 0..5 = +x,−x,+y,−y,+z,−z; cylinder: 0 side, 1 top, 2 bottom; cone: 0 mantle, 1 base; sphere: 0). */
    readonly localIndex: number
    /** CSG orientation baked into f/normal. */
    readonly sign: 1 | -1
    readonly kind: CarrierKind
    /** Signed distance to the carrier, sign-adjusted (negative on the final solid's inside of this patch). */
    f(px: number, py: number, pz: number): number
    /** Exact unit outward normal of the final solid on this patch; writes into `out` at `off`. */
    normal(px: number, py: number, pz: number, out: Float64Array, off?: number): void
    /** Closest point on the carrier; writes into `out` at `off`. */
    project(px: number, py: number, pz: number, out: Float64Array, off?: number): void
}

interface StratumIdentity {
    id: number
    ownerNodeId: number
    leafIndex: number
    localIndex: number
    sign: 1 | -1
}

/** Plane carrier: f = n·p + offset, ‖n‖ = 1. */
export function makePlaneStratum(
    ident: StratumIdentity,
    nx: number,
    ny: number,
    nz: number,
    offset: number,
): SfccStratum {
    const s = ident.sign
    return {
        ...ident,
        kind: "plane",
        f: (px, py, pz) => s * (nx * px + ny * py + nz * pz + offset),
        normal: (_px, _py, _pz, out, off = 0) => {
            out[off] = s * nx
            out[off + 1] = s * ny
            out[off + 2] = s * nz
        },
        project: (px, py, pz, out, off = 0) => {
            const d = nx * px + ny * py + nz * pz + offset
            out[off] = px - d * nx
            out[off + 1] = py - d * ny
            out[off + 2] = pz - d * nz
        },
    }
}

/** Sphere carrier: f = ‖p − c‖ − r. */
export function makeSphereStratum(
    ident: StratumIdentity,
    cx: number,
    cy: number,
    cz: number,
    r: number,
): SfccStratum {
    const s = ident.sign
    return {
        ...ident,
        kind: "sphere",
        f: (px, py, pz) => s * (Math.hypot(px - cx, py - cy, pz - cz) - r),
        normal: (px, py, pz, out, off = 0) => {
            const dx = px - cx
            const dy = py - cy
            const dz = pz - cz
            const len = Math.hypot(dx, dy, dz)
            if (len > 1e-30) {
                out[off] = (s * dx) / len
                out[off + 1] = (s * dy) / len
                out[off + 2] = (s * dz) / len
            } else {
                out[off] = 0
                out[off + 1] = s
                out[off + 2] = 0
            }
        },
        project: (px, py, pz, out, off = 0) => {
            const dx = px - cx
            const dy = py - cy
            const dz = pz - cz
            const len = Math.hypot(dx, dy, dz)
            if (len > 1e-30) {
                const k = r / len
                out[off] = cx + dx * k
                out[off + 1] = cy + dy * k
                out[off + 2] = cz + dz * k
            } else {
                out[off] = cx
                out[off + 1] = cy + r
                out[off + 2] = cz
            }
        },
    }
}

/** Infinite circular cylinder carrier: f = dist(p, axis) − r; axis through `a` with unit dir `u`. */
export function makeCylinderStratum(
    ident: StratumIdentity,
    ax: number,
    ay: number,
    az: number,
    ux: number,
    uy: number,
    uz: number,
    r: number,
): SfccStratum {
    const s = ident.sign
    const radial = (px: number, py: number, pz: number): [number, number, number, number] => {
        const vx = px - ax
        const vy = py - ay
        const vz = pz - az
        const t = vx * ux + vy * uy + vz * uz
        const rx = vx - t * ux
        const ry = vy - t * uy
        const rz = vz - t * uz
        return [rx, ry, rz, t]
    }
    return {
        ...ident,
        kind: "cylinder",
        f: (px, py, pz) => {
            const [rx, ry, rz] = radial(px, py, pz)
            return s * (Math.hypot(rx, ry, rz) - r)
        },
        normal: (px, py, pz, out, off = 0) => {
            const [rx, ry, rz] = radial(px, py, pz)
            const len = Math.hypot(rx, ry, rz)
            if (len > 1e-30) {
                out[off] = (s * rx) / len
                out[off + 1] = (s * ry) / len
                out[off + 2] = (s * rz) / len
            } else {
                // On the axis: any perpendicular; pick a stable one.
                const px2 = Math.abs(ux) < 0.9 ? 1 : 0
                const py2 = Math.abs(ux) < 0.9 ? 0 : 1
                const cxv = uy * 0 - uz * py2
                const cyv = uz * px2 - ux * 0
                const czv = ux * py2 - uy * px2
                const cl = Math.hypot(cxv, cyv, czv)
                out[off] = (s * cxv) / cl
                out[off + 1] = (s * cyv) / cl
                out[off + 2] = (s * czv) / cl
            }
        },
        project: (px, py, pz, out, off = 0) => {
            const [rx, ry, rz, t] = radial(px, py, pz)
            const len = Math.hypot(rx, ry, rz)
            if (len > 1e-30) {
                const k = r / len
                out[off] = ax + t * ux + rx * k
                out[off + 1] = ay + t * uy + ry * k
                out[off + 2] = az + t * uz + rz * k
            } else {
                out[off] = ax + t * ux + r
                out[off + 1] = ay + t * uy
                out[off + 2] = az + t * uz
            }
        },
    }
}

/**
 * Infinite cone-mantle carrier: apex at `a`, unit axis `u` pointing from apex
 * toward the base, half-angle α (sinA/cosA precomputed). In meridian
 * coordinates (ρ = distance from axis, t = height along u from apex) the
 * mantle is the ray through the origin with direction (sinα, cosα); the signed
 * distance to its supporting line is ρ·cosα − t·sinα (positive outside).
 * Behind the apex (projection onto the mantle ray < 0) the closest carrier
 * point is the apex itself.
 */
export function makeConeStratum(
    ident: StratumIdentity,
    ax: number,
    ay: number,
    az: number,
    ux: number,
    uy: number,
    uz: number,
    sinA: number,
    cosA: number,
): SfccStratum {
    const s = ident.sign
    const decompose = (px: number, py: number, pz: number): [number, number, number, number, number] => {
        const vx = px - ax
        const vy = py - ay
        const vz = pz - az
        const t = vx * ux + vy * uy + vz * uz
        const rx = vx - t * ux
        const ry = vy - t * uy
        const rz = vz - t * uz
        const rho = Math.hypot(rx, ry, rz)
        return [rx, ry, rz, t, rho]
    }
    return {
        ...ident,
        kind: "cone",
        f: (px, py, pz) => {
            const [, , , t, rho] = decompose(px, py, pz)
            const proj = rho * sinA + t * cosA
            if (proj < 0) {
                // Behind the apex: closest carrier point is the apex.
                return s * Math.hypot(rho, t)
            }
            return s * (rho * cosA - t * sinA)
        },
        normal: (px, py, pz, out, off = 0) => {
            const [rx, ry, rz, t, rho] = decompose(px, py, pz)
            const proj = rho * sinA + t * cosA
            if (proj < 0 && (rho > 1e-30 || Math.abs(t) > 1e-30)) {
                const len = Math.hypot(rho, t)
                // Direction from apex to p.
                const k = s / len
                out[off] = (rx + t * ux) * k
                out[off + 1] = (ry + t * uy) * k
                out[off + 2] = (rz + t * uz) * k
                return
            }
            if (rho > 1e-30) {
                // n = cosα·radialDir − sinα·u (unit by construction).
                const inv = 1 / rho
                out[off] = s * (cosA * rx * inv - sinA * ux)
                out[off + 1] = s * (cosA * ry * inv - sinA * uy)
                out[off + 2] = s * (cosA * rz * inv - sinA * uz)
            } else {
                // On the axis (incl. the apex): normal undefined; return −u as a
                // stable fallback. S2 certificates exclude the axis by refinement.
                out[off] = -s * ux
                out[off + 1] = -s * uy
                out[off + 2] = -s * uz
            }
        },
        project: (px, py, pz, out, off = 0) => {
            const [rx, ry, rz, t, rho] = decompose(px, py, pz)
            const proj = rho * sinA + t * cosA
            if (proj <= 0 || rho <= 1e-30) {
                // Apex (also the stable choice exactly on the axis).
                out[off] = ax
                out[off + 1] = ay
                out[off + 2] = az
                return
            }
            // Foot of perpendicular on the mantle ray, in meridian coords (ρ*, t*) = proj·(sinα, cosα).
            const rhoStar = proj * sinA
            const tStar = proj * cosA
            const inv = rhoStar / rho
            out[off] = ax + tStar * ux + rx * inv
            out[off + 1] = ay + tStar * uy + ry * inv
            out[off + 2] = az + tStar * uz + rz * inv
        },
    }
}
