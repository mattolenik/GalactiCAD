//! Geometry checks shared by triangulation and mesh edits. Error is measured as
//! controlled projection displacement, not as a claimed bound on |field|.
use super::point_table::PointTable;
use crate::sdf::SdfQuery;
pub(crate) type P3 = [f64; 3];
pub(crate) fn pos(p: &PointTable, i: usize) -> P3 {
    [p.x(i), p.y(i), p.z(i)]
}
pub(crate) fn sub(a: P3, b: P3) -> P3 {
    std::array::from_fn(|k| a[k] - b[k])
}
pub(crate) fn dot(a: P3, b: P3) -> f64 {
    (0..3).map(|k| a[k] * b[k]).sum()
}
pub(crate) fn cross(a: P3, b: P3) -> P3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub(crate) fn norm(a: P3) -> f64 {
    a[0].hypot(a[1]).hypot(a[2])
}
pub(crate) fn normal(p: [P3; 3]) -> P3 {
    cross(sub(p[1], p[0]), sub(p[2], p[0]))
}
pub(crate) fn quality(p: [P3; 3]) -> f64 {
    let max = (0..3)
        .map(|k| norm(sub(p[k], p[(k + 1) % 3])))
        .fold(0., f64::max);
    if max == 0. {
        0.
    } else {
        norm(normal(p)) / max / max
    }
}
pub(crate) fn rounded(p: P3) -> P3 {
    p.map(|v| v as f32 as f64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rejection {
    NonFinite,
    Orientation,
    Projection,
    Displacement,
    Ownership,
    Topology,
    Budget,
    Chart,
}

/// Samples include quarter edges and asymmetric interior points. This is a
/// sampled fidelity check, not a Hausdorff certificate.
pub(crate) const SAMPLES: [[f64; 3]; 13] = [
    [1. / 3.; 3],
    [0.5, 0.5, 0.],
    [0., 0.5, 0.5],
    [0.5, 0., 0.5],
    [0.75, 0.25, 0.],
    [0.25, 0.75, 0.],
    [0., 0.75, 0.25],
    [0., 0.25, 0.75],
    [0.25, 0., 0.75],
    [0.75, 0., 0.25],
    [0.6, 0.2, 0.2],
    [0.2, 0.6, 0.2],
    [0.2, 0.2, 0.6],
];
pub(crate) fn bary(p: [P3; 3], w: [f64; 3]) -> P3 {
    std::array::from_fn(|k| (0..3).map(|i| p[i][k] * w[i]).sum())
}

pub(crate) fn project<T: SdfQuery + ?Sized>(
    tree: &T,
    p: P3,
    budget: f64,
    eps: f64,
) -> Result<P3, Rejection> {
    if !p.iter().all(|x| x.is_finite()) || !budget.is_finite() || budget < 0. {
        return Err(Rejection::NonFinite);
    }
    let mut q = p;
    for _ in 0..24 {
        let s = tree.field_sample(q);
        let len = norm(s.gradient);
        if !s.value.is_finite() || !len.is_finite() || len <= f64::MIN_POSITIVE {
            return Err(Rejection::Projection);
        }
        // Normalizing both sides makes convergence invariant under a constant
        // rescaling of the equation; the final distance is still displacement.
        if s.value.abs() / len <= eps {
            return Ok(q);
        }
        let direction = s.gradient.map(|v| v / len);
        let mut step = s.value / len;
        let mut next = None;
        for _ in 0..12 {
            let n = std::array::from_fn(|k| q[k] - step * direction[k]);
            if norm(sub(n, p)) <= budget && tree.f(n).abs() < s.value.abs() {
                next = Some(n);
                break;
            }
            step *= 0.5;
        }
        q = next.ok_or(Rejection::Displacement)?;
    }
    Err(Rejection::Projection)
}

pub(crate) fn valid_orientation(p: [P3; 3], reference: P3) -> bool {
    for p in [p, p.map(rounded)] {
        if !p.iter().flatten().all(|x| x.is_finite()) {
            return false;
        }
        let n = normal(p);
        let l = norm(n);
        if !l.is_finite() || l == 0. || dot(n, reference) <= 0. {
            return false;
        }
    }
    true
}

pub(crate) fn deviation<T: SdfQuery + ?Sized>(
    tree: &T,
    p: [P3; 3],
    tolerance: f64,
) -> Result<f64, Rejection> {
    if !p.iter().flatten().all(|x| x.is_finite()) {
        return Err(Rejection::NonFinite);
    }
    let mut worst = 0_f64;
    for w in SAMPLES {
        let x = bary(p, w);
        let q = project(tree, x, tolerance, tolerance * 0.001)?;
        worst = worst.max(norm(sub(q, x)));
    }
    Ok(worst)
}

#[derive(Debug, Default)]
pub(crate) struct QualityReport {
    pub triangles: usize,
    pub slivers: usize,
    pub below_5_degrees: usize,
    pub p5_angle: f64,
    pub median_angle: f64,
    pub area_weighted_angle: f64,
}
pub(crate) fn measure(points: &PointTable, tris: &[usize]) -> QualityReport {
    let mut report = QualityReport::default();
    let mut angles = Vec::new();
    let mut area = 0.;
    for t in tris.chunks_exact(3) {
        let p = std::array::from_fn(|k| pos(points, t[k]));
        let mut angle = f64::INFINITY;
        for k in 0..3 {
            let u = sub(p[(k + 1) % 3], p[k]);
            let v = sub(p[(k + 2) % 3], p[k]);
            angle = angle.min(norm(cross(u, v)).atan2(dot(u, v)).to_degrees());
        }
        let weight = norm(normal(p));
        area += weight;
        report.area_weighted_angle += angle * weight;
        report.slivers += (quality(p) < 0.02) as usize;
        report.below_5_degrees += (angle < 5.) as usize;
        angles.push(angle);
    }
    angles.sort_by(f64::total_cmp);
    report.triangles = angles.len();
    if !angles.is_empty() {
        report.p5_angle = angles[(angles.len() - 1) / 20];
        report.median_angle = angles[(angles.len() - 1) / 2];
    }
    if area > 0. {
        report.area_weighted_angle /= area;
    }
    report
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sdf::{leaf_at, Shape};
    #[test]
    fn curved_triangle_vertices_are_not_a_fidelity_test() {
        let sphere = leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        assert!(deviation(&sphere, [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]], 0.01).is_err());
    }
    #[test]
    fn reject_f32_collapse() {
        let p = [[1e8, 0., 0.], [1e8 + 1., 0., 0.], [1e8, 1., 0.]];
        assert!(quality(p) > 0.);
        assert!(!valid_orientation(p, [0., 0., 1.]));
    }
}

#[cfg(test)]
mod scaled_equation_tests {
    use super::*;
    use crate::sdf::{leaf_at, ActiveOwner, CsgNode, Shape};
    struct Scaled<'a>(&'a CsgNode, f64);
    impl SdfQuery for Scaled<'_> {
        fn f(&self, p: P3) -> f64 {
            self.0.f(p) * self.1
        }
        fn grad(&self, p: P3) -> (f64, P3) {
            let (f, n) = self.0.grad(p);
            (f * self.1, n)
        }
        fn field_sample(&self, p: P3) -> super::super::field_branches::FieldSample {
            let s = self.0.field_sample(p);
            super::super::field_branches::FieldSample {
                value: s.value * self.1,
                gradient: s.gradient.map(|v| v * self.1),
            }
        }
        fn interval_over_box(&self, c: P3, h: P3) -> (f64, f64) {
            let (a, b) = self.0.interval_over_box(c, h);
            (a * self.1, b * self.1)
        }
        fn active_owners_at(&self, p: P3, t: f64) -> Vec<ActiveOwner<'_>> {
            self.0.active_owners_at(p, t)
        }
    }
    #[test]
    fn projection_acceptance_uses_geometric_units_under_equation_rescaling() {
        let sphere = leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        for scale in [1e-100, 1., 1e100] {
            let tree = Scaled(&sphere, scale);
            assert_eq!(
                project(&tree, [1.01, 0., 0.], 0.02, 1e-9).unwrap(),
                [1., 0., 0.]
            );
            assert!(project(&tree, [1.01, 0., 0.], 0.001, 1e-9).is_err());
        }
    }
}
