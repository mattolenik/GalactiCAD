//! Per-shape f64 SDF + analytic normals for the SFCC v1 subset. Verbatim ports
//! of `src/export/sfcc/cpu-sdf-primitives.mts` (sphere/box/cylinder/cone).
//!
//! All take the primitive-LOCAL point (after the `p − pos` shift the leaf
//! applies). Distance formulas match the WGSL zero-set; normals are the exact
//! region-based analytic normals.

use crate::primitives::polygon2d::{outward_edge_normal_2d, polygon_dist_2d};

fn sgn(x: f64) -> f64 {
    if x < 0.0 {
        -1.0
    } else {
        1.0
    }
}

fn len3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}

// --- Sphere ----------------------------------------------------------------

pub fn sphere_dist(px: f64, py: f64, pz: f64, r: f64) -> f64 {
    len3(px, py, pz) - r
}

pub fn sphere_normal(px: f64, py: f64, pz: f64) -> [f64; 3] {
    let len = len3(px, py, pz);
    if len > 1e-30 {
        [px / len, py / len, pz / len]
    } else {
        [0.0, 1.0, 0.0]
    }
}

// --- Box -------------------------------------------------------------------

pub fn box_dist(px: f64, py: f64, pz: f64, bx: f64, by: f64, bz: f64) -> f64 {
    let dx = px.abs() - bx;
    let dy = py.abs() - by;
    let dz = pz.abs() - bz;
    let outside = len3(dx.max(0.0), dy.max(0.0), dz.max(0.0));
    let inside_max = dx.min(0.0).max(dy.min(0.0)).max(dz.min(0.0));
    outside + inside_max
}

pub fn box_normal(px: f64, py: f64, pz: f64, bx: f64, by: f64, bz: f64) -> [f64; 3] {
    let dx = px.abs() - bx;
    let dy = py.abs() - by;
    let dz = pz.abs() - bz;
    let ox = dx.max(0.0) * sgn(px);
    let oy = dy.max(0.0) * sgn(py);
    let oz = dz.max(0.0) * sgn(pz);
    let outside_len = len3(ox, oy, oz);
    if outside_len > 0.0 {
        return [ox / outside_len, oy / outside_len, oz / outside_len];
    }
    if dx > dy && dx > dz {
        [sgn(px), 0.0, 0.0]
    } else if dy > dz {
        [0.0, sgn(py), 0.0]
    } else {
        [0.0, 0.0, sgn(pz)]
    }
}

// --- Cylinder (fillet/chamfer = 0): exact capped cylinder -------------------

pub fn cylinder_dist(px: f64, py: f64, pz: f64, r: f64, h: f64) -> f64 {
    let cr = r.max(1e-6);
    let ch = h.max(1e-6);
    let dr = px.hypot(pz) - cr;
    let dy = py.abs() - ch;
    dr.max(dy).min(0.0) + dr.max(0.0).hypot(dy.max(0.0))
}

pub fn cylinder_normal(px: f64, py: f64, pz: f64, r: f64, h: f64) -> [f64; 3] {
    let cr = r.max(1e-6);
    let ch = h.max(1e-6);
    let rho = px.hypot(pz);
    let dr = rho - cr;
    let dy = py.abs() - ch;
    let (nr, ny);
    if dr > 0.0 && dy > 0.0 {
        let len = dr.hypot(dy);
        nr = dr / len;
        ny = (dy / len) * sgn(py);
    } else if dr > dy {
        nr = 1.0;
        ny = 0.0;
    } else {
        nr = 0.0;
        ny = sgn(py);
    }
    if rho > 1e-12 && nr != 0.0 {
        let ox = nr * px / rho;
        let oz = nr * pz / rho;
        let len = len3(ox, ny, oz);
        [ox / len, ny / len, oz / len]
    } else if nr != 0.0 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, if ny == 0.0 { 1.0 } else { ny }, 0.0]
    }
}

// --- Cone ------------------------------------------------------------------

pub fn cone_dist(px: f64, py: f64, pz: f64, radius: f64, height: f64) -> f64 {
    let qx = px.hypot(pz);
    let qy = py;
    let tip_x = qx;
    let tip_y = qy - height;
    let l = height.hypot(radius);
    let md_x = height / l;
    let md_y = radius / l;
    let mantle = tip_x * md_x + tip_y * md_y;
    let base = -qy;
    let mut d = mantle.max(base);
    let projected = tip_x * md_y - tip_y * md_x;
    if qy > height && projected < 0.0 {
        d = d.max(tip_x.hypot(tip_y));
    }
    if qx > radius && projected > l {
        d = d.max((qx - radius).hypot(qy));
    }
    d
}

pub fn cone_normal(px: f64, py: f64, pz: f64, radius: f64, height: f64) -> [f64; 3] {
    let len_xz = px.hypot(pz);
    let qx = len_xz;
    let qy = py;
    let tip_x = qx;
    let tip_y = qy - height;
    let l = height.hypot(radius);
    let md_x = height / l;
    let md_y = radius / l;
    let mantle = tip_x * md_x + tip_y * md_y;
    let base = -qy;
    let mut d = mantle;
    let mut region = 0;
    if base > d {
        d = base;
        region = 1;
    }
    let projected = tip_x * md_y - tip_y * md_x;
    if qy > height && projected < 0.0 {
        let tip_dist = tip_x.hypot(tip_y);
        if tip_dist > d {
            d = tip_dist;
            region = 2;
        }
    }
    if qx > radius && projected > l {
        let base_dist = (qx - radius).hypot(qy);
        if base_dist > d {
            region = 3;
        }
    }
    let (mut rd_x, mut rd_z) = (1.0, 0.0);
    if len_xz > 1e-8 {
        rd_x = px / len_xz;
        rd_z = pz / len_xz;
    }
    let n = match region {
        3 => {
            let v = [px - radius * rd_x, py, pz - radius * rd_z];
            let len = len3(v[0], v[1], v[2]);
            if len > 1e-30 {
                [v[0] / len, v[1] / len, v[2] / len]
            } else {
                [0.0, -1.0, 0.0]
            }
        }
        2 => {
            let v = [px, py - height, pz];
            let len = len3(v[0], v[1], v[2]);
            if len > 1e-30 {
                [v[0] / len, v[1] / len, v[2] / len]
            } else {
                [0.0, 1.0, 0.0]
            }
        }
        1 => [0.0, -1.0, 0.0],
        _ => {
            let v = [md_x * rd_x, md_y, md_x * rd_z];
            let len = len3(v[0], v[1], v[2]);
            if len > 1e-30 {
                [v[0] / len, v[1] / len, v[2] / len]
            } else {
                [0.0, 1.0, 0.0]
            }
        }
    };
    n
}

// --- Extrude (prism over a 2D polygon, optional twist) ---------------------
//
// max(2D polygon distance in the (possibly un-twisted) xz frame, |y| − h). The
// twist path queries at R(−angle)·(x,z), angle = twist·clamp((y+h)/2h,0,1) —
// sign-correct with the exact zero set but NOT 1-Lipschitz.

pub fn extrude_dist(verts: &[f64], wind: f64, h: f64, twist_rad: f64, px: f64, py: f64, pz: f64) -> f64 {
    let (mut qx, mut qz) = (px, pz);
    if twist_rad != 0.0 {
        let t = ((py + h) / (2.0 * h)).clamp(0.0, 1.0);
        let angle = twist_rad * t;
        let (ca, sa) = (angle.cos(), angle.sin());
        qx = ca * px + sa * pz;
        qz = -sa * px + ca * pz;
    }
    let r = polygon_dist_2d(verts, wind, qx, qz);
    r.d.max(py.abs() - h)
}

pub fn extrude_normal(verts: &[f64], wind: f64, h: f64, twist_rad: f64, px: f64, py: f64, pz: f64) -> [f64; 3] {
    let t = ((py + h) / (2.0 * h)).clamp(0.0, 1.0);
    let angle = twist_rad * t;
    let (ca, sa) = (angle.cos(), angle.sin());
    let qx = ca * px + sa * pz;
    let qz = -sa * px + ca * pz;
    let r = polygon_dist_2d(verts, wind, qx, qz);
    if r.d > py.abs() - h {
        let (gx, gz) = (r.gx, r.gz);
        let k = if h.abs() > 1e-6 { twist_rad / (2.0 * h) } else { 0.0 };
        let gy = k * (gx * qz - gz * qx);
        let nx = ca * gx - sa * gz;
        let nz = sa * gx + ca * gz;
        let len = (nx * nx + gy * gy + nz * nz).sqrt();
        if len > 1e-12 {
            [nx / len, gy / len, nz / len]
        } else {
            [1.0, 0.0, 0.0]
        }
    } else {
        [0.0, if py >= 0.0 { 1.0 } else { -1.0 }, 0.0]
    }
}

// --- Loft (prism over linearly-morphed 2D profiles) ------------------------
//
// max(profile-mix distance, |y| − h). Profile field at height y interpolates the
// two bracketing profiles' polygon SDFs. NOT 1-Lipschitz in y (the morph term).

pub fn loft_dist(profs: &[Vec<f64>], winds: &[f64], h: f64, px: f64, py: f64, pz: f64) -> f64 {
    let m = profs.len();
    let t = ((py + h) / (2.0 * h)).clamp(0.0, 1.0);
    let seg = t * (m as f64 - 1.0);
    let si = (seg.floor() as usize).min(m - 2);
    let lt = seg - si as f64;
    let a = polygon_dist_2d(&profs[si], winds[si], px, pz);
    let b = polygon_dist_2d(&profs[si + 1], winds[si + 1], px, pz);
    let d_profile = a.d * (1.0 - lt) + b.d * lt;
    d_profile.max(py.abs() - h)
}

pub fn loft_normal(profs: &[Vec<f64>], winds: &[f64], h: f64, px: f64, py: f64, pz: f64) -> [f64; 3] {
    let m = profs.len();
    let t_raw = (py + h) / (2.0 * h);
    let t = t_raw.clamp(0.0, 1.0);
    let seg = t * (m as f64 - 1.0);
    let si = (seg.floor() as usize).min(m - 2);
    let lt = seg - si as f64;
    let a = polygon_dist_2d(&profs[si], winds[si], px, pz);
    let b = polygon_dist_2d(&profs[si + 1], winds[si + 1], px, pz);
    let d_profile = a.d * (1.0 - lt) + b.d * lt;
    if d_profile > py.abs() - h {
        let gx = a.gx * (1.0 - lt) + b.gx * lt;
        let gz = a.gz * (1.0 - lt) + b.gz * lt;
        let gy = if t_raw > 0.0 && t_raw < 1.0 && h.abs() > 1e-9 {
            ((b.d - a.d) * (m as f64 - 1.0)) / (2.0 * h)
        } else {
            0.0
        };
        let len = (gx * gx + gy * gy + gz * gz).sqrt();
        if len > 1e-12 {
            [gx / len, gy / len, gz / len]
        } else {
            [1.0, 0.0, 0.0]
        }
    } else {
        [0.0, if py >= 0.0 { 1.0 } else { -1.0 }, 0.0]
    }
}

// --- Lathe (revolution of a (r,y) polygon around local Y) ------------------
//
// Distance to NON-axis profile edges (the true revolved boundary), even-odd
// parity over the FULL polygon for inside/outside. Exact SDF (profiles stay at
// r ≥ 0), globally 1-Lipschitz.

/// Profile-space |r| at/below which a vertex sits on the revolution axis.
pub const LATHE_AXIS_R: f64 = 1e-6;
const LATHE_EDGE_DIR_EPS: f64 = 1e-9;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LatheEdgeKind {
    None,
    Plane,
    Cylinder,
    Cone,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LatheProfileEdge {
    pub kind: LatheEdgeKind,
    pub r0: f64,
    pub y0: f64,
    pub r1: f64,
    pub y1: f64,
    pub len: f64,
    pub nr: f64,
    pub ny: f64,
}

/// Classify the profile edges of a lathe polygon and compute outward normals.
pub fn lathe_profile_edges(vertices: &[[f64; 2]], wind: f64) -> Vec<LatheProfileEdge> {
    let n = vertices.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let [r0, y0] = vertices[i];
        let [r1, y1] = vertices[(i + 1) % n];
        let dr = r1 - r0;
        let dy = y1 - y0;
        let len = dr.hypot(dy);
        let kind = if len < 1e-12 || (r0.abs() <= LATHE_AXIS_R && r1.abs() <= LATHE_AXIS_R) {
            LatheEdgeKind::None
        } else if dy.abs() <= LATHE_EDGE_DIR_EPS * len {
            LatheEdgeKind::Plane
        } else if dr.abs() <= LATHE_EDGE_DIR_EPS * len {
            LatheEdgeKind::Cylinder
        } else {
            LatheEdgeKind::Cone
        };
        let [nr, ny] = if kind == LatheEdgeKind::None { [0.0, 0.0] } else { outward_edge_normal_2d(dr, dy, wind) };
        out.push(LatheProfileEdge { kind, r0, y0, r1, y1, len, nr, ny });
    }
    out
}

/// Signed meridian distance at q = (ρ, y): (d, gr, gy).
fn lathe_meridian(edges: &[LatheProfileEdge], qr: f64, qy: f64) -> (f64, f64, f64) {
    let mut inside = false;
    let mut min_d2 = f64::INFINITY;
    let mut closest = 0usize;
    let (mut bx, mut by) = (0.0, 0.0);
    for (i, e) in edges.iter().enumerate() {
        if (e.y0 > qy) != (e.y1 > qy) {
            let r_cross = e.r0 + ((qy - e.y0) / (e.y1 - e.y0)) * (e.r1 - e.r0);
            if qr < r_cross {
                inside = !inside;
            }
        }
        if e.kind == LatheEdgeKind::None {
            continue;
        }
        let ex = e.r1 - e.r0;
        let ey = e.y1 - e.y0;
        let wx = qr - e.r0;
        let wy = qy - e.y0;
        let t = ((wx * ex + wy * ey) / (e.len * e.len)).clamp(0.0, 1.0);
        let dxv = wx - ex * t;
        let dyv = wy - ey * t;
        let d2 = dxv * dxv + dyv * dyv;
        if d2 < min_d2 {
            min_d2 = d2;
            closest = i;
            bx = dxv;
            by = dyv;
        }
    }
    let s = if inside { -1.0 } else { 1.0 };
    let d = s * min_d2.sqrt();
    let b_len = bx.hypot(by);
    if b_len >= 1e-6 {
        (d, s * bx / b_len, s * by / b_len)
    } else {
        (d, edges[closest].nr, edges[closest].ny)
    }
}

pub fn lathe_dist(edges: &[LatheProfileEdge], px: f64, py: f64, pz: f64) -> f64 {
    lathe_meridian(edges, px.hypot(pz), py).0
}

pub fn lathe_normal(edges: &[LatheProfileEdge], px: f64, py: f64, pz: f64) -> [f64; 3] {
    let rho = px.hypot(pz);
    let (_, gr, gy) = lathe_meridian(edges, rho, py);
    let (rdx, rdz) = if rho > 1e-12 { (px / rho, pz / rho) } else { (1.0, 0.0) };
    [gr * rdx, gy, gr * rdz]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(n: [f64; 3]) -> bool {
        (len3(n[0], n[1], n[2]) - 1.0).abs() < 1e-12
    }

    #[test]
    fn sphere_exact() {
        assert!((sphere_dist(0., 0., 0., 1.) - -1.0).abs() < 1e-15);
        assert!((sphere_dist(2., 0., 0., 1.) - 1.0).abs() < 1e-15);
        assert_eq!(sphere_normal(3., 0., 0.), [1.0, 0.0, 0.0]);
    }

    #[test]
    fn box_exact() {
        assert!((box_dist(0., 0., 0., 1., 1., 1.) - -1.0).abs() < 1e-15);
        assert!((box_dist(2., 0., 0., 1., 1., 1.) - 1.0).abs() < 1e-15);
        assert_eq!(box_normal(2., 0., 0., 1., 1., 1.), [1.0, 0.0, 0.0]);
        assert!(unit(box_normal(2., 2., 0., 1., 1., 1.)));
    }

    #[test]
    fn cylinder_exact() {
        assert!((cylinder_dist(0., 0., 0., 1., 2.) - -1.0).abs() < 1e-12);
        assert!((cylinder_dist(2., 0., 0., 1., 2.) - 1.0).abs() < 1e-12);
        assert!(unit(cylinder_normal(2., 0., 0., 1., 2.)));
        assert!(unit(cylinder_normal(0., 3., 0., 1., 2.)));
    }

    #[test]
    fn cone_sanity() {
        // On the base plane at center, d ≈ 0; inside negative; far outside positive.
        assert!(cone_dist(0., 0., 0., 1., 2.).abs() < 1e-12);
        assert!(cone_dist(0., 1.0, 0., 1., 2.) < 0.0);
        assert!(cone_dist(5., 1.0, 0., 1., 2.) > 0.0);
        assert!(unit(cone_normal(2., 1.0, 0., 1., 2.)));
    }

    /// Analytic gradient agrees with a central finite difference of the SDF.
    #[test]
    fn normals_match_finite_difference() {
        let eps = 1e-6;
        let fd = |f: &dyn Fn(f64, f64, f64) -> f64, x: f64, y: f64, z: f64| {
            [
                (f(x + eps, y, z) - f(x - eps, y, z)) / (2.0 * eps),
                (f(x, y + eps, z) - f(x, y - eps, z)) / (2.0 * eps),
                (f(x, y, z + eps) - f(x, y, z - eps)) / (2.0 * eps),
            ]
        };
        let close = |a: [f64; 3], b: [f64; 3]| {
            (a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4 && (a[2] - b[2]).abs() < 1e-4
        };
        for &(x, y, z) in &[(1.3, 0.4, -0.7), (0.2, 1.7, 0.1), (-0.9, -0.3, 1.1)] {
            assert!(close(fd(&|x, y, z| sphere_dist(x, y, z, 1.0), x, y, z), sphere_normal(x, y, z)));
            assert!(close(fd(&|x, y, z| box_dist(x, y, z, 0.5, 0.6, 0.7), x, y, z), box_normal(x, y, z, 0.5, 0.6, 0.7)));
        }
    }

    fn wind2(v: &[[f64; 2]]) -> f64 {
        crate::primitives::polygon2d::winding_sign(v)
    }

    #[test]
    fn extrude_untwisted_sanity() {
        let poly = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0]];
        let flat = vec![1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0];
        let w = wind2(&poly);
        assert!(extrude_dist(&flat, w, 2.0, 0.0, 0.0, 0.0, 0.0) < 0.0); // interior
        assert!(extrude_dist(&flat, w, 2.0, 0.0, 3.0, 0.0, 0.0) > 0.0); // outside xz
        assert!(extrude_dist(&flat, w, 2.0, 0.0, 0.0, 5.0, 0.0) > 0.0); // above cap
        assert!(unit(extrude_normal(&flat, w, 2.0, 0.0, 3.0, 0.0, 0.0)));
        assert!(unit(extrude_normal(&flat, w, 2.0, 0.7, 1.3, 0.4, -0.6))); // twisted side
    }

    #[test]
    fn loft_between_two_squares() {
        let big2 = [[2.0, 2.0], [-2.0, 2.0], [-2.0, -2.0], [2.0, -2.0]];
        let small2 = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0]];
        let profs = vec![
            vec![2.0, 2.0, -2.0, 2.0, -2.0, -2.0, 2.0, -2.0],
            vec![1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0],
        ];
        let winds = vec![wind2(&big2), wind2(&small2)];
        assert!(loft_dist(&profs, &winds, 3.0, 0.0, 0.0, 0.0) < 0.0); // interior
        assert!(loft_dist(&profs, &winds, 3.0, 5.0, 0.0, 0.0) > 0.0); // outside xz
        assert!(loft_dist(&profs, &winds, 3.0, 0.0, 5.0, 0.0) > 0.0); // above cap
        assert!(unit(loft_normal(&profs, &winds, 3.0, 5.0, 0.0, 0.0)));
    }

    #[test]
    fn lathe_revolves_profile() {
        // Rectangle (r,y) → cylinder r=1, y ∈ [−2, 2].
        let verts = [[0.0, -2.0], [1.0, -2.0], [1.0, 2.0], [0.0, 2.0]];
        let w = wind2(&verts);
        let edges = lathe_profile_edges(&verts, w);
        assert!(lathe_dist(&edges, 0.0, 0.0, 0.0) < 0.0); // on axis, interior
        assert!(lathe_dist(&edges, 2.0, 0.0, 0.0) > 0.0); // beyond radius
        assert!((lathe_dist(&edges, 0.5, 0.0, 0.0) - -0.5).abs() < 1e-9); // wall at r=1
        assert!(unit(lathe_normal(&edges, 2.0, 0.0, 0.0)));
        // Analytic normal agrees with FD on a side point.
        let eps = 1e-6;
        let f = |x: f64, y: f64, z: f64| lathe_dist(&edges, x, y, z);
        let g = [
            (f(1.3 + eps, 0.4, 0.2) - f(1.3 - eps, 0.4, 0.2)) / (2.0 * eps),
            (f(1.3, 0.4 + eps, 0.2) - f(1.3, 0.4 - eps, 0.2)) / (2.0 * eps),
            (f(1.3, 0.4, 0.2 + eps) - f(1.3, 0.4, 0.2 - eps)) / (2.0 * eps),
        ];
        let n = lathe_normal(&edges, 1.3, 0.4, 0.2);
        assert!((n[0] - g[0]).abs() < 1e-4 && (n[1] - g[1]).abs() < 1e-4 && (n[2] - g[2]).abs() < 1e-4);
    }
}
