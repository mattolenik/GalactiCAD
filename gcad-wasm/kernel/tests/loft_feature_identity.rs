//! Equivalent profile fields must share one feature representation, without
//! changing the source loft used by blends or its worker-side reconstruction.
use gcad_kernel::{
    primitives::smin::SminMode,
    scene_bridge::{build_csg_tree, BridgeNode},
    sdf::{self, BlendKind, CsgNode, Shape},
    sfcc::{
        feature_curves::CurveKind,
        feature_set::{compile_feature_set, compile_native_features, SfccFeatureSet},
        pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube},
        worker,
    },
    strata::CarrierKind,
    tolerances::resolve_tolerances,
    tuning::SfccTuning,
};
use std::collections::BTreeSet;

fn loft(profiles: Vec<Vec<[f64; 2]>>) -> CsgNode {
    build_csg_tree(&BridgeNode::Loft {
        node_id: 0,
        pos: [0.; 3],
        profiles,
        h: 2.,
    })
    .unwrap()
}
fn square() -> Vec<[f64; 2]> {
    vec![[-2., -2.], [2., -2.], [2., 2.], [-2., 2.]]
}
fn equivalent_stack(count: usize, start: usize, reversed: bool) -> CsgNode {
    loft(
        (0..count)
            .map(|i| {
                let mut p = square();
                p.rotate_left((start + i) % 4);
                if (i % 2 == 0) == reversed {
                    p.reverse();
                }
                p
            })
            .collect(),
    )
}
fn features(tree: &CsgNode) -> SfccFeatureSet {
    compile_feature_set(
        tree,
        &resolve_tolerances(&SfccTuning::default(), 4. * 3_f64.sqrt()),
    )
    .0
}

fn compiled_length(fs: &SfccFeatureSet) -> f64 {
    fs.curves
        .iter()
        .map(|c| {
            c.index_polyline
                .windows(6)
                .step_by(3)
                .map(|p| (p[3] - p[0]).hypot(p[4] - p[1]).hypot(p[5] - p[2]))
                .sum::<f64>()
        })
        .sum()
}
fn check_cube_edges(fs: &SfccFeatureSet) {
    assert_eq!(fs.curves.len(), 12);
    assert_eq!(fs.corners.len(), 8);
    assert_eq!(fs.strata.len(), 6);
    let mut unique = BTreeSet::new();
    for curve in &fs.curves {
        assert_eq!(curve.kind(), CurveKind::Segment);
        let a = curve.point_at(curve.t_min);
        let b = curve.point_at(curve.t_max);
        let varying: Vec<_> = (0..3).filter(|&k| a[k] != b[k]).collect();
        assert_eq!(
            varying.len(),
            1,
            "not a straight cuboid edge: {a:?} -> {b:?}"
        );
        let axis = varying[0];
        assert_eq!((a[axis] - b[axis]).abs(), 4.);
        assert!(a.iter().chain(&b).all(|v| v.abs() == 2.));
        let key = (axis, a[(axis + 1) % 3] as i32, a[(axis + 2) % 3] as i32);
        assert!(unique.insert(key), "duplicate cuboid edge {key:?}");
        for t in [0.25, 0.5, 0.75] {
            let p = curve.point_at(t);
            for &id in &curve.adjacent_strata {
                assert!(fs.strata[id].f(p[0], p[1], p[2]).abs() < 1e-12);
                assert!(fs.strata[id].domain_contains(p, 1e-8));
            }
        }
        for (end, id) in [(0, curve.corner_start), (1, curve.corner_end)] {
            assert!(id >= 0);
            assert!(fs.corners[id as usize]
                .curve_ends
                .contains(&(curve.id, end)));
        }
    }
    assert!(fs
        .corners
        .iter()
        .all(|c| c.curve_ends.len() == 3 && c.strata.len() == 3));
}

#[test]
fn cyclic_and_reversed_constant_lofts_have_exactly_the_twelve_cube_edges() {
    let native_fingerprint = compile_native_features(&equivalent_stack(2, 0, false)).fingerprint();
    for count in [2, 3, 5] {
        for start in 0..4 {
            for reverse in [false, true] {
                let tree = equivalent_stack(count, start, reverse);
                let CsgNode::Leaf(leaf) = &tree else {
                    panic!("loft leaf")
                };
                assert!(matches!(&leaf.shape, Shape::Loft { profs, .. } if profs.len() == count));
                assert_eq!(leaf.strata.len(), 6);
                for p in [
                    [0_f64; 3],
                    [3., 3., 3.],
                    [-3., -4., 0.],
                    [1., 0.3, 2.4],
                    [2., -2., 2.],
                ] {
                    let (x, z) = (p[0].abs() - 2., p[2].abs() - 2.);
                    let profile = x.max(0.).hypot(z.max(0.)) + x.max(z).min(0.);
                    let expected = profile.max(p[1].abs() - 2.);
                    assert!(
                        (tree.f(p) - expected).abs() < 1e-12,
                        "off-surface loft field changed at {p:?}"
                    );
                }
                let native = compile_native_features(&tree);
                check_cube_edges(&native);
                assert_eq!(native.fingerprint(), native_fingerprint);
                check_cube_edges(&features(&tree));
            }
        }
    }
}

#[test]
fn nonidentical_and_differing_topology_profiles_keep_their_own_fields() {
    let mut near = square();
    for p in &mut near {
        p[0] += 1e-7;
    }
    let tree = loft(vec![square(), near]);
    let CsgNode::Leaf(leaf) = &tree else {
        panic!("loft leaf")
    };
    assert!(leaf.strata[..4]
        .iter()
        .any(|s| s.kind == CarrierKind::LoftSide));
    assert!((tree.f([2., 0., 0.]) + 0.5e-7).abs() < 1e-12);

    let triangle = vec![[0., 0.], [2., 0.], [2., 2.]];
    let top = vec![[0., 0.], [2., 0.], [2., 2.], [0., 2.]];
    for start in 0..4 {
        let mut upper = top.clone();
        upper.rotate_left(start);
        let tree = loft(vec![triangle.clone(), upper]);
        let expected = 0.2 * (1.8 - 0.2) / 2_f64.sqrt() - 0.8 * 0.2;
        assert!((tree.f([0.2, 1.2, 1.8]) - expected).abs() < 1e-12);
        let fs = features(&tree);
        for (profile, y) in [(&triangle, -2.), (&top, 2.)] {
            for (i, a) in profile.iter().enumerate() {
                let b = profile[(i + 1) % profile.len()];
                let p = [(a[0] + b[0]) * 0.5, y, (a[1] + b[1]) * 0.5];
                assert!(
                    fs.curves
                        .iter()
                        .any(|c| c.project(p[0], p[1], p[2]).1 < 1e-5),
                    "missing nonidentical profile rim at {p:?}"
                );
            }
        }
    }
}

#[test]
fn equivalent_profile_branches_preserve_a_displaced_chamfer_crease() {
    let tree = CsgNode::Blend {
        kind: BlendKind::Smax,
        mode: SminMode::Chamfer,
        r: 1.,
        n: 4.,
        children: vec![
            equivalent_stack(3, 1, true),
            sdf::leaf_at(
                Shape::Cuboid {
                    half: [10., 0.6, 10.],
                },
                [0.; 3],
            ),
        ],
    };
    let fs = features(&tree);
    assert!(fs.unresolved_branch_paths.is_empty());
    for y in [-0.2_f64, 0., 0.2] {
        let inset = 1.6 - y.abs();
        for x in [-inset, inset] {
            for z in [-inset, inset] {
                let p = [x, y, z];
                assert!(tree.f(p).abs() < 1e-12, "independent inset equation");
                assert!(
                    fs.curves
                        .iter()
                        .any(|c| c.project(p[0], p[1], p[2]).1 < 0.002),
                    "lost displaced crease {p:?}"
                );
            }
        }
    }
}

#[test]
fn constant_loft_mesh_and_worker_metadata_preserve_unique_edge_coverage() {
    let tree = equivalent_stack(3, 2, true);
    let cube = SfccWorldCube {
        min_x: -2.,
        min_y: -2.,
        min_z: -2.,
        size: 4.,
    };
    let tuning = PipelineTuning::default();
    let started = std::time::Instant::now();
    let mesh = run_sfcc_pipeline(&tree, &cube, &tuning);
    eprintln!(
        "constant loft native: {} triangles, {} unresolved cells, {} ms",
        mesh.tris.len() / 3,
        mesh.validation.unresolved_cells,
        started.elapsed().as_millis()
    );
    assert!(mesh.manifold.ok, "{:?}", mesh.validation);
    assert_eq!(mesh.stats.failed_cells, 0);
    assert_eq!(mesh.stats.feature_cell_fallbacks, 0);
    let leaves = worker::prepare(&tree, &cube, &tuning);
    let partials: Vec<_> = (0..4)
        .map(|i| worker::mesh_partition(&tree, &cube, &tuning, &leaves, i, 4))
        .collect();
    let merged = worker::merge(&tree, &cube, &tuning, &partials);
    assert!(
        merged.manifold.ok && !merged.serial_recovery,
        "{:?}",
        merged.validation
    );
    assert_eq!(
        merged.validation.unresolved_cells,
        mesh.validation.unresolved_cells
    );
    for validation in [&mesh.validation, &merged.validation] {
        assert!(validation.feature_chains.as_ref().unwrap().passed());
        // Conservative loft intervals can leave same-sign boxes unresolved.
        // This test establishes feature preservation, not discovery completion.
        assert_eq!(
            validation.status(),
            if validation.unresolved_cells > 0 {
                "incomplete"
            } else {
                "passed"
            }
        );
    }
    for (verts, edges) in [
        (&mesh.verts, &mesh.feature_edges),
        (&merged.verts, &merged.feature_edges),
    ] {
        assert_eq!(
            edges
                .iter()
                .map(|e| e.interval.curve_id)
                .collect::<BTreeSet<_>>()
                .len(),
            12
        );
        let length: f64 = edges
            .iter()
            .map(|e| {
                let a = e.vertices[0] as usize * 8;
                let b = e.vertices[1] as usize * 8;
                (verts[a] as f64 - verts[b] as f64)
                    .hypot(verts[a + 1] as f64 - verts[b + 1] as f64)
                    .hypot(verts[a + 2] as f64 - verts[b + 2] as f64)
            })
            .sum();
        assert!(
            (length - 48.).abs() < 1e-5,
            "duplicate or missing mesh edge coverage: {length}"
        );
    }
}

#[test]
fn hard_box_duplicates_and_overlaps_cover_the_exposed_creases_once() {
    for offset in [0., 2.] {
        let tree = build_csg_tree(&BridgeNode::Union {
            node_id: 0,
            radius: 0.,
            mode: None,
            n: None,
            children: vec![
                BridgeNode::Box {
                    node_id: 1,
                    pos: [0.; 3],
                    half: [2.; 3],
                },
                BridgeNode::Box {
                    node_id: 2,
                    pos: [0., offset, 0.],
                    half: [2.; 3],
                },
            ],
        })
        .unwrap();
        let fs = features(&tree);
        let expected = 48. + 4. * offset;
        assert!(
            (compiled_length(&fs) - expected).abs() < 1e-5,
            "offset {offset}: {} curves, length {}, expected {expected}",
            fs.curves.len(),
            compiled_length(&fs)
        );
        // Each midpoint of each expected atomic interval must be represented
        // exactly once; total length alone could trade an omission for a copy.
        for y in [-1., 1., 3.].into_iter().filter(|&y| y < 2. + offset) {
            for x in [-2., 2.] {
                for z in [-2., 2.] {
                    assert_eq!(
                        fs.curves
                            .iter()
                            .filter(|c| c.project(x, y, z).1 < 1e-7)
                            .count(),
                        1,
                        "vertical edge coverage at {:?}",
                        [x, y, z]
                    );
                }
            }
        }
        for y in [-2., 2. + offset] {
            for along_x in [true, false] {
                for side in [-2., 2.] {
                    let p = if along_x {
                        [0., y, side]
                    } else {
                        [side, y, 0.]
                    };
                    assert_eq!(
                        fs.curves
                            .iter()
                            .filter(|c| c.project(p[0], p[1], p[2]).1 < 1e-7)
                            .count(),
                        1,
                        "cap edge coverage at {p:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn nearby_disjoint_collinear_edges_retain_their_gap() {
    let tree = build_csg_tree(&BridgeNode::Union {
        node_id: 0,
        radius: 0.,
        mode: None,
        n: None,
        children: vec![
            BridgeNode::Box {
                node_id: 1,
                pos: [0.; 3],
                half: [0.0005, 2., 2.],
            },
            BridgeNode::Box {
                node_id: 2,
                pos: [0.0015, 0., 0.],
                half: [0.0005, 2., 2.],
            },
        ],
    })
    .unwrap();
    let fs = features(&tree);
    assert!((compiled_length(&fs) - 64.008).abs() < 1e-5);
    for y in [-2., 2.] {
        for z in [-2., 2.] {
            for x in [0., 0.0015] {
                assert_eq!(
                    fs.curves
                        .iter()
                        .filter(|c| c.project(x, y, z).1 < 1e-8)
                        .count(),
                    1
                );
            }
            assert!(
                fs.curves
                    .iter()
                    .all(|c| c.project(0.00075, y, z).1 > 0.0002),
                "bridged a real gap"
            );
        }
    }
}

#[test]
fn identical_cylinders_have_two_unique_closed_rims() {
    let cylinder = || BridgeNode::Cylinder {
        node_id: 0,
        pos: [0.; 3],
        r: 2.,
        h: 2.,
        fillet_top: 0.,
        fillet_bottom: 0.,
        chamfer_top: 0.,
        chamfer_bottom: 0.,
    };
    let tree = build_csg_tree(&BridgeNode::Union {
        node_id: 0,
        children: vec![cylinder(), cylinder()],
        radius: 0.,
        mode: None,
        n: None,
    })
    .unwrap();
    let fs = features(&tree);
    assert_eq!(
        fs.curves.len(),
        2,
        "duplicate cylindrical rim representations"
    );
    assert!(fs.corners.is_empty());
    for y in [-2., 2.] {
        for i in 0..16 {
            let angle = i as f64 * std::f64::consts::TAU / 16.;
            let p = [2. * angle.cos(), y, 2. * angle.sin()];
            assert_eq!(
                fs.curves
                    .iter()
                    .filter(|c| c.project(p[0], p[1], p[2]).1 < 1e-8)
                    .count(),
                1
            );
        }
    }
    for curve in &fs.curves {
        assert_eq!(curve.kind(), CurveKind::Circle);
        assert!(curve.closed);
        let quarter = curve.t_min + (curve.t_max - curve.t_min) * 0.25;
        assert!((curve.param_distance(curve.t_min, quarter) - std::f64::consts::PI).abs() < 1e-10);
    }
}
