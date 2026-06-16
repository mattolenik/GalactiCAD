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
use crate::strata::Stratum;
use std::f64::consts::{FRAC_1_SQRT_2, SQRT_2};

#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    Sphere { r: f64 },
    Cuboid { half: [f64; 3] },
    Cylinder { r: f64, h: f64 },
    Cone { r: f64, h: f64 },
    /// Prism over a flat 2D polygon `[x0,z0,…]`, optional twist (radians).
    Extrude { verts: Vec<f64>, wind: f64, h: f64, twist_rad: f64 },
    /// Linearly-morphed prism over M same-vertex-count profiles.
    Loft { profs: Vec<Vec<f64>>, winds: Vec<f64>, h: f64 },
    /// Revolution of a (r,y) profile (precompiled edges) around local Y.
    Lathe { edges: Vec<shapes::LatheProfileEdge> },
}

impl Shape {
    fn dist(&self, x: f64, y: f64, z: f64) -> f64 {
        match self {
            Shape::Sphere { r } => shapes::sphere_dist(x, y, z, *r),
            Shape::Cuboid { half } => shapes::box_dist(x, y, z, half[0], half[1], half[2]),
            Shape::Cylinder { r, h } => shapes::cylinder_dist(x, y, z, *r, *h),
            Shape::Cone { r, h } => shapes::cone_dist(x, y, z, *r, *h),
            Shape::Extrude { verts, wind, h, twist_rad } => shapes::extrude_dist(verts, *wind, *h, *twist_rad, x, y, z),
            Shape::Loft { profs, winds, h } => shapes::loft_dist(profs, winds, *h, x, y, z),
            Shape::Lathe { edges } => shapes::lathe_dist(edges, x, y, z),
        }
    }
    fn normal(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        match self {
            Shape::Sphere { .. } => shapes::sphere_normal(x, y, z),
            Shape::Cuboid { half } => shapes::box_normal(x, y, z, half[0], half[1], half[2]),
            Shape::Cylinder { r, h } => shapes::cylinder_normal(x, y, z, *r, *h),
            Shape::Cone { r, h } => shapes::cone_normal(x, y, z, *r, *h),
            Shape::Extrude { verts, wind, h, twist_rad } => shapes::extrude_normal(verts, *wind, *h, *twist_rad, x, y, z),
            Shape::Loft { profs, winds, h } => shapes::loft_normal(profs, winds, *h, x, y, z),
            Shape::Lathe { edges } => shapes::lathe_normal(edges, x, y, z),
        }
    }
}

/// A primitive leaf: `f = sign · s · shape((Rᵀ(p − t)/s) − pos)`.
#[derive(Clone, Debug)]
pub struct Leaf {
    /// −1 under an odd number of subtract right-hand ancestors.
    pub sign: f64,
    pub sim: Similarity,
    pub pos: [f64; 3],
    pub shape: Shape,
    /// Index of this leaf in the tree's flattened leaf list (assigned by the
    /// CSG-aware owner query; 0 until then). Mirrors `CpuSdfLeaf.index`.
    pub index: usize,
    /// This leaf's smooth analytic patches (carriers). Empty until the scene
    /// bridge / strata compilation attaches them; the M3a parity scenes build
    /// them via [`leaf_with_strata`].
    pub strata: Vec<Stratum>,
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

    /// Local Lipschitz bound of `f` over the ball (center `c`, radius `r`): 1 for
    /// every exact-SDF leaf, but >1 for the twisted extrude and the morphing loft
    /// (non-unit gradient). Port of `CpuSdfLeaf.localLipschitz` — the interval
    /// composition must use this, never assume global 1-Lipschitz. Returns `None`
    /// when the leaf is a plain 1-Lipschitz SDF.
    pub fn local_lipschitz(&self, c: [f64; 3], r: f64) -> Option<f64> {
        match &self.shape {
            Shape::Extrude { twist_rad, h, .. } => {
                if *twist_rad == 0.0 {
                    return None;
                }
                let k = if h.abs() > 1e-9 { twist_rad / (2.0 * h) } else { 0.0 };
                let l = self.sim.inv_apply_point(c[0], c[1], c[2]);
                let rl = r / self.sim.s;
                let rho = (l[0] - self.pos[0]).hypot(l[2] - self.pos[2]) + rl;
                Some((1.0 + k * rho * (k * rho)).sqrt())
            }
            Shape::Loft { profs, winds, h } => {
                // Prismatic lofts (all profiles identical) are 1-Lipschitz.
                let prismatic = profs.iter().all(|p| p.iter().zip(profs[0].iter()).all(|(a, b)| a == b));
                if prismatic {
                    return None;
                }
                let m = profs.len();
                let seg_h = (2.0 * h) / (m as f64 - 1.0);
                let l = self.sim.inv_apply_point(c[0], c[1], c[2]);
                let rl = r / self.sim.s;
                let qx = l[0] - self.pos[0];
                let qz = l[2] - self.pos[2];
                let d_vals: Vec<f64> =
                    (0..m).map(|i| crate::primitives::polygon2d::polygon_dist_2d(&profs[i], winds[i], qx, qz).d).collect();
                let mut max_diff = 0.0f64;
                for i in 0..(m - 1) {
                    max_diff = max_diff.max((d_vals[i + 1] - d_vals[i]).abs());
                }
                let slope = (max_diff + 2.0 * rl) / seg_h;
                Some((1.0 + slope * slope).sqrt())
            }
            _ => None,
        }
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

/// Max positive principal curvature of the analytic carriers reachable under a
/// blend's children, in world units (the uniform similarity scale `s` divides a
/// local radius). Plane → 0; Sphere/Cylinder → 1/(r·s). Returns false the moment
/// a carrier has no constant analytic curvature here — Cone (radius shrinks to the
/// apex ⇒ unbounded), Extrude/Loft (ruled, non-unit gradient), Lathe (mixed
/// profile) — so the blend falls back to the sampled cone. Recurses through hard
/// combiners and nested blends, reading the FINAL solid's carriers (sign-agnostic:
/// curvature magnitude is what bounds normal variation).
fn max_carrier_curvature(children: &[CsgNode], out: &mut f64) -> bool {
    fn walk(node: &CsgNode, out: &mut f64) -> bool {
        match node {
            CsgNode::Leaf(l) => {
                let s = l.sim.s.max(1e-12);
                match &l.shape {
                    Shape::Cuboid { .. } => true, // 6 planes → κ = 0
                    Shape::Sphere { r } | Shape::Cylinder { r, .. } => {
                        if *r > 1e-12 {
                            let k = 1.0 / (*r * s);
                            if k > *out {
                                *out = k;
                            }
                        }
                        true
                    }
                    // Cone curvature → ∞ at the apex; ruled/profile shapes have no
                    // constant analytic curvature → ineligible for the analytic bound.
                    Shape::Cone { .. } | Shape::Extrude { .. } | Shape::Loft { .. } | Shape::Lathe { .. } => false,
                }
            }
            CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter().all(|c| walk(c, out)),
            CsgNode::Blend { mode, children, .. } => {
                // A nested blend is itself a carrier of the parent fillet only if it is
                // analytic-eligible; require Round + eligible carriers underneath.
                if *mode != SminMode::Round {
                    return false;
                }
                children.iter().all(|c| walk(c, out))
            }
        }
    }
    children.iter().all(|c| walk(c, out))
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

/// Interval enclosure of a blend node over its children's intervals (`los`/`his`).
/// Factored out so both [`CsgNode::interval_over_ball`] and the Lever-1
/// [`Pruned`] view share ONE implementation — the pruned interval cannot drift
/// from the full tree's.
fn blend_interval(kind: BlendKind, mode: SminMode, br: f64, n: f64, los: &[f64], his: &[f64]) -> (f64, f64) {
    if mode == SminMode::Columns || mode == SminMode::ColumnsI {
        let sgn = if kind == BlendKind::Smax { -1.0 } else { 1.0 };
        let t_los: Vec<f64> = los.iter().enumerate().map(|(i, &lo)| if sgn == 1.0 { lo } else { -his[i] }).collect();
        let t_his: Vec<f64> = his.iter().enumerate().map(|(i, &hi)| if sgn == 1.0 { hi } else { -los[i] }).collect();
        let (ulo, uhi) = if los.len() == 2 {
            let iv = smin_columns_interval(mode, t_los[0], t_his[0], t_los[1], t_his[1], br, n);
            (iv[0], iv[1])
        } else {
            let t_lo = t_los.iter().cloned().fold(f64::INFINITY, f64::min);
            let cr = (br * SQRT_2) / ((n - 1.0) * 2.0 + SQRT_2);
            let ulo = t_lo.min(SQRT_2 * t_lo.min(0.0) - FRAC_1_SQRT_2 * br).min(-cr);
            let uhi = t_his.iter().cloned().fold(f64::INFINITY, f64::min);
            (ulo, uhi)
        };
        if sgn == 1.0 {
            (ulo, uhi)
        } else {
            (-uhi, -ulo)
        }
    } else {
        (blend_value_of(kind, mode, br, n, los), blend_value_of(kind, mode, br, n, his))
    }
}

/// Stack-first scratch for per-child field values on the eval hot path. The CSG
/// combiner folds (`collect_owners`, interval enclosure) used to `collect` a fresh
/// `Vec<f64>` at EVERY Min/Max/Blend node — a heap allocation per combiner per
/// query, and WASM's allocator makes that bite. Almost every combiner is binary or
/// small-arity, so values go into a fixed inline array; only unusually wide
/// combiners spill to the heap. The values and their order are identical to the old
/// `Vec`, so every downstream fold/compare stays byte-identical.
const CHILD_VALS_INLINE: usize = 8;

enum ChildVals {
    Inline { buf: [f64; CHILD_VALS_INLINE], len: usize },
    Heap(Vec<f64>),
}

impl ChildVals {
    /// Evaluate `n` child values in order (`f(0), f(1), …`) into inline-or-heap
    /// storage — same eval order as the old `children.iter().map(..).collect()`.
    #[inline]
    fn eval(n: usize, mut f: impl FnMut(usize) -> f64) -> ChildVals {
        if n <= CHILD_VALS_INLINE {
            let mut buf = [0.0f64; CHILD_VALS_INLINE];
            for (slot, i) in buf.iter_mut().zip(0..n) {
                *slot = f(i);
            }
            ChildVals::Inline { buf, len: n }
        } else {
            ChildVals::Heap((0..n).map(f).collect())
        }
    }
    #[inline]
    fn as_slice(&self) -> &[f64] {
        match self {
            ChildVals::Inline { buf, len } => &buf[..*len],
            ChildVals::Heap(v) => v.as_slice(),
        }
    }
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
                // Non-unit-gradient leaves (twisted extrude / morphing loft) need
                // their local Lipschitz bound; everything else is an exact SDF.
                let lip = l.local_lipschitz(c, r).unwrap_or(1.0);
                (fc - lip * r, fc + lip * r)
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
                let m = children.len();
                if m <= CHILD_VALS_INLINE {
                    let mut los = [0.0f64; CHILD_VALS_INLINE];
                    let mut his = [0.0f64; CHILD_VALS_INLINE];
                    for (i, x) in children.iter().enumerate() {
                        let (clo, chi) = x.interval_over_ball(c, r);
                        los[i] = clo;
                        his[i] = chi;
                    }
                    blend_interval(*kind, *mode, *br, *n, &los[..m], &his[..m])
                } else {
                    let mut los = Vec::with_capacity(m);
                    let mut his = Vec::with_capacity(m);
                    for x in children {
                        let (clo, chi) = x.interval_over_ball(c, r);
                        los.push(clo);
                        his.push(chi);
                    }
                    blend_interval(*kind, *mode, *br, *n, &los, &his)
                }
            }
        }
    }

    /// Enclosure of f over an axis-aligned box via its circumscribed ball.
    pub fn interval_over_box(&self, c: [f64; 3], half: [f64; 3]) -> (f64, f64) {
        self.interval_over_ball(c, (half[0] * half[0] + half[1] * half[1] + half[2] * half[2]).sqrt())
    }

    /// CSG-aware winner set: the leaves whose surfaces can own the point — those
    /// within `tol` of the winning value at every min/max combiner on their
    /// path. Two owners ⇒ boolean seam, three+ ⇒ seam corner. Only meaningful
    /// near the surface. Port of `collectOwners` (cpu-sdf.mts).
    ///
    /// ON a blend surface no child matches (the fillet lies on no carrier) and
    /// the owner set is empty — by design, blend surfaces are featureless.
    pub fn active_owners_at(&self, p: [f64; 3], tol: f64) -> Vec<ActiveOwner<'_>> {
        let mut out = Vec::new();
        self.collect_owners(p, tol, &mut out);
        out
    }

    fn collect_owners<'a>(&'a self, p: [f64; 3], tol: f64, out: &mut Vec<ActiveOwner<'a>>) -> f64 {
        match self {
            CsgNode::Leaf(l) => {
                let d = l.f(p);
                out.push(ActiveOwner { leaf: l, d });
                d
            }
            CsgNode::Min(ch) => {
                let ds = ChildVals::eval(ch.len(), |i| ch[i].f(p));
                let ds = ds.as_slice();
                let best = ds.iter().cloned().fold(f64::INFINITY, f64::min);
                for (i, c) in ch.iter().enumerate() {
                    if (ds[i] - best).abs() <= tol {
                        c.collect_owners(p, tol, out);
                    }
                }
                best
            }
            CsgNode::Max(ch) => {
                let ds = ChildVals::eval(ch.len(), |i| ch[i].f(p));
                let ds = ds.as_slice();
                let best = ds.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                for (i, c) in ch.iter().enumerate() {
                    if (ds[i] - best).abs() <= tol {
                        c.collect_owners(p, tol, out);
                    }
                }
                best
            }
            CsgNode::Blend { kind, mode, r, n, children } => {
                let ds = ChildVals::eval(children.len(), |i| children[i].f(p));
                let ds = ds.as_slice();
                let value = blend_value_of(*kind, *mode, *r, *n, ds);
                for (i, c) in children.iter().enumerate() {
                    if (ds[i] - value).abs() <= tol {
                        c.collect_owners(p, tol, out);
                    }
                }
                value
            }
        }
    }

    /// Advisory bound on |∇f| relative to the leaves' own bounds: 1 for hard
    /// trees, √2 per round/chamfer/columns blend nesting level (soft is convex,
    /// stairs selects a single operand). Port of `gradBoundOf`.
    pub fn grad_bound(&self) -> f64 {
        match self {
            CsgNode::Leaf(_) => 1.0,
            CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter().map(|c| c.grad_bound()).fold(1.0, f64::max),
            CsgNode::Blend { mode, children, .. } => {
                let mut m = children.iter().map(|c| c.grad_bound()).fold(1.0, f64::max);
                if *mode != SminMode::Soft && *mode != SminMode::Stairs {
                    m *= SQRT_2;
                }
                m
            }
        }
    }

    /// Analytic blend-curvature bound (the lever-2 cert, opt-in/default-OFF). A
    /// round-`smin` fillet has a closed-form surface curvature: the cross-section arc
    /// is `1/r`, so for a Smin UNION (convex carriers, the fillet bulges outward and
    /// carriers only REDUCE it) `κ ≤ 1/r`, and for a Smax INTERSECT/SUBTRACT (concave
    /// groove) `κ ≤ 1/r + max(0, κ_a, κ_b)` (the concave carrier curvature adds).
    /// Empirically (`examples/blend_curv_probe`): plane∪plane = exactly `1/r`,
    /// sphere∪sphere = `0.80 < 1/r`, box−sphere = `1/r`, perpendicular cylinders
    /// `≈1/r`. So this is a SOUND upper bound on the true fillet curvature. The
    /// per-cell normal variation is then ≤ `κ · cellSize`, and the analytic cert splits
    /// iff `κ · cellSize > θ` — with NO per-cell ∇f cone (the strata-empty path needs
    /// no owner/grad query at all).
    ///
    /// HONEST RESULT (measured): because `κ` is a single worst-case CONSTANT over the
    /// whole blend band while the sampled ∇f cone reads the TRUE *local* curvature
    /// (≈0 on the flat approaches, reduced on convex carriers), the analytic cert
    /// TIES the sampled cone only on the dominant plane∪plane case and OVER-refines
    /// curved-carrier fillets (sphere∪sphere ≈ +70% leaves at matched θ). It is
    /// SOUND (never faceting-regresses — realized fillet variation stays ≤ θ) but NOT
    /// tighter, so it ships default-OFF and wired for A/B, mirroring the Lever-1
    /// disposition. See the SfccTuning flag `blend_curvature_analytic`.
    ///
    /// Returns `Some(κ_max)` (max over all blends) iff EVERY blend in the tree is
    /// analytic-eligible: `Round` mode and only plane/sphere/cylinder carriers (whose
    /// principal curvatures are constant and known). `None` ⇒ at least one blend is
    /// not analytically bounded here (non-round mode, or a cone/extrude/loft/lathe
    /// carrier whose curvature is position-dependent or ruled) — the caller falls back
    /// to the sampled ∇f cone for the whole tree. Hard/primitive-only trees (no blend)
    /// return `Some(0.0)` (the cert is inert there anyway).
    pub fn blend_curvature_bound(&self) -> Option<f64> {
        let mut k = 0.0f64;
        if self.collect_blend_curvature(&mut k) {
            Some(k)
        } else {
            None
        }
    }

    /// Accumulate the max round-blend curvature bound into `k`; returns false the
    /// moment any blend is analytic-ineligible.
    fn collect_blend_curvature(&self, k: &mut f64) -> bool {
        match self {
            CsgNode::Leaf(_) => true,
            CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter().all(|c| c.collect_blend_curvature(k)),
            CsgNode::Blend { kind, mode, r, children, .. } => {
                if *mode != SminMode::Round {
                    return false; // soft/chamfer/stairs/columns → sampled fallback
                }
                // Max positive carrier principal curvature over this blend's leaves.
                let mut carrier_k = 0.0f64;
                if !max_carrier_curvature(children, &mut carrier_k) {
                    return false; // a cone/ruled carrier sits under this round blend
                }
                if *r > 1e-12 {
                    // Round-smin fillet curvature: the cross-section arc is 1/r. For a
                    // Smin UNION the carriers are CONVEX from the solid's side and the
                    // fillet bulges OUTWARD — empirically κ ≤ 1/r (convex carriers only
                    // REDUCE it; `examples/blend_curv_probe`: sphere∪sphere measured
                    // 0.80 < 1.0 = 1/r). For a Smax INTERSECT/SUBTRACT the fillet is a
                    // concave groove and a concave carrier ADDS its curvature, so the
                    // sound bound there is 1/r + κ_carrier. Splitting the cases keeps
                    // the common union fillet tight (1/r) without losing soundness on
                    // grooves.
                    let node_k = if *kind == BlendKind::Smin { 1.0 / *r } else { 1.0 / *r + carrier_k };
                    if node_k > *k {
                        *k = node_k;
                    }
                }
                // Recurse into children too (nested blends).
                children.iter().all(|c| c.collect_blend_curvature(k))
            }
        }
    }

    /// True when the CSG contains any smooth-boolean blend node (any mode).
    /// Port of `hasBlendNode`.
    pub fn has_blend(&self) -> bool {
        match self {
            CsgNode::Leaf(_) => false,
            CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter().any(|c| c.has_blend()),
            CsgNode::Blend { .. } => true,
        }
    }

    /// Assign dense leaf indices in a left-to-right traversal (mirrors the order
    /// `compileCpuSdf`'s `walk` pushes leaves). Strata must already carry their
    /// `leaf_index`; this only sets each `Leaf::index`.
    pub fn assign_leaf_indices(&mut self) {
        let mut next = 0usize;
        self.assign_leaf_indices_from(&mut next);
    }

    fn assign_leaf_indices_from(&mut self, next: &mut usize) {
        match self {
            CsgNode::Leaf(l) => {
                l.index = *next;
                *next += 1;
            }
            CsgNode::Min(ch) | CsgNode::Max(ch) => {
                for c in ch.iter_mut() {
                    c.assign_leaf_indices_from(next);
                }
            }
            CsgNode::Blend { children, .. } => {
                for c in children.iter_mut() {
                    c.assign_leaf_indices_from(next);
                }
            }
        }
    }

    /// Number of leaves in the (sub)tree. Used to gate Lever-1 pruning (small
    /// trees skip it — the prune build can't be amortized).
    pub fn leaf_count(&self) -> usize {
        match self {
            CsgNode::Leaf(_) => 1,
            CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter().map(|c| c.leaf_count()).sum(),
            CsgNode::Blend { children, .. } => children.iter().map(|c| c.leaf_count()).sum(),
        }
    }

    /// Lever 1: a region-pruned [`Pruned`] view valid over the ball circumscribing
    /// the box (center `c`, half-extents `half`) — structurally reduced to the
    /// leaves/subtrees that can affect `f`/interval there, with EXACT `f` (for any
    /// point in the ball) and EXACT interval (for that ball) vs the full tree.
    /// Pure work-elimination, no precision change. Build once per region, reuse
    /// across that region's many evals (root-finding, certificates).
    pub fn prune_to_box(&self, c: [f64; 3], half: [f64; 3]) -> Pruned<'_> {
        Pruned::wrap(self).prune_to_box(c, half)
    }
}

/// Lever-1 conditional gate for per-region CSG pruning. DEFAULT: OFF.
///
/// The intent of the lever was that pruning a region down to the 2–3 carriers it
/// touches would amortize across that region's many evals (root-finds, certificate
/// grads, owner queries). The full A/B integration sweep (`examples/lever1_bench`,
/// octree / contour / cell-mesh each isolatable) found the OPPOSITE on EVERY blend
/// scene measured — shallow N-ary blobs AND deep nested chains — pruning is
/// net-NEGATIVE (e.g. a 32-sphere nested chain: 1146 ms full → 3406 ms pruned, 3×
/// slower; a 48-sphere blob: 1377 → 1714, +24%). Two structural reasons:
///  1. `prune_to_box` calls the (recursive, O(subtree)) `interval_over_ball` at
///     every node, rebuilt FRESH per region — O(tree²) for unbalanced chains — and
///     allocates a new `Pruned` tree each time.
///  2. The build is paid for EVERY cell/face, but most have few or zero crossings,
///     so the eval savings never amortize the per-region build + the indirection of
///     `Pruned::f` (pointer-chased leaves) vs the cache-friendly `Vec<CsgNode>`
///     tight loop of the full `f`.
///
/// The simple/twist scenes are correctly UNAFFECTED (their numbers match full-tree
/// within noise) — the gate just never won, so it ships off.
///
/// The integration stays wired (the eval surface is trait-abstracted, the pruned
/// view is bit-exact and proven by `lever1_prune_parity`) so a future CHEAPER prune
/// — bottom-up O(tree) interval, arena-allocated or in-place node reuse, or a lazy
/// build gated on an actual crossing — can flip this gate on without re-plumbing.
/// `SFCC_LEVER1=1` (native only) force-enables it for those experiments;
/// `SFCC_LEVER1=0` force-disables. `min_leaves` is retained for that future gate.
pub fn lever1_should_prune(_tree: &CsgNode, _min_leaves: usize) -> bool {
    // Measurement / experiment escape hatch (native only). Absent ⇒ default OFF.
    #[cfg(not(target_arch = "wasm32"))]
    if let Ok(v) = std::env::var("SFCC_LEVER1") {
        return v != "0";
    }
    false
}

/// A borrowed, region-pruned view of a [`CsgNode`] (Lever 1). Reports `f` and
/// interval BIT-EXACT to the full tree for points within the prune ball, so any
/// computation it feeds is unchanged. Cull rules (each interval-/f-exact because
/// `interval_over_ball` is a certified enclosure — `f_k(p) ≤ hi_k`, `f_j(p) ≥ lo_j`
/// for all `p` in the ball):
///  - Min: drop child j when some sibling k has `hi_k < lo_j` (strictly smaller
///    over the whole ball → j is never the min; the argmin-lo/argmin-hi survive).
///  - Max: symmetric (`lo_k > hi_j`).
///  - Blend: drop j only when ≥2 siblings strictly dominate it (`hi_k < lo_j`) —
///    a child outside the smallest two can never enter the nearest-pair fold.
///    Binary blends (the common case) are therefore never pruned.
pub enum Pruned<'a> {
    Leaf(&'a Leaf),
    Min(Vec<Pruned<'a>>),
    Max(Vec<Pruned<'a>>),
    Blend { kind: BlendKind, mode: SminMode, r: f64, n: f64, children: Vec<Pruned<'a>> },
}

impl<'a> Pruned<'a> {
    /// Wrap a full tree with no culling.
    fn wrap(node: &'a CsgNode) -> Pruned<'a> {
        match node {
            CsgNode::Leaf(l) => Pruned::Leaf(l),
            CsgNode::Min(ch) => Pruned::Min(ch.iter().map(Pruned::wrap).collect()),
            CsgNode::Max(ch) => Pruned::Max(ch.iter().map(Pruned::wrap).collect()),
            CsgNode::Blend { kind, mode, r, n, children } => Pruned::Blend {
                kind: *kind,
                mode: *mode,
                r: *r,
                n: *n,
                children: children.iter().map(Pruned::wrap).collect(),
            },
        }
    }

    pub fn leaf_count(&self) -> usize {
        match self {
            Pruned::Leaf(_) => 1,
            Pruned::Min(ch) | Pruned::Max(ch) => ch.iter().map(|c| c.leaf_count()).sum(),
            Pruned::Blend { children, .. } => children.iter().map(|c| c.leaf_count()).sum(),
        }
    }

    /// Signed field — same fold as [`CsgNode::f`], over the pruned children.
    pub fn f(&self, p: [f64; 3]) -> f64 {
        match self {
            Pruned::Leaf(l) => l.f(p),
            Pruned::Min(ch) => ch.iter().map(|c| c.f(p)).fold(f64::INFINITY, f64::min),
            Pruned::Max(ch) => ch.iter().map(|c| c.f(p)).fold(f64::NEG_INFINITY, f64::max),
            Pruned::Blend { kind, mode, r, n, children } => {
                let sgn = if *kind == BlendKind::Smax { -1.0 } else { 1.0 };
                let (mut va, mut vb) = (f64::INFINITY, f64::INFINITY);
                if children.len() == 2 {
                    va = sgn * children[0].f(p);
                    vb = sgn * children[1].f(p);
                } else {
                    for c in children {
                        let v = sgn * c.f(p);
                        if v < va {
                            vb = va;
                            va = v;
                        } else if v < vb {
                            vb = v;
                        }
                    }
                }
                sgn * smin(*mode, va, vb, *r, *n)
            }
        }
    }

    /// Interval enclosure over the ball — same formula as
    /// [`CsgNode::interval_over_ball`], over the pruned children.
    pub fn interval_over_ball(&self, c: [f64; 3], r: f64) -> (f64, f64) {
        match self {
            Pruned::Leaf(l) => {
                let fc = l.f(c);
                let lip = l.local_lipschitz(c, r).unwrap_or(1.0);
                (fc - lip * r, fc + lip * r)
            }
            Pruned::Min(ch) => {
                let (mut lo, mut hi) = (f64::INFINITY, f64::INFINITY);
                for x in ch {
                    let (clo, chi) = x.interval_over_ball(c, r);
                    lo = lo.min(clo);
                    hi = hi.min(chi);
                }
                (lo, hi)
            }
            Pruned::Max(ch) => {
                let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
                for x in ch {
                    let (clo, chi) = x.interval_over_ball(c, r);
                    lo = lo.max(clo);
                    hi = hi.max(chi);
                }
                (lo, hi)
            }
            Pruned::Blend { kind, mode, r: br, n, children } => {
                let m = children.len();
                if m <= CHILD_VALS_INLINE {
                    let mut los = [0.0f64; CHILD_VALS_INLINE];
                    let mut his = [0.0f64; CHILD_VALS_INLINE];
                    for (i, x) in children.iter().enumerate() {
                        let (clo, chi) = x.interval_over_ball(c, r);
                        los[i] = clo;
                        his[i] = chi;
                    }
                    blend_interval(*kind, *mode, *br, *n, &los[..m], &his[..m])
                } else {
                    let mut los = Vec::with_capacity(m);
                    let mut his = Vec::with_capacity(m);
                    for x in children {
                        let (clo, chi) = x.interval_over_ball(c, r);
                        los.push(clo);
                        his.push(chi);
                    }
                    blend_interval(*kind, *mode, *br, *n, &los, &his)
                }
            }
        }
    }

    pub fn interval_over_box(&self, c: [f64; 3], half: [f64; 3]) -> (f64, f64) {
        self.interval_over_ball(c, (half[0] * half[0] + half[1] * half[1] + half[2] * half[2]).sqrt())
    }

    /// One-sided unit gradient — same winner routing / smin-weighted mix as
    /// [`CsgNode::grad`], over the pruned children. BIT-EXACT to the full tree for
    /// points inside the prune ball: a dropped child can never be the argmin/argmax
    /// (Min/Max) nor enter the nearest-pair (Blend) at any point in the ball, so the
    /// winner(s) routing `grad` selects are always among the kept children.
    pub fn grad(&self, p: [f64; 3]) -> (f64, [f64; 3]) {
        match self {
            Pruned::Leaf(l) => (l.f(p), l.normal(p)),
            Pruned::Min(ch) => {
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
            Pruned::Max(ch) => {
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
            Pruned::Blend { kind, mode, r, n, children } => {
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

    /// CSG-aware winner set — same fold as [`CsgNode::active_owners_at`], over the
    /// pruned children. BIT-EXACT for points inside the prune ball: a dropped child
    /// is strictly non-winning everywhere in the ball, so for the certificate
    /// callers (`tol == 0`, exact winner only) it could never have been collected.
    pub fn active_owners_at(&self, p: [f64; 3], tol: f64) -> Vec<ActiveOwner<'a>> {
        let mut out = Vec::new();
        self.collect_owners(p, tol, &mut out);
        out
    }

    fn collect_owners(&self, p: [f64; 3], tol: f64, out: &mut Vec<ActiveOwner<'a>>) -> f64 {
        match self {
            Pruned::Leaf(l) => {
                let d = l.f(p);
                out.push(ActiveOwner { leaf: l, d });
                d
            }
            Pruned::Min(ch) => {
                let ds = ChildVals::eval(ch.len(), |i| ch[i].f(p));
                let ds = ds.as_slice();
                let best = ds.iter().cloned().fold(f64::INFINITY, f64::min);
                for (i, c) in ch.iter().enumerate() {
                    if (ds[i] - best).abs() <= tol {
                        c.collect_owners(p, tol, out);
                    }
                }
                best
            }
            Pruned::Max(ch) => {
                let ds = ChildVals::eval(ch.len(), |i| ch[i].f(p));
                let ds = ds.as_slice();
                let best = ds.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                for (i, c) in ch.iter().enumerate() {
                    if (ds[i] - best).abs() <= tol {
                        c.collect_owners(p, tol, out);
                    }
                }
                best
            }
            Pruned::Blend { kind, mode, r, n, children } => {
                let ds = ChildVals::eval(children.len(), |i| children[i].f(p));
                let ds = ds.as_slice();
                let value = blend_value_of(*kind, *mode, *r, *n, ds);
                for (i, c) in children.iter().enumerate() {
                    if (ds[i] - value).abs() <= tol {
                        c.collect_owners(p, tol, out);
                    }
                }
                value
            }
        }
    }

    /// Refine to a (sub-)box, dropping children that cannot affect `f`/interval
    /// over the box's circumscribing ball.
    pub fn prune_to_box(&self, c: [f64; 3], half: [f64; 3]) -> Pruned<'a> {
        self.prune_to_ball(c, (half[0] * half[0] + half[1] * half[1] + half[2] * half[2]).sqrt())
    }

    fn prune_to_ball(&self, c: [f64; 3], r: f64) -> Pruned<'a> {
        match self {
            Pruned::Leaf(l) => Pruned::Leaf(l),
            Pruned::Min(ch) => {
                let iv: Vec<(f64, f64)> = ch.iter().map(|x| x.interval_over_ball(c, r)).collect();
                let kept: Vec<Pruned<'a>> = ch
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| !iv.iter().enumerate().any(|(k, &(_, hk))| k != *j && hk < iv[*j].0))
                    .map(|(_, x)| x.prune_to_ball(c, r))
                    .collect();
                // The argmin can never be dropped (strict rule), so `kept` is
                // non-empty; the fallback is pure defense against FP ties.
                Pruned::Min(if kept.is_empty() { ch.iter().map(|x| x.prune_to_ball(c, r)).collect() } else { kept })
            }
            Pruned::Max(ch) => {
                let iv: Vec<(f64, f64)> = ch.iter().map(|x| x.interval_over_ball(c, r)).collect();
                let kept: Vec<Pruned<'a>> = ch
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| !iv.iter().enumerate().any(|(k, &(lk, _))| k != *j && lk > iv[*j].1))
                    .map(|(_, x)| x.prune_to_ball(c, r))
                    .collect();
                Pruned::Max(if kept.is_empty() { ch.iter().map(|x| x.prune_to_ball(c, r)).collect() } else { kept })
            }
            Pruned::Blend { kind, mode, r: br, n, children } => {
                let iv: Vec<(f64, f64)> = children.iter().map(|x| x.interval_over_ball(c, r)).collect();
                let kept: Vec<Pruned<'a>> = children
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| {
                        // A child outside the smallest two can never enter the
                        // nearest-pair fold (≥2 siblings strictly dominate it).
                        iv.iter().enumerate().filter(|(k, &(_, hk))| *k != *j && hk < iv[*j].0).count() < 2
                    })
                    .map(|(_, x)| x.prune_to_ball(c, r))
                    .collect();
                // `blend_interval`/`blend_value_of` pick DIFFERENT (and, for
                // columns/stairs, order-sensitive) formulas for exactly 2 children
                // vs >2. Pruning must not flip that branch, so floor the kept count
                // at min(orig, 3): the dropped children are non-extremal, so adding
                // any back is still exact, and the >2 path stays the >2 path.
                let min_keep = children.len().min(3);
                let children =
                    if kept.len() < min_keep { children.iter().map(|x| x.prune_to_ball(c, r)).collect() } else { kept };
                Pruned::Blend { kind: *kind, mode: *mode, r: *br, n: *n, children }
            }
        }
    }
}

/// The shared eval surface of the SFCC hot path. Both the full [`CsgNode`] and the
/// Lever-1 region-pruned [`Pruned`] view implement it, so the contour root-finds,
/// the cell-mesh interior projection, and the per-cell refine certificates can run
/// against EITHER — the pruned view eliminating the dropped-leaf work while staying
/// bit-exact for every point inside the prune ball it was built over. The query
/// methods (`f`/`grad`/`interval`/`active_owners_at`) are the ones the hot path
/// actually calls; `grad_bound`/`has_blend` are tree-level advisories that callers
/// hoist once from the full tree (so they are NOT on this trait).
pub trait SdfQuery {
    fn f(&self, p: [f64; 3]) -> f64;
    fn grad(&self, p: [f64; 3]) -> (f64, [f64; 3]);
    fn interval_over_box(&self, c: [f64; 3], half: [f64; 3]) -> (f64, f64);
    fn active_owners_at(&self, p: [f64; 3], tol: f64) -> Vec<ActiveOwner<'_>>;
}

impl SdfQuery for CsgNode {
    fn f(&self, p: [f64; 3]) -> f64 {
        CsgNode::f(self, p)
    }
    fn grad(&self, p: [f64; 3]) -> (f64, [f64; 3]) {
        CsgNode::grad(self, p)
    }
    fn interval_over_box(&self, c: [f64; 3], half: [f64; 3]) -> (f64, f64) {
        CsgNode::interval_over_box(self, c, half)
    }
    fn active_owners_at(&self, p: [f64; 3], tol: f64) -> Vec<ActiveOwner<'_>> {
        CsgNode::active_owners_at(self, p, tol)
    }
}

impl SdfQuery for Pruned<'_> {
    fn f(&self, p: [f64; 3]) -> f64 {
        Pruned::f(self, p)
    }
    fn grad(&self, p: [f64; 3]) -> (f64, [f64; 3]) {
        Pruned::grad(self, p)
    }
    fn interval_over_box(&self, c: [f64; 3], half: [f64; 3]) -> (f64, f64) {
        Pruned::interval_over_box(self, c, half)
    }
    fn active_owners_at(&self, p: [f64; 3], tol: f64) -> Vec<ActiveOwner<'_>> {
        Pruned::active_owners_at(self, p, tol)
    }
}

/// A leaf within `tol` of the winning value at every combiner on its path.
/// Port of `ActiveOwner` (cpu-sdf.mts).
#[derive(Clone, Copy, Debug)]
pub struct ActiveOwner<'a> {
    pub leaf: &'a Leaf,
    /// The leaf's signed distance at the query point.
    pub d: f64,
}

// --- Tree builder (mirrors the TS operator + negation semantics) -------------

/// A leaf under a baked similarity at a local position (no strata attached).
pub fn leaf(shape: Shape, sim: Similarity, pos: [f64; 3]) -> CsgNode {
    CsgNode::Leaf(Leaf { sign: 1.0, sim, pos, shape, index: 0, strata: Vec::new() })
}

/// An untransformed leaf at a world position (identity similarity).
pub fn leaf_at(shape: Shape, pos: [f64; 3]) -> CsgNode {
    leaf(shape, Similarity::identity(), pos)
}

/// A leaf with its smooth analytic strata attached. Used by the M3a octree
/// parity scenes (the full scene-bridge strata compilation is M4).
pub fn leaf_with_strata(shape: Shape, sim: Similarity, pos: [f64; 3], strata: Vec<Stratum>) -> CsgNode {
    CsgNode::Leaf(Leaf { sign: 1.0, sim, pos, shape, index: 0, strata })
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
            // Negation parity is baked into the strata sign too, so each
            // carrier keeps describing the FINAL solid (cpu-sdf.mts walks
            // negation into `makeLeaf`'s `sign` before building strata).
            for st in l.strata.iter_mut() {
                st.sign = -st.sign;
            }
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
    fn blend_curvature_bound_round_union_planes_is_inv_r() {
        // Two boxes, round Smin union r=2 → κ = 1/r = 0.5 (planes add nothing).
        let t = union_smooth(
            vec![
                leaf_at(Shape::Cuboid { half: [5.0, 5.0, 5.0] }, [-4.0, 0.0, 0.0]),
                leaf_at(Shape::Cuboid { half: [5.0, 5.0, 5.0] }, [0.0, -4.0, 0.0]),
            ],
            SminMode::Round,
            2.0,
            2.0,
        );
        assert_eq!(t.blend_curvature_bound(), Some(0.5));
    }

    #[test]
    fn blend_curvature_bound_round_union_spheres_drops_carrier() {
        // Smin union of spheres r=4 → convex union, carrier curvature is DROPPED →
        // κ = 1/r only (sound: convex union is ≤ 1/r).
        let t = union_smooth(
            vec![leaf_at(sphere(4.0), [-3.0, 0.0, 0.0]), leaf_at(sphere(4.0), [3.0, 0.0, 0.0])],
            SminMode::Round,
            1.0,
            2.0,
        );
        assert_eq!(t.blend_curvature_bound(), Some(1.0));
    }

    #[test]
    fn blend_curvature_bound_round_subtract_adds_carrier() {
        // Smax (subtract) round, carve sphere r=4 → concave groove, carrier ADDS:
        // κ = 1/r + 1/4 = 1.0 + 0.25.
        let t = subtract_smooth(
            leaf_at(Shape::Cuboid { half: [5.0, 5.0, 5.0] }, [0.0, 0.0, 0.0]),
            leaf_at(sphere(4.0), [5.0, 0.0, 0.0]),
            SminMode::Round,
            1.0,
            2.0,
        );
        assert_eq!(t.blend_curvature_bound(), Some(1.25));
    }

    #[test]
    fn blend_curvature_bound_uniform_scale_divides_radius() {
        // Sphere r=2 under ×2 uniform scale = world r=4 → carrier κ = 1/4 (but Smin
        // drops it). Use Smax to observe the scaled carrier curvature add: 1/r + 1/4.
        let s = leaf(sphere(2.0), Similarity::from_uniform_scale(2.0), [0.0, 0.0, 0.0]);
        let t = subtract_smooth(
            leaf_at(Shape::Cuboid { half: [5.0, 5.0, 5.0] }, [0.0, 0.0, 0.0]),
            s,
            SminMode::Round,
            1.0,
            2.0,
        );
        assert_eq!(t.blend_curvature_bound(), Some(1.25));
    }

    #[test]
    fn blend_curvature_bound_ineligible_modes_and_cone() {
        // Soft mode → not analytically bounded here → None.
        let soft = union_smooth(
            vec![leaf_at(sphere(2.0), [-1.0, 0.0, 0.0]), leaf_at(sphere(2.0), [1.0, 0.0, 0.0])],
            SminMode::Soft,
            1.0,
            2.0,
        );
        assert_eq!(soft.blend_curvature_bound(), None);
        // Round but with a cone carrier (position-dependent curvature) → None.
        let cone = union_smooth(
            vec![leaf_at(Shape::Cone { r: 2.0, h: 4.0 }, [0.0, 0.0, 0.0]), leaf_at(sphere(2.0), [3.0, 0.0, 0.0])],
            SminMode::Round,
            1.0,
            2.0,
        );
        assert_eq!(cone.blend_curvature_bound(), None);
        // No blend at all → Some(0.0) (cert inert).
        let hard = union(vec![leaf_at(sphere(2.0), [-1.0, 0.0, 0.0]), leaf_at(sphere(2.0), [1.0, 0.0, 0.0])]);
        assert_eq!(hard.blend_curvature_bound(), Some(0.0));
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

    #[test]
    fn complex_shape_leaves_dispatch() {
        let flat = vec![1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0];
        let w = crate::primitives::polygon2d::winding_sign(&[[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0]]);
        let ext = leaf_at(Shape::Extrude { verts: flat, wind: w, h: 2.0, twist_rad: 0.0 }, [0.0, 0.0, 0.0]);
        assert!(ext.f([0.0, 0.0, 0.0]) < 0.0);
        assert!(ext.f([3.0, 0.0, 0.0]) > 0.0);
        // Lathe leaf under a translate: cylinder centered at (5,0,0).
        let prof = [[0.0, -2.0], [1.0, -2.0], [1.0, 2.0], [0.0, 2.0]];
        let edges = shapes::lathe_profile_edges(&prof, crate::primitives::polygon2d::winding_sign(&prof));
        let lathe = leaf(Shape::Lathe { edges }, Similarity::from_translation(5.0, 0.0, 0.0), [0.0, 0.0, 0.0]);
        assert!(lathe.f([5.0, 0.0, 0.0]) < 0.0);
        assert!(lathe.f([8.0, 0.0, 0.0]) > 0.0);
    }
}
