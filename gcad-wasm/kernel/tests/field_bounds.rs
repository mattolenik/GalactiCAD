//! Independent surface witnesses and equivalent-scene controls for SDF bounds and pruning.
use gcad_kernel::primitives::smin::SminMode;
use gcad_kernel::scene_bridge::{build_csg_tree, BridgeBlendMode, BridgeNode};
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};

fn sphere(pos: [f64; 3], r: f64) -> BridgeNode {
    BridgeNode::Sphere { node_id: 0, pos, r }
}

#[test]
fn loft_bounds_enclose_surface_after_cyclic_profile_reindexing() {
    let center = [0.2, 0.06, 1.8];
    let half = [0.02; 3];
    let inside = [0.2, 0.08, 1.8];
    let triangle_distance = (1.8 - 0.2) / 2.0_f64.sqrt();
    let expected_center = 0.2 * triangle_distance - 0.8 * 0.2;
    for start in 0..4 {
        let mut square = vec![[0., 0.], [2., 0.], [2., 2.], [0., 2.]];
        square.rotate_left(start);
        let tree = build_csg_tree(&BridgeNode::Loft {
            node_id: 0,
            pos: [0.; 3],
            profiles: vec![vec![[0., 0.], [2., 0.], [2., 2.]], square],
            h: 0.1,
        })
        .unwrap();
        // A continuous profile blend changes sign inside this cube. Changing
        // the polygon's starting vertex must not make its surface excludable.
        assert!((tree.f(center) - expected_center).abs() < 1e-12);
        assert!((tree.f(inside) + 0.02).abs() < 1e-12);
        let pruned = tree.prune_to_box(center, half);
        for (lo, hi) in [
            tree.interval_over_box(center, half),
            pruned.interval_over_box(center, half),
        ] {
            assert!(
                lo <= -0.02 && hi >= expected_center,
                "profile start {start}: interval [{lo}, {hi}] excludes an in-cube witness"
            );
        }
    }
}

#[test]
fn identical_loft_profiles_retain_unit_lipschitz_bound() {
    let square = vec![[0., 0.], [2., 0.], [2., 2.], [0., 2.]];
    let tree = build_csg_tree(&BridgeNode::Loft {
        node_id: 0,
        pos: [0.; 3],
        profiles: vec![square.clone(), square],
        h: 0.1,
    })
    .unwrap();
    let CsgNode::Leaf(leaf) = &tree else {
        panic!("expected a loft leaf")
    };
    assert_eq!(leaf.local_lipschitz([0.2, 0.06, 1.8], 0.04), None);
}

#[test]
fn pruning_preserves_complemented_blends_inside_the_query_region() {
    for mode in [
        SminMode::Round,
        SminMode::Soft,
        SminMode::Chamfer,
        SminMode::Stairs,
    ] {
        for count in [2, 3, 4, 5] {
            let mut children: Vec<_> = (0..count - 1)
                .map(|i| sdf::leaf_at(Shape::Sphere { r: 1. }, [10., i as f64 * 0.02, 0.]))
                .collect();
            children.push(sdf::leaf_at(Shape::Sphere { r: 1. }, [0.; 3]));
            let tree = sdf::negate(sdf::union_smooth(children, mode, 0.5, 3.));
            assert_eq!(tree.f([0.; 3]), 1., "the origin is inside the cutter");
            for center in [[0.; 3], [10., 0.02, 0.]] {
                let half = [0.05; 3];
                let pruned = tree.prune_to_box(center, half);
                for dx in [-0.04, 0., 0.04] {
                    let p = [center[0] + dx, center[1] + 0.01, center[2] + 0.02];
                    assert_eq!(
                        pruned.f(p),
                        tree.f(p),
                        "{mode:?}, {count} operands at {p:?}"
                    );
                    assert_eq!(
                        pruned.grad(p),
                        tree.grad(p),
                        "{mode:?}, {count} operands at {p:?}"
                    );
                }
                assert_eq!(
                    pruned.interval_over_box(center, half),
                    tree.interval_over_box(center, half)
                );
            }
        }
    }
}

#[test]
fn buried_primitives_do_not_remove_a_cavity_when_pruning_activates() {
    let base = BridgeNode::Subtract {
        node_id: 0,
        lh: Box::new(BridgeNode::Box {
            node_id: 0,
            pos: [0.; 3],
            half: [50.; 3],
        }),
        rh: Box::new(BridgeNode::Union {
            node_id: 0,
            children: vec![
                sphere([11.7, 1.7, 1.7], 1.),
                sphere([11.7, 1.72, 1.7], 1.),
                sphere([11.7, 1.7, 1.72], 1.),
                sphere([1.7; 3], 1.),
            ],
            radius: 0.5,
            mode: Some(BridgeBlendMode::Round),
            n: None,
        }),
        radius: 0.,
        mode: None,
        n: None,
    };
    let mut children = vec![base.clone()];
    children.extend((0..9).map(|i| sphere([-20., i as f64 - 4., -20.], 0.2)));
    let with_buried = BridgeNode::Union {
        node_id: 0,
        children,
        radius: 0.,
        mode: None,
        n: None,
    };
    for (scene, leaf_count) in [(base, 5), (with_buried, 14)] {
        let tree = build_csg_tree(&scene).unwrap();
        assert_eq!(tree.leaf_count(), leaf_count);
        assert_eq!(tree.f([1.7; 3]), 1.);
        let result = run_sfcc_pipeline(
            &tree,
            &SfccWorldCube {
                min_x: -50.,
                min_y: -50.,
                min_z: -50.,
                size: 100.,
            },
            &PipelineTuning::default(),
        );
        assert!(result.manifold.ok, "{leaf_count} leaves");
        assert_eq!(
            result.manifold.components, 3,
            "{leaf_count} leaves: outer shell and both cavities"
        );
        assert!(
            result.verts.chunks_exact(8).any(|v| {
                let d = (v[0] as f64 - 1.7)
                    .hypot(v[1] as f64 - 1.7)
                    .hypot(v[2] as f64 - 1.7);
                (d - 1.).abs() < 0.01
            }),
            "{leaf_count} leaves: no vertices on the isolated unit cavity"
        );
    }
}

#[test]
#[ignore = "requires coordinated GPU/native polygon scalar repair of the 1e-12 edge-length floor"]
fn tiny_profile_edges_preserve_world_distance_and_bounds_under_scale() {
    let d = 1e-7;
    let tree = build_csg_tree(&BridgeNode::Scale {
        node_id: 0,
        sx: 1e8,
        sy: 1e8,
        sz: 1e8,
        arg: Box::new(BridgeNode::Extrude {
            node_id: 0,
            pos: [0.; 3],
            verts: vec![[0., 0.], [d, 0.], [d, d], [0., d]],
            h: d,
            twist_degrees: 0.,
        }),
    })
    .unwrap();
    for z in [-0.01, 0., 0.01] {
        assert!(
            (tree.f([5., 0., z]) + z).abs() < 1e-10,
            "world side at z=0, sample z={z}"
        );
    }
    let (lo, hi) = tree.interval_over_box([5., 0., -0.01], [0.02; 3]);
    assert!(lo <= -0.01 && hi >= 0.01);
}

#[test]
#[ignore = "requires coordinated GPU/native lathe scalar and axis-domain handling for tiny profiles"]
fn tiny_lathe_inner_radius_preserves_world_distance_and_bounds_under_scale() {
    let tree = build_csg_tree(&BridgeNode::Scale {
        node_id: 0,
        sx: 1e6,
        sy: 1e6,
        sz: 1e6,
        arg: Box::new(BridgeNode::Lathe {
            node_id: 0,
            pos: [0.; 3],
            verts: vec![[5e-7, -2e-6], [2e-6, -2e-6], [2e-6, 2e-6], [5e-7, 2e-6]],
        }),
    })
    .unwrap();
    for x in [0.49, 0.5, 0.51] {
        assert!(
            (tree.f([x, 0., 0.]) - (0.5 - x)).abs() < 1e-10,
            "inner wall at r=.5, sample r={x}"
        );
    }
    let (lo, hi) = tree.interval_over_box([0.49, 0., 0.], [0.02; 3]);
    assert!(lo <= -0.01 && hi >= 0.01);
}
