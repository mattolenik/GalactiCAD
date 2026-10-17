//! Analytic witnesses test exclusion; the optional record stream is independently
//! checked with exact rational arithmetic by numerical-exclusion-oracle.py.
use gcad_kernel::math::{
    grid::{cell_aabb, make_lattice},
    similarity::Similarity,
};
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::octree::{build_octree, CellDecision, OctreeBuildOptions};

fn contains_zero(iv: (f64, f64)) {
    assert!(!(iv.0 > 0. || iv.1 < 0.), "false exclusion: {iv:?}");
}
fn sphere(r: f64) -> CsgNode {
    sdf::leaf_at(Shape::Sphere { r }, [0.; 3])
}

#[test]
fn represented_affine_matrix_and_large_pythagorean_ball_keep_exact_zeros() {
    let a = 1. + 2f64.powi(-22);
    let mut sim = Similarity::identity();
    sim.r[0] = a;
    let tree = sdf::leaf(Shape::Sphere { r: 1. }, sim, [0.; 3]);
    // x=1/a is an exact rational root in this one-ULP query box (oracle verifies).
    contains_zero(tree.interval_over_box([1. / a, 0., 0.], [2f64.powi(-53), 0., 0.]));
    let (x, y, r) = (16072908759584i128, 218874968123250i128, 219464325271666i128);
    assert_eq!(x * x + y * y, r * r);
    let tree = sphere(r as f64);
    contains_zero(tree.interval_over_ball([x as f64, y as f64, 0.], 0.));
    contains_zero(tree.interval_over_box([x as f64, y as f64, 0.], [0.; 3]));
}

#[test]
fn transformed_box_and_sphere_keep_contact_and_useful_signed_controls() {
    let (sin, cos) = 0.713f64.sin_cos();
    let mut sim = Similarity {
        r: [cos, -sin, 0., sin, cos, 0., 0., 0., 1.],
        t: [1e8, -1e8, 0.],
        s: 2.,
    };
    for shape in [Shape::Sphere { r: 1. }, Shape::Cuboid { half: [1.; 3] }] {
        let tree = sdf::leaf(shape, sim, [0.; 3]);
        // z axis is exact despite rounded xy rotation.
        contains_zero(tree.interval_over_box([1e8, -1e8, 2.], [0.; 3]));
        assert!(tree.interval_over_box([1e8, -1e8, 4.], [0.01; 3]).0 > 0.);
        assert!(tree.interval_over_box(sim.t, [0.01; 3]).1 < 0.);
    }
    sim.r[0] = 2.; // No orthogonality tolerance is a substitute for actual bounds.
    contains_zero(
        sdf::leaf(Shape::Cuboid { half: [1.; 3] }, sim, [0.; 3])
            .interval_over_box([1e8, -1e8, 2.], [0.; 3]),
    );
}

#[test]
fn scaling_subnormal_overflow_and_invalid_arithmetic_are_explicit() {
    for scale in [2f64.powi(-500), 1., 2f64.powi(500)] {
        let tree = sdf::leaf(
            Shape::Sphere { r: 1. },
            Similarity::from_uniform_scale(scale),
            [0.; 3],
        );
        assert!(
            tree.interval_over_box([3. * scale, 0., 0.], [0.01 * scale; 3])
                .0
                > 0.
        );
        assert!(tree.interval_over_box([0.; 3], [0.01 * scale; 3]).1 < 0.);
        contains_zero(tree.interval_over_ball([scale, 0., 0.], 0.));
    }
    let tiny = f64::from_bits(1);
    contains_zero(sphere(tiny).interval_over_box([tiny, 0., 0.], [0.; 3]));
    contains_zero(sphere(f64::MAX / 2.).interval_over_box([f64::MAX / 2., 0., 0.], [0.; 3]));
    for invalid in [sphere(f64::NAN), sphere(-1.), CsgNode::Min(vec![])] {
        for tree in [
            CsgNode::Min(vec![invalid.clone(), sphere(1.)]),
            CsgNode::Max(vec![invalid, sphere(1.)]),
        ] {
            assert!(tree.interval_over_box([4., 0., 0.], [0.1; 3]).0.is_nan());
            assert!(tree.interval_over_ball([4., 0., 0.], 0.1).0.is_nan());
        }
    }
}

#[test]
fn ancestor_composition_and_pruned_views_preserve_original_signed_trees() {
    let tree = CsgNode::Max(vec![sphere(1.), sdf::subtract(sphere(4.), sphere(1.))]);
    contains_zero(tree.interval_over_box([1., 0., 0.], [0.; 3]));
    let pruned = tree.prune_to_box([1., 0., 0.], [0.1; 3]);
    assert_eq!(
        pruned.leaf_count(),
        tree.leaf_count(),
        "supported pruning retains floating evaluation order"
    );
    for p in [[1., 0., 0.], [1.01, 0., 0.], [0., 0., 0.], [100., 0., 0.]] {
        assert_eq!(pruned.f(p).to_bits(), tree.f(p).to_bits());
        assert_eq!(pruned.grad(p), tree.grad(p));
    }
    assert_eq!(
        pruned.interval_over_box([1., 0., 0.], [0.1; 3]),
        tree.interval_over_box([1., 0., 0.], [0.1; 3])
    );
}

#[test]
fn initial_child_and_balance_culls_keep_known_zero_at_insufficient_depth() {
    for depth_min in [0, 2] {
        let lat = make_lattice(3, -2., -2., -2., 4.);
        for tree in [
            sphere(1.),
            CsgNode::Max(vec![
                sphere(1.),
                sdf::leaf_at(Shape::Cuboid { half: [2.; 3] }, [0.; 3]),
            ]),
        ] {
            let octree = build_octree(
                &tree,
                &lat,
                OctreeBuildOptions {
                    depth_min,
                    depth_max: 3,
                    enforce_edge_balance: true,
                },
                |_, _| CellDecision {
                    split: true,
                    feature_curve: -1,
                    feature_corner: -1,
                },
            );
            for p in [[1., 0., 0.], [-1., 0., 0.], [0., 1., 0.], [0., 0., -1.]] {
                assert!(
                    octree.leaves.iter().any(|c| {
                        let b = cell_aabb(&lat, c.level, c.ix, c.iy, c.iz);
                        c.degenerate
                            && c.level == 3
                            && (0..3).all(|a| b[a] <= p[a] && p[a] <= b[a + 3])
                    }),
                    "zero witness {p:?} removed at depth_min={depth_min}"
                );
            }
        }
    }
}

#[test]
fn exact_rational_oracle_records() {
    let Some(path) = std::env::var_os("SFCC_BOUND_RECORDS") else {
        return;
    };
    let mut rows = Vec::new();
    for scale in [2f64.powi(-500), 1., 2f64.powi(500), f64::from_bits(64)] {
        let (sin, cos) = 0.713f64.sin_cos();
        for matrix in [
            Similarity::identity().r,
            [cos, -sin, 0., sin, cos, 0., 0., 0., 1.],
            [
                cos as f32 as f64,
                -(sin as f32 as f64),
                0.,
                sin as f32 as f64,
                cos as f32 as f64,
                0.,
                0.,
                0.,
                1.,
            ],
            [1., 0.25, 0., -0.125, 1., 0., 0., 0., 1.],
        ] {
            let sim = Similarity {
                r: matrix,
                t: [scale * 1024., -scale * 512., 0.],
                s: scale,
            };
            for kind in [0, 1] {
                for sign in [-1., 1.] {
                    for p in [
                        [0., 0., 1.],
                        [3., 4., 0.],
                        [1., 1., 1.],
                        [1.0000000000000002, 0., 0.],
                    ] {
                        let mut tree = sdf::leaf(
                            if kind == 0 {
                                Shape::Sphere { r: 1. }
                            } else {
                                Shape::Cuboid { half: [1.; 3] }
                            },
                            sim,
                            [0.25, -0.5, 0.],
                        );
                        let CsgNode::Leaf(l) = &mut tree else {
                            unreachable!()
                        };
                        l.sign = sign;
                        let c = std::array::from_fn(|a| sim.t[a] + p[a] * scale);
                        let half = [scale * 2f64.powi(-20); 3];
                        let iv = tree.interval_over_box(c, half);
                        if iv.0.is_finite() && iv.1.is_finite() {
                            rows.push(format!("{{\"kind\":{kind},\"sign\":{sign},\"matrix\":{:?},\"t\":{:?},\"scale\":{:?},\"pos\":[0.25,-0.5,0.0],\"c\":{c:?},\"half\":{half:?},\"lo\":{:?},\"hi\":{:?}}}",sim.r,sim.t,sim.s,iv.0,iv.1));
                        }
                    }
                }
            }
        }
    }
    assert_eq!(rows.len(), 256);
    std::fs::write(path, rows.join("\n") + "\n").unwrap();
}

#[test]
fn approximate_matrix_zero_survives_the_actual_initial_and_child_culls() {
    let a = 1. + 2f64.powi(-22);
    let c = 1. / a;
    let h = 2f64.powi(-53);
    let mut sim = Similarity::identity();
    sim.r[0] = a;
    let tree = sdf::leaf(Shape::Sphere { r: 1. }, sim, [0.; 3]);
    let lat = make_lattice(3, c - 4. * h, -4. * h, -4. * h, 8. * h);
    for depth_min in [0, 2] {
        let octree = build_octree(
            &tree,
            &lat,
            OctreeBuildOptions {
                depth_min,
                depth_max: 3,
                enforce_edge_balance: true,
            },
            |_, _| CellDecision {
                split: true,
                feature_curve: -1,
                feature_corner: -1,
            },
        );
        assert!(
            !octree.leaves.is_empty(),
            "the old rotation shortcut culled this whole root"
        );
        assert!(
            octree.leaves.iter().any(|cell| {
                let b = cell_aabb(&lat, cell.level, cell.ix, cell.iy, cell.iz);
                // All x endpoints are in [0.5,1): exact dyadic numerator / 2^53.
                let numerator =
                    |x: f64| ((1u64 << 52) | (x.to_bits() & ((1u64 << 52) - 1))) as i128;
                let target = (1i128 << 22) * (1i128 << 53);
                let denominator = (1i128 << 22) + 1;
                cell.degenerate
                    && numerator(b[0]) * denominator <= target
                    && target <= numerator(b[3]) * denominator
                    && b[1] <= 0.
                    && b[4] >= 0.
                    && b[2] <= 0.
                    && b[5] >= 0.
            }),
            "exact rational root must survive the depth ceiling"
        );
    }
}

#[test]
fn representable_tiny_gap_and_large_translation_cancellation_keep_signs() {
    let gap = 2f64.powi(-32);
    let shell = sdf::subtract(sphere(1. + gap), sphere(1.));
    assert!(
        shell
            .interval_over_box([1. + gap / 2., 0., 0.], [gap / 32.; 3])
            .1
            < 0.
    );
    assert!(
        shell
            .interval_over_box([1. - gap, 0., 0.], [gap / 32.; 3])
            .0
            > 0.
    );
    for shift in [2f64.powi(30), 2f64.powi(40)] {
        let tree = sdf::leaf(
            Shape::Sphere { r: 1. },
            Similarity::from_translation(shift, -shift, shift),
            [0.; 3],
        );
        contains_zero(tree.interval_over_ball([shift + 1., -shift, shift], 0.));
        let clearance = 0.125;
        assert!(
            tree.interval_over_box([shift + 1. + clearance, -shift, shift], [0.001; 3])
                .0
                > 0.
        );
        assert!(
            tree.interval_over_box([shift + 1. - clearance, -shift, shift], [0.001; 3])
                .1
                < 0.
        );
    }
    let tree = sdf::leaf(
        Shape::Sphere { r: 1. },
        Similarity::from_translation(-f64::MAX, 0., 0.),
        [0.; 3],
    );
    assert!(tree
        .interval_over_box([f64::MAX, 0., 0.], [0.; 3])
        .0
        .is_nan());
}

#[cfg(feature = "serde")]
#[test]
fn ordinary_serialized_rotations_remain_useful_in_the_actual_exporter() {
    use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
    let cube = SfccWorldCube {
        min_x: -4.,
        min_y: -4.,
        min_z: -4.,
        size: 8.,
    };
    for line in include_str!("../../../docs/research/sfcc-step2/rotated-baseline.jsonl").lines() {
        let fixture: serde_json::Value = serde_json::from_str(line).unwrap();
        let tree =
            gcad_kernel::scene_bridge::build_csg_tree_from_json(&fixture["scene"].to_string())
                .unwrap();
        let result = run_sfcc_pipeline(&tree, &cube, &PipelineTuning::default());
        assert_eq!(
            result.manifold.components as u64,
            fixture["components"].as_u64().unwrap(),
            "{line}"
        );
        assert_eq!(
            result.stats.leaves as u64,
            fixture["leaves"].as_u64().unwrap(),
            "{line}"
        );
        assert_eq!(
            result.validation.unresolved_cells as u64,
            fixture["unresolved"].as_u64().unwrap(),
            "{line}"
        );
        assert_eq!(result.ok, fixture["ok"].as_bool().unwrap(), "{line}");
    }
}

#[cfg(feature = "serde")]
#[test]
fn mixed_opaque_controls_preserve_legacy_refinement_without_widening_blend_operands() {
    use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
    let cube = SfccWorldCube {
        min_x: -4.,
        min_y: -4.,
        min_z: -4.,
        size: 8.,
    };
    for line in include_str!("../../../docs/research/sfcc-step2/mixed-baseline.jsonl").lines() {
        let fixture: serde_json::Value = serde_json::from_str(line).unwrap();
        let tree =
            gcad_kernel::scene_bridge::build_csg_tree_from_json(&fixture["scene"].to_string())
                .unwrap();
        let result = run_sfcc_pipeline(&tree, &cube, &PipelineTuning::default());
        assert_eq!(
            result.manifold.components as u64,
            fixture["components"].as_u64().unwrap(),
            "{line}"
        );
        assert_eq!(
            result.stats.leaves as u64,
            fixture["leaves"].as_u64().unwrap(),
            "{line}"
        );
        assert_eq!(
            result.validation.unresolved_cells as u64,
            fixture["unresolved"].as_u64().unwrap(),
            "{line}"
        );
        assert_eq!(result.ok, fixture["ok"].as_bool().unwrap(), "{line}");
    }
}

#[test]
fn opaque_legacy_bounds_reject_finite_input_transform_overflow_before_box_minmax() {
    let bad = sdf::leaf(
        Shape::Cuboid { half: [1.; 3] },
        Similarity {
            s: f64::MIN_POSITIVE,
            ..Similarity::identity()
        },
        [0.; 3],
    );
    let point = [4., 4., 0.];
    assert_eq!(
        bad.f(point),
        0.,
        "the legacy box evaluator masks NaN local coordinates"
    );
    let blend = sdf::union_smooth(
        vec![bad, sphere(1.)],
        gcad_kernel::primitives::smin::SminMode::Round,
        0.2,
        2.,
    );
    for tree in [blend.clone(), CsgNode::Min(vec![blend, sphere(1.)])] {
        for iv in [
            tree.interval_over_ball(point, 0.01),
            tree.interval_over_box(point, [0.01; 3]),
            tree.prune_to_box(point, [0.01; 3])
                .interval_over_box(point, [0.01; 3]),
        ] {
            assert!(
                iv.0.is_nan() && iv.1.is_nan(),
                "opaque arithmetic failure was hidden: {iv:?}"
            );
        }
    }
}

#[test]
fn subnormal_step_rounding_cannot_remove_the_requested_root_domain() {
    use gcad_kernel::sfcc::refine_criteria::{discovery_guard, make_probe};
    let size = f64::from_bits(23001);
    let center = [
        f64::from_bits(21000),
        f64::from_bits(8000),
        f64::from_bits(8000),
    ];
    let radius = f64::from_bits(500);
    let tree = sdf::leaf_at(Shape::Sphere { r: radius }, center);
    let lat = make_lattice(14, 0., 0., 0., size);
    assert_eq!(lat.step, f64::from_bits(1));
    assert_eq!(lat.step * lat.res as f64, f64::from_bits(16384));
    // Bounds cover the nominal domain even though the legacy sample map is narrower.
    assert_eq!(gcad_kernel::math::grid::point_to_world(&lat, lat.res, lat.res, lat.res), [f64::from_bits(16384); 3]);
    // Integer subnormal units give an exact surface witness at (21500,8000,8000).
    let witness = [f64::from_bits(21500), center[1], center[2]];
    assert_eq!(witness[0] - center[0], radius);
    let oct = build_octree(
        &tree,
        &lat,
        OctreeBuildOptions {
            depth_min: 0,
            depth_max: 0,
            enforce_edge_balance: true,
        },
        |cell, samples| {
            let probe = make_probe(
                &lat,
                &tree,
                |x, y, z| samples.sample_at(x, y, z),
                cell.level,
                cell.ix,
                cell.iy,
                cell.iz,
            );
            CellDecision {
                split: discovery_guard(&tree, &probe).needs_split(),
                feature_curve: -1,
                feature_corner: -1,
            }
        },
    );
    assert_eq!(
        oct.leaves.len(),
        1,
        "the actual initial cull must retain the known-zero root"
    );
    assert!(
        oct.leaves[0].degenerate,
        "a deliberately exhausted root budget must report uncertainty"
    );
}


#[test]
fn direct_probe_mutation_cannot_reuse_a_smaller_checked_region() {
    use gcad_kernel::math::grid::point_to_world;
    use gcad_kernel::sfcc::refine_criteria::{discovery_guard, make_probe, DiscoveryCheck};
    let tree = sphere(1.);
    let lat = make_lattice(3, 2., 2., 2., 1.);
    let mut probe = make_probe(&lat, &tree, |x,y,z|tree.f(point_to_world(&lat,x,y,z)), 0, 0, 0, 0);
    assert!(matches!(discovery_guard(&tree, &probe), DiscoveryCheck::NoDiscoveryRejection {..}));
    // Move the whole sample cube to the sphere while leaving the private factory region intact.
    for point in probe.pts.chunks_exact_mut(3) { for coordinate in point { *coordinate -= 2.; } }
    assert_eq!(discovery_guard(&tree, &probe), DiscoveryCheck::Indeterminate);
}
