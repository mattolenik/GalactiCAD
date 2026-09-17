use gcad_kernel::{
    sdf::{leaf_at, Shape},
    sfcc::{
        feature_chain::audit_feature_chains,
        feature_set::compile_feature_set,
        pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube},
        point_table::{CurveInterval, PointTable},
    },
    tolerances::resolve_tolerances,
    tuning::SfccTuning,
};

#[test]
fn native_box_compiled_features_survive_as_complete_chains() {
    let tree = leaf_at(Shape::Cuboid { half: [1.; 3] }, [0.; 3]);
    let result = run_sfcc_pipeline(
        &tree,
        &SfccWorldCube { min_x: -2., min_y: -2., min_z: -2., size: 4. },
        &PipelineTuning { depth_min: 3, depth_max: 5, ..Default::default() },
    );
    let report = result.validation.feature_chains.unwrap();
    assert!(report.passed(), "{report:?}");
}

#[test]
fn chain_audit_detects_a_removed_or_misassigned_interval_without_changing_triangles() {
    let tree = leaf_at(Shape::Cuboid { half: [1.; 3] }, [0.; 3]);
    let (mut features, _) = compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 4.));
    features.curves.truncate(1);
    let curve = &features.curves[0];
    let mut points = PointTable::new();
    let ids: Vec<_> = [0., 0.5, 1.]
        .into_iter()
        .map(|t| {
            let p = curve.point_at(t);
            points.add(p[0], p[1], p[2], 0., 1., 0.)
        })
        .collect();
    let q = points.add(0., 0., 0., 0., 1., 0.);
    let tris = [ids[0], ids[1], q, ids[1], ids[2], q];
    let interval = CurveInterval { curve_id: 0, start: 0., end: 0.5 };
    points.protect_curve_edge(ids[0], ids[1], interval);
    let missing = audit_feature_chains(&points, &tris, &features, 0.002);
    assert!(!missing.passed());
    assert!(missing.interval_gaps > 0);
    points.protect_curve_edge(ids[1], ids[2], CurveInterval { start: 0.5, end: 1., ..interval });
    assert!(audit_feature_chains(&points, &tris, &features, 0.002).passed());
    points.protect_curve_edge(ids[0], q, CurveInterval { start: 0., end: 1., ..interval });
    let mislabeled = audit_feature_chains(&points, &tris, &features, 0.002);
    assert!(!mislabeled.passed());
    assert!(mislabeled.off_curve_edges > 0);
}

#[test]
fn lifted_box_crease_survives_a_three_operand_partner_switch() {
    use gcad_kernel::{
        primitives::smin::SminMode,
        sdf::{BlendKind, CsgNode},
    };
    // In this neighborhood a=max(x,z), b=y-.6, c=-y-.6. Smax
    // chamfer's zero locus along a's crease is x=z=-.4-|y|.
    let tree = CsgNode::Blend {
        kind: BlendKind::Smax,
        mode: SminMode::Chamfer,
        r: 1.,
        n: 4.,
        children: vec![
            leaf_at(Shape::Cuboid { half: [10.; 3] }, [-10., 0., -10.]),
            leaf_at(Shape::Cuboid { half: [10.; 3] }, [0., -9.4, 0.]),
            leaf_at(Shape::Cuboid { half: [10.; 3] }, [0., 9.4, 0.]),
        ],
    };
    let (features, _) = compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 40.));
    assert!(features.unresolved_branch_paths.is_empty());
    let center = [-0.4, 0., -0.4];
    let junction =
        features.corners.iter().find(|c| (c.x - center[0]).hypot(c.y).hypot(c.z - center[2]) < 0.002);
    assert!(
        junction.is_some_and(|c| c.curve_ends.len() >= 4),
        "missing four-way partner/box junction: {junction:?}"
    );
    for i in -20..=20 {
        let y = i as f64 * 0.01;
        let p = [-0.4 - y.abs(), y, -0.4 - y.abs()];
        assert!(tree.f(p).abs() < 1e-12, "independent equation at {p:?}");
        let gap = features.curves.iter().map(|c| c.project(p[0], p[1], p[2]).1).fold(f64::INFINITY, f64::min);
        assert!(gap < 0.002, "partner switch lost arc at {p:?}: {gap}");
    }
    let mesh = run_sfcc_pipeline(
        &tree,
        &SfccWorldCube { min_x: -22., min_y: -22., min_z: -22., size: 44. },
        &PipelineTuning { depth_min: 4, depth_max: 7, ..Default::default() },
    );
    let position = |id: u32| std::array::from_fn::<_, 3, _>(|k| mesh.verts[id as usize * 8 + k] as f64);
    let on_arc = |p: [f64; 3]| {
        p[1].abs() < 0.4 && (p[0] - p[2]).abs() < 0.002 && (p[0] + 0.4 + p[1].abs()).abs() < 0.002
    };
    let edges: Vec<_> =
        mesh.feature_edges.iter().filter(|e| e.vertices.iter().all(|&id| on_arc(position(id)))).collect();
    for i in -20..=20 {
        let y = i as f64 * 0.01;
        let p = [-0.4 - y.abs(), y, -0.4 - y.abs()];
        let gap = edges
            .iter()
            .map(|e| {
                let a = position(e.vertices[0]);
                let b = position(e.vertices[1]);
                let d: [f64; 3] = std::array::from_fn(|k| b[k] - a[k]);
                let t = ((0..3).map(|k| (p[k] - a[k]) * d[k]).sum::<f64>()
                    / d.iter().map(|v| v * v).sum::<f64>())
                .clamp(0., 1.);
                (0..3).map(|k| (p[k] - a[k] - t * d[k]).powi(2)).sum::<f64>().sqrt()
            })
            .fold(f64::INFINITY, f64::min);
        assert!(gap < 0.002, "expected arc missing from labeled final mesh at {p:?}: {gap}");
    }
    let mut graph = std::collections::BTreeMap::<u32, std::collections::BTreeSet<u32>>::new();
    for e in edges {
        let [a, b] = e.vertices;
        graph.entry(a).or_default().insert(b);
        graph.entry(b).or_default().insert(a);
    }
    let mut stack = vec![*graph.keys().next().unwrap()];
    let mut seen = std::collections::BTreeSet::new();
    while let Some(id) = stack.pop() {
        if seen.insert(id) {
            stack.extend(&graph[&id]);
        }
    }
    assert_eq!(seen.len(), graph.len(), "the two sides of the partner switch must share a mesh junction");
}

#[test]
fn simultaneous_loft_profile_switches_have_complete_inset_arcs() {
    use gcad_kernel::{
        primitives::smin::SminMode,
        sdf::{BlendKind, CsgNode},
    };
    for extra_vertex in [false, true] {
        let mut upper = vec![-3., -3., 3., -3., 3., 3., -3., 3.];
        if extra_vertex {
            upper = vec![-3., -3., 0., -3., 3., -3., 3., 3., -3., 3.];
        }
        let leaf = leaf_at(
            Shape::Loft {
                profs: vec![vec![-2., -2., 2., -2., 2., 2., -2., 2.], upper],
                winds: vec![-1., -1.],
                h: 2.,
            },
            [0.; 3],
        );
        let tree = CsgNode::Blend {
            kind: BlendKind::Smax,
            mode: SminMode::Chamfer,
            r: 0.8,
            n: 4.,
            children: vec![leaf.clone(), leaf],
        };
        let (features, _) = compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 12.));
        assert!(features.unresolved_branch_paths.is_empty());
        // Both profiles are interior here; above y=-.4 the lower square
        // uses its smooth exterior corner distance, so max(x,z)-2 is invalid.
        for i in 0..=10 {
            let y = -1.5 + i as f64 * 0.1;
            let x = 2.1 + y * 0.25;
            for sx in [-1., 1.] {
                for sz in [-1., 1.] {
                    let p = [sx * x, y, sz * x];
                    assert!(tree.f(p).abs() < 1e-12);
                    let gap = features
                        .curves
                        .iter()
                        .map(|c| c.project(p[0], p[1], p[2]).1)
                        .fold(f64::INFINITY, f64::min);
                    assert!(gap < 0.002, "loft extra={extra_vertex} at {p:?}: {gap}");
                }
            }
        }
    }
}

#[test]
fn removing_a_label_fails_coverage_while_the_closed_mesh_is_unchanged() {
    use gcad_kernel::sfcc::manifold_check::check_manifold;
    let tree = leaf_at(Shape::Cuboid { half: [1.; 3] }, [0.; 3]);
    let result = run_sfcc_pipeline(
        &tree,
        &SfccWorldCube { min_x: -2., min_y: -2., min_z: -2., size: 4. },
        &PipelineTuning { depth_min: 3, depth_max: 5, ..Default::default() },
    );
    assert!(check_manifold(&result.tris, true).ok);
    let (features, _) =
        compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 4. * 3f64.sqrt()));
    let mut points = PointTable::new();
    for v in result.verts.chunks_exact(8) {
        points.add(v[0] as f64, v[1] as f64, v[2] as f64, v[4] as f64, v[5] as f64, v[6] as f64);
    }
    let tris: Vec<_> = result.tris.iter().map(|&i| i as usize).collect();
    for edge in result.feature_edges.iter().skip(1) {
        points.protect_curve_edge(edge.vertices[0] as usize, edge.vertices[1] as usize, edge.interval);
    }
    let report = audit_feature_chains(&points, &tris, &features, 0.002);
    assert!(!report.passed());
    assert!(report.interval_gaps > 0 || report.missing_curves > 0);
}

#[test]
fn loft_height_knot_remains_an_exposed_feature_after_displacement() {
    use gcad_kernel::{
        primitives::smin::SminMode,
        sdf::{BlendKind, CsgNode},
    };
    let square = |r: f64| vec![-r, -r, r, -r, r, r, -r, r];
    let loft = leaf_at(
        Shape::Loft { profs: vec![square(2.), square(3.), square(2.)], winds: vec![-1.; 3], h: 3. },
        [0.; 3],
    );
    let tree = CsgNode::Blend {
        kind: BlendKind::Smax,
        mode: SminMode::Chamfer,
        r: 0.8,
        n: 4.,
        children: vec![loft.clone(), loft],
    };
    let (features, _) = compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 12.));
    for i in -10..=10 {
        let p = [2.6, 0., i as f64 * 0.1];
        assert!(tree.f(p).abs() < 1e-12);
        let gap = features.curves.iter().map(|c| c.project(p[0], p[1], p[2]).1).fold(f64::INFINITY, f64::min);
        assert!(gap < 0.002, "height-knot crease missing at {p:?}: {gap}");
        let (_, a) = tree.grad([2.6 - 1e-5 / 3., -1e-5, p[2]]);
        let (_, b) = tree.grad([2.6 - 1e-5 / 3., 1e-5, p[2]]);
        assert!(a[1] * b[1] < 0., "independent one-sided normal jump");
    }
}
