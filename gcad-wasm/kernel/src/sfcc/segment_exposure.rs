//! Exposure of a straight carrier intersection in hard box CSG. Box face
//! crossings partition the parameter interval; infinitesimal half-space tests
//! classify each open interval without a probe spacing or minimum feature size.
use super::{
    feature_curves::{CurveKind, FeatureCurve},
    tree::SfccTree,
    trim::TrimmedRun,
};
use crate::sdf::{CsgNode, Shape};
use crate::tolerances::ResolvedTolerances;

fn hard_boxes(node: &CsgNode) -> bool {
    match node {
        CsgNode::Leaf(leaf) => matches!(leaf.shape, Shape::Cuboid { .. }),
        CsgNode::Min(children) | CsgNode::Max(children) => children.iter().all(hard_boxes),
        CsgNode::Blend { .. } => false,
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn plane_value(f: [f64; 4], p: [f64; 3]) -> f64 {
    dot([f[0], f[1], f[2]], p) + f[3]
}

fn same_plane(a: [f64; 4], b: [f64; 4]) -> bool {
    a == b || a == b.map(|x| -x)
}

fn and(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    }
}

fn or(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
    }
}

fn occupied(node: &CsgNode, faces: &mut impl Iterator<Item = Option<bool>>) -> Option<bool> {
    let (children, union) = match node {
        CsgNode::Leaf(leaf) => {
            // A positive box is the intersection of its negative half-spaces;
            // its complement is the union of the sign-reversed half-spaces.
            let mut inside = Some(leaf.sign > 0.);
            for _ in 0..6 {
                let face = faces.next().flatten();
                inside = if leaf.sign > 0. {
                    and(inside, face)
                } else {
                    or(inside, face)
                };
            }
            return inside;
        }
        CsgNode::Min(children) => (children, true),
        CsgNode::Max(children) => (children, false),
        CsgNode::Blend { .. } => return None,
    };
    let mut inside = Some(!union);
    for child in children {
        let child = occupied(child, faces);
        inside = if union {
            or(inside, child)
        } else {
            and(inside, child)
        };
    }
    inside
}

// Membership at p + epsilon*tangent + epsilon^2*normal. The two incident
// equations vanish on the declared segment; other near-zero equations stay
// unresolved instead of rounding a possible third boundary to either side.
fn side(
    tree: &CsgNode,
    planes: &[[f64; 4]],
    incident: [[f64; 4]; 2],
    p: [f64; 3],
    tangent: [f64; 3],
    normal: [f64; 3],
) -> Option<bool> {
    let mut faces = planes.iter().map(|&plane| {
        let n = [plane[0], plane[1], plane[2]];
        if incident.iter().any(|&f| same_plane(plane, f)) {
            let d = dot(n, tangent);
            let error = 16.
                * f64::EPSILON
                * n.iter()
                    .zip(tangent)
                    .map(|(n, t)| (n * t).abs())
                    .sum::<f64>();
            if d.abs() > error {
                return Some(d < 0.);
            }
            // Only the flank's own plane is symbolically tangent to this
            // direction. Cancellation for the other carrier is uncertainty.
            if n != normal && n != normal.map(|v| -v) {
                return None;
            }
            let d = dot(n, normal);
            return if d.abs() > 16. * f64::EPSILON {
                Some(d < 0.)
            } else {
                None
            };
        }
        let value = plane_value(plane, p);
        let error = 16.
            * f64::EPSILON
            * (n.iter().zip(p).map(|(n, p)| (n * p).abs()).sum::<f64>() + plane[3].abs());
        if value.is_finite() && value.abs() > error {
            Some(value < 0.)
        } else {
            None
        }
    });
    occupied(tree, &mut faces)
}

/// `None` retains the general sampled trimmer. A returned result covers the
/// supported box/segment arrangement or explicitly counts an uncertain curve.
pub(super) fn trim(
    tree: &SfccTree<'_>,
    curve: &FeatureCurve,
    curve_idx: usize,
    tol: &ResolvedTolerances,
) -> Option<(Vec<TrimmedRun>, usize)> {
    if curve.kind() != CurveKind::Segment || !hard_boxes(tree.root) {
        return None;
    }
    let incident = [
        tree.strata[curve.adjacent_strata[0]].planar_coefficients()?,
        tree.strata[curve.adjacent_strata[1]].planar_coefficients()?,
    ];
    if same_plane(incident[0], incident[1]) {
        return Some((Vec::new(), 0));
    }
    let planes: Option<Vec<_>> = tree
        .leaves
        .iter()
        .flat_map(|leaf| {
            tree.strata[leaf.strata_start..leaf.strata_end]
                .iter()
                .map(|s| s.planar_coefficients())
        })
        .collect();
    let planes = planes?;
    let a = curve.point_at_checked(curve.t_min)?;
    let b = curve.point_at_checked(curve.t_max)?;
    let mut events = vec![0., 1.];
    for &plane in &planes {
        if !plane.iter().all(|v| v.is_finite()) {
            return Some((Vec::new(), 1));
        }
        if incident.iter().any(|&f| same_plane(plane, f)) {
            continue;
        }
        let fa = plane_value(plane, a);
        let fb = plane_value(plane, b);
        if fa != fb {
            let u = fa / (fa - fb);
            if u > 0. && u < 1. {
                events.push(u);
            }
        }
    }
    events.sort_by(f64::total_cmp);
    events.dedup();
    let normals = incident.map(|f| [f[0], f[1], f[2]]);
    let tangent = cross(normals[0], normals[1]);
    let length = dot(tangent, tangent).sqrt();
    if !length.is_finite() || length <= 16. * f64::EPSILON {
        return Some((Vec::new(), 1));
    }
    let tangent = tangent.map(|v| v / length);
    let mut runs: Vec<TrimmedRun> = Vec::new();
    let mut unresolved = false;
    for interval in events.windows(2) {
        let t0 = curve.t_min + interval[0] * (curve.t_max - curve.t_min);
        let t1 = curve.t_min + interval[1] * (curve.t_max - curve.t_min);
        let p = curve.point_at((t0 + t1) * 0.5);
        if !curve
            .adjacent_strata
            .iter()
            .all(|&id| tree.strata[id].domain_contains(p, tol.curve_eps * 8.))
        {
            continue;
        }
        let mut exposed = Some(true);
        for n in normals {
            let across = cross(n, tangent);
            let mut flank = Some(false);
            for direction in [across, across.map(|v| -v)] {
                let inside = side(tree.root, &planes, incident, p, direction, n.map(|v| -v));
                let outside = side(tree.root, &planes, incident, p, direction, n).map(|v| !v);
                flank = or(flank, and(inside, outside));
            }
            exposed = and(exposed, flank);
        }
        match exposed {
            Some(true) => {
                if let Some(last) = runs.last_mut().filter(|run| run.t1 == t0) {
                    last.t1 = t1;
                } else {
                    runs.push(TrimmedRun {
                        curve_idx,
                        t0,
                        t1,
                        full_closed: false,
                    });
                }
            }
            Some(false) => {}
            None => unresolved = true,
        }
    }
    Some((runs, usize::from(unresolved)))
}
