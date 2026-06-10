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
