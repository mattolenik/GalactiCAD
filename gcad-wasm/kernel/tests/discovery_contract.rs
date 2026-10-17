//! End-to-end discovery validation; expectations localize the hidden primitive.
#[path = "support/discovery.rs"]
mod support;
use gcad_kernel::math::grid::{cell_aabb, point_to_world};
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::refine_criteria::{discovery_guard, make_probe};
use gcad_kernel::sfcc::worker::*;
use support::*;

fn hidden_leaf(bytes: &[u8], tree: &CsgNode, center: [f64; 3], radius: f64, depth: u32) {
    let (lat, leaves) = decode_tagged_leaves(bytes);
    let l = leaves
        .iter()
        .find(|l| {
            let b = cell_aabb(&lat, l.level, l.ix, l.iy, l.iz);
            (0..3).all(|a| center[a] - radius > b[a] && center[a] + radius < b[a + 3])
        })
        .expect("actual hidden sphere cell must survive");
    let p = make_probe(
        &lat,
        tree,
        |x, y, z| tree.f(point_to_world(&lat, x, y, z)),
        l.level,
        l.ix,
        l.iy,
        l.iz,
    );
    assert!(discovery_guard(tree, &p).needs_split());
    assert!(l.degenerate);
    assert_eq!(l.level, depth);
    if tree.leaf_count() > 12 {
        // The decision driver's actual coarse region is level 5, padded by 10%.
        let level = l.level.min(5);
        let shift = l.level - level;
        let b = cell_aabb(&lat, level, l.ix >> shift, l.iy >> shift, l.iz >> shift);
        let coarse_center = std::array::from_fn(|a| (b[a] + b[a + 3]) * 0.5);
        let pruned = tree.prune_to_box(coarse_center, [(b[3] - b[0]) * 0.6; 3]);
        assert_eq!(pruned.leaf_count(), tree.leaf_count(),
            "supported hard trees retain all floating evaluator operands until dominance is proved");
        let witness = [center[0] + radius, center[1], center[2]];
        assert!(tree.f(witness).abs() < 1e-10);
        assert_eq!(pruned.f(witness), tree.f(witness));
    }
}

#[test]
fn sufficient_depth_reconstructs_both_supplied_components_at_their_locations() {
    let (tree, cube) = hidden();
    let t = PipelineTuning {
        depth_max: 14,
        surface_tol_mm: 1e-5,
        ..Default::default()
    };
    let r = run_sfcc_pipeline(&tree, &cube, &t);
    eprintln!(
        "fine hidden: leaves={} components={} unresolved={} failed={} degenerate={}",
        r.stats.leaves,
        r.manifold.components,
        r.validation.unresolved_cells,
        r.stats.failed_cells,
        r.stats.degenerate_cells
    );
    assert_eq!(
        r.manifold.components, 2,
        "sufficient resolution must reconstruct both components"
    );
    assert!(r.manifold.ok);
    assert!(r.verts.chunks_exact(8).any(|v| (v[0] as f64 - CENTER[0])
        .hypot(v[1] as f64 - CENTER[1])
        .hypot(v[2] as f64 - CENTER[2])
        < 1.1 * RADIUS));
    assert!(r.verts.chunks_exact(8).any(|v| v[0] < -1.));
    let radial: Vec<_> = r
        .verts
        .chunks_exact(8)
        .map(|v| {
            (v[0] as f64 - CENTER[0])
                .hypot(v[1] as f64 - CENTER[1])
                .hypot(v[2] as f64 - CENTER[2])
        })
        .filter(|&d| d < 2. * RADIUS)
        .collect();
    assert!(radial.len() >= 4);
    assert!(radial.iter().all(|&d| (d - RADIUS).abs() < 0.01 * RADIUS));
    assert_eq!(r.stats.failed_cells, 0);
    // Component recovery is not a claim that every cell has resolved.
    eprintln!(
        "maximum sphere residual={:.9e}",
        radial
            .iter()
            .map(|&d| (d - RADIUS).abs())
            .fold(0., f64::max)
    );
}

#[test]
fn hidden_and_many_leaf_decisions_roundtrip_through_resumable_and_reversed_partitions() {
    for (tree, cube) in [hidden(), many_hidden()] {
        for depth in [6, 8] {
            let t = PipelineTuning {
                depth_min: 3,
                depth_max: depth,
                normal_variation_deg: 180.,
                blend_curvature_refine: false,
                quality_triangulation: false,
                quality_refinement: false,
                quality_remeshing: false,
                ..Default::default()
            };
            #[cfg(feature = "sfcc-profile")]
            gcad_kernel::sfcc::perf::reset();
            let serial = prepare(&tree, &cube, &t);
            #[cfg(feature = "sfcc-profile")]
            {
                let c = gcad_kernel::sfcc::perf::snapshot();
                assert_eq!(
                    c[19],
                    c[18] * (tree.leaf_count() + 1),
                    "every guard traverses original root even above coarse prune gate"
                );
            }
            hidden_leaf(&serial, &tree, CENTER, RADIUS, depth);
            let (lat, leaves) = decode_tagged_leaves(&serial);
            let fingerprint = u64::from_le_bytes(serial[4..12].try_into().unwrap());
            assert_eq!(encode_tagged_leaves(&lat, &leaves, fingerprint), serial);
            assert_eq!(build_octree_resumable_inprocess(&tree, &cube, &t), serial);
            for n in [1, 2, 4, 8] {
                octree_session_begin(tree.clone(), &cube, &t);
                let mut done = false;
                for _ in 0..32 {
                    let frontier = octree_session_current_frontier();
                    let count = decode_tagged_leaves(&frontier).1.len();
                    let whole = decide_partition_bytes(&tree, &cube, &t, &frontier, 0, count);
                    let mut chunks: Vec<_> = (0..n)
                        .rev()
                        .map(|part| {
                            (
                                part,
                                decode_decisions(&decide_partition_bytes(
                                    &tree,
                                    &cube,
                                    &t,
                                    &frontier,
                                    part * count / n,
                                    (part + 1) * count / n,
                                )),
                            )
                        })
                        .collect();
                    chunks.sort_by_key(|(i, _)| *i);
                    let joined = encode_decisions(
                        &chunks.into_iter().flat_map(|(_, v)| v).collect::<Vec<_>>(),
                    );
                    assert_eq!(joined, whole, "partitioned decisions differ at N={n}");
                    if octree_session_apply_decisions(&joined) {
                        done = true;
                        break;
                    }
                }
                assert!(done, "finite depth ceiling must terminate session");
                assert_eq!(
                    octree_session_finish(),
                    serial,
                    "resumable tagged leaves differ at N={n}"
                );
            }
        }
    }
}

#[test]
fn actual_hidden_worker_mesh_preserves_raw_degeneracy_without_serial_recovery() {
    let (tree, cube) = hidden();
    let t = PipelineTuning::default();
    let serial = run_sfcc_pipeline(&tree, &cube, &t);
    let leaves = prepare(&tree, &cube, &t);
    hidden_leaf(&leaves, &tree, CENTER, RADIUS, t.depth_max);
    let raw_degenerate = decode_tagged_leaves(&leaves)
        .1
        .iter()
        .filter(|l| l.degenerate)
        .count();
    eprintln!(
        "hidden serial: degenerate={} failed={} unresolved={} components={}",
        serial.stats.degenerate_cells,
        serial.stats.failed_cells,
        serial.validation.unresolved_cells,
        serial.manifold.components
    );
    assert_eq!(
        serial.stats.failed_cells, 0,
        "fixture must exercise raw degeneracy, not failed cells"
    );
    assert_eq!(serial.stats.degenerate_cells, raw_degenerate);
    assert_eq!(serial.validation.unresolved_cells, raw_degenerate);
    for n in [1, 2, 4, 8] {
        let mut partials: Vec<_> = (0..n)
            .map(|i| mesh_partition(&tree, &cube, &t, &leaves, i, n))
            .collect();
        for reverse in [false, true] {
            if reverse {
                partials.reverse();
            }
            let merged = merge(&tree, &cube, &t, &partials);
            assert!(!merged.serial_recovery, "N={n} reverse={reverse}");
            assert_eq!(merged.failed_cells, 0);
            assert_eq!(merged.degenerate_cells, raw_degenerate);
            assert_eq!(merged.validation, serial.validation);
            assert_eq!(merged.manifold.components, serial.manifold.components);
            assert_eq!(merged.tris.len(), serial.tris.len());
            assert!(!merged.ok);
        }
    }
}

#[test]
fn co_scaled_scene_cube_padding_and_geometric_tolerances_keep_the_hidden_cell_unresolved() {
    for scale in [0.01, 1., 100.] {
        for translation in [[0.; 3], [7. * scale, -9. * scale, 11. * scale]] {
            let (mut tree, cube) = hidden();
            fn transform(tree: &mut CsgNode, sim: Similarity) {
                match tree {
                    CsgNode::Leaf(l) => {
                        l.sim = Similarity::compose(&sim, &l.sim);
                        l.strata.clear();
                    }
                    CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => {
                        for t in c {
                            transform(t, sim)
                        }
                    }
                }
            }
            let sim = Similarity {
                t: translation,
                s: scale,
                ..Similarity::identity()
            };
            transform(&mut tree, sim);
            let tree = prepared(tree);
            let c = SfccWorldCube {
                min_x: cube.min_x * scale + translation[0],
                min_y: cube.min_y * scale + translation[1],
                min_z: cube.min_z * scale + translation[2],
                size: cube.size * scale,
            };
            let t = PipelineTuning {
                bounds_padding_mm: 2. * scale,
                surface_tol_mm: 0.01 * scale,
                curve_chord_tol_mm: 0.02 * scale,
                seed_cell_size_mm: 0.,
                ..Default::default()
            };
            let bytes = prepare(&tree, &c, &t);
            let center = sim.apply_point(CENTER[0], CENTER[1], CENTER[2]);
            hidden_leaf(&bytes, &tree, center, RADIUS * scale, t.depth_max);
        }
    }
}

#[test]
fn comfortably_buried_and_far_controls_preserve_a_useful_flat_box_mesh() {
    let cube = cube();
    let t = PipelineTuning::default();
    let base = run_sfcc_pipeline(&prepared(box_node()), &cube, &t);
    assert!(base.ok);
    assert_eq!(base.stats.degenerate_cells, 0);
    for tree in [
        sdf::union(vec![box_node(), sphere(0.1, [0.; 3])]),
        sdf::union(vec![
            box_node(),
            sdf::intersect(vec![sphere(0.1, [3., 0., 0.]), sphere(1., [100.; 3])]),
        ]),
    ] {
        let r = run_sfcc_pipeline(&prepared(tree), &cube, &t);
        assert!(r.ok);
        assert_eq!(r.stats.degenerate_cells, 0);
        assert_eq!(r.stats.leaves, base.stats.leaves);
        assert_eq!(r.manifold.components, 1);
        assert_eq!(r.tris.len(), base.tris.len());
    }
    let near = sdf::union(vec![
        box_node(),
        sdf::leaf_at(Shape::Sphere { r: 0.001 }, [2.9989, 0., 0.]),
    ]);
    let r = run_sfcc_pipeline(&prepared(near), &cube, &t);
    assert_eq!(
        r.manifold.components, 1,
        "buried tiny sphere cannot become an exposed component"
    );
    assert!(r.validation.unresolved_cells > 0 || r.ok);
}

#[test]
fn separate_worker_recovery_keeps_hidden_cell_diagnosis() {
    let (hidden, cube) = hidden();
    let tree = prepared(sdf::union(vec![
        hidden,
        sdf::leaf_at(Shape::Cylinder { r: 3., h: 5. }, [20.; 3]),
    ]));
    let t = PipelineTuning {
        max_polyline_points_per_cell: 1,
        curve_chord_tol_mm: 1e-8,
        ..Default::default()
    };
    let leaves = prepare(&tree, &cube, &t);
    hidden_leaf(&leaves, &tree, CENTER, RADIUS, t.depth_max);
    let serial = run_sfcc_pipeline(&tree, &cube, &t);
    let partials: Vec<_> = (0..2)
        .rev()
        .map(|i| mesh_partition(&tree, &cube, &t, &leaves, i, 2))
        .collect();
    let merged = merge(&tree, &cube, &t, &partials);
    assert!(
        merged.serial_recovery,
        "fixture must trigger actual recovery"
    );
    assert!(merged.validation.unresolved_cells > 0);
    assert!(!merged.ok);
    assert_eq!(merged.validation, serial.validation);
    assert_eq!(merged.verts, serial.verts);
    assert_eq!(merged.tris, serial.tris);
}
