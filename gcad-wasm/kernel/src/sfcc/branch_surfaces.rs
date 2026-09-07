//! Lift an operand's piecewise branches through its enclosing blend. Their
//! intersections are creases of the displaced surface, not primitive zero seams.
use super::{
    field_branches::{sample_blend, sample_tree, FieldRef, FieldSample},
    tree::SfccTree,
};
use crate::{
    primitives::{polygon2d::{polygon_dist_2d, polygon_edge_dist_2d}, smin::SminMode},
    sdf::{BlendKind, CsgNode, Shape},
    strata::{Stratum, StratumIdentity},
};
use std::sync::Arc;

#[derive(Clone, Debug)]
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
    /// Override one profile's nearest segment in the interpolated side field.
    LoftEdge(usize, usize),
    /// Bottom clamp, each interpolation segment, top clamp.
    LoftRegion(usize),
}
impl FieldBranch {
    pub(crate) fn valid(&self, node: &CsgNode, p: [f64; 3], tol: f64) -> bool {
        let CsgNode::Leaf(l) = node else { return true };
        let y = l.sim.inv_apply_point(p[0], p[1], p[2])[1] - l.pos[1];
        let tol = tol / l.sim.s;
        match (&l.shape, self) {
            (Shape::Loft { h, profs, .. }, Self::LoftEdge(profile, _)) => {
                let t = ((y + h) / (2. * h)).clamp(0., 1.) * (profs.len() - 1) as f64;
                (t - *profile as f64).abs() < 1.
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
                        FieldSample { value: sign * [x, y, z][axis] - half[axis],
                            gradient: std::array::from_fn(|k| if k == axis { sign } else { 0. }) }
                    }
                    (Shape::Cylinder { r, .. }, Self::CylinderPart(0)) => {
                        let rho = x.hypot(z);
                        FieldSample { value: rho - r, gradient: if rho > 1e-12 { [x / rho, 0., z / rho] } else { [0.; 3] } }
                    }
                    (Shape::Cylinder { h, .. }, Self::CylinderPart(part)) => cap(*part == 1).sub(FieldSample::constant(*h)),
                    (Shape::Cone { r, h }, Self::ConePart(0)) => {
                        let rho = x.hypot(z);
                        let length = r.hypot(*h);
                        FieldSample { value: (rho * h + (y - h) * r) / length,
                            gradient: if rho > 1e-12 { [x / rho * h / length, r / length, z / rho * h / length] } else { [0., r / length, 0.] } }
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
                        let sign = if crate::primitives::shapes::lathe_dist(edges, x, y, z) < 0. { -1. } else { 1. };
                        let (gr, gy) = if length >= 1e-6 { (sign * dx / length, sign * dy / length) } else { (e.nr, e.ny) };
                        FieldSample { value: sign * length,
                            gradient: if rho > 1e-12 { [gr * x / rho, gy, gr * z / rho] } else { [0., gy, 0.] } }
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
                            Self::LoftEdge(profile, edge) if *profile == j =>
                                polygon_edge_dist_2d(&profs[j], winds[j], x, z, *edge),
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
                        if matches!(self, Self::LoftPart(0) | Self::LoftEdge(_, _)) {
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
        .map(
            |(i, c)| if i == path[0] { sample_override(c, &path[1..], branch, p) } else { sample_tree(c, p) },
        )
        .collect();
    match node {
        CsgNode::Min(_) | CsgNode::Max(_) => values[path[0]],
        CsgNode::Blend { kind, mode, r, n, .. } => {
            let sign = if *kind == BlendKind::Smin { 1. } else { -1. };
            if *mode == SminMode::Chamfer {
                let other = (0..values.len())
                    .filter(|&i| i != path[0])
                    .min_by(|&a, &b| (sign * values[a].value).total_cmp(&(sign * values[b].value)))
                    .unwrap();
                return values[path[0]]
                    .add(values[other])
                    .sub(FieldSample::constant(sign * r))
                    .scale(std::f64::consts::FRAC_1_SQRT_2);
            }
            let mut values: Vec<_> = values.into_iter().map(|x| x.scale(sign)).collect();
            values.sort_by(|a, b| a.value.total_cmp(&b.value));
            sample_blend(*mode, values[0], values[1], *r, *n).scale(sign)
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
    p: [f64; 3],
    tol: f64,
) -> bool {
    if path.is_empty() && !branch.valid(node, p, tol) {
        return false;
    }
    let actual = sample_tree(node, p);
    let selected = sample_override(node, path, branch, p);
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
    override_valid(&c[path[0]], &path[1..], branch, p, tol)
}

/// Explicit pairs only: unrelated lifted fields often coincide wherever their
/// operand is inactive, and must not enter the ordinary all-carrier cross product.
pub(crate) fn append_branch_pairs(
    tree: &mut SfccTree<'_>,
    native_band: f64,
) -> Vec<(usize, usize, [f64; 6])> {
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
                    Shape::Lathe { edges } => groups.push(edges.iter().enumerate()
                        .filter(|(_, e)| e.kind != crate::primitives::shapes::LatheEdgeKind::None)
                        .map(|(i, _)| FieldBranch::LatheEdge(i)).collect()),
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
                        for (profile, verts) in profs.iter().enumerate() {
                            groups.push((0..verts.len() / 2).map(|edge| FieldBranch::LoftEdge(profile, edge)).collect());
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
            for group in groups {
                let first = strata.len();
                for branch in group {
                    let domain = FieldRef::new(root.clone(), op.clone()).with_branch(
                        path[op.len()..].to_vec(),
                        branch,
                        native_band,
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
                }
                for a in first..strata.len() {
                    for b in a + 1..strata.len() {
                        pairs.push((a, b, *bounds));
                    }
                }
            }
        }
        if let CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } = node {
            for (i, c) in c.iter().enumerate() {
                path.push(i);
                walk(root, c, path, owner.clone(), strata, pairs, native_band);
                path.pop();
            }
        }
    }
    let root = Arc::new(tree.root.clone());
    let mut pairs = Vec::new();
    walk(&root, &root, &mut Vec::new(), None, &mut tree.strata, &mut pairs, native_band);
    pairs
}
