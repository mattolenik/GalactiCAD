//! Conforming refinement of triangle interiors after partition assembly. The
//! octree depth ceiling is a sampling budget, not a triangle-fidelity guarantee.
use super::{feature_set::SfccFeatureSet, point_table::PointTable};
use super::{mesh_edit::{intersects_both, GrowingIndex, TriangleIndex}, triangle_quality as q};
use crate::sdf::CsgNode;
use std::collections::{BTreeMap, BTreeSet};

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
    surface_tolerance: f64,
    feature_tolerance: f64,
) -> (Vec<usize>, usize) {
    // Surface approximation and curve membership are distinct obligations.
    // Preserve a historically tighter chord setting without letting a looser
    // feature budget substitute for the requested surface budget. This pass
    // remains a sampled field check, not a geometric-distance certificate.
    let tolerance = surface_tolerance.min(feature_tolerance);
    // Establish exactly the previous feature-budget construction first. A
    // tighter surface request must not retriangulate an existing intersection
    // into new offending faces merely because their indices are different.
    let (coarse, unresolved) = refine_legacy(tree, features, points, tris, feature_tolerance);
    if tolerance >= feature_tolerance || !tree.has_blend() {
        return (coarse, unresolved);
    }
    let index_budget = tris.len().saturating_add(3 * (tris.len() / 3).clamp(10_000, 500_000));
    refine_guarded(tree, features, points, &coarse, tolerance, feature_tolerance, index_budget)
}

fn refine_legacy(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    tris: &[usize],
    feature_tolerance: f64,
) -> (Vec<usize>, usize) {
    let tolerance = feature_tolerance;
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
                        if tree.f(p).abs() > feature_tolerance * 0.1
                            || (0..3).map(|k| (p[k] - mid[k]).powi(2)).sum::<f64>().sqrt() > length
                            || !curve
                                .adjacent_strata
                                .iter()
                                .all(|&id| features.strata[id].domain_contains(p, feature_tolerance * 0.1))
                        {
                            return false;
                        }
                        if let Some(q) = chosen {
                            if (0..3).map(|k| (p[k] - q[k]).powi(2)).sum::<f64>().sqrt() > feature_tolerance * 0.01 {
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

fn sampled_failure(tree: &CsgNode, p: [q::P3; 3], tolerance: f64) -> bool {
    [[1. / 3.; 3], [0.5, 0.5, 0.], [0., 0.5, 0.5], [0.5, 0., 0.5]]
        .into_iter()
        .any(|w| tree.f(q::bary(p, w)).abs() > tolerance)
}

fn split_position(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    a: usize,
    b: usize,
    tolerance: f64,
    feature_tolerance: f64,
) -> Option<(q::P3, Vec<f64>)> {
    let pa = pos(points, a);
    let pb = pos(points, b);
    let mid = std::array::from_fn(|k| (pa[k] + pb[k]) * 0.5);
    let length = q::norm(q::sub(pa, pb));
    if !points.edge_is_protected(a, b) {
        return project(tree, mid, length, tolerance * 0.01).map(|p| (p, Vec::new()));
    }
    let intervals = points.curve_intervals(a, b);
    if intervals.is_empty() { return None; }
    let mut chosen: Option<q::P3> = None;
    let mut parameters = Vec::with_capacity(intervals.len());
    for interval in intervals {
        let curve = features.curves.get(interval.curve_id)?;
        let (t, p) = curve.project_interval(mid, interval.start, interval.end)?;
        if t == interval.start || t == interval.end
            || !p.iter().all(|v| v.is_finite())
            || tree.f(p).abs() > feature_tolerance * 0.1
            || q::norm(q::sub(p, mid)) > length
            || !curve.adjacent_strata.iter().all(|&id| features.strata[id].domain_contains(p, feature_tolerance * 0.1))
            || chosen.is_some_and(|old| q::norm(q::sub(old, p)) > feature_tolerance * 0.01)
        { return None; }
        if chosen.is_none() { chosen = Some(p); }
        parameters.push(t);
    }
    chosen.map(|p| (p, parameters))
}

/// Check against the mesh that would survive this atomic edge-star replacement.
/// Existing nonincident intersections are not authorized for new child faces.
fn embedded_star(
    proposal: &[([usize; 3], [q::P3; 3])],
    tris: &[usize],
    geometry: &[[q::P3; 3]],
    index: &TriangleIndex,
    removed: &BTreeSet<usize>,
    affected: &[usize],
    added: &GrowingIndex,
) -> bool {
    for (i, &(ids, p)) in proposal.iter().enumerate() {
        if added.conflicts(ids, p) { return false; }
        for &(other, geometry) in &proposal[..i] {
            if intersects_both(p, geometry, ids, other) { return false; }
        }
        for j in index.query(p) {
            if removed.contains(&j) || affected.contains(&j) { continue; }
            let other = [tris[3 * j], tris[3 * j + 1], tris[3 * j + 2]];
            let g = geometry[j];
            // Intersection predicates require genuine 2D faces. A nearby
            // malformed old face is unsupported, not permission to ignore it.
            if !q::valid_orientation(g, q::normal(g)) || intersects_both(p, g, ids, other) {
                return false;
            }
        }
    }
    true
}

fn refine_guarded(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    input: &[usize],
    tolerance: f64,
    feature_tolerance: f64,
    index_budget: usize,
) -> (Vec<usize>, usize) {
    let mut tris = input.to_vec();
    for _ in 0..8 {
        if super::cancel::is_cancelled() { break; }
        let geometry: Vec<_> = tris.chunks_exact(3).map(|t| [t[0], t[1], t[2]].map(|i| pos(points, i))).collect();
        let index = TriangleIndex::new(&geometry);
        let mut adjacency = BTreeMap::<_, Vec<usize>>::new();
        let mut queue = BTreeSet::new();
        for (i, t) in tris.chunks_exact(3).enumerate() {
            let bad = sampled_failure(tree, geometry[i], tolerance * 0.75);
            for k in 0..3 {
                let e = edge(t[k], t[(k + 1) % 3]);
                adjacency.entry(e).or_default().push(i);
                if bad { queue.insert(e); }
            }
        }
        if queue.is_empty() { return (tris, 0); }
        // An atomic split consumes its incident faces for this sweep. Prefer
        // the edge carrying the actual deviation; repeatedly bisecting an
        // already-exact axial edge would leave a cylindrical chord unchanged.
        let mut queue: Vec<_> = queue.into_iter().map(|(a, b)| {
            let pa = pos(points, a); let pb = pos(points, b);
            let mid = std::array::from_fn(|k| (pa[k] + pb[k]) * 0.5);
            ((a, b), tree.f(mid).abs(), q::norm(q::sub(pa, pb)))
        }).collect();
        queue.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| b.2.total_cmp(&a.2)).then(a.0.cmp(&b.0)));
        let mut removed = BTreeSet::new();
        let mut added = Vec::<([usize; 3], Option<usize>)>::new();
        let mut added_index = GrowingIndex::new();
        let mut output_indices = tris.len();
        for ((a, b), _, _) in queue {
            if super::cancel::is_cancelled() { break; }
            let affected = &adjacency[&edge(a, b)];
            if affected.is_empty() || affected.len() > 2
                || affected.iter().any(|i| removed.contains(i))
            { continue; }
            if output_indices.saturating_add(affected.len() * 3) > index_budget { break; }
            let Some((candidate, parameters)) = split_position(tree, features, points, a, b, tolerance, feature_tolerance) else { continue; };
            if !candidate.iter().all(|v| v.is_finite()) { continue; }
            let new_id = points.count();
            let mut proposal = Vec::with_capacity(affected.len() * 2);
            let mut owners = Vec::with_capacity(affected.len() * 2);
            let mut valid = true;
            for &j in affected {
                let t = [tris[3 * j], tris[3 * j + 1], tris[3 * j + 2]];
                let reference = q::normal(geometry[j]);
                if !q::valid_orientation(geometry[j], reference) { valid = false; break; }
                let Some(k) = (0..3).find(|&k| edge(t[k], t[(k + 1) % 3]) == edge(a, b)) else { valid = false; break; };
                let [u, v, w] = [t[k], t[(k + 1) % 3], t[(k + 2) % 3]];
                for ids in [[u, new_id, w], [new_id, v, w]] {
                    let p = ids.map(|id| if id == new_id { candidate } else { pos(points, id) });
                    if !q::valid_orientation(p, reference) { valid = false; break; }
                    proposal.push((ids, p));
                    owners.push(points.patch(t));
                }
                if !valid { break; }
            }
            if !valid || !embedded_star(&proposal, &tris, &geometry, &index, &removed, affected, &added_index) { continue; }
            let (_, normal) = tree.grad(candidate);
            if !normal.iter().all(|v| v.is_finite()) { continue; }
            // Geometry and all incident faces have been checked in f64/f32.
            // Only now allocate the shared point and retire parent intervals.
            points.add(candidate[0], candidate[1], candidate[2], normal[0], normal[1], normal[2]);
            points.split_curve_edge_at(a, b, new_id, &parameters);
            for ((ids, _), owner) in proposal.iter().zip(owners) {
                added.push((*ids, owner));
            }
            added_index.extend(proposal);
            removed.extend(affected.iter().copied());
            output_indices += affected.len() * 3;
        }
        if removed.is_empty() { break; }
        let mut next = Vec::with_capacity(output_indices);
        for (i, t) in tris.chunks_exact(3).enumerate() {
            if !removed.contains(&i) { next.extend_from_slice(t); }
        }
        for (ids, owner) in added {
            if let Some(owner) = owner { points.set_patch(ids, owner); }
            next.extend(ids);
        }
        tris = next;
    }
    let unresolved = tris.chunks_exact(3)
        .filter(|t| sampled_failure(tree, [t[0], t[1], t[2]].map(|id| pos(points, id)), tolerance))
        .count();
    (tris, unresolved)
}

#[cfg(test)]
mod embedded_refinement_tests {
    use super::*;

    fn check_rejection(vertices: [q::P3; 6], ids: [[usize; 3]; 2], working: bool) {
        let [retained, proposed] = ids.map(|t| t.map(|i| vertices[i]));
        assert_eq!(super::super::mesh_edit::intersects(retained, proposed, ids[0], ids[1]), working);
        assert!(super::super::mesh_edit::intersects(
            retained.map(q::rounded), proposed.map(q::rounded), ids[0], ids[1],
        ));
        let index = TriangleIndex::new(&[retained]);
        assert!(!embedded_star(&[(ids[1], proposed)], &ids[0], &[retained], &index,
            &BTreeSet::new(), &[], &GrowingIndex::new()));
        let mut earlier = GrowingIndex::new();
        earlier.extend([(ids[0], retained)]);
        assert!(!embedded_star(&[(ids[1], proposed)], &[], &[], &TriangleIndex::new(&[]),
            &BTreeSet::new(), &[], &earlier));
    }

    #[test]
    fn projected_housing_children_cannot_cross_a_retained_feature_patch() {
        // Matching native-working faces behind new WASM pair 42643/42660.
        check_rejection([
            [-5.223132512314515, -7.399999618530273, 12.557654640987074],
            [-5.231284871328391, -7.399999618530273, 12.56235817871026],
            [-5.252085290113976, -7.385986411888905, 12.596956232001412],
            [-5.2504386482035015, -7.387378173093391, 12.573926589093038],
            [-5.227886908021553, -7.399999618530272, 12.580302556992958],
            [-5.2247050839451035, -7.393144465126942, 12.552962404452972],
        ], [[2, 0, 1], [3, 5, 4]], true);
    }

    #[test]
    fn a_working_disjoint_housing_pair_must_also_pass_final_f32_embedding() {
        // Native pair 42657/42706 is disjoint before conversion and intersects
        // after rounding. Preserve the actual represented numbers, not epsilons.
        check_rejection([
            [-5.235487586707822, -7.399999618530273, 12.570812642342505],
            [-5.235487586707822, -7.399999618530273, 12.575241854246825],
            [-5.252085290113976, -7.385986411888905, 12.596956232001412],
            [-5.199316403767342, -7.399999618530273, 12.60809077526727],
            [-5.2504386482035015, -7.387378173093391, 12.573926589093038],
            [-5.227886908021553, -7.399999618530272, 12.580302556992958],
        ], [[2, 4, 5], [0, 3, 1]], false);
    }
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
        let (tris, _) = refine_surface(&tree, &features, &mut points, &[a, b, c], 0.01, 0.02);
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

#[cfg(test)]
mod residual_distance_tests {
    use super::*;
    use crate::primitives::smin::SminMode;
    use crate::sdf::{leaf_at, BlendKind, Shape};

    #[test]
    fn round_blend_residual_does_not_bound_geometric_chord_error() {
        let half = 16.;
        let k = 0.1 * std::f64::consts::FRAC_1_SQRT_2;
        let c = (1. - k * k).sqrt();
        let offset = half + 1. - std::f64::consts::FRAC_1_SQRT_2;
        let make_box = |nx: f64| {
            let CsgNode::Leaf(mut leaf) = leaf_at(Shape::Cuboid { half: [half; 3] }, [-offset, 0., 0.]) else {
                unreachable!()
            };
            leaf.sim.r = [nx, 0., -k, 0., 1., 0., k, 0., nx];
            CsgNode::Leaf(leaf)
        };
        let tree = CsgNode::Blend {
            kind: BlendKind::Smin,
            mode: SminMode::Round,
            r: 1.,
            n: 4.,
            children: vec![make_box(c), make_box(-c)],
        };
        // Use the stored offset, not an idealized exactly orthogonal transform.
        let a0 = offset - half;
        let center_z = (1. - a0) / k;
        let radius_z = std::f64::consts::FRAC_1_SQRT_2 / k;
        let radius_x = std::f64::consts::FRAC_1_SQRT_2 / c;
        let lower_z = center_z - radius_z;
        let delta = 0.013;
        let query = [0., 0., lower_z + delta];
        let d = 0.011;

        // Throughout this cube, both finite boxes use only their positive x
        // face distances, strictly inside the active radius-one Round branch.
        assert!(a0 - c * d + k * (query[2] - d) > 0.);
        assert!(a0 + c * d + k * (query[2] + d) < 1.);
        assert!(k * d + c * (query[2].abs() + d) < half);
        assert!(d < half);

        // Squaring the active Round norm cancels the opposing x terms:
        // 2*((1-a0-k*z)^2+c^2*x^2). Its maximum on this cube is strictly <1,
        // so F>0 throughout the cube and the contained radius-.011 ball.
        // This calibration uses ordinary f64 arithmetic with a 1e-4 margin;
        // it is not an outward-rounded runtime enclosure certificate.
        let norm_squared_upper = 2. * ((1. - a0 - k * (query[2] - d)).powi(2) + c * c * d * d);
        assert!(norm_squared_upper < 1. - 1e-4);
        assert!(d > 0.01);
        assert!(tree.f(query).abs() < 0.002);

        let x = radius_x * (1. - ((query[2] - center_z) / radius_z).powi(2)).sqrt();
        for vx in [-x, x] {
            for vy in [-0.02, 0.02] {
                assert!(tree.f([vx, vy, query[2]]).abs() < 1e-12);
            }
        }
        // No assertion about whether the refiner accepts this chord: improving
        // refinement must not invalidate this field-versus-distance control.
    }
}
