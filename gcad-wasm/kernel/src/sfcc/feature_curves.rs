//! Analytic feature curves. Port of `src/export/sfcc/feature-curves.mts`.
//!
//! A feature curve is a sharp-edge locus with its two adjacent smooth strata.
//! v1 native kinds are exact closed forms: `Segment` (straight edge) and
//! `Circle` (full or arc — cylinder rims, cone base, lathe rings). Numerically
//! traced boolean-seam / twisted-helix curves (`makeTracedCurve`) are M4b.
//!
//! Parameterization: segments t ∈ [0,1]; circles θ ∈ [0,2π).

use std::f64::consts::PI;

const TAU: f64 = 2.0 * PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurveKind {
    Segment,
    Circle,
    Traced,
}

#[derive(Clone, Copy, Debug)]
pub struct CurveFaceCrossing {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// |unit tangent · plane-normal axis| — transversality measure.
    pub tangential_dot: f64,
}

#[derive(Clone, Debug)]
enum Geom {
    Segment {
        a: [f64; 3],
        d: [f64; 3],
        len: f64,
        tan: [f64; 3],
    },
    Circle {
        c: [f64; 3],
        e1: [f64; 3],
        e2: [f64; 3],
        r: f64,
        arc: bool,
    },
}

#[derive(Clone, Debug)]
pub struct FeatureCurve {
    pub id: usize,
    pub adjacent_strata: [usize; 2],
    pub closed: bool,
    pub param_wrap: Option<f64>,
    pub t_min: f64,
    pub t_max: f64,
    pub owner_node_id: i64,
    pub native: bool,
    /// Corner id at the start/end (-1 = free end).
    pub corner_start: i64,
    pub corner_end: i64,
    /// Coarse polyline (xyz triplets) for spatial indexing — NOT exact geometry.
    pub index_polyline: Vec<f64>,
    geom: Geom,
}

impl FeatureCurve {
    pub fn kind(&self) -> CurveKind {
        match self.geom {
            Geom::Segment { .. } => CurveKind::Segment,
            Geom::Circle { .. } => CurveKind::Circle,
        }
    }

    pub fn point_at(&self, t: f64) -> [f64; 3] {
        match &self.geom {
            Geom::Segment { a, d, .. } => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t],
            Geom::Circle { c, e1, e2, r, .. } => {
                let (co, si) = (t.cos(), t.sin());
                [
                    c[0] + r * (co * e1[0] + si * e2[0]),
                    c[1] + r * (co * e1[1] + si * e2[1]),
                    c[2] + r * (co * e1[2] + si * e2[2]),
                ]
            }
        }
    }

    pub fn tangent_at(&self, t: f64) -> [f64; 3] {
        match &self.geom {
            Geom::Segment { tan, .. } => *tan,
            Geom::Circle { e1, e2, .. } => {
                let (co, si) = (t.cos(), t.sin());
                [-si * e1[0] + co * e2[0], -si * e1[1] + co * e2[1], -si * e1[2] + co * e2[2]]
            }
        }
    }

    /// Closest curve parameter + distance to a world point.
    pub fn project(&self, px: f64, py: f64, pz: f64) -> (f64, f64) {
        match &self.geom {
            Geom::Segment { a, d, len, .. } => {
                let mut t = ((px - a[0]) * d[0] + (py - a[1]) * d[1] + (pz - a[2]) * d[2]) / (len * len);
                t = t.clamp(0.0, 1.0);
                let q = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
                (t, ((px - q[0]).powi(2) + (py - q[1]).powi(2) + (pz - q[2]).powi(2)).sqrt())
            }
            Geom::Circle { c, e1, e2, .. } => {
                let v = [px - c[0], py - c[1], pz - c[2]];
                let a1 = v[0] * e1[0] + v[1] * e1[1] + v[2] * e1[2];
                let a2 = v[0] * e2[0] + v[1] * e2[1] + v[2] * e2[2];
                let t = self.into_range(a2.atan2(a1));
                let q = self.point_at(t);
                (t, ((px - q[0]).powi(2) + (py - q[1]).powi(2) + (pz - q[2]).powi(2)).sqrt())
            }
        }
    }

    fn into_range(&self, th: f64) -> f64 {
        let mut v = (th - self.t_min) % TAU;
        if v < 0.0 {
            v += TAU;
        }
        self.t_min + v
    }

    /// All crossings of the curve with the plane {p[axis] = coord}.
    pub fn axis_plane_crossings(&self, axis: usize, coord: f64) -> Vec<CurveFaceCrossing> {
        match &self.geom {
            Geom::Segment { a, d, tan, .. } => {
                let da = d[axis];
                if da == 0.0 {
                    return Vec::new();
                }
                let t = (coord - a[axis]) / da;
                if !(0.0..=1.0).contains(&t) {
                    return Vec::new();
                }
                vec![CurveFaceCrossing {
                    t,
                    x: a[0] + d[0] * t,
                    y: a[1] + d[1] * t,
                    z: a[2] + d[2] * t,
                    tangential_dot: tan[axis].abs(),
                }]
            }
            Geom::Circle { c, e1, e2, r, arc } => {
                let big_a = r * e1[axis];
                let big_b = r * e2[axis];
                let big_c = coord - c[axis];
                let big_r = big_a.hypot(big_b);
                if big_r < 1e-30 {
                    return Vec::new();
                }
                let ratio = big_c / big_r;
                if !(-1.0..=1.0).contains(&ratio) {
                    return Vec::new();
                }
                let phi = big_b.atan2(big_a);
                let alpha = ratio.clamp(-1.0, 1.0).acos();
                let sols: &[f64] = if alpha == 0.0 { &[phi] } else { &[phi + alpha, phi - alpha] };
                let mut out = Vec::new();
                for &raw in sols {
                    let th = self.into_range(raw);
                    if *arc && th > self.t_max {
                        continue;
                    }
                    let (co, si) = (th.cos(), th.sin());
                    let tg = [-si * e1[0] + co * e2[0], -si * e1[1] + co * e2[1], -si * e1[2] + co * e2[2]];
                    out.push(CurveFaceCrossing {
                        t: th,
                        x: c[0] + r * (co * e1[0] + si * e2[0]),
                        y: c[1] + r * (co * e1[1] + si * e2[1]),
                        z: c[2] + r * (co * e1[2] + si * e2[2]),
                        tangential_dot: tg[axis].abs(),
                    });
                }
                out
            }
        }
    }

    pub fn param_distance(&self, t0: f64, t1: f64) -> f64 {
        match &self.geom {
            Geom::Segment { len, .. } => (t1 - t0).abs() * len,
            Geom::Circle { r, .. } => {
                let mut d = (t1 - t0).abs() % TAU;
                if d > PI {
                    d = TAU - d;
                }
                d * r
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn make_segment_curve(
    id: usize,
    owner_node_id: i64,
    adjacent_strata: [usize; 2],
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
) -> FeatureCurve {
    let d = [bx - ax, by - ay, bz - az];
    let len = d[0].hypot(d[1]).hypot(d[2]);
    let tan = [d[0] / len, d[1] / len, d[2] / len];
    FeatureCurve {
        id,
        adjacent_strata,
        closed: false,
        param_wrap: None,
        t_min: 0.0,
        t_max: 1.0,
        owner_node_id,
        native: false,
        corner_start: -1,
        corner_end: -1,
        index_polyline: vec![ax, ay, az, bx, by, bz],
        geom: Geom::Segment { a: [ax, ay, az], d, len, tan },
    }
}

#[allow(clippy::too_many_arguments)]
pub fn make_circle_curve(
    id: usize,
    owner_node_id: i64,
    adjacent_strata: [usize; 2],
    cx: f64,
    cy: f64,
    cz: f64,
    wx: f64,
    wy: f64,
    wz: f64,
    r: f64,
    arc: Option<(f64, f64)>,
) -> FeatureCurve {
    // Orthonormal in-plane basis (e1, e2) with e1 × e2 = w.
    let mut ex = if wx.abs() < 0.9 { 1.0 } else { 0.0 };
    let mut ey = if wx.abs() < 0.9 { 0.0 } else { 1.0 };
    let ez = 0.0;
    let dot_ew = ex * wx + ey * wy + ez * wz;
    ex -= dot_ew * wx;
    ey -= dot_ew * wy;
    let mut e1z = ez - dot_ew * wz;
    let e1len = ex.hypot(ey).hypot(e1z);
    let e1x = ex / e1len;
    let e1y = ey / e1len;
    e1z /= e1len;
    let e2x = wy * e1z - wz * e1y;
    let e2y = wz * e1x - wx * e1z;
    let e2z = wx * e1y - wy * e1x;
    let e1 = [e1x, e1y, e1z];
    let e2 = [e2x, e2y, e2z];

    let (t_min, t_max) = match arc {
        Some((t0, t1)) => (t0, t1),
        None => (0.0, TAU),
    };
    let index_segs = (8usize).max((64.0 * (t_max - t_min) / TAU).ceil() as usize);
    let mut index_polyline = vec![0.0; (index_segs + 1) * 3];
    for i in 0..=index_segs {
        let th = t_min + (i as f64 / index_segs as f64) * (t_max - t_min);
        let (co, si) = (th.cos(), th.sin());
        index_polyline[i * 3] = cx + r * (co * e1x + si * e2x);
        index_polyline[i * 3 + 1] = cy + r * (co * e1y + si * e2y);
        index_polyline[i * 3 + 2] = cz + r * (co * e1z + si * e2z);
    }

    FeatureCurve {
        id,
        adjacent_strata,
        closed: arc.is_none(),
        param_wrap: if arc.is_none() { Some(TAU) } else { None },
        t_min,
        t_max,
        owner_node_id,
        native: false,
        corner_start: -1,
        corner_end: -1,
        index_polyline,
        geom: Geom::Circle { c: [cx, cy, cz], e1, e2, r, arc: arc.is_some() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_axis_plane_crossing() {
        // Segment from (0,0,0) to (2,0,0); plane x=1 crosses at t=0.5.
        let s = make_segment_curve(0, -1, [0, 1], 0., 0., 0., 2., 0., 0.);
        assert_eq!(s.kind(), CurveKind::Segment);
        let xs = s.axis_plane_crossings(0, 1.0);
        assert_eq!(xs.len(), 1);
        assert!((xs[0].t - 0.5).abs() < 1e-12);
        assert!((xs[0].x - 1.0).abs() < 1e-12);
        assert!((xs[0].tangential_dot - 1.0).abs() < 1e-12); // tangent ‖ x
        // Plane y=1 never crosses (segment is on y=0).
        assert!(s.axis_plane_crossings(1, 1.0).is_empty());
    }

    #[test]
    fn circle_basics_and_plane_crossings() {
        // Unit circle in the z=0 plane (axis +z), centered at origin.
        let c = make_circle_curve(0, -1, [0, 1], 0., 0., 0., 0., 0., 1., 1.0, None);
        assert_eq!(c.kind(), CurveKind::Circle);
        assert!(c.closed);
        // point_at(0) is on the circle at radius 1.
        let p0 = c.point_at(0.0);
        assert!((p0[0].hypot(p0[1]) - 1.0).abs() < 1e-12 && p0[2].abs() < 1e-12);
        // Plane x=0 cuts the circle at two points (θ where cos=0).
        let xs = c.axis_plane_crossings(0, 0.0);
        assert_eq!(xs.len(), 2);
        for x in &xs {
            assert!(x.x.abs() < 1e-9);
            assert!((x.x * x.x + x.y * x.y + x.z * x.z - 1.0).abs() < 1e-9);
        }
        // Plane x=2 misses the unit circle.
        assert!(c.axis_plane_crossings(0, 2.0).is_empty());
        // Projection of a point outside snaps to radius 1.
        let (_, dist) = c.project(3.0, 0.0, 0.0);
        assert!((dist - 2.0).abs() < 1e-9);
    }
}
