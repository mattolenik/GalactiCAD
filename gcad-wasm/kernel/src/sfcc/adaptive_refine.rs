//! Localized, conforming refinement. Interior error inserts one point; edge
//! error splits only the offending shared edge. Immutable analytical ownership
//! and recorded curve intervals are required before proposing a new point.
use super::{
    feature_set::SfccFeatureSet,
    mesh_edit::{intersects, TriangleIndex},
    point_table::PointTable,
    quality_remesh::validate,
    triangle_quality::{self as q, P3},
};
use crate::sdf::CsgNode;
use std::collections::{BTreeMap, BTreeSet};
fn edge(a: usize, b: usize) -> (usize, usize) {
    (a.min(b), a.max(b))
}
#[derive(Default, Debug)]
pub(crate) struct RefineReport {
    pub inserted: usize,
    pub edge_splits: usize,
    pub interior_splits: usize,
    pub rejected: usize,
    pub unresolved: usize,
    pub cancelled: bool,
}
fn error(carrier: &crate::strata::Stratum, p: [P3; 3], _tol: f64) -> (f64, Option<usize>) {
    let mut worst = 0.;
    let mut at = None;
    for (k, w) in q::SAMPLES.iter().enumerate() {
        let x = q::bary(p, *w);
        let y = carrier.project(x[0], x[1], x[2]);
        let d = if y.iter().all(|v| v.is_finite()) {
            q::norm(q::sub(y, x))
        } else {
            f64::INFINITY
        };
        if d > worst {
            worst = d;
            at = match k {
                1 | 4 | 5 => Some(0),
                2 | 6 | 7 => Some(1),
                3 | 8 | 9 => Some(2),
                _ => None,
            };
        }
    }
    (worst, at)
}
pub(crate) fn refine(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    input: &[usize],
    tol: f64,
    max_added: usize,
) -> (Vec<usize>, RefineReport) {
    let mut tris: Vec<[usize; 3]> = points
        .ordered_triangles(input)
        .chunks_exact(3)
        .map(|t| [t[0], t[1], t[2]])
        .collect();
    let mut report = RefineReport::default();
    for _ in 0..8 {
        if super::cancel::is_cancelled() {
            report.cancelled = true;
            break;
        }
        let geo: Vec<_> = tris.iter().map(|t| t.map(|i| q::pos(points, i))).collect();
        let index = TriangleIndex::new(&geo);
        let mut adjacency = BTreeMap::<_, Vec<_>>::new();
        for (i, t) in tris.iter().enumerate() {
            for k in 0..3 {
                adjacency
                    .entry(edge(t[k], t[(k + 1) % 3]))
                    .or_default()
                    .push(i);
            }
        }
        let mut queue: Vec<_> = geo
            .iter()
            .enumerate()
            .filter_map(|(i, &p)| {
                let owner = points.patch(tris[i])?;
                if !super::surface_patch::supports_local_edits(&features.strata[owner]) {
                    return None;
                }
                let (e, k) = error(&features.strata[owner], p, tol);
                if e > tol * 0.75 {
                    Some((e, i, k, false))
                } else if q::quality(p) < 0.02 {
                    let k = (0..3)
                        .max_by(|&a, &b| {
                            q::norm(q::sub(p[a], p[(a + 1) % 3]))
                                .total_cmp(&q::norm(q::sub(p[b], p[(b + 1) % 3])))
                        })
                        .unwrap();
                    Some((0., i, Some(k), true))
                } else {
                    None
                }
            })
            .collect();
        queue.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        let mut removed = BTreeSet::new();
        let mut added: Vec<([usize; 3], [P3; 3], usize)> = Vec::new();
        let mut added_index = super::mesh_edit::GrowingIndex::new();
        for (_, i, k, quality_only) in queue {
            if report.inserted >= max_added {
                break;
            }
            if super::cancel::is_cancelled() {
                report.cancelled = true;
                break;
            }
            if removed.contains(&i) {
                continue;
            }
            let t = tris[i];
            let Some(owner) = points.patch(t) else {
                report.rejected += 1;
                continue;
            };
            let carrier = &features.strata[owner];
            let mut memberships = Vec::new();
            let (seed, affected, split_edge) = if let Some(k) = k {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let affected = adjacency[&edge(a, b)].clone();
                if affected.len() != 2 || affected.iter().any(|id| removed.contains(id)) {
                    report.rejected += 1;
                    continue;
                }
                (
                    std::array::from_fn(|j| (q::pos(points, a)[j] + q::pos(points, b)[j]) * 0.5),
                    affected,
                    Some((a, b)),
                )
            } else {
                let seed = q::SAMPLES
                    .into_iter()
                    .filter(|w| !w.contains(&0.))
                    .map(|w| q::bary(geo[i], w))
                    .max_by(|a, b| {
                        let distance =
                            |p: P3| q::norm(q::sub(carrier.project(p[0], p[1], p[2]), p));
                        distance(*a).total_cmp(&distance(*b))
                    })
                    .unwrap();
                (seed, vec![i], None)
            };
            let radius = geo[i]
                .iter()
                .map(|&p| q::norm(q::sub(p, seed)))
                .fold(0., f64::max);
            let mut candidate = carrier.project(seed[0], seed[1], seed[2]);
            if let Some((a, b)) = split_edge {
                if points.edge_is_protected(a, b) {
                    let intervals = points.curve_intervals(a, b);
                    let mut valid = !intervals.is_empty();
                    let mut chosen = None;
                    for interval in intervals {
                        let Some(curve) = features.curves.get(interval.curve_id) else {
                            valid = false;
                            break;
                        };
                        let Some((param, p)) =
                            curve.project_interval(seed, interval.start, interval.end)
                        else {
                            valid = false;
                            break;
                        };
                        if param == interval.start
                            || param == interval.end
                            || chosen.is_some_and(|v| q::norm(q::sub(v, p)) > tol * 0.001)
                        {
                            valid = false;
                            break;
                        }
                        chosen = Some(p);
                        memberships.push(param);
                    }
                    if !valid {
                        report.rejected += 1;
                        continue;
                    }
                    candidate = chosen.unwrap();
                } else if affected
                    .iter()
                    .any(|&j| points.patch(tris[j]) != Some(owner))
                {
                    report.rejected += 1;
                    continue;
                }
            }
            if !candidate.iter().all(|x| x.is_finite())
                || q::norm(q::sub(candidate, seed)) > radius
                || geo[i]
                    .iter()
                    .any(|&p| q::norm(q::sub(candidate, p)) <= radius * 1e-9)
            {
                report.rejected += 1;
                continue;
            }
            let id = points.count();
            let mut proposal = Vec::new();
            let mut valid = true;
            let before_shape = affected
                .iter()
                .map(|&j| q::quality(geo[j]))
                .fold(f64::INFINITY, f64::min);
            for &j in &affected {
                let Some(owner) = points.patch(tris[j]) else {
                    valid = false;
                    break;
                };
                let tri = tris[j];
                let children = if let Some((a, b)) = split_edge {
                    let l = (0..3)
                        .find(|&l| edge(tri[l], tri[(l + 1) % 3]) == edge(a, b))
                        .unwrap();
                    let (a, b, c) = (tri[l], tri[(l + 1) % 3], tri[(l + 2) % 3]);
                    vec![[a, id, c], [id, b, c]]
                } else {
                    vec![
                        [tri[0], tri[1], id],
                        [tri[1], tri[2], id],
                        [tri[2], tri[0], id],
                    ]
                };
                for child in children {
                    let p = child.map(|v| {
                        if v == id {
                            candidate
                        } else {
                            q::pos(points, v)
                        }
                    });
                    // Refinement may need several rounds to reach tolerance;
                    // every accepted child must improve its parent's sampled
                    // geometric error, and remain on its own exposed carrier.
                    let parent_error = error(&features.strata[owner], geo[j], tol).0;
                    if !parent_error.is_finite()
                        || (quality_only && q::quality(p) <= before_shape * 1.001)
                        || validate(
                            tree,
                            &features.strata[owner],
                            p,
                            q::normal(geo[j]),
                            tol.max(parent_error * 1.000001),
                        )
                        .is_err()
                        || error(&features.strata[owner], p, tol).0
                            > parent_error.max(tol) * 1.000001
                    {
                        valid = false;
                        break;
                    }
                    proposal.push((child, p, owner));
                }
            }
            if valid {
                for (ci, &(ids, p, _)) in proposal.iter().enumerate() {
                    if added_index.conflicts(ids, p) {
                        valid = false;
                        break;
                    }
                    for &(other, g, _) in &proposal[..ci] {
                        if intersects(p, g, ids, other)
                            || intersects(p.map(q::rounded), g.map(q::rounded), ids, other)
                        {
                            valid = false;
                            break;
                        }
                    }
                    if !valid {
                        break;
                    }
                    for j in index.query(p) {
                        if !removed.contains(&j)
                            && !affected.contains(&j)
                            && (intersects(p, geo[j], ids, tris[j])
                                || intersects(
                                    p.map(q::rounded),
                                    geo[j].map(q::rounded),
                                    ids,
                                    tris[j],
                                ))
                        {
                            valid = false;
                            break;
                        }
                    }
                }
            }
            if !valid {
                report.rejected += 1;
                continue;
            }
            let (_, n) = tree.grad(candidate);
            points.add(candidate[0], candidate[1], candidate[2], n[0], n[1], n[2]);
            if let Some((a, b)) = split_edge {
                points.split_curve_edge_at(a, b, id, &memberships);
                report.edge_splits += 1;
            } else {
                report.interior_splits += 1;
            }
            for &(t, _, owner) in &proposal {
                points.set_patch(t, owner);
            }
            removed.extend(affected);
            added_index.extend(proposal.iter().map(|&(t, p, _)| (t, p)));
            added.extend(proposal);
            report.inserted += 1;
        }
        if added.is_empty() {
            break;
        }
        tris = tris
            .into_iter()
            .enumerate()
            .filter_map(|(i, t)| (!removed.contains(&i)).then_some(t))
            .chain(added.into_iter().map(|(t, _, _)| t))
            .collect();
    }
    report.unresolved = tris
        .iter()
        .filter(|t| {
            points.patch(**t).is_some_and(|owner| {
                error(&features.strata[owner], t.map(|i| q::pos(points, i)), tol).0 > tol
            })
        })
        .count();
    (tris.into_iter().flatten().collect(), report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        sdf::{leaf_at, Shape},
        sfcc::feature_set::compile_native_features,
    };
    #[test]
    fn curve_splits_preserve_multiple_unwrapped_memberships() {
        use super::super::{feature_curves::make_circle_curve,point_table::CurveInterval};
        let tree=leaf_at(Shape::Sphere{r:1.},[0.;3]);
        let mut features=compile_native_features(&tree);
        features.curves=(0..3).map(|id|make_circle_curve(id,-1,[0,0],0.,0.,0.,0.,0.,1.,if id==2 {0.999}else{1.},None)).collect();
        let a=features.curves[0].point_at(0.);
        let b=features.curves[0].point_at(std::f64::consts::FRAC_PI_2);
        let mut points=PointTable::new();
        for p in [a,a.map(|x|-x),b,b.map(|x|-x),[0.,0.,1.],[0.,0.,-1.]] {points.add(p[0],p[1],p[2],p[0],p[1],p[2]);}
        let mut tris=Vec::new();
        for mut t in [[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]] {
            let p=t.map(|i|q::pos(&points,i));
            if q::dot(q::normal(p),q::bary(p,[1./3.;3]))<0. {t.swap(0,1);}
            points.set_patch(t,0);tris.extend(t);
        }
        for (curve_id,start) in [(0,std::f64::consts::TAU),(1,-std::f64::consts::TAU)] {
            points.protect_curve_edge(0,2,CurveInterval{curve_id,start,end:start+std::f64::consts::FRAC_PI_2});
        }
        let (out,report)=refine(&tree,&features,&mut points,&tris,0.05,1000);
        assert!(report.edge_splits>0);
        assert!(points.curve_intervals(0,2).is_empty());
        let mut lengths=[0.;2];let mut count=0;
        for ((a,b),intervals) in points.identified_edges() {
            count+=1;assert_eq!(intervals.len(),2);
            assert!(out.chunks_exact(3).filter(|t|t.contains(&a)&&t.contains(&b)).count()==2);
            for interval in intervals {assert!(interval.curve_id<2);lengths[interval.curve_id]+=(interval.end-interval.start).abs();}
            for id in [a,b] {let p=q::pos(&points,id);assert!(p[2].abs()<1e-12);assert!((p[0].hypot(p[1])-1.).abs()<1e-12);}
        }
        assert!(count>1);
        for length in lengths {assert!((length-std::f64::consts::FRAC_PI_2).abs()<1e-12);}
    }
    #[test]
    fn hard_primitive_refines_conformingly_with_explicit_budget() {
        let tree = leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        let features = compile_native_features(&tree);
        let fixture = || {
            let mut p = PointTable::new();
            for x in [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.], [-1., 0., 0.]] {
                p.add(x[0], x[1], x[2], x[0], x[1], x[2]);
            }
            p.set_patch([0, 1, 2], 0);
            p.set_patch([2, 1, 3], 0);
            p
        };
        let tris = [0, 1, 2, 2, 1, 3];
        let mut p = fixture();
        let count = p.count();
        let (unchanged, r) = refine(&tree, &features, &mut p, &tris, 0.05, 0);
        assert_eq!(r.inserted, 0);
        assert!(r.unresolved > 0);
        assert_eq!(p.count(), count);
        assert_eq!(unchanged.len(), tris.len());
        let mut p = fixture();
        let (out, r) = refine(&tree, &features, &mut p, &tris, 0.05, 500);
        assert!(r.inserted > 0);
        assert!(r.interior_splits > 0);
        assert!(r.edge_splits > 0);
        // Interior shared edges always have exactly two incident faces. Open
        // input boundary arcs are deliberately immutable in this first stage.
        let mut incidence = BTreeMap::<_, usize>::new();
        for t in out.chunks_exact(3) {
            for k in 0..3 {
                *incidence.entry(edge(t[k], t[(k + 1) % 3])).or_default() += 1;
            }
        }
        assert!(incidence.values().all(|&n| n <= 2));
        assert!(!incidence.contains_key(&edge(1, 2)));
        for (&(a, b), &n) in &incidence {
            if n == 1 {
                assert!(a < 4 && b < 4);
            }
        }
    }
    #[test]
    fn cancellation_does_not_mutate() {
        let tree = leaf_at(Shape::Sphere { r: 1. }, [0.; 3]);
        let features = compile_native_features(&tree);
        let mut p = PointTable::new();
        for x in [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]] {
            p.add(x[0], x[1], x[2], x[0], x[1], x[2]);
        }
        p.set_patch([0, 1, 2], 0);
        let _guard = super::super::cancel::CancelGuard::install(Box::new(|| true));
        let (out, r) = refine(&tree, &features, &mut p, &[0, 1, 2], 0.01, 100);
        assert!(r.cancelled);
        assert_eq!(out.len(), 3);
        assert_eq!(p.count(), 3);
    }
}
