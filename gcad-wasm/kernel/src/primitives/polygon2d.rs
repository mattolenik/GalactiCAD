//! 2D polygon signed-distance field (IQ's even-odd test), ported verbatim from
//! `src/scene/primitives/polygon2d.mts` (winding) and
//! `src/export/sfcc/cpu-sdf-primitives.mts` (distance + outward edge normal).
//!
//! Negative inside regardless of winding. Native and generated WGSL use the
//! closest edge's outward normal when its closest-point vector is exactly zero.

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
    let e_len = ex.hypot(ez);
    if e_len == 0. { [0.; 2] } else { [(-ez / e_len) * wind, (ex / e_len) * wind] }
}

/// Closest-point offset and whether its foot is in the segment interior.
pub(crate) fn segment_offset_2d(ex: f64, ey: f64, wx: f64, wy: f64) -> ([f64; 2], bool) {
    let scale = ex.abs().max(ey.abs());
    if scale == 0. { return ([wx, wy], false); }
    let (ux, uy) = (ex / scale, ey / scale);
    // Normalize the edge before squaring; its denominator is then in [1, 2].
    let along = ((wx * ux + wy * uy) / (ux * ux + uy * uy)).clamp(0., scale);
    ([wx - ux * along, wy - uy * along], along > 0. && along < scale)
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

/// Supporting signed distance to one finite segment. The clamped endpoint
/// joins are C1 away from the segment itself; nearest-segment ties can have
/// distinct gradients and must remain separate displaced-field carriers.
pub(crate) fn polygon_edge_dist_2d(
    verts: &[f64], wind: f64, px: f64, pz: f64, edge: usize,
) -> Polygon2DResult {
    let actual = polygon_dist_2d(verts, wind, px, pz);
    let next = (edge + 1) % (verts.len() / 2);
    let (ex, ez) = (verts[2 * next] - verts[2 * edge], verts[2 * next + 1] - verts[2 * edge + 1]);
    let (wx, wz) = (px - verts[2 * edge], pz - verts[2 * edge + 1]);
    let ([dx, dz], _) = segment_offset_2d(ex, ez, wx, wz);
    let length = dx.hypot(dz);
    let sign = if actual.d < 0. { -1. } else { 1. };
    let [gx, gz] = if length > 0. {
        [sign * dx / length, sign * dz / length]
    } else {
        outward_edge_normal_2d(ex, ez, wind)
    };
    Polygon2DResult { d: sign * length, gx, gz, edge }
}

/// Exact signed distance to a closed polygon. `verts` is flat `[x0,z0,x1,z1,…]`.
pub fn polygon_dist_2d(verts: &[f64], wind: f64, px: f64, pz: f64) -> Polygon2DResult {
    let n = verts.len() / 2;
    let mut d = (px - verts[0]).hypot(pz - verts[1]);
    let mut s = 1.0;
    let mut min_dist = f64::INFINITY;
    let mut closest = 0usize;
    let mut closest_interior = false;
    let mut bx = px - verts[0];
    let mut bz = pz - verts[1];
    let mut j = n - 1;
    for i in 0..n {
        let vix = verts[i * 2];
        let viz = verts[i * 2 + 1];
        let vjx = verts[j * 2];
        let vjz = verts[j * 2 + 1];
        let ex = vjx - vix;
        let ez = vjz - viz;
        if ex == 0. && ez == 0. {
            j = i;
            continue;
        }
        let wx = px - vix;
        let wz = pz - viz;
        let ([qx, qz], interior) = segment_offset_2d(ex, ez, wx, wz);
        let dd = qx.hypot(qz);
        d = d.min(dd);
        if dd < min_dist {
            min_dist = dd;
            closest = j;
            closest_interior = interior;
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
    let mut out = Polygon2DResult { d: s * d, gx: 0.0, gz: 0.0, edge: closest };
    let b_len = bx.hypot(bz);
    if b_len > 0. && !closest_interior {
        out.gx = s * bx / b_len;
        out.gz = s * bz / b_len;
    } else {
        // Interior feet have the analytic edge normal, even at tiny residuals;
        // normalizing their cancellation-prone closest-point offset adds noise.
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

    #[test]
    fn tiny_segments_and_duplicate_vertices_keep_distance_and_derivative() {
        for scale in [1e-12, 1e-7, 1., 1e7] {
            let vertices = [[0., 0.], [1., 0.], [1., 0.], [1., 1.], [0., 1.]]
                .map(|p| p.map(|v| v * scale));
            let flat: Vec<_> = vertices.iter().flatten().copied().collect();
            let wind = winding_sign(&vertices);
            let k = 1. / 5.0_f64.sqrt();
            for (p, d, g) in [
                ([0.5, -0.1], 0.1, [0., -1.]),
                ([0.2, 0.7], -0.2, [-1., 0.]),
                ([1.2, 1.4], 0.2 / k, [k, 2. * k]),
                ([0.5, 0.], 0., [0., -1.]),
            ] {
                let sample = polygon_dist_2d(&flat, wind, p[0] * scale, p[1] * scale);
                assert!((sample.d / scale - d).abs() < 1e-12, "scale={scale}, p={p:?}");
                assert!((sample.gx - g[0]).hypot(sample.gz - g[1]) < 1e-12,
                    "scale={scale}, p={p:?}, gradient=({}, {})", sample.gx, sample.gz);
            }
            let branch = polygon_edge_dist_2d(&flat, wind, 0.5 * scale, -0.1 * scale, 0);
            assert!((branch.d / scale - 0.1).abs() < 1e-12);
            assert_eq!([branch.gx, branch.gz], [0., -1.]);
        }
        assert_eq!(segment_offset_2d(0., 0., 2., 3.), ([2., 3.], false));
        assert_eq!(outward_edge_normal_2d(0., 0., 1.), [0.; 2]);
    }

    #[test]
    fn concave_profile_gradients_cover_both_sides_and_endpoint_regions() {
        let k = std::f64::consts::FRAC_1_SQRT_2;
        for scale in [1., 1e-7, 1e-12] {
            for reverse in [false, true] {
                let mut vertices = vec![[0., 0.], [2., 0.], [2., 1.], [1., 1.], [1., 2.], [0., 2.]];
                if reverse { vertices.reverse(); }
                let vertices: Vec<_> = vertices.iter().map(|p| p.map(|v| v * scale)).collect();
                let flat: Vec<_> = vertices.iter().flatten().copied().collect();
                for (p, d, g) in [
                    ([1.3, 1.2], 0.2, [0., 1.]),
                    ([1.2, 1.3], 0.2, [1., 0.]),
                    ([0.8, 1.5], -0.2, [1., 0.]),
                    ([1.5, 0.8], -0.2, [0., 1.]),
                    ([0.9, 0.9], -0.1 / k, [k, k]),
                ] {
                    let sample = polygon_dist_2d(&flat, winding_sign(&vertices), p[0] * scale, p[1] * scale);
                    assert!((sample.d / scale - d).abs() < 1e-12, "scale={scale}, p={p:?}");
                    assert!((sample.gx - g[0]).hypot(sample.gz - g[1]) < 1e-12,
                        "scale={scale}, p={p:?}: ({}, {})", sample.gx, sample.gz);
                }
            }
        }
    }
}
