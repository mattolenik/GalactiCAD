//! CPU-side f64 signed-distance evaluator: leaves (shape + baked similarity) and
//! the CSG tree (hard min/max + smooth blends). Port of the eval core of
//! `src/export/sfcc/cpu-sdf.mts` (`evalNode` / `gradNode` / `intervalNode`) over
//! the SFCC v1 subset.
//!
//! M2 scope: sphere / box / cylinder / cone leaves under a baked `Similarity`,
//! plus hard + smooth booleans (round/soft/chamfer/stairs/columns). Builder
//! constructors mirror the TS operator/negation semantics. DEFERRED to later
//! milestones: extrude/loft/lathe leaves, owner/strata queries, and ingestion of
//! the serialized scene (`SerializedNode[]`) — trees are built directly for now.

use crate::math::similarity::Similarity;
use crate::primitives::shapes;
use crate::primitives::smin::{smin, smin_columns_interval, smin_grad_weights, SminMode};
use std::f64::consts::{FRAC_1_SQRT_2, SQRT_2};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    Sphere { r: f64 },
    Cuboid { half: [f64; 3] },
    Cylinder { r: f64, h: f64 },
    Cone { r: f64, h: f64 },
}

impl Shape {
    fn dist(&self, x: f64, y: f64, z: f64) -> f64 {
        match *self {
            Shape::Sphere { r } => shapes::sphere_dist(x, y, z, r),
            Shape::Cuboid { half } => shapes::box_dist(x, y, z, half[0], half[1], half[2]),
            Shape::Cylinder { r, h } => shapes::cylinder_dist(x, y, z, r, h),
            Shape::Cone { r, h } => shapes::cone_dist(x, y, z, r, h),
        }
    }
    fn normal(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        match *self {
            Shape::Sphere { .. } => shapes::sphere_normal(x, y, z),
            Shape::Cuboid { half } => shapes::box_normal(x, y, z, half[0], half[1], half[2]),
            Shape::Cylinder { r, h } => shapes::cylinder_normal(x, y, z, r, h),
            Shape::Cone { r, h } => shapes::cone_normal(x, y, z, r, h),
        }
    }
}

/// A primitive leaf: `f = sign · s · shape((Rᵀ(p − t)/s) − pos)`.
#[derive(Clone, Copy, Debug)]
pub struct Leaf {
    /// −1 under an odd number of subtract right-hand ancestors.
    pub sign: f64,
    pub sim: Similarity,
    pub pos: [f64; 3],
    pub shape: Shape,
}

impl Leaf {
    pub fn f(&self, p: [f64; 3]) -> f64 {
        let l = self.sim.inv_apply_point(p[0], p[1], p[2]);
        self.sign * self.sim.s * self.shape.dist(l[0] - self.pos[0], l[1] - self.pos[1], l[2] - self.pos[2])
    }
    pub fn normal(&self, p: [f64; 3]) -> [f64; 3] {
        let l = self.sim.inv_apply_point(p[0], p[1], p[2]);
        let nl = self.shape.normal(l[0] - self.pos[0], l[1] - self.pos[1], l[2] - self.pos[2]);
        let nw = self.sim.rotate_vector(nl[0], nl[1], nl[2]);
        [self.sign * nw[0], self.sign * nw[1], self.sign * nw[2]]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlendKind {
    Smin,
    Smax,
}

#[derive(Clone, Debug)]
pub enum CsgNode {
    Leaf(Leaf),
    Min(Vec<CsgNode>),
    Max(Vec<CsgNode>),
    Blend {
        kind: BlendKind,
        mode: SminMode,
        r: f64,
        n: f64,
        children: Vec<CsgNode>,
    },
}

/// The nearest two transformed field values (smallest first), matching the
/// shader's nearest-pair fold. Binary blends keep operand order.
fn nearest_pair(children: &[CsgNode], p: [f64; 3], sgn: f64) -> (f64, f64) {
    if children.len() == 2 {
        (sgn * children[0].f(p), sgn * children[1].f(p))
    } else {
        let (mut va, mut vb) = (f64::INFINITY, f64::INFINITY);
        for c in children {
            let v = sgn * c.f(p);
            if v < va {
                vb = va;
                va = v;
            } else if v < vb {
                vb = v;
            }
        }
        (va, vb)
    }
}

/// Monotone-blend interval composition: smin over the nearest pair of endpoint
/// field values (round/soft/chamfer/stairs only).
fn blend_value_of(kind: BlendKind, mode: SminMode, r: f64, n: f64, ds: &[f64]) -> f64 {
    let sgn = if kind == BlendKind::Smax { -1.0 } else { 1.0 };
    let (va, vb) = if ds.len() == 2 {
        (sgn * ds[0], sgn * ds[1])
    } else {
        let (mut va, mut vb) = (f64::INFINITY, f64::INFINITY);
        for &d in ds {
            let v = sgn * d;
            if v < va {
                vb = va;
                va = v;
            } else if v < vb {
                vb = v;
            }
        }
        (va, vb)
    };
    sgn * smin(mode, va, vb, r, n)
}

impl CsgNode {
    /// Signed field of the full tree (negative inside, f = 0 ⟺ surface).
    pub fn f(&self, p: [f64; 3]) -> f64 {
        match self {
            CsgNode::Leaf(l) => l.f(p),
            CsgNode::Min(ch) => ch.iter().map(|c| c.f(p)).fold(f64::INFINITY, f64::min),
            CsgNode::Max(ch) => ch.iter().map(|c| c.f(p)).fold(f64::NEG_INFINITY, f64::max),
            CsgNode::Blend { kind, mode, r, n, children } => {
                let sgn = if *kind == BlendKind::Smax { -1.0 } else { 1.0 };
                let (va, vb) = nearest_pair(children, p, sgn);
                sgn * smin(*mode, va, vb, *r, *n)
            }
        }
    }

    /// One-sided unit gradient (winner routing for hard combiners; analytic
    /// smin-weighted mix inside blend bands). Returns (f, unit gradient).
    pub fn grad(&self, p: [f64; 3]) -> (f64, [f64; 3]) {
        match self {
            CsgNode::Leaf(l) => (l.f(p), l.normal(p)),
            CsgNode::Min(ch) => {
                let mut bi = 0;
                let mut best = f64::INFINITY;
                for (i, c) in ch.iter().enumerate() {
                    let d = c.f(p);
                    if d < best {
                        best = d;
                        bi = i;
                    }
                }
                ch[bi].grad(p)
            }
            CsgNode::Max(ch) => {
                let mut bi = 0;
                let mut best = f64::NEG_INFINITY;
                for (i, c) in ch.iter().enumerate() {
                    let d = c.f(p);
                    if d > best {
                        best = d;
                        bi = i;
                    }
                }
                ch[bi].grad(p)
            }
            CsgNode::Blend { kind, mode, r, n, children } => {
                let sgn = if *kind == BlendKind::Smax { -1.0 } else { 1.0 };
                let (ia, ib, va, vb) = if children.len() == 2 {
                    (0, 1, sgn * children[0].f(p), sgn * children[1].f(p))
                } else {
                    let (mut ia, mut ib) = (0usize, 0usize);
                    let (mut va, mut vb) = (f64::INFINITY, f64::INFINITY);
                    for (i, c) in children.iter().enumerate() {
                        let v = sgn * c.f(p);
                        if v < va {
                            ib = ia;
                            vb = va;
                            ia = i;
                            va = v;
                        } else if v < vb {
                            ib = i;
                            vb = v;
                        }
                    }
                    (ia, ib, va, vb)
                };
                let value = sgn * smin(*mode, va, vb, *r, *n);
                let [wa, wb] = smin_grad_weights(*mode, va, vb, *r, *n);
                if wb == 0.0 {
                    return (value, children[ia].grad(p).1);
                }
                if wa == 0.0 {
                    return (value, children[ib].grad(p).1);
                }
                let ga = children[ia].grad(p).1;
                let gb = children[ib].grad(p).1;
                let gx = wa * ga[0] + wb * gb[0];
                let gy = wa * ga[1] + wb * gb[1];
                let gz = wa * ga[2] + wb * gb[2];
                let len = (gx * gx + gy * gy + gz * gz).sqrt();
                if len > 1e-12 {
                    (value, [gx / len, gy / len, gz / len])
                } else {
                    (value, if wa >= wb { ga } else { gb })
                }
            }
        }
    }

    /// Certified enclosure of f over the ball (center, r). v1 shapes are exact
    /// SDFs (L = 1), so leaves use the centered form [f(c) − r, f(c) + r].
    pub fn interval_over_ball(&self, c: [f64; 3], r: f64) -> (f64, f64) {
        match self {
            CsgNode::Leaf(l) => {
                let fc = l.f(c);
                (fc - r, fc + r)
            }
            CsgNode::Min(ch) => {
                let (mut lo, mut hi) = (f64::INFINITY, f64::INFINITY);
                for x in ch {
                    let (clo, chi) = x.interval_over_ball(c, r);
                    lo = lo.min(clo);
                    hi = hi.min(chi);
                }
                (lo, hi)
            }
            CsgNode::Max(ch) => {
                let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
                for x in ch {
                    let (clo, chi) = x.interval_over_ball(c, r);
                    lo = lo.max(clo);
                    hi = hi.max(chi);
                }
                (lo, hi)
            }
            CsgNode::Blend { kind, mode, r: br, n, children } => {
                let mut los = Vec::with_capacity(children.len());
                let mut his = Vec::with_capacity(children.len());
                for x in children {
                    let (clo, chi) = x.interval_over_ball(c, r);
                    los.push(clo);
                    his.push(chi);
                }
                if *mode == SminMode::Columns || *mode == SminMode::ColumnsI {
                    let sgn = if *kind == BlendKind::Smax { -1.0 } else { 1.0 };
                    let t_los: Vec<f64> =
                        los.iter().enumerate().map(|(i, &lo)| if sgn == 1.0 { lo } else { -his[i] }).collect();
                    let t_his: Vec<f64> =
                        his.iter().enumerate().map(|(i, &hi)| if sgn == 1.0 { hi } else { -los[i] }).collect();
                    let (ulo, uhi) = if children.len() == 2 {
                        let iv = smin_columns_interval(*mode, t_los[0], t_his[0], t_los[1], t_his[1], *br, *n);
                        (iv[0], iv[1])
                    } else {
                        let t_lo = t_los.iter().cloned().fold(f64::INFINITY, f64::min);
                        let cr = (*br * SQRT_2) / ((*n - 1.0) * 2.0 + SQRT_2);
                        let ulo = t_lo.min(SQRT_2 * t_lo.min(0.0) - FRAC_1_SQRT_2 * *br).min(-cr);
                        let uhi = t_his.iter().cloned().fold(f64::INFINITY, f64::min);
                        (ulo, uhi)
                    };
                    if sgn == 1.0 {
                        (ulo, uhi)
                    } else {
                        (-uhi, -ulo)
                    }
                } else {
                    (
                        blend_value_of(*kind, *mode, *br, *n, &los),
                        blend_value_of(*kind, *mode, *br, *n, &his),
                    )
                }
            }
        }
    }

    /// Enclosure of f over an axis-aligned box via its circumscribed ball.
    pub fn interval_over_box(&self, c: [f64; 3], half: [f64; 3]) -> (f64, f64) {
        self.interval_over_ball(c, (half[0] * half[0] + half[1] * half[1] + half[2] * half[2]).sqrt())
    }
}

// --- Tree builder (mirrors the TS operator + negation semantics) -------------

/// A leaf under a baked similarity at a local position.
pub fn leaf(shape: Shape, sim: Similarity, pos: [f64; 3]) -> CsgNode {
    CsgNode::Leaf(Leaf { sign: 1.0, sim, pos, shape })
}

/// An untransformed leaf at a world position (identity similarity).
pub fn leaf_at(shape: Shape, pos: [f64; 3]) -> CsgNode {
    leaf(shape, Similarity::identity(), pos)
}

pub fn union(children: Vec<CsgNode>) -> CsgNode {
    CsgNode::Min(children)
}

pub fn intersect(children: Vec<CsgNode>) -> CsgNode {
    CsgNode::Max(children)
}

/// A − B = A ∩ ¬B.
pub fn subtract(a: CsgNode, b: CsgNode) -> CsgNode {
    CsgNode::Max(vec![a, negate(b)])
}

pub fn union_smooth(children: Vec<CsgNode>, mode: SminMode, r: f64, n: f64) -> CsgNode {
    CsgNode::Blend { kind: BlendKind::Smin, mode, r, n, children }
}

pub fn intersect_smooth(a: CsgNode, b: CsgNode, mode: SminMode, r: f64, n: f64) -> CsgNode {
    CsgNode::Blend { kind: BlendKind::Smax, mode: intersect_mode(mode), r, n, children: vec![a, b] }
}

pub fn subtract_smooth(a: CsgNode, b: CsgNode, mode: SminMode, r: f64, n: f64) -> CsgNode {
    CsgNode::Blend { kind: BlendKind::Smax, mode: intersect_mode(mode), r, n, children: vec![a, negate(b)] }
}

/// User-facing `columns` becomes the internal `columnsI` formula under the
/// intersect/subtract families (the negation identity columns violates).
fn intersect_mode(mode: SminMode) -> SminMode {
    if mode == SminMode::Columns {
        SminMode::ColumnsI
    } else {
        mode
    }
}

/// De Morgan negation (sign fold). Columns blends are rejected — build
/// intersect/subtract columns directly via the smooth combinators.
pub fn negate(node: CsgNode) -> CsgNode {
    match node {
        CsgNode::Leaf(mut l) => {
            l.sign = -l.sign;
            CsgNode::Leaf(l)
        }
        CsgNode::Min(ch) => CsgNode::Max(ch.into_iter().map(negate).collect()),
        CsgNode::Max(ch) => CsgNode::Min(ch.into_iter().map(negate).collect()),
        CsgNode::Blend { kind, mode, r, n, children } => {
            assert!(
                mode != SminMode::Columns && mode != SminMode::ColumnsI,
                "M2: negating a columns blend is unsupported; build intersect/subtract columns directly"
            );
            let flipped = if kind == BlendKind::Smin { BlendKind::Smax } else { BlendKind::Smin };
            CsgNode::Blend { kind: flipped, mode, r, n, children: children.into_iter().map(negate).collect() }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sphere(r: f64) -> Shape {
        Shape::Sphere { r }
    }

    #[test]
    fn untransformed_leaf_matches_shape() {
        let s = leaf_at(sphere(2.0), [3.0, 0.0, 0.0]);
        assert!((s.f([3.0, 0.0, 0.0]) - -2.0).abs() < 1e-12); // center
        assert!((s.f([0.0, 0.0, 0.0]) - 1.0).abs() < 1e-12); // |3|-2
    }

    #[test]
    fn leaf_honors_translate_and_scale() {
        // Translated sphere: center sits at the translation.
        let t = leaf(sphere(2.0), Similarity::from_translation(5.0, 0.0, 0.0), [0.0, 0.0, 0.0]);
        assert!((t.f([5.0, 0.0, 0.0]) - -2.0).abs() < 1e-12);
        // Uniform scale ×2 turns an r=1 sphere into an r=2 sphere about the origin.
        let sc = leaf(sphere(1.0), Similarity::from_uniform_scale(2.0), [0.0, 0.0, 0.0]);
        assert!(sc.f([2.0, 0.0, 0.0]).abs() < 1e-12);
    }

    #[test]
    fn hard_union_is_min() {
        let u = union(vec![leaf_at(sphere(2.0), [-3.0, 0.0, 0.0]), leaf_at(sphere(2.0), [3.0, 0.0, 0.0])]);
        // midpoint: both fields = |3|-2 = 1.
        assert!((u.f([0.0, 0.0, 0.0]) - 1.0).abs() < 1e-12);
        // inside the left sphere.
        assert!(u.f([-3.0, 0.0, 0.0]) < 0.0);
    }

    #[test]
    fn subtract_carves() {
        let solid = subtract(
            leaf_at(Shape::Cuboid { half: [2.0, 2.0, 2.0] }, [0.0, 0.0, 0.0]),
            leaf_at(sphere(1.0), [2.0, 0.0, 0.0]),
        );
        // Origin: inside box, outside the carving sphere → still solid (negative).
        assert!(solid.f([0.0, 0.0, 0.0]) < 0.0);
        // At (2,0,0): inside the box but inside the carve → removed (positive).
        assert!(solid.f([2.0, 0.0, 0.0]) > 0.0);
    }

    #[test]
    fn smooth_union_matches_smin() {
        let a = leaf_at(sphere(2.0), [-1.5, 0.0, 0.0]);
        let b = leaf_at(sphere(2.0), [1.5, 0.0, 0.0]);
        let blended = union_smooth(vec![a.clone(), b.clone()], SminMode::Round, 1.0, 2.0);
        let p = [0.4, 0.3, 0.2];
        let expect = smin(SminMode::Round, a.f(p), b.f(p), 1.0, 2.0);
        assert!((blended.f(p) - expect).abs() < 1e-12);
        // Smooth union sits below the hard min everywhere.
        assert!(blended.f(p) <= a.f(p).min(b.f(p)) + 1e-12);
    }

    #[test]
    fn grad_matches_finite_difference() {
        let tree = union_smooth(
            vec![leaf_at(sphere(2.0), [-1.5, 0.0, 0.0]), leaf_at(sphere(2.0), [1.5, 0.0, 0.0])],
            SminMode::Round,
            1.0,
            2.0,
        );
        let eps = 1e-6;
        for &p in &[[0.4, 0.3, 0.2], [1.2, -0.7, 0.5], [-2.0, 0.1, 0.0]] {
            let (_, g) = tree.grad(p);
            let dx = (tree.f([p[0] + eps, p[1], p[2]]) - tree.f([p[0] - eps, p[1], p[2]])) / (2.0 * eps);
            let dy = (tree.f([p[0], p[1] + eps, p[2]]) - tree.f([p[0], p[1] - eps, p[2]])) / (2.0 * eps);
            let dz = (tree.f([p[0], p[1], p[2] + eps]) - tree.f([p[0], p[1], p[2] - eps])) / (2.0 * eps);
            let fdlen = (dx * dx + dy * dy + dz * dz).sqrt();
            // Compare unit directions (grad is normalized).
            assert!((g[0] - dx / fdlen).abs() < 1e-3 && (g[1] - dy / fdlen).abs() < 1e-3 && (g[2] - dz / fdlen).abs() < 1e-3);
        }
    }

    #[test]
    fn interval_encloses_sampled_field() {
        let tree = union(vec![leaf_at(sphere(2.0), [-3.0, 0.0, 0.0]), leaf_at(sphere(2.0), [3.0, 0.0, 0.0])]);
        let c = [0.0, 0.0, 0.0];
        let half = [4.0, 2.0, 2.0];
        let (lo, hi) = tree.interval_over_box(c, half);
        for i in 0..=6 {
            for j in 0..=4 {
                for k in 0..=4 {
                    let p = [
                        c[0] - half[0] + 2.0 * half[0] * i as f64 / 6.0,
                        c[1] - half[1] + 2.0 * half[1] * j as f64 / 4.0,
                        c[2] - half[2] + 2.0 * half[2] * k as f64 / 4.0,
                    ];
                    let v = tree.f(p);
                    assert!(v >= lo - 1e-9 && v <= hi + 1e-9, "f={v} outside [{lo},{hi}]");
                }
            }
        }
    }

    #[test]
    fn smooth_columns_interval_encloses() {
        let tree = union_smooth(
            vec![leaf_at(sphere(2.0), [-1.0, 0.0, 0.0]), leaf_at(sphere(2.0), [1.0, 0.0, 0.0])],
            SminMode::Columns,
            1.0,
            2.0,
        );
        let c = [0.0, 0.0, 0.0];
        let half = [3.0, 2.0, 2.0];
        let (lo, hi) = tree.interval_over_box(c, half);
        for i in 0..=8 {
            for j in 0..=4 {
                let p = [c[0] - half[0] + 2.0 * half[0] * i as f64 / 8.0, c[1] - half[1] + 2.0 * half[1] * j as f64 / 4.0, 0.1];
                let v = tree.f(p);
                assert!(v >= lo - 1e-9 && v <= hi + 1e-9, "columns f={v} outside [{lo},{hi}]");
            }
        }
    }
}
