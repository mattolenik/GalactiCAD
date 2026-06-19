//! Slice 5b stage B gate — the RESUMABLE per-round octree build.
//!
//! Proves the per-round build driver (snapshot frontier → caller-supplied decisions
//! → split+ripple → next round), driven by the WORKER decision primitive
//! (`decide_partition`, a fresh un-cached sampler), reconstructs the serial build's
//! tagged leaves BYTE-IDENTICALLY. This is the obstacle the gate flagged: the build
//! is now a borrow-free state machine that yields its frontier between rounds (so a
//! JS BSP orchestration can scatter the decision to worker wasm instances) — and it
//! produces the exact same octree as the inline serial build.
//!
//! Compares, on box / box-minus-sphere / rounded-union / twisted-l, the encoded
//! tagged leaves from `build_octree_resumable_inprocess` vs serial `prepare`.

use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::worker::{build_octree_resumable_inprocess, prepare};

// --- scene builders (mirror octree_decide_partition.rs; test crates can't share) ---

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

fn assert_resumable_matches_serial(name: &str, tree: &CsgNode, c: &SfccWorldCube) {
    let t = tuning();
    let serial = prepare(tree, c, &t);
    let resumable = build_octree_resumable_inprocess(tree, c, &t);
    assert!(!serial.is_empty(), "{name}: serial prepare produced no leaves");
    assert_eq!(
        serial, resumable,
        "{name}: resumable per-round build leaves != serial build (byte-identical gate failed)"
    );
    println!("[octree-resumable] {name}: resumable per-round build == serial, {} leaf-bytes", serial.len());
}

#[test]
fn box_resumable_matches_serial() {
    assert_resumable_matches_serial("box", &box_scene(), &cube20());
}

#[test]
fn box_minus_sphere_resumable_matches_serial() {
    assert_resumable_matches_serial("box-minus-sphere", &box_minus_sphere_scene(), &cube20());
}

#[test]
fn rounded_union_resumable_matches_serial() {
    assert_resumable_matches_serial("rounded-union", &rounded_union_scene(), &cube20());
}

#[test]
fn twisted_l_resumable_matches_serial() {
    let (tree, c) = twisted_l_scene();
    assert_resumable_matches_serial("twisted-l", &tree, &c);
}
