//! Complete memberships on existing edges for proven common loft-cap rims.
//! Partial overlaps split incident faces conformingly; complete duplicates change
//! only memberships. Different side patches remain
//! distinct; their restrictions to the same source cap can share a curve locus.
use super::{
    feature_curves::FeatureCurve,
    feature_set::SfccFeatureSet,
    point_table::{CurveInterval, PointTable},
    predicates::orient2d,
    triangle_quality as q,
};
use std::collections::{BTreeMap, BTreeSet};

/// Affine map from one exact Segment chart to another. No proximity matching:
/// source occurrence/cap restriction and exact collinearity are both required.
fn parameter_map(
    a: &FeatureCurve,
    b: &FeatureCurve,
    features: &SfccFeatureSet,
) -> Option<(f64, f64)> {
    if a.closed || b.closed || a.param_wrap.is_some() || b.param_wrap.is_some() {
        return None;
    }
    let compatible = a.adjacent_strata.iter().any(|&cap| {
        if !b.adjacent_strata.contains(&cap) {
            return false;
        }
        let Some(&sa) = a.adjacent_strata.iter().find(|&&id| id != cap) else {
            return false;
        };
        let Some(&sb) = b.adjacent_strata.iter().find(|&&id| id != cap) else {
            return false;
        };
        features.strata[sa].shares_loft_rim(&features.strata[sb], &features.strata[cap])
    });
    if !compatible {
        return None;
    }
    let (pa, da) = a.segment_chart()?;
    let (pb, db) = b.segment_chart()?;
    if pa
        .iter()
        .chain(&da)
        .chain(&pb)
        .chain(&db)
        .any(|x| !x.is_finite())
    {
        return None;
    }
    let axis = (0..3).max_by(|&i, &j| db[i].abs().total_cmp(&db[j].abs()))?;
    if db[axis] == 0. || da[axis] == 0. {
        return None;
    }
    // The represented affine lines must coincide exactly, not merely after f32 rounding.
    for k in 0..3 {
        if k != axis
            && (orient2d([0., 0.], [da[axis], da[k]], [db[axis], db[k]]) != 0
                || super::predicates::displacement_cross(
                    [pa[axis], pa[k]],
                    [pb[axis], pb[k]],
                    [db[axis], db[k]],
                ) != 0)
        {
            return None;
        }
    }
    let shift = (pa[axis] - pb[axis]) / db[axis];
    let scale = da[axis] / db[axis];
    let [lo, hi] = [shift + scale * a.t_min, shift + scale * a.t_max];
    if ![shift, scale, lo, hi, b.t_min, b.t_max]
        .iter()
        .all(|v| v.is_finite())
        || scale == 0.
    {
        return None;
    }
    (lo.min(hi) < b.t_max && lo.max(hi) > b.t_min).then_some((shift, scale))
}

/// The same source cap restriction gives a common pin identity, without equating
/// the different interior side carriers. Exact payload equality is required here.
pub(crate) fn canonical_pin(
    curve_id: usize,
    t: f64,
    p: [f64; 3],
    features: &SfccFeatureSet,
) -> (usize, f64) {
    let source = &features.curves[curve_id];
    if source.segment_chart().is_none() {
        return (curve_id, t);
    }
    for target in &features.curves[..curve_id] {
        if let Some((shift, scale)) = parameter_map(source, target, features) {
            let mapped = shift + scale * t;
            if mapped >= target.t_min && mapped <= target.t_max && target.point_at(mapped) == p {
                return (target.id, mapped);
            }
        }
    }
    (curve_id, t)
}

pub(crate) fn same_traced_endpoints(source: &FeatureCurve, target: &FeatureCurve) -> bool {
    source.kind() == super::feature_curves::CurveKind::Traced
        && target.kind() == source.kind()
        && !source.closed
        && !target.closed
        && source.corner_start >= 0
        && source.corner_end >= 0
        && source.corner_start != source.corner_end
        && ((source.corner_start, source.corner_end) == (target.corner_start, target.corner_end)
            || (source.corner_start, source.corner_end) == (target.corner_end, target.corner_start))
}

pub(crate) fn complete(points: &mut PointTable, tris: &mut Vec<usize>, features: &SfccFeatureSet) {
    let mut maps = BTreeMap::<usize, Vec<(usize, f64, f64)>>::new();
    for a in &features.curves {
        if a.segment_chart().is_none() {
            continue;
        }
        for b in &features.curves {
            if a.id == b.id {
                continue;
            }
            if let Some((shift, scale)) = parameter_map(a, b, features) {
                maps.entry(a.id).or_default().push((b.id, shift, scale));
            }
        }
    }
    if maps.is_empty() {
        return;
    }
    subdivide_overlap_ends(points, tris, features, &maps);
    // A label can only be added to an actual edge of a valid final f32 face.
    let valid_edges: BTreeSet<_> = tris
        .chunks_exact(3)
        .filter(|t| {
            let p: [[f64; 3]; 3] = std::array::from_fn(|i| {
                [
                    points.x(t[i]) as f32 as f64,
                    points.y(t[i]) as f32 as f64,
                    points.z(t[i]) as f32 as f64,
                ]
            });
            if p.iter().flatten().any(|v| !v.is_finite()) {
                return false;
            }
            (0..3).any(|k| {
                orient2d(
                    [p[0][k], p[0][(k + 1) % 3]],
                    [p[1][k], p[1][(k + 1) % 3]],
                    [p[2][k], p[2][(k + 1) % 3]],
                ) != 0
            })
        })
        .flat_map(|t| (0..3).map(move |k| (t[k].min(t[(k + 1) % 3]), t[k].max(t[(k + 1) % 3]))))
        .collect();
    let mut additions = Vec::new();
    for ((a, b), memberships) in points.identified_edges() {
        if !valid_edges.contains(&(a, b)) {
            continue;
        }
        for source in memberships {
            let Some(candidates) = maps.get(&source.curve_id) else {
                continue;
            };
            let curve = &features.curves[source.curve_id];
            if ![source.start, source.end]
                .iter()
                .all(|&t| t.is_finite() && t >= curve.t_min && t <= curve.t_max)
            {
                continue;
            }
            // Trust source identity, but reject inconsistent edge payloads. This
            // allowance is arithmetic roundoff, not the user meshing tolerance.
            if ![(a, source.start), (b, source.end)]
                .into_iter()
                .all(|(id, t)| {
                    let p = [points.x(id), points.y(id), points.z(id)];
                    let q = curve.point_at(t);
                    p.iter().zip(q).all(|(&x, y)| {
                        x.is_finite()
                            && (x - y).abs() <= 64. * f64::EPSILON * (1. + x.abs() + y.abs())
                    })
                })
            {
                continue;
            }
            for &(id, shift, scale) in candidates {
                let target = &features.curves[id];
                let start = shift + scale * source.start;
                let end = shift + scale * source.end;
                if !start.is_finite() || !end.is_finite() {
                    continue;
                }
                // A rejected subdivision remains a visible chain gap; never give a
                // longer physical edge a clipped parameter interval.
                if start.min(end) < target.t_min || start.max(end) > target.t_max || start == end {
                    continue;
                }
                additions.push((
                    a,
                    b,
                    CurveInterval {
                        curve_id: id,
                        start,
                        end,
                    },
                ));
            }
        }
    }
    for (a, b, interval) in additions {
        points.protect_curve_edge(a, b, interval);
    }
}

/// Split every incident triangle before attaching a partial-overlap membership.
/// Existing metadata splitting transports each source parameter independently.
fn subdivide_overlap_ends(
    points: &mut PointTable,
    tris: &mut Vec<usize>,
    features: &SfccFeatureSet,
    maps: &BTreeMap<usize, Vec<(usize, f64, f64)>>,
) {
    let mut cuts = BTreeMap::<(usize, usize), Vec<f64>>::new();
    for ((a, b), intervals) in points.identified_edges() {
        if intervals
            .iter()
            .any(|i| features.curves[i.curve_id].segment_chart().is_none())
        {
            continue;
        }
        for i in intervals {
            if i.start == i.end {
                continue;
            }
            for &(id, shift, scale) in maps.get(&i.curve_id).into_iter().flatten() {
                for t in [features.curves[id].t_min, features.curves[id].t_max] {
                    let u = ((t - shift) / scale - i.start) / (i.end - i.start);
                    if u > 0. && u < 1. {
                        cuts.entry((a, b)).or_default().push(u);
                    }
                }
            }
        }
    }
    for ((a, b), mut cuts) in cuts {
        cuts.sort_by(f64::total_cmp);
        cuts.dedup();
        let intervals = points.curve_intervals(a, b);
        let pa = q::pos(points, a);
        let pb = q::pos(points, b);
        let candidates: Vec<[f64; 3]> = cuts
            .iter()
            .map(|&u| std::array::from_fn(|k| pa[k] + u * (pb[k] - pa[k])))
            .collect();
        // Subdivision must preserve the embedded edge in both representations.
        // A non-representable cut stays an explicit membership gap.
        if candidates.iter().any(|&p| {
            let raw = [pa, pb, p];
            [raw, raw.map(q::rounded)].into_iter().any(|v| {
                v.iter().flatten().any(|x| !x.is_finite())
                    || (0..3).any(|k| {
                        orient2d(
                            [v[0][k], v[0][(k + 1) % 3]],
                            [v[1][k], v[1][(k + 1) % 3]],
                            [v[2][k], v[2][(k + 1) % 3]],
                        ) != 0
                    })
            })
        }) {
            continue;
        }
        // Source labels must describe the actual straight edge, including all
        // split locations. Arithmetic error is allowed; geometric proximity is not identity.
        if intervals.iter().any(|i| {
            [0., 1.].into_iter().chain(cuts.iter().copied()).any(|u| {
                let p: [f64; 3] = std::array::from_fn(|k| pa[k] + u * (pb[k] - pa[k]));
                let expected =
                    features.curves[i.curve_id].point_at(i.start + u * (i.end - i.start));
                p.iter().zip(expected).any(|(&x, y)| {
                    !x.is_finite()
                        || !y.is_finite()
                        || (x - y).abs() > 64. * f64::EPSILON * (1. + x.abs() + y.abs())
                })
            })
        }) {
            continue;
        }
        let first = points.count();
        let chain: Vec<_> = std::iter::once(a)
            .chain((0..cuts.len()).map(|i| first + i))
            .chain(std::iter::once(b))
            .collect();
        let position = |v| {
            if v >= first {
                candidates[v - first]
            } else {
                q::pos(points, v)
            }
        };
        let mut proposals = Vec::new();
        let mut valid = true;
        for (index, tri) in tris.chunks_exact(3).enumerate() {
            let Some(k) = (0..3)
                .find(|&k| (tri[k].min(tri[(k + 1) % 3]), tri[k].max(tri[(k + 1) % 3])) == (a, b))
            else {
                continue;
            };
            let normal = q::normal([
                q::pos(points, tri[0]),
                q::pos(points, tri[1]),
                q::pos(points, tri[2]),
            ]);
            let children: Vec<_> = chain
                .windows(2)
                .map(|w| {
                    if tri[k] == a {
                        [w[0], w[1], tri[(k + 2) % 3]]
                    } else {
                        [w[1], w[0], tri[(k + 2) % 3]]
                    }
                })
                .collect();
            if children
                .iter()
                .any(|child| !q::valid_orientation(child.map(position), normal))
            {
                valid = false;
                break;
            }
            proposals.push((index, children, points.patch([tri[0], tri[1], tri[2]])));
        }
        if !valid || proposals.is_empty() {
            continue;
        }
        for (&u, p) in cuts.iter().zip(&candidates) {
            let mut n = [
                points.nx(a) * (1. - u) + points.nx(b) * u,
                points.ny(a) * (1. - u) + points.ny(b) * u,
                points.nz(a) * (1. - u) + points.nz(b) * u,
            ];
            let len = n[0].hypot(n[1]).hypot(n[2]);
            if len > 0. {
                for x in &mut n {
                    *x /= len;
                }
            }
            points.add(p[0], p[1], p[2], n[0], n[1], n[2]);
        }
        for (i, &u) in cuts.iter().enumerate() {
            let parameters: Vec<_> = intervals
                .iter()
                .map(|p| p.start + u * (p.end - p.start))
                .collect();
            points.split_curve_edge_at(chain[i], b, chain[i + 1], &parameters);
        }
        let mut out = Vec::with_capacity(tris.len() + proposals.len() * cuts.len() * 3);
        let mut replacements = proposals.into_iter().peekable();
        for (index, tri) in tris.chunks_exact(3).enumerate() {
            if let Some((_, children, owner)) = replacements.next_if(|p| p.0 == index) {
                for child in children {
                    if let Some(owner) = owner {
                        points.set_patch(child, owner);
                    }
                    out.extend_from_slice(&child);
                }
            } else {
                out.extend_from_slice(tri);
            }
        }
        *tris = out;
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        feature_chain::audit_feature_chains, feature_curves::make_segment_curve,
        spatial_index::SfccSpatialIndex,
    };
    use super::*;
    use crate::{
        math::similarity::Similarity,
        strata::{LoftSideParams, Stratum, StratumIdentity},
    };

    fn fixture(target: [f64; 2]) -> SfccFeatureSet {
        fixture_transform(target, Similarity::identity())
    }
    fn fixture_transform(target: [f64; 2], sim: Similarity) -> SfccFeatureSet {
        let ident = |id| StratumIdentity {
            id,
            owner_node_id: 42,
            leaf_index: 2,
            local_index: id,
            sign: 1.,
        };
        let side = LoftSideParams {
            sim,
            pos_x: 0.,
            pos_y: 0.,
            pos_z: 0.,
            seg_y0: 0.,
            seg_h: 2.,
            a_x: 0.,
            a_z: 0.,
            a_x1: 4.,
            a_z1: 0.,
            a_nx: 0.,
            a_nz: -1.,
            b_x: 0.,
            b_z: 1.,
            b_x1: 4.,
            b_z1: 1.,
            b_nx: 0.,
            b_nz: -1.,
        };
        let curve = |id, side, start, end| {
            let a = sim.apply_point(start, 0., 0.);
            let b = sim.apply_point(end, 0., 0.);
            make_segment_curve(id, 42, [side, 2], a[0], a[1], a[2], b[0], b[1], b[2])
        };
        let n = sim.rotate_vector(0., -1., 0.);
        let off = -(n[0] * sim.t[0] + n[1] * sim.t[1] + n[2] * sim.t[2]);
        SfccFeatureSet {
            unresolved_branch_paths: Vec::new(),
            trace_diagnostics: Default::default(),
            curves: vec![curve(0, 0, 0., 4.), curve(1, 1, target[0], target[1])],
            corners: Vec::new(),
            index: SfccSpatialIndex::new(1.),
            strata: vec![
                Stratum::loft_side(ident(0), side),
                Stratum::loft_side(
                    ident(1),
                    LoftSideParams {
                        b_z: 2.,
                        b_z1: 2.,
                        ..side
                    },
                ),
                Stratum::plane(ident(2), n[0], n[1], n[2], off),
            ],
            run_id: super::super::feature_set::next_feature_set_run_id(),
        }
    }
    fn mesh(knots: &[f64]) -> (PointTable, Vec<usize>) {
        let mut points = PointTable::new();
        for &x in knots {
            points.add(x, 0., 0., 0., -1., 0.);
        }
        let c = points.add(0., 1., 1., 0., -1., 0.);
        let mut tris = Vec::new();
        for i in 0..knots.len() - 1 {
            points.protect_curve_edge(
                i,
                i + 1,
                CurveInterval {
                    curve_id: 0,
                    start: knots[i] / 4.,
                    end: knots[i + 1] / 4.,
                },
            );
            tris.extend_from_slice(&[i, i + 1, c]);
        }
        (points, tris)
    }
    #[test]
    fn common_rim_does_not_identify_the_different_interior_carriers() {
        let fs = fixture([0., 4.]);
        assert_eq!(
            parameter_map(&fs.curves[0], &fs.curves[1], &fs),
            Some((0., 1.))
        );
        assert_ne!(fs.strata[0].f(2., 1., 0.5), fs.strata[1].f(2., 1., 0.5));
        assert!(!fs.strata[0].shares_loft_rim(
            &fs.strata[1],
            &Stratum::plane(
                StratumIdentity {
                    id: 3,
                    owner_node_id: 42,
                    leaf_index: 2,
                    local_index: 3,
                    sign: 1.
                },
                0.,
                1.,
                0.,
                -2.
            )
        ));
    }
    #[test]
    fn reversed_partial_overlap_keeps_its_own_oriented_parameters() {
        let fs = fixture([3., 1.]);
        let (mut points, mut tris) = mesh(&[0., 1., 3., 4.]);
        complete(&mut points, &mut tris, &fs);
        assert_eq!(
            points.curve_intervals(1, 2),
            vec![
                CurveInterval {
                    curve_id: 0,
                    start: 0.25,
                    end: 0.75
                },
                CurveInterval {
                    curve_id: 1,
                    start: 1.,
                    end: 0.
                }
            ]
        );
        assert_eq!(points.curve_intervals(0, 1).len(), 1);
        assert_eq!(points.curve_intervals(2, 3).len(), 1);
        assert!(audit_feature_chains(&points, &tris, &fs, 1e-8).passed());
        let mid = points.add(2., 0., 0., 0., -1., 0.);
        points.split_curve_edge(1, 2, mid);
        assert_eq!(
            points.curve_intervals(1, mid),
            vec![
                CurveInterval {
                    curve_id: 0,
                    start: 0.25,
                    end: 0.5
                },
                CurveInterval {
                    curve_id: 1,
                    start: 1.,
                    end: 0.5
                }
            ]
        );
    }
    #[test]
    fn partial_overlap_splits_all_incident_faces_conformingly() {
        let fs = fixture([1., 3.]);
        let (mut points, _) = mesh(&[0., 4.]);
        points.add(0., -1., 1., 0., 1., 0.);
        let mut tris = vec![0, 1, 2, 1, 0, 3, 2, 1, 3, 0, 2, 3];
        complete(&mut points, &mut tris, &fs);
        assert_eq!(tris.len() / 3, 8);
        let ids: Vec<_> = tris.iter().map(|&id| id as u32).collect();
        assert!(super::super::manifold_check::check_manifold(&ids, true).ok);
        assert!(audit_feature_chains(&points, &tris, &fs, 1e-8).passed());
        assert!(points.curve_intervals(0, 1).is_empty());
    }
    #[test]
    fn close_sheets_and_different_source_occurrences_do_not_alias() {
        let mut fs = fixture([0., 4.]);
        fs.strata[1].leaf_index = 3;
        assert!(parameter_map(&fs.curves[0], &fs.curves[1], &fs).is_none());
        fs.strata[1].leaf_index = 2;
        fs.curves[1] = make_segment_curve(1, 42, [1, 2], 0., 0., 1e-20, 4., 0., 1e-20);
        assert!(parameter_map(&fs.curves[0], &fs.curves[1], &fs).is_none());
    }
    #[test]
    fn completing_twice_and_reversing_source_edges_is_idempotent() {
        let fs = fixture([4., 0.]);
        let (mut points, mut tris) = mesh(&[4., 2., 0.]);
        complete(&mut points, &mut tris, &fs);
        let before = points.curve_intervals(0, 1);
        complete(&mut points, &mut tris, &fs);
        assert_eq!(points.curve_intervals(0, 1), before);
        assert!(audit_feature_chains(&points, &tris, &fs, 1e-8).passed());
    }
    #[test]
    fn memberships_do_not_rescue_invalid_faces_or_displaced_payloads() {
        let fs = fixture([0., 4.]);
        let (mut points, _) = mesh(&[0., 4.]);
        complete(&mut points, &mut vec![0, 1, 0], &fs);
        assert_eq!(points.curve_intervals(0, 1).len(), 1);
        points.relocate(0, [0., 0., 1e-5], [0., 1., 0.]);
        complete(&mut points, &mut vec![0, 1, 2], &fs);
        assert_eq!(points.curve_intervals(0, 1).len(), 1);
    }
    #[test]
    fn f32_collapsed_split_is_rejected_without_partial_mutation() {
        let fs = fixture([1. + 1e-10, 3.]);
        let (mut points, mut tris) = mesh(&[1., 4.]);
        let before = tris.clone();
        let count = points.count();
        let intervals = points.curve_intervals(0, 1);
        complete(&mut points, &mut tris, &fs);
        assert_eq!(tris, before);
        assert_eq!(points.count(), count);
        assert_eq!(points.curve_intervals(0, 1), intervals);
        assert!(audit_feature_chains(&points, &tris, &fs, 1e-8)
            .issues
            .iter()
            .any(|i| i.curve_id == 1 && i.kind == "missingCurve"));
    }
    #[test]
    fn exact_line_check_does_not_round_away_a_displaced_origin() {
        assert_ne!(
            super::super::predicates::displacement_cross([1e16, 1.], [1e16, 0.], [1., 0.]),
            0
        );
    }
    #[test]
    fn nonrepresentable_rotated_partial_cut_preserves_the_original_embedding() {
        let sim = Similarity::from_rotation_wgsl_fwd(&[0.8, 0., 0.6, 0., 1., 0., -0.6, 0., 0.8]);
        let mut fs = fixture_transform([0., 4.], sim);
        fs.curves[1].t_min = 0.37;
        fs.curves[1].t_max = 0.75;
        assert_eq!(
            parameter_map(&fs.curves[0], &fs.curves[1], &fs),
            Some((0., 1.))
        );
        let (mut points, mut tris) = mesh(&[0., 4.]);
        for i in 0..points.count() {
            let p = q::pos(&points, i);
            points.relocate(i, sim.apply_point(p[0], p[1], p[2]), [0., -1., 0.]);
        }
        let before = tris.clone();
        let count = points.count();
        complete(&mut points, &mut tris, &fs);
        assert_eq!(tris, before);
        assert_eq!(points.count(), count);
        assert!(audit_feature_chains(&points, &tris, &fs, 1e-8)
            .issues
            .iter()
            .any(|i| i.curve_id == 1 && i.kind == "missingCurve"));
    }
}
