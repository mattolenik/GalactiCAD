//! Octree-decision parallelism / Stage A — the worker `decide_partition` gate.
//!
//! Proves the cross-instance octree-DECISION primitive is correct: a worker that
//! decides a CONTIGUOUS slice `[start, end)` of a frontier (rebuilding its context
//! from scene_json — a fresh, un-cached sampler) reproduces the serial build's
//! decisions BIT-FOR-BIT, and concatenating N disjoint slices equals deciding the
//! whole frontier (so the cross-worker split is exact).
//!
//! Two checks, on box / box-minus-sphere / rounded-union / twisted-l, N ∈ {1,2,4,8}:
//!  1. PARTITION-CONSISTENCY: whole-frontier decisions == concatenated N-slice
//!     decisions (split + both feature tags), through the serialized wire format.
//!  2. FRESH-CONTEXT FIDELITY: re-deciding the built leaves reproduces the tags the
//!     serial build stamped onto them, and every KEPT (non-degenerate, level <
//!     max_depth) leaf re-decides to split:false — i.e. the un-cached worker sampler
//!     is bit-identical to the build's cached `SampleView` pass. A discrepancy here
//!     would mean a worker could disagree with the serial tree (→ cracks); it doesn't.

use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::worker::{decide_partition_bytes, decode_decisions, decode_tagged_leaves, prepare};

// --- scene builders (mirror worker_partition.rs; test crates can't share helpers) ---

fn attach_strata(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
    match node {
        CsgNode::Leaf(l) => {
            let strata = build_leaf_strata(&Leaf { strata: Vec::new(), ..l.clone() }, *leaf_index, *first_id);
            *first_id += strata.len();
            *leaf_index += 1;
            l.strata = strata;
        }
        CsgNode::Min(ch) | CsgNode::Max(ch) => {
            for c in ch.iter_mut() {
                attach_strata(c, leaf_index, first_id);
            }
        }
        CsgNode::Blend { children, .. } => {
            for c in children.iter_mut() {
                attach_strata(c, leaf_index, first_id);
            }
        }
    }
}

fn prepared_tree(mut tree: CsgNode) -> CsgNode {
    tree.assign_leaf_indices();
    let mut leaf_index = 0usize;
    let mut first_id = 0usize;
    attach_strata(&mut tree, &mut leaf_index, &mut first_id);
    tree
}

fn cube20() -> SfccWorldCube {
    SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 }
}

fn box_scene() -> CsgNode {
    prepared_tree(sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]))
}

fn box_minus_sphere_scene() -> CsgNode {
    prepared_tree(sdf::subtract(
        sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
    ))
}

fn rounded_union_scene() -> CsgNode {
    prepared_tree(sdf::union_smooth(
        vec![
            sdf::leaf_at(Shape::Cuboid { half: [7.0, 7.0, 7.0] }, [-3.0, 0.0, 0.0]),
            sdf::leaf_at(Shape::Sphere { r: 7.0 }, [4.0, 0.0, 0.0]),
        ],
        gcad_kernel::primitives::smin::SminMode::Round,
        3.0,
        2.0,
    ))
}

fn twisted_l_scene() -> (CsgNode, SfccWorldCube) {
    let l_poly: [[f64; 2]; 6] = [[-3.0, -3.0], [3.0, -3.0], [3.0, 0.0], [0.0, 0.0], [0.0, 3.0], [-3.0, 3.0]];
    let verts: Vec<f64> = l_poly.iter().flat_map(|v| [v[0], v[1]]).collect();
    let wind = winding_sign(&l_poly);
    let twist_rad = 90.0_f64 * std::f64::consts::PI / 180.0;
    let tree = prepared_tree(sdf::leaf_at(Shape::Extrude { verts, wind, h: 5.0, twist_rad }, [0.0, 0.0, 0.0]));
    (tree, SfccWorldCube { min_x: -6.0, min_y: -6.0, min_z: -6.0, size: 12.0 })
}

fn tuning() -> PipelineTuning {
    PipelineTuning { depth_min: 4, depth_max: 7, ..PipelineTuning::default() }
}

fn assert_decide_partition_correct(name: &str, tree: &CsgNode, c: &SfccWorldCube) {
    let t = tuning();
    // Built tagged leaves (the serial DECISION result) — also the test's frontier.
    let leaves_bytes = prepare(tree, c, &t);
    let (_lat, leaves) = decode_tagged_leaves(&leaves_bytes);
    let n = leaves.len();
    assert!(n > 0, "{name}: prepare produced leaves");

    // Whole-frontier decisions in one slice.
    let whole = decode_decisions(&decide_partition_bytes(tree, c, &t, &leaves_bytes, 0, n));
    assert_eq!(whole.len(), n, "{name}: whole decision count");

    // (1) PARTITION-CONSISTENCY: N disjoint slices, concatenated == whole.
    for &nparts in &[1usize, 2, 4, 8] {
        let mut chunked = Vec::with_capacity(n);
        for p in 0..nparts {
            let start = p * n / nparts;
            let end = (p + 1) * n / nparts;
            chunked.extend(decode_decisions(&decide_partition_bytes(tree, c, &t, &leaves_bytes, start, end)));
        }
        assert_eq!(chunked.len(), n, "{name}: N={nparts} concatenated decision count");
        for i in 0..n {
            assert!(
                chunked[i].split == whole[i].split
                    && chunked[i].feature_curve == whole[i].feature_curve
                    && chunked[i].feature_corner == whole[i].feature_corner,
                "{name}: N={nparts} decision[{i}] differs whole-vs-chunked (cross-worker split not exact)"
            );
        }
    }

    // (2) FRESH-CONTEXT FIDELITY: re-decided tags == build's stamped tags; every kept
    //     non-degenerate sub-max-depth leaf re-decides to split:false.
    let max_depth = t.depth_max;
    let mut kept_checked = 0usize;
    for i in 0..n {
        let l = &leaves[i];
        let d = &whole[i];
        assert_eq!(d.feature_curve, l.feature_curve, "{name}: leaf[{i}] curve tag drift (cached vs fresh sampler)");
        assert_eq!(d.feature_corner, l.feature_corner, "{name}: leaf[{i}] corner tag drift (cached vs fresh sampler)");
        if l.level < max_depth && !l.degenerate {
            assert!(!d.split, "{name}: kept leaf[{i}] (level {}) re-decided to split — worker disagrees with serial", l.level);
            kept_checked += 1;
        }
    }
    println!(
        "[octree-decide] {name}: decide_partition whole==N-slice (1,2,4,8) & fresh-context fidelity OK; {n} leaves ({kept_checked} kept sub-max-depth verified split:false)"
    );
}

#[test]
fn box_decide_partition_matches_serial() {
    assert_decide_partition_correct("box", &box_scene(), &cube20());
}

#[test]
fn box_minus_sphere_decide_partition_matches_serial() {
    assert_decide_partition_correct("box-minus-sphere", &box_minus_sphere_scene(), &cube20());
}

#[test]
fn rounded_union_decide_partition_matches_serial() {
    assert_decide_partition_correct("rounded-union", &rounded_union_scene(), &cube20());
}

#[test]
fn twisted_l_decide_partition_matches_serial() {
    let (tree, c) = twisted_l_scene();
    assert_decide_partition_correct("twisted-l", &tree, &c);
}
