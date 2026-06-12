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

// --- Polygon2D: fPolygon2D_*_combined (extrude.mts/polygon2d.mts) ------------
//
// IQ's even-odd polygon SDF, ported verbatim: exact signed distance to a
// closed polygon (negative inside regardless of winding), plus the gradient
// (direction to/from the closest edge) and the closest edge index.
//
// DELIBERATE DEVIATION from the shader: exactly ON the boundary the
// closest-point vector vanishes and the WGSL falls back to (1, 0) — GPU rays
// never sit exactly on the surface, but SFCC probes do (they're projected
// onto carriers). The fallback here is the closest edge's outward normal
// (`windSign` orients it), which is the true gradient limit.

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
        const eLen = Math.max(Math.hypot(ex, ez), 1e-12)
        out.gx = (ez / eLen) * windSign
        out.gz = (-ex / eLen) * windSign
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
