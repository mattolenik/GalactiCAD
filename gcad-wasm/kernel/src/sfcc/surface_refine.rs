//! Conforming refinement of triangle interiors after partition assembly. The
//! octree depth ceiling is a sampling budget, not a triangle-fidelity guarantee.
use super::{feature_set::SfccFeatureSet, point_table::PointTable};
use crate::sdf::CsgNode;
use std::collections::BTreeMap;

fn project(tree: &CsgNode, p: [f64; 3], budget: f64, eps: f64) -> Option<[f64; 3]> {
    let mut q = p;
    for _ in 0..24 {
        let f = super::field_branches::sample_tree(tree, q);
        if f.value.abs() <= eps {
            return Some(q);
        }
        let g2 = f.gradient.iter().map(|x| x * x).sum::<f64>();
        if !g2.is_finite() || g2 < 1e-20 {
            return None;
        }
        let mut alpha = f.value / g2;
        let mut next = None;
        for _ in 0..8 {
            let n = std::array::from_fn(|k| q[k] - alpha * f.gradient[k]);
            if (n[0] - p[0]).hypot(n[1] - p[1]).hypot(n[2] - p[2]) <= budget
                && tree.f(n).abs() < f.value.abs()
            {
                next = Some(n);
                break;
            }
            alpha *= 0.5;
        }
        q = next?;
    }
    None
}
fn pos(points: &PointTable, id: usize) -> [f64; 3] {
    [points.x(id), points.y(id), points.z(id)]
}
fn edge(a: usize, b: usize) -> (usize, usize) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

pub(crate) fn refine_surface(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    tris: &[usize],
    tolerance: f64,
) -> (Vec<usize>, usize) {
    // Primitive and hard-CSG paths retain their established feature tessellation.
    // Displaced blends can have very small local radii even with a large blend r.
    if !tree.has_blend() {
        return (tris.to_vec(), 0);
    }
    // Bound both iterations and added geometry. A very tight requested
    // tolerance must produce an explicit unresolved result, not exhaust WASM
    // memory while recursively refining an ill-conditioned region.
    let index_budget = tris.len().saturating_add(3 * (tris.len() / 3).clamp(10_000, 500_000));
    let mut tris = tris.to_vec();
    let limit = tolerance * 0.75;
    'rounds: for _ in 0..8 {
        let mut split = BTreeMap::<(usize, usize), Option<usize>>::new();
        for t in tris.chunks_exact(3) {
            let p = [pos(points, t[0]), pos(points, t[1]), pos(points, t[2])];
            let c = std::array::from_fn(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.);
            let bad = tree.f(c).abs() > limit
                || (0..3).any(|k| {
                    let m = std::array::from_fn(|j| (p[k][j] + p[(k + 1) % 3][j]) * 0.5);
                    tree.f(m).abs() > limit
                });
            if !bad {
                continue;
            }
            // Refine a failing triangle on all sides. Splitting only its bad
            // edge can keep reconnecting a distant opposite vertex, producing
            // new long diagonals instead of shrinking the inaccurate patch.
            for k in 0..3 {
                split.insert(edge(t[k], t[(k + 1) % 3]), None);
                // Each split edge adds at most two triangles across its
                // two incident faces; stop before allocating new points.
                if tris.len().saturating_add(split.len() * 6) > index_budget {
                    break 'rounds;
                }
            }
        }
        if split.is_empty() {
            return (tris, 0);
        }
        for (&(a, b), id) in &mut split {
            let pa = pos(points, a);
            let pb = pos(points, b);
            let mid = std::array::from_fn(|k| (pa[k] + pb[k]) * 0.5);
            let length = (pa[0] - pb[0]).hypot(pa[1] - pb[1]).hypot(pa[2] - pb[2]);
            let mut split_parameters = Vec::new();
            let p = if points.edge_is_protected(a, b) {
                // The creator chose this exact arc, including orientation and
                // periodic wrap. Never guess a neighboring curve from proximity.
                let intervals = points.curve_intervals(a, b);
                let mut chosen: Option<[f64; 3]> = None;
                let compatible = !intervals.is_empty()
                    && intervals.iter().all(|interval| {
                        let Some(curve) = features.curves.get(interval.curve_id) else {
                            return false;
                        };
                        let Some((t, p)) = curve.project_interval(mid, interval.start, interval.end) else {
                            return false;
                        };
                        if t == interval.start || t == interval.end {
                            return false;
                        }
                        split_parameters.push(t);
                        if tree.f(p).abs() > tolerance * 0.1
                            || (0..3).map(|k| (p[k] - mid[k]).powi(2)).sum::<f64>().sqrt() > length
                            || !curve
                                .adjacent_strata
                                .iter()
                                .all(|&id| features.strata[id].domain_contains(p, tolerance * 0.1))
                        {
                            return false;
                        }
                        if let Some(q) = chosen {
                            if (0..3).map(|k| (p[k] - q[k]).powi(2)).sum::<f64>().sqrt() > tolerance * 0.01 {
                                return false;
                            }
                        } else {
                            chosen = Some(p);
                        }
                        true
                    });
                if compatible {
                    chosen
                } else {
                    None
                }
            } else {
                project(tree, mid, length, tolerance * 0.01)
            };
            if let Some(p) = p {
                let (_, n) = tree.grad(p);
                let i = points.add(p[0], p[1], p[2], n[0], n[1], n[2]);
                *id = Some(i);
                points.split_curve_edge_at(a, b, i, &split_parameters);
            }
        }
        let mut next = Vec::with_capacity(tris.len() * 2);
        let mut changed = false;
        for t in tris.chunks_exact(3) {
            let m: [Option<usize>; 3] =
                std::array::from_fn(|k| split.get(&edge(t[k], t[(k + 1) % 3])).copied().flatten());
            let start = next.len();
            let owner = points.patch([t[0], t[1], t[2]]);
            match m.iter().filter(|m| m.is_some()).count() {
                0 => next.extend_from_slice(t),
                1 => {
                    let k = m.iter().position(Option::is_some).unwrap();
                    let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                    let ab = m[k].unwrap();
                    next.extend_from_slice(&[a, ab, c, ab, b, c]);
                    changed = true;
                }
                2 => {
                    let k = m.iter().position(Option::is_none).unwrap();
                    let (a, b, c) = (t[(k + 1) % 3], t[(k + 2) % 3], t[k]);
                    let ab = m[(k + 1) % 3].unwrap();
                    let bc = m[(k + 2) % 3].unwrap();
                    next.extend_from_slice(&[b, bc, ab]);
                    // A fixed diagonal can repeatedly recreate a long edge
                    // after neighboring splits. Choose the shorter diagonal
                    // of the remaining quadrilateral to make local progress.
                    let length2 = |x, y| {
                        let px = pos(points, x);
                        let py = pos(points, y);
                        (0..3).map(|k| (px[k] - py[k]).powi(2)).sum::<f64>()
                    };
                    if length2(a, bc) < length2(ab, c) {
                        next.extend_from_slice(&[a, ab, bc, a, bc, c]);
                    } else {
                        next.extend_from_slice(&[a, ab, c, ab, bc, c]);
                    }
                    changed = true;
                }
                _ => {
                    let (a, b, c) = (t[0], t[1], t[2]);
                    let (ab, bc, ca) = (m[0].unwrap(), m[1].unwrap(), m[2].unwrap());
                    next.extend_from_slice(&[a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca]);
                    changed = true;
                }
            }
            if let Some(owner) = owner {
                for child in next[start..].chunks_exact(3) {
                    points.set_patch([child[0], child[1], child[2]], owner);
                }
            }
        }
        tris = next;
        if !changed {
            break;
        }
    }
    let mut unresolved = 0;
    for t in tris.chunks_exact(3) {
        let p = [pos(points, t[0]), pos(points, t[1]), pos(points, t[2])];
        let mut bad = false;
        for w in [[1. / 3.; 3], [0.5, 0.5, 0.], [0., 0.5, 0.5], [0.5, 0., 0.5]] {
            let q = std::array::from_fn(|k| (0..3).map(|i| p[i][k] * w[i]).sum());
            bad |= tree.f(q).abs() > tolerance;
        }
        if bad {
            unresolved += 1;
        }
    }
    (tris, unresolved)
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    use crate::{
        primitives::smin::SminMode,
        sdf::{leaf_at, BlendKind, Shape},
        sfcc::{
            feature_curves::make_circle_curve, feature_set::compile_native_features,
            point_table::CurveInterval, spatial_index::SfccSpatialIndex,
        },
    };
    #[test]
    fn refinement_stays_on_the_identified_curve_when_a_nearer_curve_also_fits() {
        let leaf = leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        let tree = CsgNode::Blend {
            kind: BlendKind::Smin,
            mode: SminMode::Round,
            r: 0.,
            n: 4.,
            children: vec![leaf.clone(), leaf.clone()],
        };
        let mut features = compile_native_features(&leaf);
        features.curves = vec![
            make_circle_curve(0, -1, [0, 0], 0., 0., 0., 0., 0., 1., 0.999, None),
            make_circle_curve(1, -1, [0, 0], 0., 0., 0., 0., 0., 1., 1., None),
        ];
        features.index = SfccSpatialIndex::new(0.1);
        for c in &features.curves {
            features.index.insert_curve_polyline(c.id, &c.index_polyline);
        }
        let mut points = PointTable::new();
        let curve = &features.curves[1];
        let a = curve.point_at(0.);
        let b = curve.point_at(std::f64::consts::FRAC_PI_2);
        let a = points.add(a[0], a[1], a[2], a[0], a[1], a[2]);
        let b = points.add(b[0], b[1], b[2], b[0], b[1], b[2]);
        let c = points.add(0., 0., 1., 0., 0., 1.);
        points.protect_curve_edge(
            a,
            b,
            CurveInterval { curve_id: 1, start: 0., end: std::f64::consts::FRAC_PI_2 },
        );
        let (tris, _) = refine_surface(&tree, &features, &mut points, &[a, b, c], 0.02);
        assert!(tris.len() > 3);
        let edges: Vec<_> = points.identified_edges().collect();
        assert!(edges.len() > 1);
        for ((a, b), intervals) in edges {
            assert!(intervals.iter().all(|i| i.curve_id == 1));
            for id in [a, b] {
                assert!((points.x(id).hypot(points.y(id)) - 1.).abs() < 1e-12);
            }
        }
    }
}
