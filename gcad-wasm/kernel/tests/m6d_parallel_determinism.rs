//! M6d determinism gate for the rayon-parallelized refine frontier.
//!
//! The octree refine WORKLIST now runs the per-cell split DECISION
//! (`classifyCellFeatures` + the smooth certificates — the ~67% hot path) over
//! each round's frontier in parallel under the `threads` feature, serially
//! otherwise. The mesh must be IDENTICAL either way. This test pins that down on
//! the three gate scenes (box / box − sphere / twisted-l):
//!
//!   * DOUBLE-RUN BIT-IDENTICAL: two pipeline runs in the SAME build produce
//!     byte-identical vertex + triangle buffers (pos_eps = 0). Under `--features
//!     threads` this is the parallel double-run guard; under the default build it
//!     is the serial one. rayon's `par_iter().collect()` is order-preserving and
//!     the decision is a pure read over the immutable feature set, so the result
//!     is deterministic by construction.
//!
//!   * PARALLEL == SERIAL: the gate scenes here are ALSO covered by the TS-oracle
//!     parity suites (`mesh_feat_parity`, `mesh_extrude_parity`), which run in
//!     BOTH builds and canonical-compare to the same TS fixture — so parallel
//!     output and serial output both equal the oracle, hence each other. This
//!     file is the self-contained, feature-agnostic restatement of that gate.
//!
//! Each scene also re-checks the closed-2-manifold invariant (parallelism must
//! not perturb topology). A `THREADS=on/off` marker is printed so the active
//! build is visible in the test log.

use gcad_kernel::parity::{meshes_equivalent, CanonicalizeOptions};
use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccPipelineResult, SfccWorldCube};

const THREADS_ON: bool = cfg!(feature = "threads");

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

/// A twisted L-profile extrude — the classify-bound family the parallelism
/// targets (traced side carriers, many feature-edge cells).
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

/// Double-run bit-identical (pos_eps = 0) + closed-2-manifold.
fn assert_deterministic_manifold(name: &str, tree: &CsgNode, c: &SfccWorldCube) -> SfccPipelineResult {
    println!("[m6d] {name}: THREADS={}", if THREADS_ON { "on" } else { "off" });
    let r1 = run_sfcc_pipeline(tree, c, &tuning());
    let r2 = run_sfcc_pipeline(tree, c, &tuning());

    assert!(!r1.tris.is_empty(), "{name}: produced triangles");
    assert!(r1.manifold.ok, "{name}: closed 2-manifold");
    assert_eq!(r1.manifold.components, 1, "{name}: single component");

    // Exact (byte-identical) buffers — the strongest determinism statement.
    assert_eq!(r1.verts, r2.verts, "{name}: double-run vertex buffer not byte-identical");
    assert_eq!(r1.tris, r2.tris, "{name}: double-run triangle buffer not byte-identical");
    // Canonical compare too (catches accidental winding/topology drift at eps 0).
    let rv1: Vec<f64> = r1.verts.iter().map(|&f| f as f64).collect();
    let rv2: Vec<f64> = r2.verts.iter().map(|&f| f as f64).collect();
    let exact = CanonicalizeOptions { pos_eps: 0.0, compare_normals: true, ..CanonicalizeOptions::default() };
    meshes_equivalent(&rv1, &r1.tris, &rv2, &r2.tris, &exact)
        .unwrap_or_else(|e| panic!("{name}: double-run NOT bit-identical: {e}"));
    r1
}

#[test]
fn box_double_run_bit_identical() {
    let tree = box_scene();
    let r = assert_deterministic_manifold("box", &tree, &cube20());
    assert_eq!(r.manifold.euler_per_component, vec![2i64], "box: χ = 2");
}

#[test]
fn box_minus_sphere_double_run_bit_identical() {
    let tree = box_minus_sphere_scene();
    let r = assert_deterministic_manifold("box-minus-sphere", &tree, &cube20());
    // Genus-2 carve (sphere pokes through three faces) → χ = −2, matching mesh_feat_parity.
    assert_eq!(r.manifold.euler_per_component, vec![-2i64], "box-minus-sphere: χ = −2");
}

#[test]
fn twisted_l_double_run_bit_identical() {
    let (tree, c) = twisted_l_scene();
    let r = assert_deterministic_manifold("twisted-l", &tree, &c);
    assert_eq!(r.manifold.euler_per_component, vec![2i64], "twisted-l: χ = 2 (solid)");
}
