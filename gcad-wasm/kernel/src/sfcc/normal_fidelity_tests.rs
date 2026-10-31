use super::super::point_table::CurveInterval;
use super::*;

fn obligations(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    e: Edge,
    tolerance: f64,
) -> Result<Vec<Obligation>, Stop> {
    super::obligations(
        tree,
        features,
        points,
        e,
        tolerance,
        &mut NormalRepairReport::default(),
    )
}
fn contract(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    tris: &[Tri],
    tolerance: f64,
) -> Result<Contract, Stop> {
    super::contract(
        tree,
        features,
        points,
        tris,
        tolerance,
        &mut NormalRepairReport::default(),
    )
}
fn score(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &PointTable,
    t: Tri,
    tolerance: f64,
    c: &Contract,
) -> Result<f64, Stop> {
    super::score(
        tree,
        features,
        points,
        t,
        tolerance,
        c,
        &mut NormalRepairReport::default(),
    )
}
fn source_side(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    pair: [usize; 2],
    p: P3,
    tolerance: f64,
) -> Result<usize, Stop> {
    super::source_side(
        tree,
        features,
        pair,
        p,
        tolerance,
        &mut NormalRepairReport::default(),
    )
}

fn housing() -> (CsgNode, SfccFeatureSet, serde_json::Value) {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/housing-main-bore-gpu.json")).unwrap();
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/housing-crease-neighborhoods.json"
    ))
    .unwrap();
    assert_eq!(fixture["sourceSha256"], cases["sourceSha256"]);
    let tree =
        crate::scene_bridge::build_csg_tree_from_json(fixture["sceneJson"].as_str().unwrap())
            .unwrap();
    let side =
        fixture["cube"]["max"][0].as_f64().unwrap() - fixture["cube"]["min"][0].as_f64().unwrap();
    let tolerances = crate::tolerances::resolve_tolerances(
        &crate::tuning::SfccTuning::default(),
        side * 3_f64.sqrt(),
    );
    let (features, _) = super::super::feature_set::compile_feature_set(&tree, &tolerances);
    (tree, features, cases)
}
fn patch(case: &serde_json::Value) -> (PointTable, Vec<usize>) {
    let mut points = PointTable::new();
    let vertices: Vec<P3> = serde_json::from_value(case["positions"].clone()).unwrap();
    for p in vertices.into_iter().map(q::rounded) {
        points.add(p[0], p[1], p[2], 0., 0., 1.);
    }
    for row in case["memberships"].as_array().unwrap() {
        points.protect_curve_edge(
            row[0].as_u64().unwrap() as usize,
            row[1].as_u64().unwrap() as usize,
            CurveInterval {
                curve_id: row[2].as_u64().unwrap() as usize,
                start: row[3].as_f64().unwrap(),
                end: row[4].as_f64().unwrap(),
            },
        );
    }
    let tris: Vec<Tri> = serde_json::from_value(case["triangles"].clone()).unwrap();
    (points, tris.into_iter().flatten().collect())
}
fn metadata(points: &PointTable) -> Vec<(Edge, Vec<CurveInterval>)> {
    let mut out: Vec<_> = points
        .identified_edges()
        .map(|(e, i)| (e, i.to_vec()))
        .collect();
    out.sort_by_key(|r| r.0);
    out
}
fn paired_patch(cases: &serde_json::Value) -> (PointTable, Vec<usize>) {
    let mut points = PointTable::new();
    let mut ids = BTreeMap::new();
    let mut tris = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let old_ids: Vec<usize> = serde_json::from_value(case["globalVertexIds"].clone()).unwrap();
        let positions: Vec<P3> = serde_json::from_value(case["positions"].clone()).unwrap();
        let mut local = Vec::new();
        for (old, p) in old_ids
            .into_iter()
            .zip(positions.into_iter().map(q::rounded))
        {
            let id = *ids
                .entry(old)
                .or_insert_with(|| points.add(p[0], p[1], p[2], 0., 0., 1.));
            assert_eq!(q::pos(&points, id), p);
            local.push(id);
        }
        for row in case["memberships"].as_array().unwrap() {
            points.protect_curve_edge(
                local[row[0].as_u64().unwrap() as usize],
                local[row[1].as_u64().unwrap() as usize],
                CurveInterval {
                    curve_id: row[2].as_u64().unwrap() as usize,
                    start: row[3].as_f64().unwrap(),
                    end: row[4].as_f64().unwrap(),
                },
            );
        }
        let faces: Vec<Tri> = serde_json::from_value(case["triangles"].clone()).unwrap();
        for t in faces {
            tris.extend(t.map(|v| local[v]));
        }
    }
    (points, tris)
}
#[test]
fn generic_discovery_and_private_descent_repair_both_housing_neighborhoods() {
    let (tree, features, cases) = housing();
    let (mut points, input) = paired_patch(&cases);
    let before_metadata = metadata(&points);
    let before_positions: Vec<_> = (0..points.count()).map(|i| q::pos(&points, i)).collect();
    let original_contracts: Vec<_> = input
        .chunks_exact(18)
        .map(|side| {
            let tris: Vec<Tri> = side.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
            contract(&tree, &features, &points, &tris, 0.01).unwrap()
        })
        .collect();
    let (out, report) = repair(&tree, &features, &mut points, &input, 0.01);
    eprintln!("paired actual descent {report:?} out={out:?}");
    assert_eq!(
        report.accepted, 1,
        "both sides must commit in ONE transaction"
    );
    assert_eq!(report.flips, 3);
    assert_ne!(out, input);
    assert_eq!(out.len(), input.len());
    assert_eq!(metadata(&points), before_metadata);
    assert_eq!(
        (0..points.count())
            .map(|i| q::pos(&points, i))
            .collect::<Vec<_>>(),
        before_positions
    );
    for (side, frozen) in out.chunks_exact(18).zip(&original_contracts) {
        let tris: Vec<Tri> = side.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
        for t in tris {
            assert!(score(&tree, &features, &points, t, 0.01, frozen).unwrap() <= frozen.gate);
        }
    }
    assert!(report.scores <= report.seeds * 2 * MAX_SCORES);
    assert!(report.trigger_scores <= report.seeds * 2);
    let (repeat, again) = repair(&tree, &features, &mut points, &out, 0.01);
    assert_eq!(repeat, out);
    assert_eq!(again.accepted, 0);
}
#[test]
fn second_housing_neighborhood_rolls_back_when_only_one_flip_is_allowed() {
    let (tree, features, cases) = housing();
    for limits in [
        Limits {
            flips: [1; 2],
            scores: [MAX_SCORES; 2],
        },
        Limits {
            flips: [3, 0],
            scores: [MAX_SCORES; 2],
        },
        Limits {
            flips: [3; 2],
            scores: [MAX_SCORES, 0],
        },
    ] {
        let (mut points, input) = paired_patch(&cases);
        for t in input.chunks_exact(3) {
            points.set_patch([t[0], t[1], t[2]], 77);
        }
        let old_metadata = metadata(&points);
        let (out, report) = repair_with_limits(&tree, &features, &mut points, &input, 0.01, limits);
        eprintln!("paired rollback {report:?}");
        assert_eq!(out, input, "no transferred-error intermediate may publish");
        assert!(
            report.exhausted > 0,
            "actual descent must reach its declared limit: {report:?}"
        );
        assert_eq!(report.accepted, 0);
        assert_eq!(report.flips, 0);
        if limits.flips[1] == 0 || limits.scores[1] == 0 {
            assert!(
                report.staged_flips > 0,
                "first side should stage before second side stops"
            );
        }
        assert_eq!(metadata(&points), old_metadata);
        for t in input.chunks_exact(3) {
            assert_eq!(points.patch([t[0], t[1], t[2]]), Some(77));
        }
    }
}
#[test]
fn score_exhaustion_and_cancellation_preserve_geometry_and_metadata() {
    let (tree, features, cases) = housing();
    for cancelled in [false, true] {
        let (mut points, input) = paired_patch(&cases);
        let old_metadata = metadata(&points);
        let guard =
            cancelled.then(|| super::super::cancel::CancelGuard::install(Box::new(|| true)));
        let (out, report) = repair_with_limits(
            &tree,
            &features,
            &mut points,
            &input,
            0.01,
            Limits {
                flips: [MAX_FLIPS; 2],
                scores: [0; 2],
            },
        );
        drop(guard);
        assert_eq!(out, input);
        assert_eq!(metadata(&points), old_metadata);
        if cancelled {
            assert!(report.cancelled);
        } else {
            assert!(report.exhausted > 0, "{report:?}");
        }
    }
}
#[test]
fn empty_or_unknown_alias_cannot_authorize_a_source_gate() {
    let (tree, features, cases) = housing();
    let (mut points, _) = patch(&cases["cases"][0]);
    points.protect_edge(0, 1);
    assert!(obligations(&tree, &features, &points, (0, 1), 0.01).is_err());
    points.protect_curve_edge(
        3,
        4,
        CurveInterval {
            curve_id: usize::MAX,
            start: 0.,
            end: 1.,
        },
    );
    assert!(obligations(&tree, &features, &points, (3, 4), 0.01).is_err());
}
#[test]
fn half_jump_face_bounds_do_not_authorize_a_flattened_physical_crease() {
    let axis = [0., 0., 1.];
    assert!(!retained_contrast(axis, axis, 12.));
    // The 2-degree floor must not erase a shallow but nonzero source contrast.
    assert!(!retained_contrast(axis, axis, 3.));
    let tilted = [0., 6_f64.to_radians().sin(), 6_f64.to_radians().cos()];
    assert!(retained_contrast(axis, tilted, 10.));
}
#[test]
fn vertex_link_and_edge_orientation_controls_reject_pinched_or_nonmanifold_patches() {
    assert!(manifold(&[[0, 1, 2], [2, 1, 3]]));
    assert!(!manifold(&[[0, 1, 2], [0, 3, 4]]));
    assert!(!manifold(&[[0, 1, 2], [0, 1, 3]]));
    assert!(!manifold(&[[0, 1, 2], [1, 0, 3], [0, 1, 4]]));
}
#[test]
fn a_buried_carrier_intersection_does_not_supply_an_exposed_gate() {
    let (tree, features, cases) = housing();
    let (points, _) = patch(&cases["cases"][0]);
    assert!(obligations(&tree, &features, &points, (3, 4), 0.01).is_ok());
    let covering = crate::sdf::CsgNode::Leaf(crate::sdf::Leaf {
        sign: 1.,
        sim: crate::math::similarity::Similarity::identity(),
        pos: [0.; 3],
        shape: crate::sdf::Shape::Sphere { r: 1000. },
        index: 0,
        strata: Vec::new(),
        warped: false,
        warp_scale: 1.0,
        params_valid: Default::default(),
        polygons_valid: Default::default(),
    });
    let occluded = crate::sdf::CsgNode::Min(vec![tree, covering]);
    assert!(obligations(&occluded, &features, &points, (3, 4), 0.01).is_err());
}
#[test]
fn source_carrier_ties_are_unsupported_even_with_a_favorable_full_field_normal() {
    let (tree, features, cases) = housing();
    let (points, _) = patch(&cases["cases"][0]);
    let interval = points.curve_intervals(3, 4)[0];
    let curve = &features.curves[interval.curve_id];
    let p = curve.point_at_checked(interval.midpoint()).unwrap();
    assert!(source_side(&tree, &features, curve.adjacent_strata, p, 0.01).is_err());
}
#[test]
fn housing_source_contracts_check_every_alias_before_descent() {
    let (tree, features, cases) = housing();
    for case in cases["cases"].as_array().unwrap() {
        let (points, input) = patch(case);
        for e in points.protected_edges() {
            let result = obligations(&tree, &features, &points, e, 0.01);
            eprintln!(
                "source gate seed={} edge={e:?} accepted={}",
                case["seedTriangle"],
                result.is_ok()
            );
            assert!(
                result.is_ok(),
                "required own-chart observation unsupported at {e:?}"
            );
        }
        let tris: Vec<Tri> = input.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
        let frozen = contract(&tree, &features, &points, &tris, 0.01).unwrap();
        eprintln!(
            "frozen source gate seed={} target={} supports={:?}",
            case["seedTriangle"], frozen.gate, frozen.supports
        );
        for t in tris {
            let result = score(&tree, &features, &points, t, 0.01, &frozen);
            eprintln!("source score {t:?} {result:?}");
            assert!(
                result.is_ok(),
                "every original side site must have a unique compatible support"
            );
        }
    }
}
#[test]
fn neither_one_sided_housing_draft_may_publish_and_removed_obligations_still_fail() {
    let (tree, features, cases) = housing();
    let (mut points, input) = paired_patch(&cases);
    let live = LiveMesh::new(&points, &input);
    let (out, report) = repair(&tree, &features, &mut points, &input, 0.01);
    assert_eq!(report.accepted, 1);
    let candidate: Vec<Tri> = out.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
    let required: Vec<_> = protected(&points, &live.tris)
        .into_iter()
        .map(|e| (e, obligations(&tree, &features, &points, e, 0.01).unwrap()))
        .collect();
    let gate = required
        .iter()
        .flat_map(|(_, o)| o)
        .map(|o| o.gate)
        .fold(f64::INFINITY, f64::min);
    for range in [0..6, 6..12] {
        let selected: Vec<_> = range.clone().collect();
        let mut metrics = NormalRepairReport::default();
        assert!(
            !protected_pairs(
                &tree,
                &features,
                &points,
                &live,
                &selected,
                &candidate[range],
                &required,
                0.01,
                gate,
                &mut metrics
            ),
            "unchanged external incident face must prevent one-sided flattening"
        );
    }
    let selected: Vec<_> = (0..12).collect();
    assert!(protected_pairs(
        &tree,
        &features,
        &points,
        &live,
        &selected,
        &candidate,
        &required,
        0.01,
        gate,
        &mut NormalRepairReport::default()
    ));
    let without_edge: Vec<_> = candidate
        .iter()
        .copied()
        .filter(|t| !(t.contains(&3) && t.contains(&4)))
        .collect();
    assert!(
        !protected_pairs(
            &tree,
            &features,
            &points,
            &live,
            &selected,
            &without_edge,
            &required,
            0.01,
            gate,
            &mut NormalRepairReport::default()
        ),
        "a removed physical edge must not disappear from frozen obligations"
    );
}

fn simple_points(vertices: &[P3]) -> PointTable {
    let mut points = PointTable::new();
    for p in vertices {
        points.add(p[0], p[1], p[2], 0., 0., 1.);
    }
    points
}
#[test]
fn final_embedding_rejects_retained_and_cross_side_f32_only_collisions() {
    let epsilon = 1. / 67_108_864.;
    let points = simple_points(&[
        [0., 0., 1. + epsilon],
        [1., 0., 1. + epsilon],
        [1., 1., 1. + epsilon],
        [0., 1., 2.],
        [0.625, 0.125, 1. - epsilon],
        [0.75, 0.125, 1. - epsilon],
        [0.625, 0.25, 1. - epsilon],
        [0.625, 0.25, 0.5],
    ]);
    let old = [[0, 1, 3], [1, 2, 3], [4, 5, 6]];
    for &t in &old[..2] {
        assert!(!intersects_both(
            geometry(&points, t),
            geometry(&points, old[2]),
            t,
            old[2]
        ));
    }
    let child = [0, 1, 2];
    let obstacle = [4, 5, 6];
    let p = geometry(&points, child);
    let q = geometry(&points, obstacle);
    assert!(!super::super::mesh_edit::intersects(p, q, child, obstacle));
    assert!(super::super::mesh_edit::intersects(
        p.map(q::rounded),
        q.map(q::rounded),
        child,
        obstacle
    ));
    let input: Vec<_> = old.into_iter().flatten().collect();
    let live = LiveMesh::new(&points, &input);
    assert!(!final_embedding(
        &points,
        &[[0, 1, 2], [0, 2, 3]],
        &[0, 1],
        &live.tris,
        &live.positions,
        &live.index
    ));
    // The obstacle is now supplied by the other staged side; neither old side
    // remains in the retained set, so the cross-proposal guard must catch it.
    let live = LiveMesh::new(&points, &[0, 1, 3, 1, 2, 3, 4, 5, 7]);
    assert!(!final_embedding(
        &points,
        &[[0, 1, 2], [0, 2, 3], [4, 5, 6]],
        &[0, 1, 2],
        &live.tris,
        &live.positions,
        &live.index
    ));
}
#[test]
fn final_embedding_does_not_omit_a_nearby_malformed_retained_face() {
    let points = simple_points(&[
        [0., 0., 0.],
        [1., 0., 0.],
        [1., 1., 0.],
        [0., 1., 0.],
        [0.5, 0.1, 0.],
        [0.6, 0.1, 0.],
        [0.7, 0.1, 0.],
    ]);
    let live = LiveMesh::new(&points, &[0, 1, 3, 1, 2, 3, 4, 5, 6]);
    assert!(!q::valid_orientation(
        live.positions[2],
        q::normal(live.positions[2])
    ));
    assert!(!final_embedding(
        &points,
        &[[0, 1, 2], [0, 2, 3]],
        &[0, 1],
        &live.tris,
        &live.positions,
        &live.index
    ));
}
#[test]
fn committed_edits_update_live_adjacency_index_and_owners_before_later_windows() {
    let mut points = simple_points(&[
        [0., 0., 0.],
        [1., 0., 0.],
        [1., 1., 0.],
        [-0.5, 1., 0.],
        [2., 0., 0.],
        [2.5, 1., 0.],
    ]);
    let input = [0, 1, 3, 1, 2, 3, 1, 4, 2, 4, 5, 2];
    for t in input.chunks_exact(3) {
        points.set_patch([t[0], t[1], t[2]], 11);
    }
    points.set_patch([0, 1, 2], 99); // historical tag on a genuinely new triple
    let mut live = LiveMesh::new(&points, &input);
    live.commit(&mut points, &[0, 1, 2], &[[0, 1, 2], [0, 2, 3], [4, 2, 1]]);
    assert_eq!(points.patch([0, 1, 2]), None);
    assert_eq!(points.patch([0, 1, 3]), None);
    assert_eq!(points.patch([1, 4, 2]), Some(11)); // same oriented triple, cyclic row change
    assert_eq!(points.patch([4, 5, 2]), Some(11));
    assert!(!live.adjacent.contains_key(&edge(1, 3)));
    assert!(live.adjacent.contains_key(&edge(0, 2)));
    assert!(outside_edges(&live, &[2, 3], &[live.tris[2], live.tris[3]]).contains(&edge(1, 2)));
    live.commit(&mut points, &[2, 3], &[[1, 4, 5], [1, 5, 2]]);
    let flat: Vec<_> = live.tris.iter().flatten().copied().collect();
    let rebuilt = LiveMesh::new(&points, &flat);
    let normalized = |a: &Adjacency| {
        a.iter()
            .map(|(&e, f)| {
                let mut f = f.clone();
                f.sort_unstable();
                (e, f)
            })
            .collect::<BTreeMap<_, _>>()
    };
    assert_eq!(normalized(&live.adjacent), normalized(&rebuilt.adjacent));
    assert_eq!(live.vertex_faces, rebuilt.vertex_faces);
    let probes = [
        [[-0.4, 0.9, 0.], [-0.39, 0.9, 0.], [-0.4, 0.91, 0.]],
        [[2.4, 0.9, 0.], [2.41, 0.9, 0.], [2.4, 0.91, 0.]],
    ];
    assert!(
        !live.index.query(probes[0]).contains(&0),
        "old row0 bounds must shrink"
    );
    assert!(
        live.index.query(probes[1]).contains(&2),
        "new row2 bounds must expand"
    );
    for p in live.positions.iter().chain(&probes) {
        let mut a = live.index.query(*p);
        a.sort_unstable();
        let mut b = rebuilt.index.query(*p);
        b.sort_unstable();
        assert_eq!(a, b);
    }
    assert_eq!(
        outside_edges(&live, &[0, 1], &live.tris[..2]),
        outside_edges(&rebuilt, &[0, 1], &rebuilt.tris[..2])
    );
}
#[test]
fn cancellation_after_private_staging_rolls_back_both_housing_sides() {
    use std::{cell::Cell, rc::Rc};
    let (tree, features, cases) = housing();
    let run = |stop_at: usize| {
        let (mut points, input) = paired_patch(&cases);
        let old_metadata = metadata(&points);
        let checks = Rc::new(Cell::new(0usize));
        let callback = checks.clone();
        let guard = super::super::cancel::CancelGuard::install(Box::new(move || {
            let n = callback.get() + 1;
            callback.set(n);
            n >= stop_at
        }));
        let (out, report) = repair(&tree, &features, &mut points, &input, 0.01);
        drop(guard);
        assert_eq!(metadata(&points), old_metadata);
        (input, out, report, checks.get())
    };
    let (_, _, completed, total) = run(usize::MAX);
    assert_eq!(completed.accepted, 1);
    // Locate the first cancellation checkpoint after a private flip. This
    // exercises real cooperative cancellation without a test-only runtime hook.
    let (mut low, mut high) = (1, total);
    while low < high {
        let middle = low + (high - low) / 2;
        let (_, _, report, _) = run(middle);
        if report.staged_flips > 0 {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    let (input, out, report, _) = run(low);
    assert!(report.cancelled && report.staged_flips > 0);
    assert_eq!(report.accepted, 0);
    assert_eq!(report.flips, 0);
    assert_eq!(out, input);
}
#[test]
fn overlapping_two_hop_side_windows_are_explicitly_unsupported() {
    let mut points = simple_points(&[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]);
    points.protect_edge(0, 1);
    let live = LiveMesh::new(&points, &[0, 1, 2, 1, 0, 3, 0, 2, 3, 1, 3, 2]);
    assert_eq!(
        paired_windows(&points, &live, &[0, 1]),
        Err(Stop::Unsupported)
    );
}
#[test]
fn descent_cannot_introduce_an_outside_or_stale_protected_diagonal() {
    let (tree, features, cases) = housing();
    for protected_record in [false, true] {
        let (mut points, input) = patch(&cases["cases"][0]);
        let old: Vec<Tri> = input.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
        let frozen = contract(&tree, &features, &points, &old, 0.01).unwrap();
        let blocked = edge(3, 6);
        assert!(!edges(&old).contains_key(&blocked));
        let outside = if protected_record {
            points.protect_edge(3, 6);
            BTreeSet::new()
        } else {
            BTreeSet::from([blocked])
        };
        let mut report = NormalRepairReport::default();
        let result = descend(
            &tree,
            &features,
            &points,
            &old,
            &outside,
            0.01,
            &frozen,
            &mut report,
            MAX_FLIPS,
            MAX_SCORES,
            &points.geometric_ranks(),
        );
        assert!(report.trials > 0);
        if let Ok((candidate, _)) = result {
            assert!(!edges(&candidate).contains_key(&blocked));
        }
    }
}
#[test]
fn the_withdrawn_center_fan_cannot_hide_bad_companion_children() {
    let (tree, features, cases) = housing();
    let (mut points, input) = patch(&cases["cases"][1]);
    let old: Vec<Tri> = input.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
    let frozen = contract(&tree, &features, &points, &old, 0.01).unwrap();
    let parent = old[3];
    let p = geometry(&points, parent);
    let center = q::project(&tree, q::bary(p, [1. / 3.; 3]), 0.01, 0.000001).unwrap();
    let m = points.add(center[0], center[1], center[2], 0., 0., 1.);
    let children = [
        [parent[0], parent[1], m],
        [parent[1], parent[2], m],
        [parent[2], parent[0], m],
    ];
    let centroid_errors: Vec<_> = children
        .iter()
        .map(|&t| {
            let p = geometry(&points, t);
            let root = q::project(&tree, q::bary(p, [1. / 3.; 3]), 0.01, 0.000001).unwrap();
            angle(q::normal(p), tree.field_sample(root).gradient).unwrap()
        })
        .collect();
    eprintln!("withdrawn center fan centroid errors={centroid_errors:?}");
    assert!(centroid_errors.iter().any(|&a| a < frozen.gate));
    assert!(centroid_errors.iter().any(|&a| a > 20.));
    assert!(children
        .iter()
        .any(|&t| score(&tree, &features, &points, t, 0.01, &frozen)
            .map_or(true, |a| a > frozen.gate)));
}
#[test]
fn shared_assembly_runs_normal_repair_after_each_geometry_route() {
    let (tree, features, cases) = housing();
    for flags in [0, 8, 1, 2, 4, 7] {
        let (mut points, input) = paired_patch(&cases);
        let tuning = super::super::pipeline::PipelineTuning {
            quality_triangulation: flags & 1 != 0,
            quality_refinement: flags & 2 != 0,
            quality_remeshing: flags & 4 != 0,
            quality_audit: flags & 8 != 0,
            ..Default::default()
        };
        let (out, _, audit) = super::super::assembly::finish(
            &tree,
            &features,
            &mut points,
            &input,
            0.191015625,
            &tuning,
            None,
        );
        eprintln!(
            "assembly flags={flags} normal report={:?}",
            points.normal_repair
        );
        assert!(points.normal_repair.checked);
        assert_eq!(points.normal_repair.accepted, 1);
        assert_eq!(points.normal_repair.flips, 3);
        assert_eq!(out.len(), input.len());
        assert_eq!(audit.is_some(), flags != 0);
    }
}

// Uses existing production field queries, not a separate reference evaluator.
#[test]
fn a_third_exposed_carrier_cannot_hide_the_chosen_source_normal_error() {
    use crate::sdf::{leaf_at, Shape};
    let half = 4.;
    let make_box = |rotation: [f64; 9]| {
        let CsgNode::Leaf(mut leaf) = leaf_at(Shape::Cuboid { half: [half; 3] }, [0., 0., -half])
        else {
            unreachable!()
        };
        leaf.sim.r = rotation;
        CsgNode::Leaf(leaf)
    };
    // All three finite boxes have a top plane through the origin. A has +z
    // normal; B has (0,.6,.8), giving a derived half-jump gate ~18.435 degrees.
    // C has (sqrt(.5),0,sqrt(.5)), 45 degrees from A. The A/B crease is exposed
    // at x<0,y=z=0. C supplies the full-scene boundary at tiny x>0,z=-x.
    let c = std::f64::consts::FRAC_1_SQRT_2;
    let tree = CsgNode::Max(vec![
        make_box([1., 0., 0., 0., 1., 0., 0., 0., 1.]),
        make_box([1., 0., 0., 0., 0.8, 0.6, 0., -0.6, 0.8]),
        make_box([c, 0., c, 0., 1., 0., -c, 0., c]),
    ]);
    let tolerance = 0.01;
    let tol = crate::tolerances::resolve_tolerances(&crate::tuning::SfccTuning::default(), 32.);
    let (features, _) = super::super::feature_set::compile_feature_set(&tree, &tol);
    let edge_point = [-1., 0., 0.];
    let a = features
        .strata
        .iter()
        .position(|s| {
            s.leaf_index == 0 && s.normal(edge_point[0], edge_point[1], edge_point[2])[2] > 0.99
        })
        .expect("actual compiled A top carrier");
    let b = features
        .strata
        .iter()
        .position(|s| {
            let n = s.normal(edge_point[0], edge_point[1], edge_point[2]);
            s.leaf_index == 1 && n[1] > 0.59 && n[2] > 0.79
        })
        .expect("actual compiled B top carrier");
    assert!(exposed(&tree, edge_point, tolerance * 0.01));
    assert!(carrier_contains(
        &features,
        a,
        edge_point,
        tolerance * 0.001
    ));
    assert!(carrier_contains(
        &features,
        b,
        edge_point,
        tolerance * 0.001
    ));
    let n_a = features.strata[a].normal(edge_point[0], edge_point[1], edge_point[2]);
    let n_b = features.strata[b].normal(edge_point[0], edge_point[1], edge_point[2]);
    let frozen = Contract {
        gate: (angle(n_a, n_b).unwrap() / 2.).max(2.),
        supports: vec![([a, b], 0)],
    };
    assert!(frozen.gate > 18. && frozen.gate < 19.);

    let d = 0.000002;
    let mut points = PointTable::new();
    for p in [[d, -0.5, -d], [2. * d, -0.5, -2. * d], [d, -0.49, -d]] {
        points.add(p[0], p[1], p[2], c, 0., c);
    }
    let triangle = [0, 1, 2];
    let p = geometry(&points, triangle);
    assert!(q::valid_orientation(p, q::normal(p)));
    // Every declared core reference has unique APPROXIMATE A/B containment:
    // A's field is within the existing epsilon, B is far inside. Full-field
    // gradient is actually C, and its dot with A is positive. The old score
    // using full-field normals alone would accept this triangle.
    for p in [p, p.map(q::rounded)] {
        for weights in NORMAL_SITES {
            let root =
                q::project(&tree, q::bary(p, weights), tolerance, tolerance * 0.0001).unwrap();
            assert_eq!(
                source_side(&tree, &features, [a, b], root, tolerance),
                Ok(0)
            );
            let full = tree.field_sample(root);
            assert!(q::dot(n_a, full.gradient) > 0.);
            assert!(angle(q::normal(p), full.gradient).unwrap() < 0.001);
        }
    }
    // No new threshold is needed: the SAME source-derived gate rejects the
    // chosen-source normal error. This is a finite compatibility control,
    // not a claim to identify a unique branch at all nearby points.
    let result = score(&tree, &features, &points, triangle, tolerance, &frozen).unwrap();
    assert!(result > 40. && result > frozen.gate);
}

#[test]
fn malformed_protected_endpoints_are_unresolved_before_geometric_seed_sorting() {
    let (tree, features, cases) = housing();
    let (mut points, input) = paired_patch(&cases);
    points.protect_edge(0, usize::MAX);
    let protected_before: BTreeSet<_> = points.protected_edges().collect();
    let metadata_before = metadata(&points);
    let (out, report) = repair(&tree, &features, &mut points, &input, 0.01);
    assert_eq!(out, input);
    assert_eq!(
        points.protected_edges().collect::<BTreeSet<_>>(),
        protected_before
    );
    assert_eq!(metadata(&points), metadata_before);
    assert_eq!(report.unsupported, report.seeds);
    assert_eq!(report.accepted, 0);
    assert!(report.incomplete());
}

#[test]
fn chart_sample_bits_and_endpoint_associations_survive_interval_reversal() {
    // Actual hidden-fine WASM feature records: the old directional formula
    // differs by one or two f64 ULPs at the same physical sample.
    for (start, end) in [
        (0_f64, 0.02187132584629744),
        (0.02186360638696719, 0.05373860638696719),
    ] {
        let old_forward = start + 0.25 * (end - start);
        let old_reverse = end + 0.75 * (start - end);
        assert_ne!(old_forward.to_bits(), old_reverse.to_bits());
        let forward = chart_samples(start, end);
        let reverse = chart_samples(end, start);
        assert_eq!(
            forward.map(|(t, _)| t.to_bits()),
            reverse.map(|(t, _)| t.to_bits())
        );
        assert_eq!(forward[0], (start, Some(0)));
        assert_eq!(forward[4], (end, Some(1)));
        assert_eq!(reverse[0], (start, Some(1)));
        assert_eq!(reverse[4], (end, Some(0)));
    }
}

#[test]
fn actual_chart_checks_and_alias_order_ignore_reversed_worker_endpoint_ids() {
    let scene = r#"{"kind":"union","children":[{"kind":"box","pos":[-50,0,0],"half":[50,100,100]},{"kind":"sphere","pos":[0.04125955406450752,1.53,1.53],"r":0.01650382162580301}]}"#;
    let tree = crate::scene_bridge::build_csg_tree_from_json(scene).unwrap();
    let tuning = crate::tuning::SfccTuning {
        surface_tol_mm: 1e-5,
        ..Default::default()
    };
    let tol = crate::tolerances::resolve_tolerances(&tuning, 200. * 3_f64.sqrt());
    let (features, _) = super::super::feature_set::compile_feature_set(&tree, &tol);
    let actual = [[-100., -100., -100.], [-100., -100., -95.625732421875]];
    let sets = [
        vec![(0., 0.02187132584629744)],
        vec![(0., 0.04), (0.01, 0.02)],
    ];
    for intervals in sets {
        let mut counts = Vec::new();
        for reverse in [false, true] {
            let positions = if reverse {
                [actual[1], actual[0]]
            } else {
                actual
            };
            let mut points = simple_points(&positions);
            for &(start, end) in &intervals {
                let (start, end) = if reverse { (end, start) } else { (start, end) };
                points.protect_curve_edge(
                    0,
                    1,
                    CurveInterval {
                        curve_id: 2,
                        start,
                        end,
                    },
                );
            }
            let before = metadata(&points);
            let mut report = NormalRepairReport::default();
            let result = super::obligations(&tree, &features, &points, (0, 1), 1e-5, &mut report);
            assert!(
                matches!(result, Err(Stop::Unsupported)),
                "rounded endpoint stays outside the original1e-8 chart guard"
            );
            assert_eq!(metadata(&points), before);
            counts.push(report.chart_observations);
        }
        assert_eq!(
            counts,
            vec![5, 5],
            "same actual source premises and first failing endpoint in both point-table orders"
        );
    }
}
