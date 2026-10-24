//! Enclosures of the real field defined by the represented affine coefficients.
//! No matrix orthogonality or library hypot accuracy is assumed. See the proof.
use super::{BlendKind, CsgNode, Leaf, Shape};
use crate::primitives::smin::SminMode;

pub(super) fn invalid_interval() -> (f64, f64) {
    (f64::NAN, f64::NAN)
}
pub(super) fn valid_interval((lo, hi): (f64, f64)) -> bool {
    lo.is_finite() && hi.is_finite() && lo <= hi
}

#[derive(Clone, Copy)]
pub(crate) struct Interval {
    pub lo: f64,
    pub hi: f64,
}
impl Interval {
    pub(crate) fn point(x: f64) -> Self {
        Self { lo: x, hi: x }
    }
    fn checked(lo: f64, hi: f64) -> Option<Self> {
        if valid_interval((lo, hi)) {
            Some(Self { lo, hi })
        } else {
            None
        }
    }
    pub(crate) fn add(self, b: Self) -> Option<Self> {
        Self::checked((self.lo + b.lo).next_down(), (self.hi + b.hi).next_up())
    }
    pub(crate) fn sub(self, b: Self) -> Option<Self> {
        Self::checked((self.lo - b.hi).next_down(), (self.hi - b.lo).next_up())
    }
    pub(crate) fn mul(self, x: f64) -> Option<Self> {
        if x == 0. {
            return Some(Self::point(0.));
        }
        let (a, b) = if x > 0. {
            (self.lo * x, self.hi * x)
        } else {
            (self.hi * x, self.lo * x)
        };
        Self::checked(a.next_down(), b.next_up())
    }
    fn abs(self) -> Self {
        if self.lo >= 0. {
            self
        } else if self.hi <= 0. {
            Self {
                lo: -self.hi,
                hi: -self.lo,
            }
        } else {
            Self {
                lo: 0.,
                hi: (-self.lo).max(self.hi),
            }
        }
    }
}

// Scaled Euclidean norm: each operation is rounded outward. Unlike hypot, sqrt
// has a correct-rounding contract. Scaling prevents avoidable squared overflow.
fn norm(v: [f64; 3], upper: bool) -> Option<f64> {
    let m = v.into_iter().fold(0., f64::max);
    if m == 0. {
        return Some(0.);
    }
    let round = |x: f64| {
        if upper {
            x.next_up()
        } else {
            x.next_down().max(0.)
        }
    };
    let mut sum = 0.;
    for x in v {
        let q = round(x / m);
        sum = round(sum + round(q * q));
    }
    let n = round(round(sum.sqrt()) * m);
    n.is_finite().then_some(n)
}

// Keep a sphere's radial geometry rather than replacing a rotated query by a
// loose local AABB. The defect bound uses the *represented* matrix, not a claim
// that its columns are orthonormal. Failure falls back to the affine enclosure.
fn sphere_metric(leaf: &Leaf, radius: f64, c: [f64; 3], half: [f64; 3]) -> Option<Interval> {
    let r = &leaf.sim.r;
    let mut defect = 0.0f64;
    for i in 0..3 {
        let mut row_bound = Interval::point(0.);
        for j in 0..3 {
            let mut dot = Interval::point(0.);
            for k in 0..3 {
                dot = dot.add(Interval::point(r[i * 3 + k]).mul(r[j * 3 + k])?)?;
            }
            let error = dot
                .sub(Interval::point(if i == j { 1. } else { 0. }))?
                .abs()
                .hi;
            row_bound = row_bound.add(Interval::point(error))?;
        }
        defect = defect.max(row_bound.hi);
    }
    // A large defect makes the radial bound unhelpful, not invalid geometry.
    if defect >= 1. {
        return None;
    }
    let lower_factor = (1. - defect).next_down().max(0.).sqrt().next_down().max(0.);
    let upper_factor = (1. + defect).next_up().sqrt().next_up();
    let mut rotated_pos = [Interval::point(0.); 3];
    for i in 0..3 {
        for k in 0..3 {
            rotated_pos[i] = rotated_pos[i].add(Interval::point(leaf.pos[k]).mul(r[i * 3 + k])?)?;
        }
    }
    let mut world = [Interval::point(0.); 3];
    let mut residual = [0.; 3];
    for a in 0..3 {
        let center = rotated_pos[a]
            .mul(leaf.sim.s)?
            .add(Interval::point(leaf.sim.t[a]))?;
        world[a] = Interval::point(c[a])
            .add(Interval {
                lo: -half[a],
                hi: half[a],
            })?
            .sub(center)?
            .abs();
        let mut q = Interval::point(0.);
        for b in 0..3 {
            q = q.add(rotated_pos[b].mul(r[b * 3 + a])?)?;
        }
        residual[a] = q
            .sub(Interval::point(leaf.pos[a]))?
            .mul(leaf.sim.s)?
            .abs()
            .hi;
    }
    let residual = norm(residual, true)?;
    let near = norm(world.map(|v| v.lo), false)?;
    let far = norm(world.map(|v| v.hi), true)?;
    let lo = ((near * lower_factor).next_down().max(0.) - residual)
        .next_down()
        .max(0.);
    let hi = ((far * upper_factor).next_up() + residual).next_up();
    Interval::checked(lo, hi)?.sub(Interval::point(radius).mul(leaf.sim.s)?)
}

fn signed_permutation(r: &[f64; 9]) -> bool {
    (0..3).all(|a| {
        (0..3).filter(|&b| r[a * 3 + b].abs() == 1.).count() == 1
            && (0..3).filter(|&b| r[b * 3 + a].abs() == 1.).count() == 1
    }) && r.iter().all(|x| *x == 0. || x.abs() == 1.)
}

pub(super) fn primitive(leaf: &Leaf, c: [f64; 3], half: [f64; 3]) -> Option<(f64, f64)> {
    if !leaf.valid_parameters()
        || c.iter().any(|x| !x.is_finite())
        || half.iter().any(|x| !x.is_finite() || *x < 0.)
    {
        return None;
    }
    if let Shape::Sphere { r } = leaf.shape {
        if !signed_permutation(&leaf.sim.r) {
            if let Some(result) = sphere_metric(leaf, r, c, half) {
                return Some(if leaf.sign < 0. {
                    (-result.hi, -result.lo)
                } else {
                    (result.lo, result.hi)
                });
            }
        }
    }
    // Homogeneity removes division by scale without changing the real field:
    // s*phi(R^T(p-t)/s-pos) = phi_scaled(R^T(p-t)-s*pos).
    let mut delta = [Interval::point(0.); 3];
    for a in 0..3 {
        delta[a] = Interval::point(c[a])
            .add(Interval {
                lo: -half[a],
                hi: half[a],
            })?
            .sub(Interval::point(leaf.sim.t[a]))?;
    }
    let mut q = [Interval::point(0.); 3];
    for a in 0..3 {
        let mut row = Interval::point(0.);
        for b in 0..3 {
            row = row.add(delta[b].mul(leaf.sim.r[b * 3 + a])?)?;
        }
        q[a] = row
            .sub(Interval::point(leaf.pos[a]).mul(leaf.sim.s)?)?
            .abs();
    }
    let result = match leaf.shape {
        Shape::Sphere { r } => {
            let d = Interval {
                lo: norm(q.map(|v| v.lo), false)?,
                hi: norm(q.map(|v| v.hi), true)?,
            };
            d.sub(Interval::point(r).mul(leaf.sim.s)?)?
        }
        Shape::Cuboid { half: h } => {
            for a in 0..3 {
                q[a] = q[a].sub(Interval::point(h[a]).mul(leaf.sim.s)?)?;
            }
            let outside = Interval {
                lo: norm(q.map(|v| v.lo.max(0.)), false)?,
                hi: norm(q.map(|v| v.hi.max(0.)), true)?,
            };
            let inside = Interval {
                lo: q
                    .iter()
                    .map(|v| v.lo)
                    .fold(f64::NEG_INFINITY, f64::max)
                    .min(0.),
                hi: q
                    .iter()
                    .map(|v| v.hi)
                    .fold(f64::NEG_INFINITY, f64::max)
                    .min(0.),
            };
            outside.add(inside)?
        }
        Shape::Cylinder { r, h } => {
            // Match the production primitive's minimum dimension convention.
            let (r, h) = (r.max(1e-6), h.max(1e-6));
            let radial = Interval {
                lo: norm([q[0].lo, q[2].lo, 0.], false)?,
                hi: norm([q[0].hi, q[2].hi, 0.], true)?,
            }
            .sub(Interval::point(r).mul(leaf.sim.s)?)?;
            let axial = q[1].sub(Interval::point(h).mul(leaf.sim.s)?)?;
            let outside = Interval {
                lo: norm([radial.lo.max(0.), axial.lo.max(0.), 0.], false)?,
                hi: norm([radial.hi.max(0.), axial.hi.max(0.), 0.], true)?,
            };
            outside.add(Interval {
                lo: radial.lo.max(axial.lo).min(0.),
                hi: radial.hi.max(axial.hi).min(0.),
            })?
        }
        _ => return None,
    };
    Some(if leaf.sign < 0. {
        (-result.hi, -result.lo)
    } else {
        (result.lo, result.hi)
    })
}

/// Partial checked enclosure of the represented real field. Unsupported valid
/// leaves/operators remain unbounded; malformed parameters or arithmetic failure
/// abort the entire query. This never imports a legacy Lipschitz estimate.
pub(super) fn partial(node: &CsgNode, c: [f64; 3], half: [f64; 3]) -> Option<(f64, f64)> {
    if c.iter().any(|x| !x.is_finite()) || half.iter().any(|x| !x.is_finite() || *x < 0.) {
        return None;
    }
    match node {
        CsgNode::Leaf(leaf) => {
            if !leaf.valid_parameters() {
                return None;
            }
            let polygon_valid = |p: &[f64]| {
                (0..p.len() / 2).all(|i| {
                    let j = (i + 1) % (p.len() / 2);
                    p[2 * i] != p[2 * j] || p[2 * i + 1] != p[2 * j + 1]
                })
            };
            match &leaf.shape {
                Shape::Extrude { verts, .. } if !polygon_valid(verts) => return None,
                Shape::Loft { profs, .. } if !profs.iter().all(|p| polygon_valid(p)) => {
                    return None
                }
                Shape::Lathe { edges }
                    if edges.iter().any(|e| e.len <= 0.)
                        || edges
                            .iter()
                            .all(|e| e.kind == crate::primitives::shapes::LatheEdgeKind::None) =>
                {
                    return None
                }
                _ => {}
            }
            match leaf.shape {
                Shape::Sphere { .. } | Shape::Cuboid { .. } | Shape::Cylinder { .. } => {
                    primitive(leaf, c, half)
                }
                _ => Some((f64::NEG_INFINITY, f64::INFINITY)),
            }
        }
        CsgNode::Min(children) | CsgNode::Max(children) => {
            let min = matches!(node, CsgNode::Min(_));
            let initial = if min {
                f64::INFINITY
            } else {
                f64::NEG_INFINITY
            };
            if children.is_empty() {
                return None;
            }
            let (mut lo, mut hi) = (initial, initial);
            for child in children {
                let (a, b) = partial(child, c, half)?;
                lo = if min { lo.min(a) } else { lo.max(a) };
                hi = if min { hi.min(b) } else { hi.max(b) };
            }
            Some((lo, hi))
        }
        CsgNode::Blend {
            kind,
            mode,
            r,
            n,
            children,
        } => {
            if children.len() < 2 || !r.is_finite() || *r <= 0. || !n.is_finite() {
                return None;
            }
            if matches!(
                mode,
                SminMode::Stairs | SminMode::Columns | SminMode::ColumnsI
            ) && *n < 1.
            {
                return None;
            }
            let mut low = [f64::INFINITY; 2];
            let mut high = low;
            for child in children {
                let (mut a, mut b) = partial(child, c, half)?;
                if *kind == BlendKind::Smax {
                    (a, b) = (-b, -a);
                }
                for (pair, value) in [(&mut low, a), (&mut high, b)] {
                    if value < pair[0] {
                        pair[1] = pair[0];
                        pair[0] = value;
                    } else if value < pair[1] {
                        pair[1] = value;
                    }
                }
            }
            if !matches!(mode, SminMode::Round | SminMode::Chamfer) {
                return Some((f64::NEG_INFINITY, f64::INFINITY));
            }
            // Order statistics and these two smin operators are coordinatewise
            // monotone. Evaluate lower/upper pairs independently, not all pairs.
            let lo = blend_endpoint(*mode, *r, low, false)?;
            let hi = blend_endpoint(*mode, *r, high, true)?;
            Some(if *kind == BlendKind::Smax {
                (-hi, -lo)
            } else {
                (lo, hi)
            })
        }
    }
}

fn blend_endpoint(mode: SminMode, r: f64, [a, b]: [f64; 2], upper: bool) -> Option<f64> {
    // Sorted endpoints: an unknown lower dominates; an unknown upper leaves the
    // finite minimum unchanged. Avoid indeterminate infinity arithmetic.
    if a == f64::NEG_INFINITY {
        return Some(a);
    }
    if b == f64::INFINITY {
        return Some(a);
    }
    let result = match mode {
        SminMode::Chamfer => {
            let bevel = Interval::point(a)
                .sub(Interval::point(r))?
                .add(Interval::point(b))?
                .mul(std::f64::consts::FRAC_1_SQRT_2)?;
            Interval {
                lo: a.min(bevel.lo),
                hi: a.min(bevel.hi),
            }
        }
        SminMode::Round => {
            let u = Interval::point(r).sub(Interval::point(a))?;
            let v = Interval::point(r).sub(Interval::point(b))?;
            Interval::point(r.max(a)).sub(Interval {
                lo: norm([u.lo.max(0.), v.lo.max(0.), 0.], false)?,
                hi: norm([u.hi.max(0.), v.hi.max(0.), 0.], true)?,
            })?
        }
        _ => return None,
    };
    Some(if upper { result.hi } else { result.lo })
}

/// A real center/half box containing both represented endpoints, including the
/// rounded midpoint and subtraction. No endpoint comparison is used as a proof.
pub(crate) fn enclosing_box(lo: [f64; 3], hi: [f64; 3]) -> Option<([f64; 3], [f64; 3])> {
    let mut c = [0.; 3];
    let mut half = [0.; 3];
    for a in 0..3 {
        if !lo[a].is_finite() || !hi[a].is_finite() || lo[a] > hi[a] {
            return None;
        }
        if lo[a] == hi[a] {
            c[a] = lo[a];
            continue;
        }
        c[a] = lo[a] * 0.5 + hi[a] * 0.5;
        half[a] = Interval::point(c[a])
            .sub(Interval::point(lo[a]))?
            .hi
            .max(Interval::point(hi[a]).sub(Interval::point(c[a]))?.hi);
    }
    Some((c, half))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::similarity::Similarity;
    use crate::sdf::{leaf, leaf_at};

    fn blend(children: Vec<CsgNode>, mode: SminMode) -> CsgNode {
        CsgNode::Blend {
            kind: BlendKind::Smin,
            mode,
            r: 0.3,
            n: 3.,
            children,
        }
    }
    fn unknown() -> CsgNode {
        leaf_at(
            Shape::Extrude {
                verts: vec![-1., -1., 1., -1., 1., 1., -1., 1.],
                wind: -1.,
                h: 2.,
                twist_rad: 2.,
            },
            [0.; 3],
        )
    }
    #[test]
    fn unknown_descendants_allow_only_supported_one_sided_claims() {
        for mode in [SminMode::Round, SminMode::Chamfer] {
            let tree = blend(
                vec![
                    leaf_at(Shape::Cylinder { r: 2., h: 3. }, [0.; 3]),
                    unknown(),
                ],
                mode,
            );
            let (lo, hi) = partial(&tree, [0.; 3], [0.1; 3]).unwrap();
            assert_eq!(lo, f64::NEG_INFINITY);
            assert!(hi < -1.8);
            let outside = partial(&tree, [10.; 3], [0.1; 3]).unwrap();
            assert!(outside.0 <= 0. && outside.1 > 0.);
        }
    }
    #[test]
    fn malformed_opaque_child_is_not_hidden_by_a_solid_sibling() {
        let mut bad = unknown();
        if let CsgNode::Leaf(l) = &mut bad {
            l.shape = Shape::Extrude {
                verts: vec![0.; 6],
                wind: 1.,
                h: 2.,
                twist_rad: 1.,
            };
        }
        let solid = leaf_at(Shape::Sphere { r: 10. }, [0.; 3]);
        assert!(partial(
            &blend(vec![solid.clone(), bad], SminMode::Chamfer),
            [0.; 3],
            [0.1; 3]
        )
        .is_none());
        let mut bad_blend = blend(vec![unknown(), unknown()], SminMode::Stairs);
        if let CsgNode::Blend { n, .. } = &mut bad_blend {
            *n = 0.;
        }
        assert!(partial(&CsgNode::Min(vec![solid, bad_blend]), [0.; 3], [0.1; 3]).is_none());
    }
    #[test]
    fn thin_hidden_sheet_and_grazing_cylinder_cannot_be_excluded() {
        let mut inner = leaf_at(
            Shape::Cylinder {
                r: 1. - 1e-8,
                h: 2.,
            },
            [0.; 3],
        );
        if let CsgNode::Leaf(l) = &mut inner {
            l.sign = -1.;
        }
        let shell = CsgNode::Max(vec![
            leaf_at(Shape::Cylinder { r: 1., h: 2. }, [0.; 3]),
            inner,
        ]);
        // All box corners are outside, but its interior intersects both sheets.
        let q = partial(&shell, [1., 0., 0.], [0.01; 3]).unwrap();
        assert!(q.0 <= 0. && q.1 >= 0.);
        let cylinder = leaf_at(Shape::Cylinder { r: 1., h: 2. }, [0.; 3]);
        let q = partial(&cylinder, [1.125, 0., 0.], [0.125; 3]).unwrap();
        assert!(q.0 <= 0. && q.1 >= 0.);
        let tiny = leaf_at(Shape::Sphere { r: 0.01 }, [0.013, 0.017, 0.019]);
        let q = partial(&tiny, [0.; 3], [0.1; 3]).unwrap();
        assert!(q.0 < 0. && q.1 > 0.);
    }
    #[test]
    fn opaque_smax_dual_and_arithmetic_failure_are_distinct() {
        let known = leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        let tree = CsgNode::Blend {
            kind: BlendKind::Smax,
            mode: SminMode::Round,
            r: 0.2,
            n: 1.,
            children: vec![known, unknown()],
        };
        let (lo, hi) = partial(&tree, [3., 0., 0.], [0.1; 3]).unwrap();
        assert!(lo > 0.);
        assert_eq!(hi, f64::INFINITY);
        let huge = leaf(
            Shape::Cylinder { r: 1., h: 1. },
            Similarity {
                r: [f64::MAX; 9],
                ..Similarity::identity()
            },
            [0.; 3],
        );
        assert!(partial(&huge, [2.; 3], [1.; 3]).is_none());
        let tiny = leaf(
            Shape::Cylinder { r: 1., h: 1. },
            Similarity {
                s: f64::from_bits(1),
                ..Similarity::identity()
            },
            [0.; 3],
        );
        let iv = partial(&tiny, [0.; 3], [f64::from_bits(1); 3]).unwrap();
        assert!(
            iv.0 <= 0. && iv.1 >= 0.,
            "subnormal rounding must retain uncertainty"
        );
        assert!(partial(&tree, [f64::NAN, 0., 0.], [1.; 3]).is_none());
    }
    #[test]
    fn cylinder_uses_represented_affine_coefficients_and_clamped_dimensions() {
        let sim = Similarity {
            r: [1.2, 0.15, 0., 0., 0.8, -0.1, 0.2, 0., 1.1],
            s: 2.3,
            t: [4., -3., 2.],
        };
        for (r, h) in [(1.3, 2.7), (1e-9, 2e-9)] {
            let tree = leaf(Shape::Cylinder { r, h }, sim, [0.2, -0.1, 0.3]);
            let c = [4.7, -2.1, 2.8];
            let half = [0.4, 0.2, 0.3];
            let range = partial(&tree, c, half).unwrap();
            // Internal formula consistency, not an independent scene reference.
            for i in 0..27 {
                let p = std::array::from_fn(|a| {
                    c[a] + half[a] * ((i / 3usize.pow(a as u32) % 3) as f64 - 1.)
                });
                let v = tree.f(p);
                assert!(v >= range.0 && v <= range.1);
            }
        }
    }
    #[test]
    fn nearest_pair_switches_and_smax_duality_preserve_ranges() {
        for mode in [SminMode::Round, SminMode::Chamfer] {
            let children = vec![
                leaf_at(Shape::Sphere { r: 0.7 }, [-0.6, 0., 0.]),
                leaf_at(Shape::Cylinder { r: 0.5, h: 2. }, [0.6, 0., 0.]),
                leaf_at(Shape::Cuboid { half: [0.5; 3] }, [0., 0.5, 0.]),
            ];
            for kind in [BlendKind::Smin, BlendKind::Smax] {
                let tree = CsgNode::Blend {
                    kind,
                    mode,
                    r: 0.3,
                    n: 3.,
                    children: children.clone(),
                };
                let range = partial(&tree, [0.; 3], [1.; 3]).unwrap();
                for i in 0..125 {
                    let p =
                        std::array::from_fn(|a| (i / 5usize.pow(a as u32) % 5) as f64 * 0.5 - 1.);
                    let v = tree.f(p);
                    assert!(v >= range.0 && v <= range.1);
                }
            }
        }
    }
}
