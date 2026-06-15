//! Analytic feature curves. Port of `src/export/sfcc/feature-curves.mts`.
//!
//! A feature curve is a sharp-edge locus with its two adjacent smooth strata.
//! v1 native kinds are exact closed forms: `Segment` (straight edge) and
//! `Circle` (full or arc — cylinder rims, cone base, lathe rings). Numerically
//! traced boolean-seam / twisted-helix curves (`makeTracedCurve`) are M4b.
//!
//! Parameterization: segments t ∈ [0,1]; circles θ ∈ [0,2π).

use crate::sfcc::newton::{carrier_pair_tangent, project_to_carrier_pair};
use crate::strata::Stratum;
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

/// Tolerances driving a traced curve's on-locus Newton re-projection. The TS
/// seam tracer wires these into `makeTracedCurve`'s `refine` closure
/// (`curveEps`, `minTangencySin`, `maxChordError*4`); carrying them on the geom
/// keeps `point_at`'s refinement faithful without a global tolerance handle.
#[derive(Clone, Copy, Debug)]
pub struct TracedRefine {
    pub curve_eps: f64,
    pub min_cross: f64,
    pub max_displacement: f64,
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
    /// Numerically traced boolean-seam / twisted-helix polyline (boxed to keep
    /// the enum small). Every sample is exactly on the carrier-pair locus;
    /// interpolation between samples is re-projected by `refine`.
    Traced(Box<TracedData>),
}

/// Payload of a [`Geom::Traced`]. `sa`/`sb` are the adjacent carriers (the
/// `tangent`/`refine` callbacks in TS), stored by value (`Stratum: Copy`).
#[derive(Clone, Debug)]
struct TracedData {
    samples: Vec<f64>,
    n: usize,
    sa: Stratum,
    sb: Stratum,
    refine: TracedRefine,
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
            Geom::Traced(_) => CurveKind::Traced,
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
            Geom::Traced(td) => {
                let TracedData { samples, n, sa, sb, refine } = &**td;
                let t_max = (*n - 1) as f64;
                let mut tc = t;
                if self.closed {
                    tc %= t_max;
                    if tc < 0.0 {
                        tc += t_max;
                    }
                } else {
                    tc = tc.clamp(0.0, t_max);
                }
                let i = (tc.floor() as usize).min(*n - 2);
                let fr = tc - i as f64;
                let (sx, sy, sz) = traced_sample(samples, i);
                let (sx1, sy1, sz1) = traced_sample(samples, i + 1);
                let lx = sx * (1.0 - fr) + sx1 * fr;
                let ly = sy * (1.0 - fr) + sy1 * fr;
                let lz = sz * (1.0 - fr) + sz1 * fr;
                if fr == 0.0 || fr == 1.0 {
                    return [lx, ly, lz];
                }
                match project_to_carrier_pair(
                    sa, sb, lx, ly, lz, refine.curve_eps, refine.min_cross, refine.max_displacement,
                ) {
                    Some(q) => q,
                    None => [lx, ly, lz],
                }
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
            Geom::Traced(td) => {
                let TracedData { samples, n, sa, sb, .. } = &**td;
                let p = self.point_at(t);
                let mut out = [0.0; 3];
                carrier_pair_tangent(sa, sb, p[0], p[1], p[2], &mut out);
                // Orient along increasing t (the tracer's direction may differ).
                let t_max = (*n - 1) as f64;
                let i = (t.floor().max(0.0).min(t_max - 1.0)) as usize;
                let (sx, sy, sz) = traced_sample(samples, i);
                let (sx1, sy1, sz1) = traced_sample(samples, i + 1);
                let dx = sx1 - sx;
                let dy = sy1 - sy;
                let dz = sz1 - sz;
                if out[0] * dx + out[1] * dy + out[2] * dz < 0.0 {
                    out[0] = -out[0];
                    out[1] = -out[1];
                    out[2] = -out[2];
                }
                out
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
                let mut t = self.wrap_angle(a2.atan2(a1));
                if let Geom::Circle { arc: true, .. } = self.geom {
                    if t > self.t_max {
                        // Outside the arc: clamp to the nearer endpoint (by angle).
                        t = if t - self.t_max < self.t_min + TAU - t { self.t_max } else { self.t_min };
                    }
                }
                let q = self.point_at(t);
                (t, ((px - q[0]).powi(2) + (py - q[1]).powi(2) + (pz - q[2]).powi(2)).sqrt())
            }
            Geom::Traced(td) => {
                let TracedData { samples, n, .. } = &**td;
                // Nearest polyline segment, then chord projection.
                let mut best_t = 0.0;
                let mut best_d2 = f64::INFINITY;
                for i in 0..(*n - 1) {
                    let (ax, ay, az) = traced_sample(samples, i);
                    let (bx, by, bz) = traced_sample(samples, i + 1);
                    let dx = bx - ax;
                    let dy = by - ay;
                    let dz = bz - az;
                    let l2 = dx * dx + dy * dy + dz * dz;
                    let mut u = if l2 > 0.0 {
                        ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2
                    } else {
                        0.0
                    };
                    u = u.clamp(0.0, 1.0);
                    let qx = ax + dx * u;
                    let qy = ay + dy * u;
                    let qz = az + dz * u;
                    let d2 = (px - qx).powi(2) + (py - qy).powi(2) + (pz - qz).powi(2);
                    if d2 < best_d2 {
                        best_d2 = d2;
                        best_t = i as f64 + u;
                    }
                }
                let q = self.point_at(best_t);
                (best_t, ((px - q[0]).powi(2) + (py - q[1]).powi(2) + (pz - q[2]).powi(2)).sqrt())
            }
        }
    }

    /// For a traced curve, its adjacent carriers + on-locus refine tolerances
    /// (used by trim's `remake_curve` to re-emit a sub-range). `None` otherwise.
    pub fn traced_carriers(&self) -> Option<(Stratum, Stratum, TracedRefine)> {
        match &self.geom {
            Geom::Traced(td) => Some((td.sa, td.sb, td.refine)),
            _ => None,
        }
    }

    fn wrap_angle(&self, th: f64) -> f64 {
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
                    let th = self.wrap_angle(raw);
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
            Geom::Traced(td) => {
                let TracedData { samples, n, sa, sb, .. } = &**td;
                let mut out = Vec::new();
                for i in 0..(*n - 1) {
                    let pi = traced_sample(samples, i);
                    let pj = traced_sample(samples, i + 1);
                    let a = pi.axis_component(axis) - coord;
                    let b = pj.axis_component(axis) - coord;
                    if a == 0.0 && b == 0.0 {
                        continue;
                    }
                    if (a < 0.0) == (b < 0.0) && a != 0.0 {
                        continue;
                    }
                    // Illinois (bracket-preserving regula-falsi) on the exact curve.
                    let mut x0 = i as f64;
                    let mut x1 = (i + 1) as f64;
                    let mut f0 = a;
                    let mut f1 = b;
                    let mut t = x1;
                    for _ in 0..50 {
                        let x2 = x1 - (f1 * (x1 - x0)) / (f1 - f0);
                        let p = self.point_at(x2);
                        let f2 = p[axis] - coord;
                        t = x2;
                        if f2 == 0.0 || f2.abs() < 1e-11 || (x1 - x0).abs() < 1e-11 {
                            break;
                        }
                        if (f2 < 0.0) == (f1 < 0.0) {
                            f0 *= 0.5;
                        } else {
                            x0 = x1;
                            f0 = f1;
                        }
                        x1 = x2;
                        f1 = f2;
                    }
                    let p = self.point_at(t);
                    let mut tg = [0.0; 3];
                    carrier_pair_tangent(sa, sb, p[0], p[1], p[2], &mut tg);
                    out.push(CurveFaceCrossing { t, x: p[0], y: p[1], z: p[2], tangential_dot: tg[axis].abs() });
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
            Geom::Traced(td) => {
                let TracedData { samples, n, .. } = &**td;
                let t_max = (*n - 1) as f64;
                let mut total = 0.0;
                for i in 0..(*n - 1) {
                    let (ax, ay, az) = traced_sample(samples, i);
                    let (bx, by, bz) = traced_sample(samples, i + 1);
                    total += ((bx - ax).powi(2) + (by - ay).powi(2) + (bz - az).powi(2)).sqrt();
                }
                let avg = total / (*n - 1) as f64;
                let mut d = (t1 - t0).abs();
                if self.closed {
                    d %= t_max;
                    if d > t_max / 2.0 {
                        d = t_max - d;
                    }
                }
                d * avg
            }
        }
    }
}

/// xyz of traced sample `i`.
#[inline]
fn traced_sample(samples: &[f64], i: usize) -> (f64, f64, f64) {
    (samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2])
}

trait Axis {
    fn axis_component(&self, axis: usize) -> f64;
}
impl Axis for (f64, f64, f64) {
    #[inline]
    fn axis_component(&self, axis: usize) -> f64 {
        match axis {
            0 => self.0,
            1 => self.1,
            _ => self.2,
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

/// Numerically traced curve (boolean seams / twisted helices). A polyline of
/// `samples` (xyz triplets), every one exactly on the carrier-pair locus, with
/// on-locus Newton re-projection (`refine`) restoring exactness after lerp.
/// Parameter = continuous polyline index t ∈ [0, n−1]; closed loops have
/// `samples[0] ≅ samples[n−1]` and wrap at n−1. Port of `makeTracedCurve`.
#[allow(clippy::too_many_arguments)]
pub fn make_traced_curve(
    id: usize,
    adjacent_strata: [usize; 2],
    samples: Vec<f64>,
    closed: bool,
    sa: Stratum,
    sb: Stratum,
    refine: TracedRefine,
    owner_node_id: i64,
) -> FeatureCurve {
    let n = samples.len() / 3;
    let t_max = (n - 1) as f64;
    FeatureCurve {
        id,
        adjacent_strata,
        closed,
        param_wrap: if closed { Some(t_max) } else { None },
        t_min: 0.0,
        t_max,
        owner_node_id,
        native: false,
        corner_start: -1,
        corner_end: -1,
        index_polyline: samples.clone(),
        geom: Geom::Traced(Box::new(TracedData { samples, n, sa, sb, refine })),
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
