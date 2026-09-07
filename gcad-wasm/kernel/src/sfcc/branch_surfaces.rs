//! Lift an operand's piecewise branches through its enclosing blend. Their
//! intersections are creases of the displaced surface, not primitive zero seams.
use super::{
    field_branches::{sample_blend, sample_tree, FieldRef, FieldSample},
    tree::SfccTree,
};
use crate::{
    primitives::{
        polygon2d::{polygon_dist_2d, polygon_edge_dist_2d},
        smin::SminMode,
    },
    sdf::{BlendKind, CsgNode, Shape},
    strata::{Stratum, StratumIdentity},
};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum FieldBranch {
    Child(usize),
    Chamfer(usize, usize),
    Pair(usize, usize),
    BoxFace(u8),
    CylinderPart(u8),
    ConePart(u8),
    LatheEdge(usize),
    /// Exact profile field or either cap supporting field.
    ExtrudePart(u8),
    /// One finite polygon segment, including its smooth endpoint regions.
    ExtrudeEdge(usize),
    /// Constant bottom angle, linear angle, constant top angle.
    TwistRegion(u8),
    LoftPart(u8),
    /// Fixed interpolation interval and one active edge from each profile.
    LoftEdges {
        region: usize,
        lower: usize,
        upper: usize,
    },
    /// Bottom clamp, each interpolation segment, top clamp.
    LoftRegion(usize),
}
impl FieldBranch {
    pub(crate) fn valid(&self, node: &CsgNode, p: [f64; 3], tol: f64) -> bool {
        let CsgNode::Leaf(l) = node else { return true };
        let y = l.sim.inv_apply_point(p[0], p[1], p[2])[1] - l.pos[1];
        let tol = tol / l.sim.s;
        match (&l.shape, self) {
            (Shape::Loft { h, profs, winds }, Self::LoftEdges { region, lower, upper }) => {
                let height = 2. * h / (profs.len() - 1) as f64;
                let start = -h + *region as f64 * height;
                if y < start - tol || y > start + height + tol {
                    return false;
                }
                let local = l.sim.inv_apply_point(p[0], p[1], p[2]);
                let (x, z) = (local[0] - l.pos[0], local[2] - l.pos[2]);
                [(*region, *lower), (*region + 1, *upper)].into_iter().all(|(profile, edge)| {
                    let actual = polygon_dist_2d(&profs[profile], winds[profile], x, z);
                    let selected = polygon_edge_dist_2d(&profs[profile], winds[profile], x, z, edge);
                    (actual.d - selected.d).abs() <= tol
                })
            }
            (Shape::Extrude { h, .. }, Self::TwistRegion(region)) => match region {
                0 => y <= -h + tol,
                1 => y >= -h - tol && y <= h + tol,
                _ => y >= h - tol,
            },
            (Shape::Loft { h, profs, .. }, Self::LoftRegion(region)) => {
                let n = profs.len() - 1;
                if *region == 0 {
                    y <= -h + tol
                } else if *region == n + 1 {
                    y >= h - tol
                } else {
                    let lo = -h + 2. * h * (*region - 1) as f64 / n as f64;
                    y >= lo - tol && y <= lo + 2. * h / n as f64 + tol
                }
            }
            _ => true,
        }
    }
    pub(crate) fn sample(&self, node: &CsgNode, p: [f64; 3]) -> FieldSample {
        match (node, self) {
            (CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. }, Self::Child(i)) => {
                sample_tree(&c[*i], p)
            }
            (CsgNode::Blend { kind, r, children, .. }, Self::Chamfer(i, j)) => {
                let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
                sample_tree(&children[*i], p)
                    .add(sample_tree(&children[*j], p))
                    .sub(FieldSample::constant(sign * r))
                    .scale(std::f64::consts::FRAC_1_SQRT_2)
            }
            (CsgNode::Blend { kind, mode, r, n, children }, Self::Pair(i, j)) => {
                let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
                sample_blend(
                    *mode,
                    sample_tree(&children[*i], p).scale(sign),
                    sample_tree(&children[*j], p).scale(sign),
                    *r,
                    *n,
                )
                .scale(sign)
            }
            (CsgNode::Leaf(l), _) => {
                let local = l.sim.inv_apply_point(p[0], p[1], p[2]);
                let [x, y, z] = std::array::from_fn(|k| local[k] - l.pos[k]);
                let cap = |top: bool| FieldSample {
                    value: if top { y } else { -y },
                    gradient: [0., if top { 1. } else { -1. }, 0.],
                };
                let out = match (&l.shape, self) {
                    (Shape::Cuboid { half }, Self::BoxFace(face)) => {
                        let axis = *face as usize / 2;
                        let sign = if face % 2 == 0 { 1. } else { -1. };
                        FieldSample {
                            value: sign * [x, y, z][axis] - half[axis],
                            gradient: std::array::from_fn(|k| if k == axis { sign } else { 0. }),
                        }
                    }
                    (Shape::Cylinder { r, .. }, Self::CylinderPart(0)) => {
                        let rho = x.hypot(z);
                        FieldSample {
                            value: rho - r,
                            gradient: if rho > 1e-12 { [x / rho, 0., z / rho] } else { [0.; 3] },
                        }
                    }
                    (Shape::Cylinder { h, .. }, Self::CylinderPart(part)) => {
                        cap(*part == 1).sub(FieldSample::constant(*h))
                    }
                    (Shape::Cone { r, h }, Self::ConePart(0)) => {
                        let rho = x.hypot(z);
                        let length = r.hypot(*h);
                        FieldSample {
                            value: (rho * h + (y - h) * r) / length,
                            gradient: if rho > 1e-12 {
                                [x / rho * h / length, r / length, z / rho * h / length]
                            } else {
                                [0., r / length, 0.]
                            },
                        }
                    }
                    (Shape::Cone { .. }, Self::ConePart(_)) => cap(false),
                    (Shape::Lathe { edges }, Self::LatheEdge(edge)) => {
                        let e = &edges[*edge];
                        let rho = x.hypot(z);
                        let (ex, ey) = (e.r1 - e.r0, e.y1 - e.y0);
                        let (wx, wy) = (rho - e.r0, y - e.y0);
                        let t = ((wx * ex + wy * ey) / (e.len * e.len)).clamp(0., 1.);
                        let (dx, dy) = (wx - t * ex, wy - t * ey);
                        let length = dx.hypot(dy);
                        let sign =
                            if crate::primitives::shapes::lathe_dist(edges, x, y, z) < 0. { -1. } else { 1. };
                        let (gr, gy) = if length >= 1e-6 {
                            (sign * dx / length, sign * dy / length)
                        } else {
                            (e.nr, e.ny)
                        };
                        FieldSample {
                            value: sign * length,
                            gradient: if rho > 1e-12 {
                                [gr * x / rho, gy, gr * z / rho]
                            } else {
                                [0., gy, 0.]
                            },
                        }
                    }
                    (Shape::Extrude { h, .. }, Self::ExtrudePart(1))
                    | (Shape::Loft { h, .. }, Self::LoftPart(1)) => cap(true).sub(FieldSample::constant(*h)),
                    (Shape::Extrude { h, .. }, Self::ExtrudePart(2))
                    | (Shape::Loft { h, .. }, Self::LoftPart(2)) => cap(false).sub(FieldSample::constant(*h)),
                    (Shape::Extrude { verts, wind, h, twist_rad }, _) => {
                        let raw = (y + h) / (2. * h);
                        let t = match self {
                            Self::TwistRegion(0) => 0.,
                            Self::TwistRegion(1) => raw,
                            Self::TwistRegion(2) => 1.,
                            _ => raw.clamp(0., 1.),
                        };
                        let k = match self {
                            Self::TwistRegion(0 | 2) => 0.,
                            Self::TwistRegion(1) => twist_rad / (2. * h),
                            _ => {
                                if raw > 0. && raw < 1. {
                                    twist_rad / (2. * h)
                                } else {
                                    0.
                                }
                            }
                        };
                        let (sn, cs) = (twist_rad * t).sin_cos();
                        let (qx, qz) = (cs * x + sn * z, -sn * x + cs * z);
                        let a = match self {
                            Self::ExtrudeEdge(edge) => polygon_edge_dist_2d(verts, *wind, qx, qz, *edge),
                            _ => polygon_dist_2d(verts, *wind, qx, qz),
                        };
                        let side = FieldSample {
                            value: a.d,
                            gradient: [
                                cs * a.gx - sn * a.gz,
                                k * (a.gx * qz - a.gz * qx),
                                sn * a.gx + cs * a.gz,
                            ],
                        };
                        if matches!(self, Self::ExtrudePart(0) | Self::ExtrudeEdge(_)) {
                            side
                        } else {
                            side.max(cap(y >= 0.).sub(FieldSample::constant(*h)))
                        }
                    }
                    (Shape::Loft { profs, winds, h }, _) => {
                        let n = profs.len() - 1;
                        let raw = (y + h) / (2. * h) * n as f64;
                        let (i, t, k) = match self {
                            Self::LoftEdges { region, .. } => {
                                (*region, raw - *region as f64, n as f64 / (2. * h))
                            }
                            Self::LoftRegion(0) => (0, 0., 0.),
                            Self::LoftRegion(r) if *r == n + 1 => (n - 1, 1., 0.),
                            Self::LoftRegion(r) => (*r - 1, raw - (*r - 1) as f64, n as f64 / (2. * h)),
                            _ => {
                                let t = raw.clamp(0., n as f64);
                                let i = (t.floor() as usize).min(n - 1);
                                (i, t - i as f64, if y > -h && y < *h { n as f64 / (2. * h) } else { 0. })
                            }
                        };
                        let profile_sample = |j: usize| match self {
                            Self::LoftEdges { region, lower, upper } => polygon_edge_dist_2d(
                                &profs[j],
                                winds[j],
                                x,
                                z,
                                if j == *region { *lower } else { *upper },
                            ),
                            _ => polygon_dist_2d(&profs[j], winds[j], x, z),
                        };
                        let a = profile_sample(i);
                        let b = profile_sample(i + 1);
                        let side = FieldSample {
                            value: a.d * (1. - t) + b.d * t,
                            gradient: [
                                a.gx * (1. - t) + b.gx * t,
                                (b.d - a.d) * k,
                                a.gz * (1. - t) + b.gz * t,
                            ],
                        };
                        if matches!(self, Self::LoftPart(0) | Self::LoftEdges { .. }) {
                            side
                        } else {
                            side.max(cap(y >= 0.).sub(FieldSample::constant(*h)))
                        }
                    }
                    _ => unreachable!(),
                };
                FieldSample {
                    value: out.value * l.sim.s * l.sign,
                    gradient: l
                        .sim
                        .rotate_vector(out.gradient[0], out.gradient[1], out.gradient[2])
                        .map(|x| x * l.sign),
                }
            }
            _ => unreachable!(),
        }
    }
}

pub(crate) fn sample_override(
    node: &CsgNode,
    path: &[usize],
    branch: &FieldBranch,
    partners: &[usize],
    p: [f64; 3],
) -> FieldSample {
    if path.is_empty() {
        return branch.sample(node, p);
    }
    let children = match node {
        CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => c,
        _ => unreachable!(),
    };
    let values: Vec<_> = children
        .iter()
        .enumerate()
        .map(|(i, c)| {
            if i == path[0] {
                sample_override(c, &path[1..], branch, &partners[1..], p)
            } else {
                sample_tree(c, p)
            }
        })
        .collect();
    match node {
        CsgNode::Min(_) | CsgNode::Max(_) => values[path[0]],
        CsgNode::Blend { kind, mode, r, n, .. } => {
            let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
            if *mode == SminMode::Chamfer {
                let other = partners[0];
                return values[path[0]]
                    .add(values[other])
                    .sub(FieldSample::constant(sign * r))
                    .scale(std::f64::consts::FRAC_1_SQRT_2);
            }
            let (i, j) = if children.len() == 2 { (0, 1) } else { (path[0], partners[0]) };
            sample_blend(*mode, values[i].scale(sign), values[j].scale(sign), *r, *n).scale(sign)
        }
        _ => unreachable!(),
    }
}

/// Validate activity at every intervening combiner. Supporting extensions of
/// an enclosing chamfer must not become live merely because a later cut is zero.
pub(crate) fn override_valid(
    node: &CsgNode,
    path: &[usize],
    branch: &FieldBranch,
    partners: &[usize],
    p: [f64; 3],
    tol: f64,
) -> bool {
    if path.is_empty() && !branch.valid(node, p, tol) {
        return false;
    }
    if !path.is_empty() {
        if let CsgNode::Blend { kind, children, .. } = node {
            let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
            let i = path[0];
            let j = partners[0];
            let a = sign * children[i].f(p);
            let b = sign * children[j].f(p);
            if children.iter().enumerate().any(|(k, c)| k != i && k != j && sign * c.f(p) < a.max(b) - tol) {
                return false;
            }
        }
    }
    let actual = sample_tree(node, p);
    let selected = sample_override(node, path, branch, partners, p);
    let magnitude =
        actual.gradient.iter().chain(selected.gradient.iter()).map(|x| x * x).sum::<f64>().sqrt().max(1.);
    if (actual.value - selected.value).abs() > tol * magnitude {
        return false;
    }
    if path.is_empty() {
        return true;
    }
    let c = match node {
        CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => c,
        _ => unreachable!(),
    };
    override_valid(&c[path[0]], &path[1..], branch, &partners[1..], p, tol)
}

/// Explicit pairs only: unrelated lifted fields often coincide wherever their
/// operand is inactive, and must not enter the ordinary all-carrier cross product.
pub(crate) fn append_branch_pairs(
    tree: &mut SfccTree<'_>,
    native_band: f64,
) -> (Vec<(usize, usize, [f64; 6])>, Vec<Vec<usize>>) {
    fn bounds(node: &CsgNode) -> [f64; 6] {
        match node {
            CsgNode::Leaf(l) => {
                let (c, h) = super::tree::local_aabb_box(&l.shape, l.pos);
                super::tree::world_aabb_of_local_box(l, c, h)
            }
            CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => {
                let mut b = [
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                ];
                for c in c {
                    let a = bounds(c);
                    for k in 0..3 {
                        b[k] = b[k].min(a[k]);
                        b[k + 3] = b[k + 3].max(a[k + 3]);
                    }
                }
                if let CsgNode::Blend { r, .. } = node {
                    for k in 0..3 {
                        b[k] -= r.abs();
                        b[k + 3] += r.abs();
                    }
                }
                b
            }
        }
    }
    fn walk(
        root: &Arc<CsgNode>,
        node: &CsgNode,
        path: &mut Vec<usize>,
        owner: Option<(Vec<usize>, [f64; 6])>,
        strata: &mut Vec<Stratum>,
        pairs: &mut Vec<(usize, usize, [f64; 6])>,
        native_band: f64,
        unresolved: &mut Vec<Vec<usize>>,
    ) {
        let owner = owner.or_else(|| {
            if matches!(node, CsgNode::Blend { .. }) {
                Some((path.clone(), bounds(node)))
            } else {
                None
            }
        });
        if let Some((op, bounds)) = &owner {
            let mut groups: Vec<Vec<FieldBranch>> = Vec::new();
            match node {
                CsgNode::Leaf(l) => match &l.shape {
                    Shape::Cuboid { .. } => groups.push((0..6).map(FieldBranch::BoxFace).collect()),
                    Shape::Cylinder { .. } => groups.push((0..3).map(FieldBranch::CylinderPart).collect()),
                    Shape::Cone { .. } => groups.push((0..2).map(FieldBranch::ConePart).collect()),
                    Shape::Lathe { edges } => groups.push(
                        edges
                            .iter()
                            .enumerate()
                            .filter(|(_, e)| e.kind != crate::primitives::shapes::LatheEdgeKind::None)
                            .map(|(i, _)| FieldBranch::LatheEdge(i))
                            .collect(),
                    ),
                    Shape::Extrude { verts, twist_rad, .. } => {
                        groups.push((0..3).map(FieldBranch::ExtrudePart).collect());
                        groups.push((0..verts.len() / 2).map(FieldBranch::ExtrudeEdge).collect());
                        if *twist_rad != 0. {
                            groups.push((0..3).map(FieldBranch::TwistRegion).collect());
                        }
                    }
                    Shape::Loft { profs, .. } => {
                        groups.push((0..3).map(FieldBranch::LoftPart).collect());
                        groups.push((0..=profs.len()).map(FieldBranch::LoftRegion).collect());
                        for region in 0..profs.len() - 1 {
                            if (profs[region].len() / 2).saturating_mul(profs[region + 1].len() / 2) > 128 {
                                unresolved.push(path.clone());
                                continue;
                            }
                            let lower_count = profs[region].len() / 2;
                            let upper_count = profs[region + 1].len() / 2;
                            groups.push(
                                (0..lower_count)
                                    .flat_map(|lower| {
                                        (0..upper_count).map(move |upper| FieldBranch::LoftEdges {
                                            region,
                                            lower,
                                            upper,
                                        })
                                    })
                                    .collect(),
                            );
                        }
                    }
                    _ => {}
                },
                CsgNode::Min(c) | CsgNode::Max(c) => {
                    groups.push((0..c.len()).map(FieldBranch::Child).collect())
                }
                CsgNode::Blend { mode: SminMode::Chamfer, children: c, .. } if path != op => {
                    let mut v: Vec<_> = (0..c.len()).map(FieldBranch::Child).collect();
                    for i in 0..c.len() {
                        for j in i + 1..c.len() {
                            v.push(FieldBranch::Chamfer(i, j));
                        }
                    }
                    groups.push(v);
                }
                CsgNode::Blend { mode, children: c, .. } if c.len() > 2 && *mode != SminMode::Chamfer => {
                    let mut v = Vec::new();
                    for i in 0..c.len() {
                        for j in i + 1..c.len() {
                            v.push(FieldBranch::Pair(i, j));
                        }
                    }
                    groups.push(v);
                }
                _ => {}
            }
            let mut owner_node = root.as_ref();
            for &i in op {
                owner_node = match owner_node {
                    CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => &c[i],
                    _ => unreachable!(),
                };
            }
            let mut states = if groups.is_empty() { Vec::new() } else { vec![Vec::new()] };
            let mut ancestor = owner_node;
            for &selected in &path[op.len()..] {
                let children = match ancestor {
                    CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => c,
                    _ => unreachable!(),
                };
                let alternatives: Vec<_> = if matches!(ancestor, CsgNode::Blend { .. }) {
                    (0..children.len()).filter(|&i| i != selected).collect()
                } else {
                    vec![usize::MAX]
                };
                if states.len().saturating_mul(alternatives.len()) > 128 {
                    unresolved.push(path.clone());
                    states.clear();
                    break;
                }
                states = states
                    .into_iter()
                    .flat_map(|state| {
                        alternatives.iter().map(move |&partner| {
                            let mut next = state.clone();
                            next.push(partner);
                            next
                        })
                    })
                    .collect();
                ancestor = &children[selected];
            }
            let states: Vec<Arc<[usize]>> = states.into_iter().map(Arc::from).collect();
            let mut intern = std::collections::HashMap::new();
            for group in groups {
                for partners in &states {
                    let mut ids = Vec::new();
                    for branch in &group {
                        let key = (branch.clone(), partners.clone());
                        if let Some(&id) = intern.get(&key) {
                            ids.push(id);
                            continue;
                        }
                        let domain = FieldRef::new(root.clone(), op.clone()).with_branch(
                            path[op.len()..].to_vec(),
                            branch.clone(),
                            native_band,
                            partners.clone(),
                        );
                        let id = strata.len();
                        strata.push(
                            Stratum::field(
                                StratumIdentity {
                                    id,
                                    owner_node_id: -1,
                                    leaf_index: usize::MAX,
                                    local_index: 0,
                                    sign: 1.,
                                },
                                domain.clone(),
                            )
                            .with_domain(domain),
                        );
                        intern.insert(key, id);
                        ids.push(id);
                    }
                    for a in 0..ids.len() {
                        for b in a + 1..ids.len() {
                            pairs.push((ids[a], ids[b], *bounds));
                        }
                    }
                }
            }
        }
        if let CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } = node {
            for (i, c) in c.iter().enumerate() {
                path.push(i);
                walk(root, c, path, owner.clone(), strata, pairs, native_band, unresolved);
                path.pop();
            }
        }
    }
    let root = Arc::new(tree.root.clone());
    let mut pairs = Vec::new();
    let mut unresolved = Vec::new();
    walk(&root, &root, &mut Vec::new(), None, &mut tree.strata, &mut pairs, native_band, &mut unresolved);
    (pairs, unresolved)
}

#[cfg(test)]
mod region_tests {
    use super::*;
    #[test]
    fn partner_expansion_budget_reports_the_affected_source_path() {
        let mut root = crate::sdf::leaf_at(Shape::Cuboid { half: [1.; 3] }, [0.; 3]);
        for _ in 0..5 {
            root = CsgNode::Blend {
                kind: BlendKind::Smin,
                mode: SminMode::Round,
                r: 1.,
                n: 4.,
                children: vec![
                    root,
                    crate::sdf::leaf_at(Shape::Sphere { r: 1. }, [2., 0., 0.]),
                    crate::sdf::leaf_at(Shape::Sphere { r: 1. }, [0., 2., 0.]),
                    crate::sdf::leaf_at(Shape::Sphere { r: 1. }, [0., 0., 2.]),
                ],
            };
        }
        let mut tree = super::super::tree::build_tree(&root, super::super::feature_set::build_leaf_strata);
        let (_, unresolved) = append_branch_pairs(&mut tree, 1e-8);
        assert_eq!(unresolved, vec![vec![0; 5]], "do not report smooth leaves with no branch alternatives");
    }
    #[test]
    fn fixed_partner_keeps_its_formula_outside_its_guard() {
        let tree = CsgNode::Blend {
            kind: BlendKind::Smax,
            mode: SminMode::Chamfer,
            r: 1.,
            n: 4.,
            children: vec![
                crate::sdf::leaf_at(Shape::Cuboid { half: [10.; 3] }, [-10., 0., -10.]),
                crate::sdf::leaf_at(Shape::Cuboid { half: [10.; 3] }, [0., -9.4, 0.]),
                crate::sdf::leaf_at(Shape::Cuboid { half: [10.; 3] }, [0., 9.4, 0.]),
            ],
        };
        let branch = FieldBranch::BoxFace(0);
        let p = [-0.5, -0.1, -0.5];
        let first = sample_override(&tree, &[0], &branch, &[1], p);
        let second = sample_override(&tree, &[0], &branch, &[2], p);
        assert!(first.gradient[1] > 0. && second.gradient[1] < 0.);
        assert!(!override_valid(&tree, &[0], &branch, &[1], p, 1e-8));
        assert!(override_valid(&tree, &[0], &branch, &[2], p, 1e-8));
        let root = Arc::new(tree);
        let field = |partner, band| {
            FieldRef::new(root.clone(), vec![]).with_branch(
                vec![0],
                branch.clone(),
                band,
                Arc::from([partner]),
            )
        };
        let mut context = super::super::provenance::IdentityContext::default();
        let first = field(1, 1e-8).semantic_identity(&mut context);
        assert_eq!(first, field(1, 1e-8).semantic_identity(&mut context));
        assert_ne!(first, field(2, 1e-8).semantic_identity(&mut context));
        assert_ne!(first, field(1, 1e-6).semantic_identity(&mut context));
    }
}
