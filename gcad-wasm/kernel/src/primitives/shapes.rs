//! Per-shape f64 SDF + analytic normals for the SFCC v1 subset. Verbatim ports
//! of `src/export/sfcc/cpu-sdf-primitives.mts` (sphere/box/cylinder/cone).
//!
//! All take the primitive-LOCAL point (after the `p − pos` shift the leaf
//! applies). Distance formulas match the WGSL zero-set; normals are the exact
//! region-based analytic normals.

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
}
