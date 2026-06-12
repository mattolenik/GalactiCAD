/**
 * f64 CPU ports of the hg_sdf.wgsl extended primitive SDFs for the SFCC v1
 * subset: `fBoxEx`, `fSphereEx`, `fCylinderEx` (fillet/chamfer = 0 only),
 * `fConeEx`. Distance formulas are ported verbatim; normals are the same
 * region-based analytic normals (for the zero-fillet cylinder we use the exact
 * region normals instead of the shader's finite-difference meridian normal —
 * same distances, exact instead of FD normals).
 *
 * All functions take the *primitive-local* point (after the `p − pos` shift the
 * shader applies — callers shift first). Scalars in, f64 out; normals written
 * into caller-provided Float64Array — never Vec3f (f32-backed).
 */

const sgn = (x: number): number => (x < 0 ? -1 : 1)

// --- Sphere: fSphereEx (hg_sdf.wgsl:631) -----------------------------------

export function sphereDist(px: number, py: number, pz: number, r: number): number {
    return Math.hypot(px, py, pz) - r
}

export function sphereNormal(px: number, py: number, pz: number, out: Float64Array, off = 0): void {
    const len = Math.hypot(px, py, pz)
    if (len > 1e-30) {
        out[off] = px / len
        out[off + 1] = py / len
        out[off + 2] = pz / len
    } else {
        out[off] = 0
        out[off + 1] = 1
        out[off + 2] = 0
    }
}

// --- Box: fBoxEx (hg_sdf.wgsl:637) ------------------------------------------

export function boxDist(px: number, py: number, pz: number, bx: number, by: number, bz: number): number {
    const dx = Math.abs(px) - bx
    const dy = Math.abs(py) - by
    const dz = Math.abs(pz) - bz
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0))
    // vmax3(min(d, 0)) — 0 outside, the least-negative component inside
    const insideMax = Math.max(Math.min(dx, 0), Math.min(dy, 0), Math.min(dz, 0))
    return outside + insideMax
}

export function boxNormal(
    px: number,
    py: number,
    pz: number,
    bx: number,
    by: number,
    bz: number,
    out: Float64Array,
    off = 0,
): void {
    const dx = Math.abs(px) - bx
    const dy = Math.abs(py) - by
    const dz = Math.abs(pz) - bz
    const ox = Math.max(dx, 0) * sgn(px)
    const oy = Math.max(dy, 0) * sgn(py)
    const oz = Math.max(dz, 0) * sgn(pz)
    const outsideLen = Math.hypot(ox, oy, oz)
    if (outsideLen > 0) {
        out[off] = ox / outsideLen
        out[off + 1] = oy / outsideLen
        out[off + 2] = oz / outsideLen
        return
    }
    if (dx > dy && dx > dz) {
        out[off] = sgn(px)
        out[off + 1] = 0
        out[off + 2] = 0
    } else if (dy > dz) {
        out[off] = 0
        out[off + 1] = sgn(py)
        out[off + 2] = 0
    } else {
        out[off] = 0
        out[off + 1] = 0
        out[off + 2] = sgn(pz)
    }
}

// --- Cylinder (fillet/chamfer = 0): fCylinderEx (hg_sdf.wgsl:725) ------------
//
// DELIBERATE DEVIATION from the shader: with zero rim radii the WGSL meridian
// trick (`sdRoundedBox2DIqMeridian` on a half-offset box) returns d = −ρ in the
// interior core and **exactly 0 along the cylinder axis** — a phantom boundary
// edge of the meridian box at ρ = 0. Harmless for raymarching (outside values
// are exact; interior is a sign-correct underestimate), but fatal for SFCC,
// whose invariant is f(p) = 0 ⟺ p on the surface: a lattice sample landing on
// the axis would classify "outside" deep inside the solid and fabricate a
// phantom sign-change sheet. We therefore evaluate the *exact* capped-cylinder
// SDF: identical to the shader outside the solid and on the true surface,
// strictly more negative (correct) in the near-axis interior, still 1-Lipschitz.

export function cylinderDist(px: number, py: number, pz: number, r: number, h: number): number {
    const cr = Math.max(r, 1e-6)
    const ch = Math.max(h, 1e-6)
    const dr = Math.hypot(px, pz) - cr
    const dy = Math.abs(py) - ch
    return Math.min(Math.max(dr, dy), 0) + Math.hypot(Math.max(dr, 0), Math.max(dy, 0))
}

/**
 * Exact region-based normal for the zero-fillet cylinder: side wall → radial,
 * caps → ±y, outside rim corner → normalized (radial, y) combination, points
 * on/near the axis fall back per the dominant component.
 */
export function cylinderNormal(
    px: number,
    py: number,
    pz: number,
    r: number,
    h: number,
    out: Float64Array,
    off = 0,
): void {
    const cr = Math.max(r, 1e-6)
    const ch = Math.max(h, 1e-6)
    const rho = Math.hypot(px, pz)
    const dr = rho - cr // signed distance to side wall in meridian
    const dy = Math.abs(py) - ch // signed distance to cap plane
    let nr: number
    let ny: number
    if (dr > 0 && dy > 0) {
        // outside rim corner
        const len = Math.hypot(dr, dy)
        nr = dr / len
        ny = (dy / len) * sgn(py)
    } else if (dr > dy) {
        nr = 1
        ny = 0
    } else {
        nr = 0
        ny = sgn(py)
    }
    if (rho > 1e-12 && nr !== 0) {
        out[off] = (nr * px) / rho
        out[off + 1] = ny
        out[off + 2] = (nr * pz) / rho
        const len = Math.hypot(out[off]!, ny, out[off + 2]!)
        out[off] = out[off]! / len
        out[off + 1] = ny / len
        out[off + 2] = out[off + 2]! / len
    } else if (nr !== 0) {
        // On the axis but side wall closest — degenerate radial direction.
        out[off] = 1
        out[off + 1] = 0
        out[off + 2] = 0
    } else {
        out[off] = 0
        out[off + 1] = ny === 0 ? 1 : ny
        out[off + 2] = 0
    }
}

/**
 * True OUTWARD unit normal of a polygon edge with tangent (ex, ez), in the
 * polygon's own 2D plane. `windSign` is `polygon2dWindingSign(vertices)`; the
 * result points out of the polygon interior regardless of winding.
 *
 * NOTE: the WGSL face-selection formula `(eTan.z, −eTan.x)·windSign` is the
 * NEGATION of this (inward — the shader's shoelace convention makes windSign
 * −1 for CCW). It is self-consistent inside the shader but must not leak into
 * SFCC: strata normals are outward of the final solid by contract
 * (strata.mts), and trim's dihedral gate compares normals across leaves.
 * Every SFCC profile-edge normal goes through this one helper.
 */
export function outwardEdgeNormal2D(ex: number, ez: number, windSign: 1 | -1): [number, number] {
    const eLen = Math.max(Math.hypot(ex, ez), 1e-12)
    return [(-ez / eLen) * windSign, (ex / eLen) * windSign]
}

// --- Polygon2D: fPolygon2D_*_combined (extrude.mts/polygon2d.mts) ------------
//
// IQ's even-odd polygon SDF, ported verbatim: exact signed distance to a
// closed polygon (negative inside regardless of winding), plus the gradient
// (direction to/from the closest edge) and the closest edge index.
//
// DELIBERATE DEVIATION from the shader: exactly ON the boundary the
// closest-point vector vanishes and the WGSL falls back to (1, 0) — GPU rays
// never sit exactly on the surface, but SFCC probes do (they're projected
// onto carriers). The fallback here is the closest edge's true OUTWARD
// normal, the limit of the off-boundary gradient s·b/|b| — so the gradient
// is continuous across the boundary.

export interface Polygon2DResult {
    d: number
    gx: number
    gz: number
    edge: number
}

export function polygonDist2D(
    verts: ArrayLike<number>,
    windSign: 1 | -1,
    px: number,
    pz: number,
    out: Polygon2DResult,
): void {
    const n = verts.length / 2
    let d = (px - verts[0]!) * (px - verts[0]!) + (pz - verts[1]!) * (pz - verts[1]!)
    let s = 1
    let minDist = Infinity
    let closest = 0
    let bx = 0
    let bz = 0
    let j = n - 1
    for (let i = 0; i < n; i++) {
        const vix = verts[i * 2]!
        const viz = verts[i * 2 + 1]!
        const vjx = verts[j * 2]!
        const vjz = verts[j * 2 + 1]!
        const ex = vjx - vix
        const ez = vjz - viz
        const wx = px - vix
        const wz = pz - viz
        const eLen2 = Math.max(ex * ex + ez * ez, 1e-12)
        const t = Math.max(0, Math.min(1, (wx * ex + wz * ez) / eLen2))
        const qx = wx - ex * t
        const qz = wz - ez * t
        const dd = qx * qx + qz * qz
        d = Math.min(d, dd)
        if (dd < minDist) {
            minDist = dd
            closest = j
            bx = qx
            bz = qz
        }
        const c0 = pz >= viz
        const c1 = pz < vjz
        const c2 = ex * wz > ez * wx
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) s = -s
        j = i
    }
    out.d = s * Math.sqrt(d)
    const bLen = Math.hypot(bx, bz)
    if (bLen >= 1e-6) {
        out.gx = (s * bx) / bLen
        out.gz = (s * bz) / bLen
    } else {
        // On the boundary: the closest edge's outward normal (see header note).
        const k = closest
        const k1 = (k + 1) % n
        const ex = verts[k1 * 2]! - verts[k * 2]!
        const ez = verts[k1 * 2 + 1]! - verts[k * 2 + 1]!
        const [gx, gz] = outwardEdgeNormal2D(ex, ez, windSign)
        out.gx = gx
        out.gz = gz
    }
    out.edge = closest
}

// --- Extrude: fExtrude_*_Ex (extrude.mts compileAux) -------------------------
//
// Prism = max(2D polygon distance in the (possibly un-twisted) xz frame,
// slab distance |y| − h). The twist path queries the polygon at
// R(−angle(y))·(x, z) with angle = twist·clamp((y+h)/2h, 0, 1) — sign-correct
// with the exact zero set, but NOT 1-Lipschitz (|∇f| grows with twist rate ×
// radius); callers must use the leaf's local Lipschitz bound for certificates.

const POLY_SCRATCH: Polygon2DResult = { d: 0, gx: 0, gz: 0, edge: 0 }

export function extrudeDist(
    verts: ArrayLike<number>,
    windSign: 1 | -1,
    h: number,
    twistRad: number,
    px: number,
    py: number,
    pz: number,
): number {
    let qx = px
    let qz = pz
    if (twistRad !== 0) {
        const t = Math.max(0, Math.min(1, (py + h) / (2 * h)))
        const angle = twistRad * t
        const ca = Math.cos(angle)
        const sa = Math.sin(angle)
        qx = ca * px + sa * pz
        qz = -sa * px + ca * pz
    }
    polygonDist2D(verts, windSign, qx, qz, POLY_SCRATCH)
    return Math.max(POLY_SCRATCH.d, Math.abs(py) - h)
}

export function extrudeNormal(
    verts: ArrayLike<number>,
    windSign: 1 | -1,
    h: number,
    twistRad: number,
    px: number,
    py: number,
    pz: number,
    out: Float64Array,
    off = 0,
): void {
    const t = Math.max(0, Math.min(1, (py + h) / (2 * h)))
    const angle = twistRad * t
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    const qx = ca * px + sa * pz
    const qz = -sa * px + ca * pz
    polygonDist2D(verts, windSign, qx, qz, POLY_SCRATCH)
    const dCap = Math.abs(py) - h
    if (POLY_SCRATCH.d > dCap) {
        // Side: rotate the 2D gradient back; the twist adds a y component
        // (same formula as the WGSL twist path).
        const gx = POLY_SCRATCH.gx
        const gz = POLY_SCRATCH.gz
        const k = Math.abs(h) > 1e-6 ? twistRad / (2 * h) : 0
        const gy = k * (gx * qz - gz * qx)
        const nx = ca * gx - sa * gz
        const nz = sa * gx + ca * gz
        const len = Math.hypot(nx, gy, nz)
        if (len > 1e-12) {
            out[off] = nx / len
            out[off + 1] = gy / len
            out[off + 2] = nz / len
        } else {
            out[off] = 1
            out[off + 1] = 0
            out[off + 2] = 0
        }
    } else {
        out[off] = 0
        out[off + 1] = py >= 0 ? 1 : -1
        out[off + 2] = 0
    }
}

// --- Loft: fLoft_*_field (loft.mts compileAuxFast) ----------------------------
//
// Prism-like: max(profile-mix distance, slab |y| − h). The profile field at
// height y linearly interpolates the 2D polygon SDFs of the two bracketing
// profiles; segment selection matches the WGSL (seg = t·(M−1),
// si = min(⌊seg⌋, M−2), localT = seg − si). Sign-correct with the exact zero
// set, but NOT 1-Lipschitz: ∂f/∂y = (dB − dA)/segH can exceed the unit xz
// gradient — callers must use the leaf's local Lipschitz bound for
// certificates (same contract as the twisted extrude).

const POLY_SCRATCH_B: Polygon2DResult = { d: 0, gx: 0, gz: 0, edge: 0 }

export function loftDist(
    profs: ReadonlyArray<ArrayLike<number>>,
    winds: ArrayLike<number>,
    h: number,
    px: number,
    py: number,
    pz: number,
): number {
    const M = profs.length
    const t = Math.max(0, Math.min(1, (py + h) / (2 * h)))
    const seg = t * (M - 1)
    const si = Math.min(Math.floor(seg), M - 2)
    const lt = seg - si
    polygonDist2D(profs[si]!, winds[si]! as 1 | -1, px, pz, POLY_SCRATCH)
    polygonDist2D(profs[si + 1]!, winds[si + 1]! as 1 | -1, px, pz, POLY_SCRATCH_B)
    const dProfile = POLY_SCRATCH.d * (1 - lt) + POLY_SCRATCH_B.d * lt
    return Math.max(dProfile, Math.abs(py) - h)
}

/**
 * Analytic region-based loft normal: side → mixed 2D gradients plus the
 * profile-morph y term ∂/∂y mix = (dB − dA)/segH (zero outside the slab where
 * t clamps, matching the WGSL FD on the clamped profile field); cap → ±y.
 */
export function loftNormal(
    profs: ReadonlyArray<ArrayLike<number>>,
    winds: ArrayLike<number>,
    h: number,
    px: number,
    py: number,
    pz: number,
    out: Float64Array,
    off = 0,
): void {
    const M = profs.length
    const tRaw = (py + h) / (2 * h)
    const t = Math.max(0, Math.min(1, tRaw))
    const seg = t * (M - 1)
    const si = Math.min(Math.floor(seg), M - 2)
    const lt = seg - si
    polygonDist2D(profs[si]!, winds[si]! as 1 | -1, px, pz, POLY_SCRATCH)
    polygonDist2D(profs[si + 1]!, winds[si + 1]! as 1 | -1, px, pz, POLY_SCRATCH_B)
    const dProfile = POLY_SCRATCH.d * (1 - lt) + POLY_SCRATCH_B.d * lt
    const dCap = Math.abs(py) - h
    if (dProfile > dCap) {
        // A loft face point generally lies on NEITHER profile's boundary;
        // polygonDist2D's gradient is uniformly outward (including its
        // exact-on-boundary fallback), so the mix needs no orientation fixup.
        const gx = POLY_SCRATCH.gx * (1 - lt) + POLY_SCRATCH_B.gx * lt
        const gz = POLY_SCRATCH.gz * (1 - lt) + POLY_SCRATCH_B.gz * lt
        const gy =
            tRaw > 0 && tRaw < 1 && Math.abs(h) > 1e-9
                ? ((POLY_SCRATCH_B.d - POLY_SCRATCH.d) * (M - 1)) / (2 * h)
                : 0
        const len = Math.hypot(gx, gy, gz)
        if (len > 1e-12) {
            out[off] = gx / len
            out[off + 1] = gy / len
            out[off + 2] = gz / len
        } else {
            out[off] = 1
            out[off + 1] = 0
            out[off + 2] = 0
        }
    } else {
        out[off] = 0
        out[off + 1] = py >= 0 ? 1 : -1
        out[off + 2] = 0
    }
}

// --- Lathe: revolution of a Polygon2D profile around the local Y axis --------
//
// DELIBERATE DEVIATION from the shader (same spirit as the cylinder note
// above): the WGSL lathe evaluates the 2D polygon SDF at the meridian point
// q = (|p.xz|, y), so a profile edge lying ON the revolution axis (both
// endpoints at r ≈ 0) reports d = 0 along the axis — but that edge is interior
// to the revolved solid, not boundary, and a phantom f = 0 axis line breaks
// SFCC's f = 0 ⟺ surface invariant. We therefore measure distance only to
// NON-AXIS profile edges (the true revolved boundary) while keeping the full
// closed polygon for the inside/outside parity test. For profiles with every
// vertex at r ≥ 0 (enforced by the compiler) the nearest point of a revolved
// edge to any query lies in the query's own meridian half-plane, so the
// meridian distance IS the exact 3D distance: an exact SDF, globally
// 1-Lipschitz, no localLipschitz bound needed.
//
// Normals use the meridian gradient lifted by the radial direction; exactly on
// the boundary the closest-point vector vanishes and we fall back to the
// closest edge's outward profile normal (the true gradient limit), matching
// the polygonDist2D deviation note above.

/** Profile-space |r| at or below which a vertex sits on the revolution axis. */
export const LATHE_AXIS_R = 1e-6

/** Relative direction epsilon: |dy| (resp. |dr|) ≤ this × edge length ⇒ plane (resp. cylinder). */
const LATHE_EDGE_DIR_EPS = 1e-9

export type LatheEdgeKind = "none" | "plane" | "cylinder" | "cone"

export interface LatheProfileEdge {
    /** "none" = degenerate or axis-lying (no revolved surface, skipped by strata/distance). */
    readonly kind: LatheEdgeKind
    /** Endpoints in (r, y) profile space (edge k runs vertex k → vertex k+1). */
    readonly r0: number
    readonly y0: number
    readonly r1: number
    readonly y1: number
    readonly len: number
    /** Unit outward profile normal of the revolved surface (true outward of the 2D region; 0 for "none"). */
    readonly nr: number
    readonly ny: number
}

/**
 * Classify the profile edges of a lathe polygon and compute their outward
 * normals (`outwardEdgeNormal2D` in the (r, y) plane, out of the polygon
 * interior regardless of authoring direction). Shared by the CPU evaluator
 * (strata carriers) and the native-feature compiler (rings/poles) so the
 * per-edge stratum layout never drifts between them.
 */
export function latheProfileEdges(vertices: [number, number][], windSign: 1 | -1): LatheProfileEdge[] {
    const n = vertices.length
    const out: LatheProfileEdge[] = []
    for (let i = 0; i < n; i++) {
        const [r0, y0] = vertices[i]!
        const [r1, y1] = vertices[(i + 1) % n]!
        const dr = r1 - r0
        const dy = y1 - y0
        const len = Math.hypot(dr, dy)
        let kind: LatheEdgeKind
        if (len < 1e-12 || (Math.abs(r0) <= LATHE_AXIS_R && Math.abs(r1) <= LATHE_AXIS_R)) {
            kind = "none"
        } else if (Math.abs(dy) <= LATHE_EDGE_DIR_EPS * len) {
            kind = "plane"
        } else if (Math.abs(dr) <= LATHE_EDGE_DIR_EPS * len) {
            kind = "cylinder"
        } else {
            kind = "cone"
        }
        const [nr, ny] = kind === "none" ? [0, 0] : outwardEdgeNormal2D(dr, dy, windSign)
        out.push({ kind, r0, y0, r1, y1, len, nr, ny })
    }
    return out
}

interface LatheMeridianResult {
    d: number
    gr: number
    gy: number
}

const LATHE_SCRATCH: LatheMeridianResult = { d: 0, gr: 0, gy: 0 }

/**
 * Signed meridian distance at q = (ρ, y): even-odd parity over the FULL
 * polygon, distance over the non-"none" edges only (see header note).
 */
function latheMeridian(edges: LatheProfileEdge[], qr: number, qy: number, out: LatheMeridianResult): void {
    let inside = false
    let minD2 = Infinity
    let closest = -1
    let bx = 0
    let by = 0
    for (let i = 0; i < edges.length; i++) {
        const e = edges[i]!
        // Even-odd ray crossing (horizontal ray toward +r); ALL edges count —
        // the region test needs the closed loop, axis edges included.
        if (e.y0 > qy !== e.y1 > qy) {
            const rCross = e.r0 + ((qy - e.y0) / (e.y1 - e.y0)) * (e.r1 - e.r0)
            if (qr < rCross) inside = !inside
        }
        if (e.kind === "none") continue
        const ex = e.r1 - e.r0
        const ey = e.y1 - e.y0
        const wx = qr - e.r0
        const wy = qy - e.y0
        const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (e.len * e.len)))
        const dxv = wx - ex * t
        const dyv = wy - ey * t
        const d2 = dxv * dxv + dyv * dyv
        if (d2 < minD2) {
            minD2 = d2
            closest = i
            bx = dxv
            by = dyv
        }
    }
    const s = inside ? -1 : 1
    out.d = s * Math.sqrt(minD2)
    const bLen = Math.hypot(bx, by)
    if (bLen >= 1e-6) {
        out.gr = (s * bx) / bLen
        out.gy = (s * by) / bLen
    } else {
        // On the boundary: the closest edge's outward normal (gradient limit).
        out.gr = edges[closest]!.nr
        out.gy = edges[closest]!.ny
    }
}

export function latheDist(edges: LatheProfileEdge[], px: number, py: number, pz: number): number {
    latheMeridian(edges, Math.hypot(px, pz), py, LATHE_SCRATCH)
    return LATHE_SCRATCH.d
}

export function latheNormal(
    edges: LatheProfileEdge[],
    px: number,
    py: number,
    pz: number,
    out: Float64Array,
    off = 0,
): void {
    const rho = Math.hypot(px, pz)
    latheMeridian(edges, rho, py, LATHE_SCRATCH)
    let rdx = 1
    let rdz = 0
    if (rho > 1e-12) {
        rdx = px / rho
        rdz = pz / rho
    }
    // (gr·radDir, gy) is unit by construction (gr² + gy² = 1).
    out[off] = LATHE_SCRATCH.gr * rdx
    out[off + 1] = LATHE_SCRATCH.gy
    out[off + 2] = LATHE_SCRATCH.gr * rdz
}

// --- Cone: fConeEx (hg_sdf.wgsl:777) -----------------------------------------
//
// Local frame: base disc on y = 0 with radius `radius`, apex at y = `height`.
// Region logic ported verbatim: 0 = mantle, 1 = base, 2 = tip (above apex,
// beyond the mantle's perpendicular), 3 = base rim (outside radius, below the
// mantle's perpendicular).

export function coneDist(px: number, py: number, pz: number, radius: number, height: number): number {
    const qx = Math.hypot(px, pz)
    const qy = py
    const tipX = qx
    const tipY = qy - height
    const L = Math.hypot(height, radius)
    const mdX = height / L
    const mdY = radius / L
    const mantle = tipX * mdX + tipY * mdY
    const base = -qy
    let d = mantle
    if (base > d) d = base
    const projected = tipX * mdY - tipY * mdX // dot(tip, perpDir), perpDir = (mdY, −mdX)
    if (qy > height && projected < 0) {
        const tipDist = Math.hypot(tipX, tipY)
        if (tipDist > d) d = tipDist
    }
    if (qx > radius && projected > L) {
        const baseDist = Math.hypot(qx - radius, qy)
        if (baseDist > d) d = baseDist
    }
    return d
}

export function coneNormal(
    px: number,
    py: number,
    pz: number,
    radius: number,
    height: number,
    out: Float64Array,
    off = 0,
): void {
    const lenXZ = Math.hypot(px, pz)
    const qx = lenXZ
    const qy = py
    const tipX = qx
    const tipY = qy - height
    const L = Math.hypot(height, radius)
    const mdX = height / L
    const mdY = radius / L
    const mantle = tipX * mdX + tipY * mdY
    const base = -qy
    let d = mantle
    let region = 0
    if (base > d) {
        d = base
        region = 1
    }
    const projected = tipX * mdY - tipY * mdX
    if (qy > height && projected < 0) {
        const tipDist = Math.hypot(tipX, tipY)
        if (tipDist > d) {
            d = tipDist
            region = 2
        }
    }
    if (qx > radius && projected > L) {
        const baseDist = Math.hypot(qx - radius, qy)
        if (baseDist > d) {
            d = baseDist
            region = 3
        }
    }
    let rdX = 1
    let rdZ = 0
    if (lenXZ > 1e-8) {
        rdX = px / lenXZ
        rdZ = pz / lenXZ
    }
    let nx: number
    let ny: number
    let nz: number
    if (region === 3) {
        nx = px - radius * rdX
        ny = py
        nz = pz - radius * rdZ
        const len = Math.hypot(nx, ny, nz)
        if (len > 1e-30) {
            nx /= len
            ny /= len
            nz /= len
        } else {
            nx = 0
            ny = -1
            nz = 0
        }
    } else if (region === 2) {
        nx = px
        ny = py - height
        nz = pz
        const len = Math.hypot(nx, ny, nz)
        if (len > 1e-30) {
            nx /= len
            ny /= len
            nz /= len
        } else {
            nx = 0
            ny = 1
            nz = 0
        }
    } else if (region === 1) {
        nx = 0
        ny = -1
        nz = 0
    } else {
        nx = mdX * rdX
        ny = mdY
        nz = mdX * rdZ
        const len = Math.hypot(nx, ny, nz)
        if (len > 1e-30) {
            nx /= len
            ny /= len
            nz /= len
        } else {
            nx = 0
            ny = 1
            nz = 0
        }
    }
    out[off] = nx
    out[off + 1] = ny
    out[off + 2] = nz
}
