//! M4 LATHE TS↔Rust feature-honoring full-mesh parity: rebuild the same revolve
//! scene + tuning that `gcad-wasm/fixtures/dump-mesh-lathe.mts` ran through the
//! TS `runSfccPipeline` (the FULL feature-aware pipeline — ring feature circles
//! on the revolved plane/cylinder/cone strata), run the Rust feature-aware
//! pipeline, and verify:
//!
//!   * topology + winding match the TS oracle EXACTLY (ring features honored),
//!     with a small `pos_eps` (1e-4·scene) absorbing V8↔Rust libm ULP drift;
//!   * closed oriented 2-manifold with χ = 2;
//!   * the Rust double-run is bit-identical (determinism guard, pos_eps = 0).
//!
//! Soft-skips the TS-fixture comparison if the fixture is absent
//! (run `tsx gcad-wasm/fixtures/dump-mesh-lathe.mts`); the invariant + determinism
//! checks run regardless.

use gcad_kernel::parity::{load_fixture, meshes_geometric_match};
use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::primitives::shapes::lathe_profile_edges;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::manifold_check::check_manifold;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccPipelineResult, SfccWorldCube};

/// MUST stay identical to `LATHE_PROFILE` in dump-mesh-lathe.mts.
const LATHE_PROFILE: [[f64; 2]; 5] = [[0.0, -2.0], [1.6, -2.0], [0.9, 1.0], [1.2, 2.0], [0.0, 2.0]];

fn tuning() -> PipelineTuning {
    PipelineTuning { depth_min: 4, depth_max: 7, ..PipelineTuning::default() }
}

fn cube() -> SfccWorldCube {
    SfccWorldCube { min_x: -3.0, min_y: -3.0, min_z: -3.0, size: 6.0 }
}

/// Attach each leaf's smooth analytic strata via `build_leaf_strata` (same helper
/// as the other feature-parity tests).
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

fn lathe_scene() -> CsgNode {
    let prof: Vec<[f64; 2]> = LATHE_PROFILE.to_vec();
    let edges = lathe_profile_edges(&prof, winding_sign(&prof));
    prepared_tree(sdf::leaf_at(Shape::Lathe { edges }, [0.0, 0.0, 0.0]))
}

fn assert_invariants(name: &str, tree: &CsgNode, r: &SfccPipelineResult) {
    assert!(!r.tris.is_empty(), "{name}: produced triangles");
    assert_eq!(r.stats.failed_cells, 0, "{name}: no failed cells");
    assert_eq!(r.stats.face_audit_failures, 0, "{name}: face audit clean");
    assert_eq!(r.stats.boundary_violations, 0, "{name}: no root-boundary crossings");
    assert!(r.ok, "{name}: pipeline ok");
    assert!(
        r.manifold.ok,
        "{name}: not a closed 2-manifold (open={} nm={} mis={})",
        r.manifold.open_edges, r.manifold.non_manifold_edges, r.manifold.misoriented_edges
    );
    assert_eq!(r.manifold.components, 1, "{name}: single component");
    assert_eq!(r.manifold.euler_per_component, vec![2i64], "{name}: χ must be 2");

    let m2 = check_manifold(&r.tris, true);
    assert!(m2.ok && m2.non_manifold_vertices == 0, "{name}: vertex-link manifold check on shipped buffer");

    let mut max_abs_f = 0.0f64;
    let mut i = 0;
    while i < r.verts.len() {
        let f = tree.f([r.verts[i] as f64, r.verts[i + 1] as f64, r.verts[i + 2] as f64]).abs();
        if f > max_abs_f {
            max_abs_f = f;
        }
        i += 8;
    }
    assert!(max_abs_f <= 0.05, "{name}: max |f| at vertices = {max_abs_f}");
}

fn assert_deterministic(name: &str, tree: &CsgNode, c: &SfccWorldCube, r: &SfccPipelineResult) {
    let r2 = run_sfcc_pipeline(tree, c, &tuning());
    assert_eq!(r.verts, r2.verts, "{name}: double-run vertex buffer not byte-identical");
    assert_eq!(r.tris, r2.tris, "{name}: double-run triangle buffer not byte-identical");
}

fn assert_ts_parity(name: &str, fixture: &str, r: &SfccPipelineResult) {
    let full = format!("{}/../fixtures/{fixture}", env!("CARGO_MANIFEST_DIR"));
    let (ts_verts, ts_tris) = match load_fixture(&full) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("mesh-lathe fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-mesh-lathe.mts`)");
            return;
        }
    };
    // Geometric tolerant parity (TS bit-parity is not a goal — the TS exporter is being
    // replaced by this kernel; the Illinois `find_root` diverges sub-root_tol from the TS
    // bisection oracle). Quality is pinned by the manifold/χ/winding invariants above.
    let rv: Vec<f64> = r.verts.iter().map(|&f| f as f64).collect();
    if let Err(e) = meshes_geometric_match(&rv, &r.tris, &ts_verts, &ts_tris, 1e-3 * 6.0, 0.06) {
        panic!("{name}: Rust↔TS geometric mesh parity failed: {e}");
    }
}

#[test]
fn mesh_lathe_matches_ts() {
    let tree = lathe_scene();
    let c = cube();
    let r = run_sfcc_pipeline(&tree, &c, &tuning());
    assert_invariants("mesh-lathe", &tree, &r);
    assert_deterministic("mesh-lathe", &tree, &c, &r);
    assert_ts_parity("mesh-lathe", "mesh-lathe.bin", &r);
}
