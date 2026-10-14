use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::scene_bridge::{build_csg_tree, BridgeNode};
use gcad_kernel::sfcc::feature_curves::{make_circle_curve, make_segment_curve};
use gcad_kernel::sfcc::feature_set::{build_leaf_strata, compile_feature_set};
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::tree::build_tree;
use gcad_kernel::sfcc::trim::trim_curve;
use gcad_kernel::tolerances::resolve_tolerances;
use gcad_kernel::tuning::SfccTuning;

fn box_node(pos: [f64; 3], half: [f64; 3]) -> BridgeNode {
    BridgeNode::Box {
        node_id: 0,
        pos,
        half,
    }
}

fn intersect(a: BridgeNode, b: BridgeNode) -> BridgeNode {
    BridgeNode::Intersect {
        node_id: 0,
        lh: Box::new(a),
        rh: Box::new(b),
        radius: 0.,
        mode: None,
        n: None,
    }
}

fn gap(features: &gcad_kernel::sfcc::feature_set::SfccFeatureSet, p: [f64; 3]) -> f64 {
    features
        .curves
        .iter()
        .map(|c| c.project(p[0], p[1], p[2]).1)
        .fold(f64::INFINITY, f64::min)
}

#[test]
fn hard_box_exposure_is_independent_of_carrier_length_phase_and_similarity() {
    let tol = resolve_tolerances(&SfccTuning::default(), 10.);
    for length in [10_f64, 5000., 500000.] {
        let spacing = 2. * length / (2. * length / tol.probe_delta).ceil().min(2048.);
        for center in [0., spacing * 0.5] {
            for transformed in [false, true] {
                let mut node = intersect(
                    box_node([0.; 3], [2., length, 2.]),
                    box_node([0., center, 0.], [20., 2., 20.]),
                );
                let mut sim = Similarity::identity();
                if transformed {
                    let fwd = [0.6, 0.8, 0., -0.8, 0.6, 0., 0., 0., 1.];
                    node = BridgeNode::Rotate {
                        node_id: 0,
                        fwd,
                        arg: Box::new(node),
                    };
                    node = BridgeNode::Scale {
                        node_id: 0,
                        sx: 1.25,
                        sy: 1.25,
                        sz: 1.25,
                        arg: Box::new(node),
                    };
                    node = BridgeNode::Translate {
                        node_id: 0,
                        d: [0.75, -1.25, 2.5],
                        arg: Box::new(node),
                    };
                    sim = Similarity {
                        r: [0.6, -0.8, 0., 0.8, 0.6, 0., 0., 0., 1.],
                        t: [0.75, -1.25, 2.5],
                        s: 1.25,
                    };
                }
                let tree = build_csg_tree(&node).unwrap();
                let (features, diagnostics) = compile_feature_set(&tree, &tol);
                assert_eq!(
                    diagnostics.unresolved_trims, 0,
                    "length={length} center={center} transform={transformed}"
                );
                for x in [-2., 2.] {
                    for z in [-2., 2.] {
                        for dy in [-1., 0., 1.] {
                            let p = sim.apply_point(x, center + dy, z);
                            assert!(gap(&features, p) < 1e-6,
                                "missing edge {p:?}, length={length} center={center} transform={transformed}");
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn box_exposure_handles_complements_and_hidden_edges() {
    let tol = resolve_tolerances(&SfccTuning::default(), 12.);
    let cutter = box_node([0.; 3], [2., 5000., 2.]);
    let shell = BridgeNode::Subtract {
        node_id: 0,
        lh: Box::new(box_node([0., 2.44140625, 0.], [3.; 3])),
        rh: Box::new(cutter),
        radius: 0.,
        mode: None,
        n: None,
    };
    let (features, diagnostics) = compile_feature_set(&build_csg_tree(&shell).unwrap(), &tol);
    assert_eq!(diagnostics.unresolved_trims, 0);
    for x in [-2., 2.] {
        for z in [-2., 2.] {
            assert!(gap(&features, [x, 2.44140625, z]) < 1e-6);
        }
    }
    let union = BridgeNode::Union {
        node_id: 0,
        children: vec![box_node([0.; 3], [2., 10., 2.]), box_node([0.; 3], [3.; 3])],
        radius: 0.,
        mode: None,
        n: None,
    };
    let (features, diagnostics) = compile_feature_set(&build_csg_tree(&union).unwrap(), &tol);
    assert_eq!(diagnostics.unresolved_trims, 0);
    assert!(
        gap(&features, [2., 0., 2.]) > 0.5,
        "covered box edges must not survive"
    );
}

fn spherical_cut(angle: f64, hidden: bool) -> BridgeNode {
    let z = 10. * angle.to_radians().cos();
    let cut = intersect(
        BridgeNode::Sphere {
            node_id: 0,
            pos: [0.; 3],
            r: 10.,
        },
        box_node([0., 0., z - 20.], [20.; 3]),
    );
    if hidden {
        BridgeNode::Union {
            node_id: 0,
            children: vec![cut, box_node([0.; 3], [30.; 3])],
            radius: 0.,
            mode: None,
            n: None,
        }
    } else {
        cut
    }
}

#[test]
fn shallow_regular_seams_survive_and_rank_limited_seams_are_reported() {
    let tol = resolve_tolerances(&SfccTuning::default(), 40.);
    for angle in [1_f64, 1.9, 10., 16.] {
        let tree = build_csg_tree(&spherical_cut(angle, false)).unwrap();
        let (features, diagnostics) = compile_feature_set(&tree, &tol);
        if angle < 2. {
            assert!(
                diagnostics.unresolved_discovery > 0,
                "untraced exposed {angle} degree circle must be explicit"
            );
            let result = run_sfcc_pipeline(
                &tree,
                &SfccWorldCube {
                    min_x: -10.,
                    min_y: -10.,
                    min_z: -10.,
                    size: 20.,
                },
                &PipelineTuning::default(),
            );
            assert!(!result.ok && result.validation.feature_trace.unresolved_discovery > 0);
        } else {
            assert_eq!(diagnostics.unresolved_discovery, 0);
            let radius = 10. * angle.to_radians().sin();
            for i in 0..24 {
                let t = i as f64 * std::f64::consts::TAU / 24.;
                assert!(
                    gap(
                        &features,
                        [
                            radius * t.cos(),
                            radius * t.sin(),
                            10. * angle.to_radians().cos()
                        ]
                    ) < 1e-5
                );
            }
        }
    }
}

#[test]
fn hidden_and_tangent_carriers_do_not_report_unresolved_discovery() {
    let tol = resolve_tolerances(&SfccTuning::default(), 100.);
    for (angle, hidden) in [(1., true), (1.9, true), (0., false)] {
        let (_, diagnostics) = compile_feature_set(
            &build_csg_tree(&spherical_cut(angle, hidden)).unwrap(),
            &tol,
        );
        assert_eq!(
            diagnostics.unresolved_discovery, 0,
            "angle={angle}, hidden={hidden}"
        );
    }
    let box_ = box_node([0.; 3], [2.; 3]);
    let (_, diagnostics) = compile_feature_set(
        &build_csg_tree(&intersect(box_.clone(), box_)).unwrap(),
        &tol,
    );
    assert_eq!(
        diagnostics.unresolved_discovery, 0,
        "coincident box faces are not unknown seams"
    );
    let tree = build_csg_tree(&box_node([0.; 3], [2.; 3])).unwrap();
    let view = build_tree(&tree, build_leaf_strata);
    let p = view.strata[0].project(0., 0., 0.);
    let candidate = make_segment_curve(0, 0, [0, 0], p[0], -1., 0., p[0], 1., 0.);
    let (runs, unresolved) = trim_curve(&view, &candidate, 0, &tol);
    assert!(runs.is_empty(), "one smooth plane is not a crease");
    assert_eq!(
        unresolved, 0,
        "an exactly coincident plane pair is resolved"
    );
}

#[test]
fn nonfinite_trim_queries_are_explicit() {
    let tree = build_csg_tree(&BridgeNode::Sphere {
        node_id: 0,
        pos: [0.; 3],
        r: 1.,
    })
    .unwrap();
    let view = build_tree(&tree, build_leaf_strata);
    let curve = make_segment_curve(0, 0, [0, 0], f64::NAN, 0., 0., 1., 0., 0.);
    let (runs, unresolved) = trim_curve(
        &view,
        &curve,
        0,
        &resolve_tolerances(&SfccTuning::default(), 4.),
    );
    assert!(runs.is_empty());
    assert_eq!(unresolved, 1);
}

#[test]
fn output_rounding_does_not_disguise_real_features_as_absent() {
    let center = 1e8;
    let tree = build_csg_tree(&BridgeNode::Cylinder {
        node_id: 0,
        pos: [center; 3],
        r: 1.,
        h: 1.,
        fillet_top: 0.,
        fillet_bottom: 0.,
        chamfer_top: 0.,
        chamfer_bottom: 0.,
    })
    .unwrap();
    let tol = resolve_tolerances(&SfccTuning::default(), 4.);
    let (_, diagnostics) = compile_feature_set(&tree, &tol);
    assert!(
        diagnostics.unresolved_trims > 0,
        "f64 rims must not disappear silently after f32 rounding"
    );

    let view = build_tree(&tree, build_leaf_strata);
    let off_surface = make_circle_curve(
        0,
        0,
        [0, 1],
        center,
        center + 1.005,
        center,
        0.,
        1.,
        0.,
        1.,
        None,
    );
    let (runs, unresolved) = trim_curve(&view, &off_surface, 0, &tol);
    assert!(runs.is_empty());
    assert_eq!(
        unresolved, 0,
        "a loose-band sample already off the f64 surface is ordinary dead geometry"
    );
}
