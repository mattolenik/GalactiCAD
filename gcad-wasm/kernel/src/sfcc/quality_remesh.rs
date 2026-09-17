//! Globally assembled, constrained quality edits. Unknown ownership and all
//! feature vertices stay locked. Candidates are validated before any mutation.
use super::{
    feature_set::SfccFeatureSet,
    mesh_edit::{intersects, TriangleIndex},
    point_table::PointTable,
    triangle_quality::{self as q, Rejection, P3},
};
use crate::{sdf::SdfQuery, strata::Stratum};
use std::collections::{BTreeMap, BTreeSet};
fn edge(a: usize, b: usize) -> (usize, usize) {
    (a.min(b), a.max(b))
}
pub(crate) fn validate<T: SdfQuery + ?Sized>(
    tree: &T,
    carrier: &Stratum,
    p: [P3; 3],
    reference: P3,
    tol: f64,
) -> Result<(), Rejection> {
    if !q::valid_orientation(p, reference) {
        return Err(Rejection::Orientation);
    }
    for p in [p, p.map(q::rounded)] {
        for w in q::SAMPLES {
            let x = q::bary(p, w);
            let y = carrier.project(x[0], x[1], x[2]);
            if !y.iter().all(|v| v.is_finite()) || q::norm(q::sub(x, y)) > tol {
                return Err(Rejection::Displacement);
            }
            if !carrier.domain_contains(y, tol * 0.001) {
                return Err(Rejection::Ownership);
            }
            let s = tree.field_sample(y);
            let len = q::norm(s.gradient);
            if !len.is_finite()
                || len == 0.
                || !s.value.is_finite()
                || s.value.abs() / len > tol * 0.01
                || (!w.contains(&0.) && q::dot(s.gradient, reference) <= 0.)
            {
                return Err(Rejection::Ownership);
            }
        }
    }
    Ok(())
}
fn geometry(points: &PointTable, tris: &[[usize; 3]]) -> Vec<[P3; 3]> {
    tris.iter().map(|t| t.map(|i| q::pos(points, i))).collect()
}
fn edges(tris: &[[usize; 3]]) -> BTreeMap<(usize, usize), Vec<usize>> {
    let mut out = BTreeMap::<_, Vec<_>>::new();
    for (i, t) in tris.iter().enumerate() {
        for k in 0..3 {
            out.entry(edge(t[k], t[(k + 1) % 3])).or_default().push(i);
        }
    }
    out
}
fn embeds(
    candidate: &[([usize; 3], [P3; 3])],
    removed: impl Fn(usize) -> bool,
    tris: &[[usize; 3]],
    positions: &[[P3; 3]],
    index: &TriangleIndex,
) -> bool {
    for (ci, &(ids, p)) in candidate.iter().enumerate() {
        for &(other, q) in &candidate[..ci] {
            if intersects(p, q, ids, other)
                || intersects(p.map(q::rounded), q.map(q::rounded), ids, other)
            {
                return false;
            }
        }
        // Query both representations: f32 rounding can introduce contacts that
        // were absent from the f64 broad phase. Rounded neighbors use a separate
        // conservative expanded query below by including their rounded bounds.
        for i in index.query(p) {
            if !removed(i)
                && (intersects(p, positions[i], ids, tris[i])
                    || intersects(
                        p.map(q::rounded),
                        positions[i].map(q::rounded),
                        ids,
                        tris[i],
                    ))
            {
                return false;
            }
        }
    }
    true
}
#[derive(Default, Debug)]
pub(crate) struct EditReport {
    pub flips: usize,
    pub collapses: usize,
    pub relocations: usize,
    pub rejected: usize,
    pub cancelled: bool,
    pub work_budget_exhausted: bool,
}

pub(crate) fn flips<T: SdfQuery + ?Sized>(
    tree: &T,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    input: &[usize],
    tol: f64,
    sweeps: usize,
) -> (Vec<usize>, EditReport) {
    let ordered = points.ordered_triangles(input);
    let mut tris: Vec<[usize; 3]> = ordered
        .chunks_exact(3)
        .map(|t| [t[0], t[1], t[2]])
        .collect();
    let mut report = EditReport::default();
    let mut positions = geometry(points, &tris);
    let mut index = TriangleIndex::new(&positions);
    for _ in 0..sweeps {
        let adjacency = edges(&tris);
        let mut touched = BTreeSet::new();
        let mut new_edges = BTreeSet::new();
        let mut changed = false;
        // Triangle order is canonicalized by geometric/provenance ordering.
        for i in 0..tris.len() {
            if i % 128 == 0 && super::cancel::is_cancelled() {
                report.cancelled = true;
                return (tris.into_iter().flatten().collect(), report);
            }
            if touched.contains(&i) || q::quality(positions[i]) >= 0.2 {
                continue;
            }
            let Some(owner) = points.patch(tris[i]) else {
                continue;
            };
            let Some(carrier) = features.strata.get(owner) else {
                continue;
            };
            if !super::surface_patch::supports_local_edits(carrier) {
                continue;
            }
            let t = tris[i];
            for k in 0..3 {
                let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                if points.edge_is_protected(a, b) {
                    continue;
                }
                let pair = &adjacency[&edge(a, b)];
                if pair.len() != 2 {
                    continue;
                }
                let j = if pair[0] == i { pair[1] } else { pair[0] };
                if touched.contains(&j) || points.patch(tris[j]) != Some(owner) {
                    continue;
                }
                let Some(l) = (0..3).find(|&l| tris[j][l] == b && tris[j][(l + 1) % 3] == a) else {
                    continue;
                };
                let d = tris[j][(l + 2) % 3];
                if c == d || adjacency.contains_key(&edge(c, d)) || new_edges.contains(&edge(c, d))
                {
                    continue;
                }
                let ids = [[c, a, d], [d, b, c]];
                let p = ids.map(|t| t.map(|i| q::pos(points, i)));
                let before = q::quality(positions[i]).min(q::quality(positions[j]));
                let after = q::quality(p[0]).min(q::quality(p[1]));
                if after <= before * 1.01 + 1e-12 {
                    continue;
                }
                let n = q::normal(positions[i]);
                let m = q::normal(positions[j]);
                if q::dot(n, m) <= 0.
                    || p.iter().any(|&p| {
                        validate(tree, carrier, p, n, tol).is_err() || !q::valid_orientation(p, m)
                    })
                {
                    report.rejected += 1;
                    continue;
                }
                if !embeds(
                    &[(ids[0], p[0]), (ids[1], p[1])],
                    |k| k == i || k == j,
                    &tris,
                    &positions,
                    &index,
                ) {
                    report.rejected += 1;
                    continue;
                }
                for (id, vertices, geo) in [(i, ids[0], p[0]), (j, ids[1], p[1])] {
                    tris[id] = vertices;
                    positions[id] = geo;
                    index.update(id, geo);
                    points.set_patch(vertices, owner);
                    touched.insert(id);
                }
                new_edges.insert(edge(c, d));
                report.flips += 1;
                changed = true;
                break;
            }
        }
        if !changed {
            break;
        }
    }
    (tris.into_iter().flatten().collect(), report)
}

fn locked_vertices(
    points: &PointTable,
    tris: &[[usize; 3]],
    features: &SfccFeatureSet,
    tol: f64,
) -> BTreeSet<usize> {
    let mut locked = BTreeSet::new();
    for (e, incident) in edges(tris) {
        if incident.len() != 2 || points.edge_is_protected(e.0, e.1) {
            locked.extend([e.0, e.1]);
        }
    }
    for t in tris {
        if points
            .patch(*t)
            .is_none_or(|id| !super::surface_patch::supports_local_edits(&features.strata[id]))
        {
            locked.extend(t);
        }
    }
    for i in 0..points.count() {
        if locked.contains(&i) {
            continue;
        }
        // String-keyed analytical pins remain fixed as well as feature arcs.
        let p = q::pos(points, i);
        let radius = tol * 0.01;
        if matches!(points.key_at(i), super::point_table::PointKey::Str(_))
            || features
                .index
                .corners_in_box(p.map(|v| v - radius), p.map(|v| v + radius))
                .into_iter()
                .any(|id| {
                    let c = &features.corners[id];
                    q::norm(q::sub(p, [c.x, c.y, c.z])) <= radius
                })
        {
            locked.insert(i);
        }
    }
    locked
}

pub(crate) fn remesh<T: SdfQuery + ?Sized>(
    tree: &T,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    input: &[usize],
    tol: f64,
    max_trials: usize,
) -> (Vec<usize>, EditReport) {
    let mut flat = points.ordered_triangles(input);
    let mut report = EditReport::default();
    let mut trials = 0;
    for _ in 0..3 {
        if trials >= max_trials {
            report.work_budget_exhausted = true;
            break;
        }
        if super::cancel::is_cancelled() {
            report.cancelled = true;
            break;
        }
        let tris: Vec<[usize; 3]> = flat.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
        let geo = geometry(points, &tris);
        let index = TriangleIndex::new(&geo);
        let adjacency = edges(&tris);
        let locked = locked_vertices(points, &tris, features, tol);
        let mut stars = BTreeMap::<usize, BTreeSet<usize>>::new();
        let mut neighbors = BTreeMap::<usize, BTreeSet<usize>>::new();
        for (i, t) in tris.iter().enumerate() {
            for &v in t {
                stars.entry(v).or_default().insert(i);
                for &u in t {
                    if u != v {
                        neighbors.entry(v).or_default().insert(u);
                    }
                }
            }
        }
        let mut removed = BTreeSet::new();
        let mut used = BTreeSet::new();
        let mut added = Vec::<([usize; 3], [P3; 3], usize)>::new();
        let mut added_index = super::mesh_edit::GrowingIndex::new();
        // Canonical triangle traversal determines endpoint order independent of
        // worker-local point numbering; equivalent geometric ties stay locked.
        let mut visited = BTreeSet::new();
        'collapse: for t in &tris {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                if !visited.insert(edge(a, b))
                    || locked.contains(&a)
                    || locked.contains(&b)
                    || used.contains(&a)
                    || used.contains(&b)
                {
                    continue;
                }
                let incident = &adjacency[&edge(a, b)];
                if incident.len() != 2 {
                    continue;
                }
                let Some(owner) = points.patch(tris[incident[0]]) else {
                    continue;
                };
                let star: BTreeSet<_> = stars[&a].union(&stars[&b]).copied().collect();
                if star.iter().any(|&i| {
                    points.patch(tris[i]) != Some(owner) || tris[i].iter().any(|v| used.contains(v))
                }) {
                    continue;
                }
                let common: BTreeSet<_> = neighbors[&a]
                    .intersection(&neighbors[&b])
                    .copied()
                    .collect();
                let opposite: BTreeSet<_> = incident
                    .iter()
                    .flat_map(|&i| tris[i])
                    .filter(|&v| v != a && v != b)
                    .collect();
                if common != opposite || common.len() != 2 {
                    continue;
                }
                let mut lengths: Vec<_> = neighbors[&a]
                    .iter()
                    .chain(neighbors[&b].iter())
                    .map(|&v| q::norm(q::sub(q::pos(points, v), q::pos(points, a))))
                    .filter(|&v| v > 0.)
                    .collect();
                lengths.sort_by(f64::total_cmp);
                if q::norm(q::sub(q::pos(points, a), q::pos(points, b)))
                    >= 0.6 * lengths[lengths.len() / 2]
                {
                    continue;
                }
                if trials >= max_trials {
                    report.work_budget_exhausted = true;
                    break 'collapse;
                }
                trials += 1;
                let affected = stars[&a].clone();
                let mut proposal = Vec::new();
                let mut valid = true;
                let before = affected
                    .iter()
                    .map(|&i| q::quality(geo[i]))
                    .fold(f64::INFINITY, f64::min);
                for &i in &affected {
                    if tris[i].contains(&b) {
                        continue;
                    }
                    let ids = tris[i].map(|v| if v == a { b } else { v });
                    let p = ids.map(|v| q::pos(points, v));
                    if validate(tree, &features.strata[owner], p, q::normal(geo[i]), tol).is_err()
                        || q::quality(p) < before * 0.99
                    {
                        valid = false;
                        break;
                    }
                    proposal.push((ids, p, owner));
                }
                let candidates: Vec<_> = proposal.iter().map(|&(t, p, _)| (t, p)).collect();
                if valid
                    && !embeds(
                        &candidates,
                        |i| removed.contains(&i) || affected.contains(&i),
                        &tris,
                        &geo,
                        &index,
                    )
                {
                    valid = false;
                }
                if valid {
                    for &(t, p, _) in &proposal {
                        if added_index.conflicts(t, p) {
                            valid = false;
                            break;
                        }
                    }
                }
                if !valid || proposal.is_empty() {
                    report.rejected += 1;
                    continue;
                }
                for &(t, _, _) in &proposal {
                    points.set_patch(t, owner);
                }
                for &i in &star {
                    used.extend(tris[i]);
                }
                removed.extend(affected);
                added_index.extend(proposal.iter().map(|&(t, p, _)| (t, p)));
                added.extend(proposal);
                report.collapses += 1;
            }
        }
        flat = tris
            .into_iter()
            .enumerate()
            .filter_map(|(i, t)| (!removed.contains(&i)).then_some(t))
            .chain(added.into_iter().map(|(t, _, _)| t))
            .flatten()
            .collect();
        let (flipped, r) = flips(tree, features, points, &flat, tol, 2);
        flat = flipped;
        report.flips += r.flips;
        report.rejected += r.rejected;
        // Tangential Laplacian proposal, projected to the owned carrier. A
        // complete star is validated transactionally, including f32 embedding.
        let tris: Vec<[usize; 3]> = flat.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
        let mut geo = geometry(points, &tris);
        let mut index = TriangleIndex::new(&geo);
        let locked = locked_vertices(points, &tris, features, tol);
        let mut stars = BTreeMap::<usize, BTreeSet<usize>>::new();
        for (i, t) in tris.iter().enumerate() {
            for &v in t {
                stars.entry(v).or_default().insert(i);
            }
        }
        let mut seen = BTreeSet::new();
        for t in &tris {
            for &v in t {
                if !seen.insert(v) || locked.contains(&v) {
                    continue;
                }
                if super::cancel::is_cancelled() {
                    report.cancelled = true;
                    return (flat, report);
                }
                let star = &stars[&v];
                let Some(owner) = points.patch(tris[*star.first().unwrap()]) else {
                    continue;
                };
                if star.iter().any(|&i| points.patch(tris[i]) != Some(owner)) {
                    continue;
                }
                let adjacent: BTreeSet<_> = star
                    .iter()
                    .flat_map(|&i| tris[i])
                    .filter(|&u| u != v)
                    .collect();
                let mut adjacent: Vec<_> = adjacent.into_iter().collect();
                adjacent.sort_by(|&a, &b| {
                    let pa = q::pos(points, a);
                    let pb = q::pos(points, b);
                    pa[0]
                        .total_cmp(&pb[0])
                        .then(pa[1].total_cmp(&pb[1]))
                        .then(pa[2].total_cmp(&pb[2]))
                        .then(points.key_at(a).cmp(points.key_at(b)))
                });
                let old = q::pos(points, v);
                let average: P3 = std::array::from_fn(|k| {
                    adjacent.iter().map(|&u| q::pos(points, u)[k]).sum::<f64>()
                        / adjacent.len() as f64
                });
                let carrier = &features.strata[owner];
                let n = carrier.normal(old[0], old[1], old[2]);
                let length = q::norm(n);
                if length == 0. || !length.is_finite() {
                    continue;
                }
                let n = n.map(|x| x / length);
                let d = q::sub(average, old);
                let mut tangent: P3 = std::array::from_fn(|k| d[k] - q::dot(d, n) * n[k]);
                let cap = 0.2
                    * adjacent
                        .iter()
                        .map(|&u| q::norm(q::sub(q::pos(points, u), old)))
                        .fold(f64::INFINITY, f64::min);
                let length = q::norm(tangent);
                if length <= cap * 1e-6 {
                    continue;
                }
                if length > cap {
                    tangent = tangent.map(|x| x * cap / length);
                }
                let p: P3 = std::array::from_fn(|k| old[k] + tangent[k]);
                let p = carrier.project(p[0], p[1], p[2]);
                if q::norm(q::sub(p, old)) > cap * 1.1 {
                    continue;
                }
                let candidates: Vec<_> = star
                    .iter()
                    .map(|&i| {
                        (
                            tris[i],
                            tris[i].map(|u| if u == v { p } else { q::pos(points, u) }),
                        )
                    })
                    .collect();
                let before = star
                    .iter()
                    .map(|&i| q::quality(geo[i]))
                    .fold(f64::INFINITY, f64::min);
                let after = candidates
                    .iter()
                    .map(|&(_, p)| q::quality(p))
                    .fold(f64::INFINITY, f64::min);
                if after <= before * 1.001 {
                    continue;
                }
                if trials >= max_trials {
                    report.work_budget_exhausted = true;
                    return (flat, report);
                }
                trials += 1;
                if star.iter().zip(&candidates).any(|(&i, &(_, p))| {
                    validate(tree, carrier, p, q::normal(geo[i]), tol).is_err()
                }) || !embeds(&candidates, |i| star.contains(&i), &tris, &geo, &index)
                {
                    report.rejected += 1;
                    continue;
                }
                let (_, n) = tree.grad(p);
                points.relocate(v, p, n);
                for (&i, &(_, p)) in star.iter().zip(&candidates) {
                    geo[i] = p;
                    index.update(i, p);
                }
                report.relocations += 1;
            }
        }
    }
    (flat, report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        sdf::{leaf_at, Shape},
        sfcc::feature_set::compile_native_features,
    };
    fn fixture() -> (CsgNodeFixture, PointTable, Vec<usize>) {
        let tree = leaf_at(
            Shape::Cuboid {
                half: [10., 10., 1.],
            },
            [0.; 3],
        );
        let features = compile_native_features(&tree);
        let owner = features
            .strata
            .iter()
            .position(|s| s.f(0., 0., 1.).abs() < 1e-12 && s.normal(0., 0., 1.)[2] > 0.9)
            .unwrap();
        let mut p = PointTable::new();
        let a = p.add(-1., 0., 1., 0., 0., 1.);
        let b = p.add(1., 0., 1., 0., 0., 1.);
        let c = p.add(0., 0.001, 1., 0., 0., 1.);
        let d = p.add(0., -1., 1., 0., 0., 1.);
        p.set_patch([a, b, c], owner);
        p.set_patch([b, a, d], owner);
        (CsgNodeFixture { tree, features }, p, vec![a, b, c, b, a, d])
    }
    struct CsgNodeFixture {
        tree: crate::sdf::CsgNode,
        features: SfccFeatureSet,
    }
    #[test]
    fn improves_sliver_without_changing_boundary() {
        let (f, mut p, tris) = fixture();
        let before = q::measure(&p, &tris);
        let (out, r) = flips(&f.tree, &f.features, &mut p, &tris, 0.001, 4);
        assert_eq!(r.flips, 1);
        assert_eq!(p.count(), 4);
        assert_eq!(q::measure(&p, &out).slivers, 0);
        assert_eq!(before.slivers, 1);
        let boundary = |t: &[usize]| {
            let t: Vec<_> = t.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
            edges(&t)
                .into_iter()
                .filter(|(_, v)| v.len() == 1)
                .map(|(e, _)| e)
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(boundary(&tris), boundary(&out));
    }
    #[test]
    fn zero_remeshing_budget_is_explicit_and_does_not_move_points() {
        let (f, mut p, tris) = fixture();
        let before: Vec<_> = (0..p.count()).map(|i| q::pos(&p, i)).collect();
        let (out, r) = remesh(&f.tree, &f.features, &mut p, &tris, 0.001, 0);
        assert!(r.work_budget_exhausted);
        assert_eq!(out.len(), tris.len());
        assert_eq!(r.collapses + r.flips + r.relocations, 0);
        assert_eq!(
            before,
            (0..p.count()).map(|i| q::pos(&p, i)).collect::<Vec<_>>()
        );
    }
    #[test]
    fn protected_or_unknown_patch_never_flips() {
        let (f, mut p, tris) = fixture();
        p.protect_edge(0, 1);
        assert_eq!(
            flips(&f.tree, &f.features, &mut p, &tris, 0.001, 4).1.flips,
            0
        );
        let (f, mut p, tris) = fixture();
        p.set_patch([1, 0, 3], usize::MAX);
        assert_eq!(
            flips(&f.tree, &f.features, &mut p, &tris, 0.001, 4).1.flips,
            0
        );
    }
    #[test]
    fn shape_improvement_cannot_trade_away_cylindrical_fidelity() {
        let tree = leaf_at(Shape::Cylinder { r: 1., h: 20. }, [0.; 3]);
        let features = compile_native_features(&tree);
        let owner = features
            .strata
            .iter()
            .position(|s| s.kind == crate::strata::CarrierKind::Cylinder)
            .unwrap();
        let mut p = PointTable::new();
        let angle = 0.1_f64;
        for x in [
            [1., -10., 0.],
            [1., 10., 0.],
            [angle.cos(), 0., angle.sin()],
            [angle.cos(), 0., -angle.sin()],
        ] {
            p.add(x[0], x[1], x[2], x[0], 0., x[2]);
        }
        let tris = [0, 1, 2, 1, 0, 3];
        for t in tris.chunks_exact(3) {
            p.set_patch([t[0], t[1], t[2]], owner);
        }
        let old = [[0, 1, 2], [1, 0, 3]].map(|t| t.map(|i| q::pos(&p, i)));
        let new = [[2, 0, 3], [3, 1, 2]].map(|t| t.map(|i| q::pos(&p, i)));
        assert!(
            new.map(q::quality)
                .into_iter()
                .fold(f64::INFINITY, f64::min)
                > 2. * old
                    .map(q::quality)
                    .into_iter()
                    .fold(f64::INFINITY, f64::min)
        );
        for t in old {
            assert!(q::deviation(&tree, t, 0.003).is_ok());
        }
        assert!(new.iter().any(|&t| q::deviation(&tree, t, 0.003).is_err()));
        let expected = p.ordered_triangles(&tris);
        let (out, r) = flips(&tree, &features, &mut p, &tris, 0.003, 4);
        assert_eq!(r.flips, 0);
        assert!(r.rejected > 0);
        assert_eq!(out, expected);
        assert_eq!(p.count(), 4);
    }
    #[test]
    fn new_diagonal_cannot_cross_an_unrelated_sheet() {
        let (f, mut p, mut tris) = fixture();
        // Vertical sheet in the replacement pair but outside the skinny input
        // triangle; its intersection must reject the shape improvement.
        let a = p.add(-0.2, -0.3, 0.9, 1., 0., 0.);
        let b = p.add(0.2, -0.3, 0.9, 1., 0., 0.);
        let c = p.add(0., -0.3, 1.1, 1., 0., 0.);
        tris.extend([a, b, c]);
        let n = p.count();
        let (_, r) = flips(&f.tree, &f.features, &mut p, &tris, 0.001, 4);
        assert_eq!(r.flips, 0);
        assert_eq!(p.count(), n);
    }
    #[test]
    fn planar_grid_relaxes_without_moving_boundary() {
        let tree = leaf_at(
            Shape::Cuboid {
                half: [10., 10., 1.],
            },
            [0.; 3],
        );
        let features = compile_native_features(&tree);
        let owner = features
            .strata
            .iter()
            .position(|s| s.f(0., 0., 1.).abs() < 1e-12 && s.normal(0., 0., 1.)[2] > 0.9)
            .unwrap();
        let mut p = PointTable::new();
        let mut tris = Vec::new();
        for y in 0..5 {
            for x in 0..5 {
                let dx = if x == 2 && y == 2 { 0.4 } else { 0. };
                p.add(x as f64 + dx, y as f64, 1., 0., 0., 1.);
            }
        }
        for y in 0..4 {
            for x in 0..4 {
                let a = y * 5 + x;
                for t in [[a, a + 1, a + 6], [a, a + 6, a + 5]] {
                    p.set_patch(t, owner);
                    tris.extend(t);
                }
            }
        }
        let boundary: Vec<_> = (0..25)
            .filter(|i| i % 5 == 0 || i % 5 == 4 || i / 5 == 0 || i / 5 == 4)
            .map(|i| (i, q::pos(&p, i)))
            .collect();
        let before = q::measure(&p, &tris);
        let (out, r) = remesh(&tree, &features, &mut p, &tris, 0.001, 10_000);
        assert!(r.relocations > 0 || r.collapses > 0 || r.flips > 0);
        assert!(q::measure(&p, &out).p5_angle > before.p5_angle);
        for (i, old) in boundary {
            assert_eq!(q::pos(&p, i), old);
        }
    }
}
