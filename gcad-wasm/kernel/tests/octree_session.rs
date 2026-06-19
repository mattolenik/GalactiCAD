//! Slice 5b stage B2a gate — the resumable octree-decision SESSION.
//!
//! Drives the wasm-holdable session API the JS BSP loop will use —
//!   octree_session_begin → loop { current_frontier → decide_partition_bytes (the
//!   WORKER decision primitive, exercising the full frontier→decisions wire
//!   round-trip) → apply_decisions } → finish
//! — and asserts the tagged leaves are BYTE-IDENTICAL to serial `prepare`.
//!
//! This is the in-process proof of the exact path stage B2b drives over real Web
//! Workers (only the inline `decide_partition_bytes` becomes a worker scatter/gather):
//! the per-round state machine + the frontier/decisions encode+decode reconstruct the
//! serial octree before any JS exists. Beyond `octree_resumable.rs` (which drives the
//! kernel `ResumableOctreeBuild` directly), this drives the SESSION exports through the
//! byte wire on both legs.
//!
//! Scenes: box / box-minus-sphere / rounded-union / twisted-l.

use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::worker::{
    decide_partition_bytes, decode_tagged_leaves, octree_session_apply_decisions, octree_session_begin,
    octree_session_current_frontier, octree_session_finish, prepare,
};

// --- scene builders (mirror octree_resumable.rs; test crates can't share) ---

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

/// Drive the session API to completion, deciding each round's frontier through the
/// worker primitive (`decide_partition_bytes`) over the wire — the exact in-process
/// analogue of the JS BSP loop.
fn run_session(tree: &CsgNode, c: &SfccWorldCube, t: &PipelineTuning) -> Vec<u8> {
    octree_session_begin(tree.clone(), c, t);
    let mut rounds = 0usize;
    loop {
        let frontier_bytes = octree_session_current_frontier();
        let (_lat, frontier) = decode_tagged_leaves(&frontier_bytes);
        if frontier.is_empty() {
            break; // is_done() — no more rounds
        }
        // Decide the whole frontier via the worker primitive (one "worker", full slice);
        // disjoint-slice exactness is proven by octree_decide_partition.rs.
        let decisions = decide_partition_bytes(tree, c, t, &frontier_bytes, 0, frontier.len());
        rounds += 1;
        if octree_session_apply_decisions(&decisions) {
            break; // build complete
        }
    }
    assert!(rounds > 0, "session ran zero decide rounds");
    octree_session_finish()
}

fn assert_session_matches_serial(name: &str, tree: &CsgNode, c: &SfccWorldCube) {
    let t = tuning();
    let serial = prepare(tree, c, &t);
    let session = run_session(tree, c, &t);
    assert!(!serial.is_empty(), "{name}: serial prepare produced no leaves");
    assert_eq!(
        serial, session,
        "{name}: session-driven per-round build leaves != serial build (byte-identical gate failed)"
    );
    println!("[octree-session] {name}: session build == serial, {} leaf-bytes", serial.len());
}

#[test]
fn box_session_matches_serial() {
    assert_session_matches_serial("box", &box_scene(), &cube20());
}

#[test]
fn box_minus_sphere_session_matches_serial() {
    assert_session_matches_serial("box-minus-sphere", &box_minus_sphere_scene(), &cube20());
}

#[test]
fn rounded_union_session_matches_serial() {
    assert_session_matches_serial("rounded-union", &rounded_union_scene(), &cube20());
}

#[test]
fn twisted_l_session_matches_serial() {
    let (tree, c) = twisted_l_scene();
    assert_session_matches_serial("twisted-l", &tree, &c);
}
