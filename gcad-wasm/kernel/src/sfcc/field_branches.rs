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
    branch: Option<(Vec<usize>, super::branch_surfaces::FieldBranch, f64)>,
    partners: std::sync::Arc<[usize]>,
}
impl FieldRef {
    pub(crate) fn semantic_identity(&self, context: &mut super::provenance::IdentityContext) -> u64 {
        use super::provenance::IdentityHash;
        let source = *context.roots.entry(std::sync::Arc::as_ptr(&self.root) as usize).or_insert_with(|| {
            let mut hash = IdentityHash::default();
            hash.include(&self.root);
            hash.0
        });
        let mut hash = IdentityHash::default();
        hash.include(source);
        hash.include(&self.path);
        hash.include(&self.branch);
        hash.include(&self.partners);
        hash.0
    }
    pub fn new(root: std::sync::Arc<CsgNode>, path: Vec<usize>) -> Self {
        Self { root, path, branch: None, partners: std::sync::Arc::from([]) }
    }
    pub(crate) fn with_branch(
        mut self,
        path: Vec<usize>,
        branch: super::branch_surfaces::FieldBranch,
        native_band: f64,
        partners: std::sync::Arc<[usize]>,
    ) -> Self {
        self.partners = partners;
        self.branch = Some((path, branch, native_band));
        self
    }
    pub fn sample(&self, p: [f64; 3]) -> FieldSample {
        match &self.branch {
            Some((path, branch, _)) => {
                super::branch_surfaces::sample_override(self.node(), path, branch, &self.partners, p)
            }
            None => sample_tree(self.node(), p),
        }
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
        let mut query = PointQuery::new(p);
        if let Some((path, branch, native_band)) = &self.branch {
            let mut target = self.node();
            for &i in path {
                target = match target {
                    CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => &c[i],
                    _ => unreachable!(),
                };
            }
            if !super::branch_surfaces::override_valid(
                self.node(),
                path,
                branch,
                &self.partners,
                p,
                tolerance,
            ) {
                return false;
            }
            let actual = query.raw(target);
            // Zero-surface seams already have native/operator carriers. Lift
            // only displaced field boundaries, avoiding duplicate curve graphs.
            // Ownership uses a fixed numerical band: a looser position query
            // must not erase a feature previously accepted by a tighter query.
            if !path.is_empty() && actual.value.abs() <= *native_band {
                return false;
            }
            let selected = branch.sample(target, p);
            let magnitude = actual
                .gradient
                .iter()
                .chain(selected.gradient.iter())
                .map(|x| x * x)
                .sum::<f64>()
                .sqrt()
                .max(1.);
            if (actual.value - selected.value).abs() > tolerance * magnitude {
                return false;
            }
        }
        let mut node = self.root.as_ref();
        for step in 0..=self.path.len() {
            if !query.raw(node).normalized_equation().is_some_and(|s| s.value.abs() <= tolerance) {
                return false;
            }
            if step < self.path.len() {
                node = match node {
                    CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => {
                        &c[self.path[step]]
                    }
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
    pub(crate) fn constant(value: f64) -> Self {
        Self { value, gradient: [0.; 3] }
    }
    pub(crate) fn scale(self, s: f64) -> Self {
        Self { value: self.value * s, gradient: self.gradient.map(|v| v * s) }
    }
    pub(crate) fn add(self, b: Self) -> Self {
        Self {
            value: self.value + b.value,
            gradient: std::array::from_fn(|k| self.gradient[k] + b.gradient[k]),
        }
    }
    pub(crate) fn sub(self, b: Self) -> Self {
        self.add(b.scale(-1.))
    }
    pub(crate) fn min(self, b: Self) -> Self {
        if self.value <= b.value {
            self
        } else {
            b
        }
    }
    pub(crate) fn max(self, b: Self) -> Self {
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
trait Evaluation<'a> {
    fn scalar(&mut self, node: &'a CsgNode, p: [f64; 3]) -> f64;
    fn raw(&mut self, node: &'a CsgNode, p: [f64; 3]) -> FieldSample;
}
struct Uncached;
impl<'a> Evaluation<'a> for Uncached {
    fn scalar(&mut self, node: &'a CsgNode, p: [f64; 3]) -> f64 {
        node.f(p)
    }
    fn raw(&mut self, node: &'a CsgNode, p: [f64; 3]) -> FieldSample {
        sample_tree(node, p)
    }
}
/// Borrowed nodes cannot move or disappear during this query. Scalar and raw
/// values deliberately occupy different slots; their arithmetic is not identical.
struct QueryEntry {
    node: usize,
    scalar: Option<f64>,
    raw: Option<FieldSample>,
}
struct PointQuery<'a> {
    point: [f64; 3],
    entries: Vec<QueryEntry>,
    // Keep all queried nodes borrowed until this query ends, even though the
    // reusable storage contains identity keys rather than references.
    nodes: std::marker::PhantomData<&'a CsgNode>,
}
thread_local! {
    // Only capacity survives a query. Clearing entries before reuse prevents
    // any cached root identity, point value or gradient from being reused.
    static QUERY_WORKSPACE: std::cell::RefCell<Vec<QueryEntry>> = const { std::cell::RefCell::new(Vec::new()) };
}
impl Drop for PointQuery<'_> {
    fn drop(&mut self) {
        self.entries.clear();
        if self.entries.capacity() == 0 { return; }
        // Nested queries can have their own workspace. Retain only the largest
        // bounded allocation; never panic during thread-local destruction.
        let _ = QUERY_WORKSPACE.try_with(|pool| {
            if let Ok(mut pool) = pool.try_borrow_mut() {
                if pool.capacity() < self.entries.capacity() {
                    std::mem::swap(&mut *pool, &mut self.entries);
                }
            }
        });
    }
}
impl<'a> PointQuery<'a> {
    fn new(point: [f64; 3]) -> Self {
        let entries = if super::perf::disabled(4) { Vec::new() } else {
            QUERY_WORKSPACE.with(|pool| std::mem::take(&mut *pool.borrow_mut()))
        };
        debug_assert!(entries.is_empty());
        if entries.capacity() > 0 { super::perf::add(17, 1); }
        Self { point, entries, nodes: std::marker::PhantomData }
    }
    fn slot(&mut self, node: &'a CsgNode) -> Option<usize> {
        if let Some(i) = self.entries.iter().position(|e| e.node == node as *const CsgNode as usize) {
            return Some(i);
        }
        if self.entries.len() >= 128 {
            return None;
        }
        let i = self.entries.len();
        if self.entries.len() == self.entries.capacity() { super::perf::add(16, 1); }
        self.entries.push(QueryEntry {
            node: node as *const CsgNode as usize,
            scalar: None,
            raw: None,
        });
        Some(i)
    }
    fn scalar(&mut self, node: &'a CsgNode) -> f64 {
        let slot = self.slot(node);
        if let Some(value) = slot.and_then(|i| self.entries[i].scalar) {
            super::perf::add(3, 1);
            return value;
        }
        super::perf::add(1, 1);
        let value = node.f_with_children(self.point, |child| self.scalar(child));
        if let Some(i) = slot {
            self.entries[i].scalar = Some(value);
        }
        value
    }
    fn raw(&mut self, node: &'a CsgNode) -> FieldSample {
        if super::perf::disabled(4) {
            return sample_tree(node, self.point);
        }
        let slot = self.slot(node);
        if let Some(value) = slot.and_then(|i| self.entries[i].raw) {
            super::perf::add(3, 1);
            return value;
        }
        super::perf::add(2, 1);
        let value = sample_tree_using(node, self.point, self);
        if let Some(i) = slot {
            self.entries[i].raw = Some(value);
        }
        value
    }
}

impl<'a> Evaluation<'a> for PointQuery<'a> {
    fn scalar(&mut self, node: &'a CsgNode, p: [f64; 3]) -> f64 {
        debug_assert_eq!(p.map(f64::to_bits), self.point.map(f64::to_bits));
        self.scalar(node)
    }
    fn raw(&mut self, node: &'a CsgNode, p: [f64; 3]) -> FieldSample {
        debug_assert_eq!(p.map(f64::to_bits), self.point.map(f64::to_bits));
        self.raw(node)
    }
}

/// Retain the incumbent scalar, including total ordering and first-child ties.
fn winner<'a, T>(children: &'a [T], mut scalar: impl FnMut(&'a T) -> f64, is_min: bool) -> &'a T {
    if super::perf::disabled(1) {
        return children
            .iter()
            .min_by(|a, b| {
                super::perf::add(0, 2);
                let order = scalar(a).total_cmp(&scalar(b));
                if is_min {
                    order
                } else {
                    order.reverse()
                }
            })
            .expect("nonempty CSG combiner");
    }
    let mut chosen = children.first().expect("nonempty CSG combiner");
    if children.len() == 1 {
        return chosen;
    }
    super::perf::add(0, children.len());
    let mut value = scalar(chosen);
    for child in &children[1..] {
        let candidate = scalar(child);
        let order = candidate.total_cmp(&value);
        if if is_min { order.is_lt() } else { order.is_gt() } {
            chosen = child;
            value = candidate;
        }
    }
    chosen
}

pub fn sample_tree(node: &CsgNode, p: [f64; 3]) -> FieldSample {
    sample_tree_using(node, p, &mut Uncached)
}
fn sample_tree_using<'a>(node: &'a CsgNode, p: [f64; 3], query: &mut impl Evaluation<'a>) -> FieldSample {
    super::perf::add(13,1);
    match node {
        CsgNode::Leaf(l) => sample_leaf(l, p),
        CsgNode::Min(children) | CsgNode::Max(children) => {
            let is_min = matches!(node, CsgNode::Min(_));
            let child = winner(children, |child| query.scalar(child, p), is_min);
            query.raw(child, p)
        }
        CsgNode::Blend { kind, mode, r, n, children } => {
            let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
            let mut pair = [0, 1];
            if children.len() > 2 {
                let mut values = [f64::INFINITY; 2];
                for (i, c) in children.iter().enumerate() {
                    let v = sign * query.scalar(c, p);
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
                query.raw(&children[pair[0]], p).scale(sign),
                query.raw(&children[pair[1]], p).scale(sign),
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
            let child = winner(children, |child| child.f(p), is_min);
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

pub(crate) fn sample_leaf(l: &Leaf, p: [f64; 3]) -> FieldSample {
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
                let gy =
                    if y > -*h && y < *h { (b.d - a.d) * (profs.len() - 1) as f64 / (2. * h) } else { 0. };
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

pub(crate) fn sample_blend(
    mode: SminMode,
    a: FieldSample,
    b: FieldSample,
    radius: f64,
    n: f64,
) -> FieldSample {
    let c = FieldSample::constant;
    let r = c(radius);
    let q = std::f64::consts::FRAC_1_SQRT_2;
    match mode {
        SminMode::Chamfer => a.min(b).min(a.add(b).sub(r).scale(q)),
        SminMode::Round => r.max(a.min(b)).sub(r.sub(a).max(c(0.)).hypot(r.sub(b).max(c(0.)))),
        SminMode::Soft => {
            // The polynomial is differentiable at a == b even though this
            // scalar spelling uses min/abs. Differentiating their independent
            // tie choices gives inconsistent one-sided derivatives there.
            let e = (radius - (a.value - b.value).abs()).max(0.);
            let wa = (0.5 + 0.5 * (b.value - a.value) / radius).clamp(0., 1.);
            FieldSample {
                value: a.value.min(b.value) - e * e / (4. * radius),
                gradient: std::array::from_fn(|k| wa * a.gradient[k] + (1. - wa) * b.gradient[k]),
            }
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
                    let expected_normal = sample.normalized_equation().unwrap().gradient;
                    assert_eq!(tree.grad(p).1, expected_normal, "{mode:?} {kind:?} at {p:?}");
                    assert_eq!(pruned.grad(p), tree.grad(p));
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

#[cfg(test)]
fn reference_sample_tree(node: &CsgNode, p: [f64; 3]) -> FieldSample {
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
            reference_sample_tree(child, p)
        }
        CsgNode::Blend {
            kind,
            mode,
            r,
            n,
            children,
        } => {
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
                reference_sample_tree(&children[pair[0]], p).scale(sign),
                reference_sample_tree(&children[pair[1]], p).scale(sign),
                *r,
                *n,
            )
            .scale(sign)
        }
    }
}

/// Raw differential over a region-pruned view; uses the same surviving operands
/// and scalar selection as the full field.
#[cfg(test)]
fn reference_sample_pruned(node: &crate::sdf::Pruned<'_>, p: [f64; 3]) -> FieldSample {
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
            reference_sample_pruned(child, p)
        }
        crate::sdf::Pruned::Blend {
            kind,
            mode,
            r,
            n,
            children,
        } => {
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
                reference_sample_pruned(&children[pair[0]], p).scale(sign),
                reference_sample_pruned(&children[pair[1]], p).scale(sign),
                *r,
                *n,
            )
            .scale(sign)
        }
    }
}

#[cfg(test)]
mod selection_equivalence {
    use super::*;
    #[test]
    fn evaluates_once_preserving_total_order_and_ties() {
        for values in [
            [0., -0., 1., f64::NAN],
            [1., 1., 2., -1.],
            [f64::NEG_INFINITY, 0., f64::INFINITY, 0.],
        ] {
            for is_min in [false, true] {
                let mut calls = 0;
                let selected = winner(
                    &values,
                    |v| {
                        calls += 1;
                        *v
                    },
                    is_min,
                );
                let old = values
                    .iter()
                    .min_by(|a, b| {
                        let c = a.total_cmp(b);
                        if is_min {
                            c
                        } else {
                            c.reverse()
                        }
                    })
                    .unwrap();
                assert!(std::ptr::eq(selected, old));
                assert_eq!(calls, values.len());
            }
        }
    }
    #[test]
    fn raw_full_and_pruned_samples_match_reference() {
        use crate::sdf::leaf_at;
        let a = leaf_at(Shape::Sphere { r: 2. }, [-1., 0., 0.]);
        let b = leaf_at(Shape::Sphere { r: 2. }, [1., 0., 0.]);
        let tree = CsgNode::Max(vec![CsgNode::Min(vec![a.clone(), b.clone(), a]), b]);
        let pruned = tree.prune_to_box([0.; 3], [4.; 3]);
        for i in -100..100 {
            let p = [i as f64 / 100., 0.25, -0.5];
            for (a, b) in [
                (sample_tree(&tree, p), reference_sample_tree(&tree, p)),
                (
                    sample_pruned(&pruned, p),
                    reference_sample_pruned(&pruned, p),
                ),
            ] {
                assert_eq!(a.value.to_bits(), b.value.to_bits());
                assert_eq!(a.gradient.map(f64::to_bits), b.gradient.map(f64::to_bits));
            }
        }
    }
}

impl FieldRef {
    #[cfg(test)]
    fn reference_surface_live(&self, p: [f64; 3], tolerance: f64) -> bool {
        if let Some((path, branch, native_band)) = &self.branch {
            let mut target = self.node();
            for &i in path {
                target = match target {
                    CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => &c[i],
                    _ => unreachable!(),
                };
            }
            if !super::branch_surfaces::override_valid(
                self.node(),
                path,
                branch,
                &self.partners,
                p,
                tolerance,
            ) {
                return false;
            }
            let actual = reference_sample_tree(target, p);
            // Zero-surface seams already have native/operator carriers. Lift
            // only displaced field boundaries, avoiding duplicate curve graphs.
            // Ownership uses a fixed numerical band: a looser position query
            // must not erase a feature previously accepted by a tighter query.
            if !path.is_empty() && actual.value.abs() <= *native_band {
                return false;
            }
            let selected = branch.sample(target, p);
            let magnitude = actual
                .gradient
                .iter()
                .chain(selected.gradient.iter())
                .map(|x| x * x)
                .sum::<f64>()
                .sqrt()
                .max(1.);
            if (actual.value - selected.value).abs() > tolerance * magnitude {
                return false;
            }
        }
        let mut node = self.root.as_ref();
        for step in 0..=self.path.len() {
            if !reference_sample_tree(node, p)
                .normalized_equation()
                .is_some_and(|s| s.value.abs() <= tolerance)
            {
                return false;
            }
            if step < self.path.len() {
                node = match node {
                    CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => {
                        &c[self.path[step]]
                    }
                    CsgNode::Leaf(_) => unreachable!("field path descends through leaf"),
                };
            }
        }
        true
    }
}

#[cfg(test)]
mod query_tests {
    use super::*;
    use crate::sdf::leaf_at;
    fn same(a: FieldSample, b: FieldSample) {
        assert_eq!(a.value.to_bits(), b.value.to_bits());
        assert_eq!(a.gradient.map(f64::to_bits), b.gradient.map(f64::to_bits));
    }
    #[test]
    fn cached_ancestors_keep_raw_and_scalar_contracts() {
        for mode in [
            SminMode::Round,
            SminMode::Soft,
            SminMode::Chamfer,
            SminMode::Stairs,
            SminMode::Columns,
        ] {
            let a = leaf_at(Shape::Sphere { r: 2. }, [-1., 0., 0.]);
            let b = leaf_at(Shape::Sphere { r: 2. }, [1., 0., 0.]);
            let blend = CsgNode::Blend {
                kind: BlendKind::Smin,
                mode,
                r: 0.4,
                n: 3.,
                children: vec![a.clone(), b.clone(), a.clone()],
            };
            let tree = std::sync::Arc::new(CsgNode::Max(vec![CsgNode::Min(vec![blend, b]), a]));
            for i in -30..31 {
                let p = [i as f64 / 10., 0.1, 0.2];
                let mut query = PointQuery::new(p);
                same(query.raw(&tree), reference_sample_tree(&tree, p));
                assert_eq!(query.scalar(&tree).to_bits(), tree.f(p).to_bits());
                let n = query.entries.len();
                same(query.raw(&tree), reference_sample_tree(&tree, p));
                assert_eq!(n, query.entries.len());
                for path in [vec![], vec![0], vec![0, 0], vec![0, 0, 0]] {
                    let field = FieldRef::new(tree.clone(), path);
                    for tol in [1e-8, 0.01, 0.1] {
                        assert_eq!(
                            field.surface_live(p, tol),
                            field.reference_surface_live(p, tol)
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn separate_roots_and_capacity_limit_cannot_alias() {
        let a = leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        let b = leaf_at(Shape::Sphere { r: 2. }, [0.; 3]);
        let wide = CsgNode::Min(
            (0..150)
                .map(|i| leaf_at(Shape::Sphere { r: 1. }, [i as f64, 0., 0.]))
                .collect(),
        );
        let p = [0.5, 0.1, 0.];
        let mut query = PointQuery::new(p);
        for tree in [&a, &b, &wide, &a] {
            same(query.raw(tree), reference_sample_tree(tree, p));
        }
        assert!(query.entries.len() <= 128);
    }
}

#[cfg(test)]
mod workspace_tests {
    use super::*;
    use crate::sdf::leaf_at;
    fn bits(s:FieldSample)->[u64;4] {[s.value.to_bits(),s.gradient[0].to_bits(),s.gradient[1].to_bits(),s.gradient[2].to_bits()]}
    #[test]
    fn storage_reuse_never_reuses_point_or_node_values() {
        let mut tree=leaf_at(Shape::Sphere {r:1.},[0.;3]);
        let address=&tree as *const CsgNode as usize;
        {
            let mut query=PointQuery::new([0.5,0.,0.]);
            assert_eq!(bits(query.raw(&tree)),bits(reference_sample_tree(&tree,[0.5,0.,0.])));
        }
        tree=leaf_at(Shape::Sphere {r:3.},[0.;3]);
        assert_eq!(address,&tree as *const CsgNode as usize);
        for p in [[0.5,0.,0.],[1.,0.,0.],[1.0000000000000002,0.,0.]] {
            let mut query=PointQuery::new(p);
            assert!(query.entries.is_empty());
            assert_eq!(bits(query.raw(&tree)),bits(reference_sample_tree(&tree,p)));
        }
        QUERY_WORKSPACE.with(|pool|assert!(pool.borrow().is_empty()));
    }
    #[test]
    fn nested_queries_keep_independent_storage_and_unwind_clears_it() {
        let tree=leaf_at(Shape::Sphere {r:1.},[0.;3]);
        let mut outer=PointQuery::new([0.5,0.,0.]);
        let expected=bits(outer.raw(&tree));
        {
            let mut inner=PointQuery::new([2.,0.,0.]);
            assert_eq!(bits(inner.raw(&tree)),bits(reference_sample_tree(&tree,[2.,0.,0.])));
        }
        assert_eq!(bits(outer.raw(&tree)),expected);
        drop(outer);
        let _=std::panic::catch_unwind(|| {
            let mut query=PointQuery::new([3.,0.,0.]);
            query.raw(&tree);
            panic!("test query unwind");
        });
        QUERY_WORKSPACE.with(|pool| {
            assert!(pool.borrow().is_empty());
            assert!(pool.borrow().capacity()<=128);
        });
    }
}
