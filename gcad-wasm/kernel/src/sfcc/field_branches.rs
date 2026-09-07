//! Analytic field contract for feature extraction. Field magnitudes are retained
//! through composition; normalization belongs to the linear solver, not the field.

use crate::primitives::{polygon2d::polygon_dist_2d, smin::SminMode};
use crate::sdf::{BlendKind, CsgNode, Leaf, Shape};

/// A stable path into one shared, immutable copy of the source expression tree.
/// Generated patches share operands instead of cloning entire nested subtrees.
#[derive(Clone, Debug)]
pub struct FieldRef {
    root: std::sync::Arc<CsgNode>,
    path: Vec<usize>,
}
impl FieldRef {
    pub fn new(root: std::sync::Arc<CsgNode>, path: Vec<usize>) -> Self {
        Self { root, path }
    }
    pub fn node(&self) -> &CsgNode {
        let mut node = self.root.as_ref();
        for &i in &self.path {
            node = match node {
                CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => &c[i],
                CsgNode::Leaf(_) => unreachable!("field path descends through leaf"),
            };
        }
        node
    }

    /// A later cutter can put the final field back at zero after an earlier
    /// union hid this surface. Require survival at every ancestor, not just at
    /// the leaf and final root.
    pub fn surface_live(&self, p: [f64; 3], tolerance: f64) -> bool {
        let mut node = self.root.as_ref();
        for step in 0..=self.path.len() {
            if !sample_tree(node, p).normalized_equation().is_some_and(|s| s.value.abs() <= tolerance) {
                return false;
            }
            if step < self.path.len() {
                node = match node {
                    CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => &c[self.path[step]],
                    CsgNode::Leaf(_) => unreachable!("field path descends through leaf"),
                };
            }
        }
        true
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FieldSample {
    pub value: f64,
    pub gradient: [f64; 3],
}

impl FieldSample {
    fn constant(value: f64) -> Self {
        Self { value, gradient: [0.; 3] }
    }
    fn scale(self, s: f64) -> Self {
        Self { value: self.value * s, gradient: self.gradient.map(|v| v * s) }
    }
    fn add(self, b: Self) -> Self {
        Self { value: self.value + b.value, gradient: std::array::from_fn(|k| self.gradient[k] + b.gradient[k]) }
    }
    fn sub(self, b: Self) -> Self {
        self.add(b.scale(-1.))
    }
    fn min(self, b: Self) -> Self {
        if self.value <= b.value {
            self
        } else {
            b
        }
    }
    fn max(self, b: Self) -> Self {
        if self.value >= b.value {
            self
        } else {
            b
        }
    }
    fn abs(self) -> Self {
        if self.value < 0. {
            self.scale(-1.)
        } else {
            self
        }
    }
    fn hypot(self, b: Self) -> Self {
        let value = self.value.hypot(b.value);
        let gradient = if value > 1e-30 {
            std::array::from_fn(|k| (self.value * self.gradient[k] + b.value * b.gradient[k]) / value)
        } else {
            [0.; 3]
        };
        Self { value, gradient }
    }
    fn modulo(self, period: f64) -> Self {
        Self { value: self.value - period * (self.value / period).floor(), ..self }
    }
    /// Scale the equation and its Jacobian row together. This is not the
    /// derivative of `value / |gradient|`; it is a preconditioned raw equation.
    pub fn normalized_equation(self) -> Option<Self> {
        let magnitude = self.gradient[0].hypot(self.gradient[1]).hypot(self.gradient[2]);
        if !self.value.is_finite() || !magnitude.is_finite() || magnitude <= 1e-30 {
            return None;
        }
        Some(Self { value: self.value / magnitude, gradient: self.gradient.map(|v| v / magnitude) })
    }
}

/// Differentiate the existing native scalar field analytically, retaining the
/// derivative magnitude across nested operators. This is feature geometry;
/// rendering normals and GPU scene sampling keep their existing APIs.
pub fn sample_tree(node: &CsgNode, p: [f64; 3]) -> FieldSample {
    match node {
        CsgNode::Leaf(l) => sample_leaf(l, p),
        CsgNode::Min(children) | CsgNode::Max(children) => {
            let is_min = matches!(node, CsgNode::Min(_));
            let child = children
                .iter()
                .min_by(|a, b| {
                    let order = a.f(p).total_cmp(&b.f(p));
                    if is_min {
                        order
                    } else {
                        order.reverse()
                    }
                })
                .expect("nonempty CSG combiner");
            sample_tree(child, p)
        }
        CsgNode::Blend { kind, mode, r, n, children } => {
            let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
            let mut pair = [0, 1];
            if children.len() > 2 {
                let mut values = [f64::INFINITY; 2];
                for (i, c) in children.iter().enumerate() {
                    let v = sign * c.f(p);
                    if v < values[0] {
                        values[1] = values[0];
                        pair[1] = pair[0];
                        values[0] = v;
                        pair[0] = i;
                    } else if v < values[1] {
                        values[1] = v;
                        pair[1] = i;
                    }
                }
            }
            sample_blend(
                *mode,
                sample_tree(&children[pair[0]], p).scale(sign),
                sample_tree(&children[pair[1]], p).scale(sign),
                *r,
                *n,
            )
            .scale(sign)
        }
    }
}

/// Raw differential over a region-pruned view; uses the same surviving operands
/// and scalar selection as the full field.
pub fn sample_pruned(node: &crate::sdf::Pruned<'_>, p: [f64; 3]) -> FieldSample {
    match node {
        crate::sdf::Pruned::Leaf(l) => sample_leaf(l, p),
        crate::sdf::Pruned::Min(children) | crate::sdf::Pruned::Max(children) => {
            let is_min = matches!(node, crate::sdf::Pruned::Min(_));
            let child = children
                .iter()
                .min_by(|a, b| {
                    let order = a.f(p).total_cmp(&b.f(p));
                    if is_min {
                        order
                    } else {
                        order.reverse()
                    }
                })
                .expect("nonempty CSG combiner");
            sample_pruned(child, p)
        }
        crate::sdf::Pruned::Blend { kind, mode, r, n, children } => {
            let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
            let mut pair = [0, 1];
            if children.len() > 2 {
                let mut values = [f64::INFINITY; 2];
                for (i, c) in children.iter().enumerate() {
                    let v = sign * c.f(p);
                    if v < values[0] {
                        values[1] = values[0];
                        pair[1] = pair[0];
                        values[0] = v;
                        pair[0] = i;
                    } else if v < values[1] {
                        values[1] = v;
                        pair[1] = i;
                    }
                }
            }
            sample_blend(
                *mode,
                sample_pruned(&children[pair[0]], p).scale(sign),
                sample_pruned(&children[pair[1]], p).scale(sign),
                *r,
                *n,
            )
            .scale(sign)
        }
    }
}

fn sample_leaf(l: &Leaf, p: [f64; 3]) -> FieldSample {
    let local = l.sim.inv_apply_point(p[0], p[1], p[2]);
    let [x, y, z] = std::array::from_fn(|k| local[k] - l.pos[k]);
    let gradient = match &l.shape {
        Shape::Extrude { verts, wind, h, twist_rad } => {
            let t = ((y + h) / (2. * h)).clamp(0., 1.);
            let angle = twist_rad * t;
            let (ca, sa) = (angle.cos(), angle.sin());
            let (qx, qz) = (ca * x + sa * z, -sa * x + ca * z);
            let profile = polygon_dist_2d(verts, *wind, qx, qz);
            if profile.d > y.abs() - h {
                let k = if y > -*h && y < *h { twist_rad / (2. * h) } else { 0. };
                [
                    ca * profile.gx - sa * profile.gz,
                    k * (profile.gx * qz - profile.gz * qx),
                    sa * profile.gx + ca * profile.gz,
                ]
            } else {
                [0., if y < 0. { -1. } else { 1. }, 0.]
            }
        }
        Shape::Loft { profs, winds, h } => {
            let segment = ((y + h) / (2. * h)).clamp(0., 1.) * (profs.len() - 1) as f64;
            let i = (segment.floor() as usize).min(profs.len() - 2);
            let t = segment - i as f64;
            let a = polygon_dist_2d(&profs[i], winds[i], x, z);
            let b = polygon_dist_2d(&profs[i + 1], winds[i + 1], x, z);
            if a.d * (1. - t) + b.d * t > y.abs() - h {
                let gy = if y > -*h && y < *h { (b.d - a.d) * (profs.len() - 1) as f64 / (2. * h) } else { 0. };
                [a.gx * (1. - t) + b.gx * t, gy, a.gz * (1. - t) + b.gz * t]
            } else {
                [0., if y < 0. { -1. } else { 1. }, 0.]
            }
        }
        _ => return FieldSample { value: l.f(p), gradient: l.normal(p) },
    };
    FieldSample {
        value: l.f(p),
        gradient: l.sim.rotate_vector(gradient[0], gradient[1], gradient[2]).map(|v| v * l.sign),
    }
}

fn sample_blend(mode: SminMode, a: FieldSample, b: FieldSample, radius: f64, n: f64) -> FieldSample {
    let c = FieldSample::constant;
    let r = c(radius);
    let q = std::f64::consts::FRAC_1_SQRT_2;
    match mode {
        SminMode::Chamfer => a.min(b).min(a.add(b).sub(r).scale(q)),
        SminMode::Round => r.max(a.min(b)).sub(r.sub(a).max(c(0.)).hypot(r.sub(b).max(c(0.)))),
        SminMode::Soft => {
            let e = r.sub(a.sub(b).abs()).max(c(0.));
            let correction = FieldSample {
                value: e.value * e.value / (4. * radius),
                gradient: e.gradient.map(|v| v * e.value / (2. * radius)),
            };
            a.min(b).sub(correction)
        }
        SminMode::Stairs => {
            let s = radius / n;
            let u = b.sub(r);
            a.min(b).min(u.add(a).add(u.sub(a).add(c(s)).modulo(2. * s).sub(c(s)).abs()).scale(0.5))
        }
        SminMode::Columns | SminMode::ColumnsI => {
            if a.value >= radius || b.value >= radius {
                return a.min(b);
            }
            let cr = radius * std::f64::consts::SQRT_2 / ((n - 1.) * 2. + std::f64::consts::SQRT_2);
            let inverse = mode == SminMode::ColumnsI;
            let px = a.add(b).scale(q).sub(r.scale(q)).add(c(if inverse {
                -cr * std::f64::consts::SQRT_2 * 0.5
            } else {
                cr * std::f64::consts::SQRT_2
            }));
            let mut py = b.sub(a).scale(q).add(c(if inverse { cr } else { 0. }));
            if n - 2. * (n / 2.).floor() != 0. {
                py = py.add(c(cr));
            }
            let length = px.hypot(py.modulo(2. * cr));
            if inverse {
                c(cr).sub(length).max(px).min(a).min(b)
            } else {
                length.sub(c(cr)).min(px).min(a).min(b)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blend_derivatives_match_scalar_field_for_every_mode_and_sign() {
        use crate::sdf::leaf_at;
        for mode in [
            SminMode::Chamfer,
            SminMode::Round,
            SminMode::Soft,
            SminMode::Stairs,
            SminMode::Columns,
            SminMode::ColumnsI,
        ] {
            for kind in [BlendKind::Smin, BlendKind::Smax] {
                let inner = CsgNode::Blend {
                    mode: SminMode::Round,
                    kind: BlendKind::Smin,
                    r: 0.7,
                    n: 3.,
                    children: vec![
                        leaf_at(Shape::Sphere { r: 2. }, [-0.8, 0., 0.]),
                        leaf_at(Shape::Sphere { r: 1.7 }, [0.6, 0.2, 0.]),
                    ],
                };
                let tree = CsgNode::Blend {
                    mode,
                    kind,
                    r: 0.8,
                    n: 3.,
                    children: vec![
                        inner,
                        leaf_at(Shape::Sphere { r: 1.8 }, [0., 0.6, 0.]),
                        leaf_at(Shape::Sphere { r: 1.4 }, [0.5, 0., 0.3]),
                    ],
                };
                for i in 0..40 {
                    let p = [0.17 + i as f64 * 0.061, 0.31 + i as f64 * 0.023, 0.53];
                    let sample = sample_tree(&tree, p);
                    let pruned = tree.prune_to_box(p, [0.01; 3]);
                    let regional = sample_pruned(&pruned, p);
                    assert_eq!(sample.value, regional.value);
                    assert_eq!(sample.gradient, regional.gradient);
                    assert!((sample.value - tree.f(p)).abs() < 1e-12, "{mode:?} {kind:?} at {p:?}");
                    for k in 0..3 {
                        let (mut a, mut b) = (p, p);
                        a[k] -= 1e-6;
                        b[k] += 1e-6;
                        let numerical = (tree.f(b) - tree.f(a)) / 2e-6;
                        assert!(
                            (numerical - sample.gradient[k]).abs() < 1e-6,
                            "{mode:?} {kind:?} at {p:?}, axis {k}: {} vs {numerical}",
                            sample.gradient[k]
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn equation_scaling_preserves_residual_and_direction() {
        for scale in [0.01, 1., 100.] {
            let a = FieldSample { value: 2. * scale, gradient: [3. * scale, 4. * scale, 0.] }
                .normalized_equation()
                .unwrap();
            assert!((a.value - 0.4).abs() < 1e-14);
            assert!((a.gradient[0] - 0.6).abs() < 1e-14);
            assert!((a.gradient[1] - 0.8).abs() < 1e-14);
        }
    }

    #[test]
    fn singular_and_nonfinite_equations_are_explicit() {
        for sample in [
            FieldSample { value: 0., gradient: [0.; 3] },
            FieldSample { value: f64::NAN, gradient: [1., 0., 0.] },
            FieldSample { value: 0., gradient: [f64::INFINITY, 0., 0.] },
        ] {
            assert!(sample.normalized_equation().is_none());
        }
    }
}
