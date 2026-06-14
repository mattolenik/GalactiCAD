//! 2D polygon signed-distance field (IQ's even-odd test), ported verbatim from
//! `src/scene/primitives/polygon2d.mts` (winding) and
//! `src/export/sfcc/cpu-sdf-primitives.mts` (distance + outward edge normal).
//!
//! Negative inside regardless of winding. DELIBERATE DEVIATION from the shader:
//! exactly on the boundary the closest-point vector vanishes; instead of the
//! WGSL (1,0) fallback this returns the closest edge's true OUTWARD normal (the
//! limit of the off-boundary gradient), so the gradient is continuous across the
//! boundary — SFCC probes do sit exactly on carriers.

/// Winding sign consistent with the extrude WGSL shoelace sum. Returns +1 / −1.
pub fn winding_sign(verts: &[[f64; 2]]) -> f64 {
    let n = verts.len();
    let mut area = 0.0;
    for i in 0..n {
        let [ax, ay] = verts[i];
        let [bx, by] = verts[(i + 1) % n];
        area += (ax + bx) * (ay - by);
    }
    if area < 0.0 {
        -1.0
    } else {
        1.0
    }
}

/// True outward unit normal of a polygon edge with tangent (ex, ez), in the
/// polygon's own 2D plane. `wind` is [`winding_sign`].
pub fn outward_edge_normal_2d(ex: f64, ez: f64, wind: f64) -> [f64; 2] {
    let e_len = ex.hypot(ez).max(1e-12);
    [(-ez / e_len) * wind, (ex / e_len) * wind]
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Polygon2DResult {
    /// Signed distance (negative inside).
    pub d: f64,
    /// Gradient (unit, points away from the surface).
    pub gx: f64,
    pub gz: f64,
    /// Index of the closest edge's start vertex.
    pub edge: usize,
}

/// Exact signed distance to a closed polygon. `verts` is flat `[x0,z0,x1,z1,…]`.
pub fn polygon_dist_2d(verts: &[f64], wind: f64, px: f64, pz: f64) -> Polygon2DResult {
    let n = verts.len() / 2;
    let mut d = (px - verts[0]) * (px - verts[0]) + (pz - verts[1]) * (pz - verts[1]);
    let mut s = 1.0;
    let mut min_dist = f64::INFINITY;
    let mut closest = 0usize;
    let mut bx = 0.0;
    let mut bz = 0.0;
    let mut j = n - 1;
    for i in 0..n {
        let vix = verts[i * 2];
        let viz = verts[i * 2 + 1];
        let vjx = verts[j * 2];
        let vjz = verts[j * 2 + 1];
        let ex = vjx - vix;
        let ez = vjz - viz;
        let wx = px - vix;
        let wz = pz - viz;
        let e_len2 = (ex * ex + ez * ez).max(1e-12);
        let t = ((wx * ex + wz * ez) / e_len2).clamp(0.0, 1.0);
        let qx = wx - ex * t;
        let qz = wz - ez * t;
        let dd = qx * qx + qz * qz;
        d = d.min(dd);
        if dd < min_dist {
            min_dist = dd;
            closest = j;
            bx = qx;
            bz = qz;
        }
        let c0 = pz >= viz;
        let c1 = pz < vjz;
        let c2 = ex * wz > ez * wx;
        if (c0 && c1 && c2) || (!c0 && !c1 && !c2) {
            s = -s;
        }
        j = i;
    }
    let mut out = Polygon2DResult { d: s * d.sqrt(), gx: 0.0, gz: 0.0, edge: closest };
    let b_len = bx.hypot(bz);
    if b_len >= 1e-6 {
        out.gx = s * bx / b_len;
        out.gz = s * bz / b_len;
    } else {
        // On the boundary: the closest edge's outward normal (see header note).
        let k = closest;
        let k1 = (k + 1) % n;
        let ex = verts[k1 * 2] - verts[k * 2];
        let ez = verts[k1 * 2 + 1] - verts[k * 2 + 1];
        let [gx, gz] = outward_edge_normal_2d(ex, ez, wind);
        out.gx = gx;
        out.gz = gz;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unit square, CCW in screen terms: (0,0)→(1,0)→(1,1)→(0,1).
    const SQUARE: [f64; 8] = [0., 0., 1., 0., 1., 1., 0., 1.];

    #[test]
    fn winding_sign_flips_with_orientation() {
        let ccw = [[0., 0.], [1., 0.], [1., 1.], [0., 1.]];
        let cw = [[0., 1.], [1., 1.], [1., 0.], [0., 0.]];
        assert_eq!(winding_sign(&ccw), -winding_sign(&cw));
    }

    #[test]
    fn inside_is_negative_outside_is_positive() {
        let w = winding_sign(&[[0., 0.], [1., 0.], [1., 1.], [0., 1.]]);
        let center = polygon_dist_2d(&SQUARE, w, 0.5, 0.5);
        assert!((center.d - -0.5).abs() < 1e-12, "center d = {}", center.d);
        let outside = polygon_dist_2d(&SQUARE, w, 2.0, 0.5);
        assert!((outside.d - 1.0).abs() < 1e-12, "outside d = {}", outside.d);
    }

    #[test]
    fn gradient_is_unit_length() {
        let w = winding_sign(&[[0., 0.], [1., 0.], [1., 1.], [0., 1.]]);
        // Off-boundary point: gradient is s·b/|b|, unit length.
        let r = polygon_dist_2d(&SQUARE, w, 1.7, 0.3);
        assert!((r.gx.hypot(r.gz) - 1.0).abs() < 1e-12);
        // On-boundary point: falls back to the outward edge normal, also unit.
        let on = polygon_dist_2d(&SQUARE, w, 1.0, 0.5);
        assert!(on.d.abs() < 1e-9, "on-edge d = {}", on.d);
        assert!((on.gx.hypot(on.gz) - 1.0).abs() < 1e-12);
    }
}
