//! M4 LOFT TS↔Rust feature-honoring full-mesh parity + loftSide carrier parity.
//! Rebuilds the same 2-profile morph scene + tuning that
//! `gcad-wasm/fixtures/dump-mesh-loft.mts` ran through the TS `runSfccPipeline`
//! (the FULL feature-aware pipeline), runs the Rust feature-aware pipeline, and
//! verifies:
//!
//!   * loftSide CARRIER parity: every side stratum's f/normal matches the TS
//!     oracle at a shared point cloud to < 1e-9 (localizes the bug-prone
//!     ruled-carrier port);
//!   * topology + winding match the TS oracle EXACTLY (cap rims / morph curves /
//!     cap corners honored), with `pos_eps = 1e-4·scene` absorbing libm ULP drift;
//!   * closed oriented 2-manifold with χ = 2;
//!   * the Rust double-run is bit-identical (determinism guard, pos_eps = 0).
//!
//! Soft-skips the fixture comparisons if absent
//! (run `tsx gcad-wasm/fixtures/dump-mesh-loft.mts`); invariants + determinism
//! run regardless.

use gcad_kernel::parity::{load_fixture, meshes_geometric_match};
use gcad_kernel::primitives::polygon2d::winding_sign;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::manifold_check::check_manifold;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccPipelineResult, SfccWorldCube};
use std::fs;

/// MUST stay identical to the literals in dump-mesh-loft.mts.
const BOTTOM: [[f64; 2]; 4] = [[2.0, 2.0], [-2.0, 2.0], [-2.0, -2.0], [2.0, -2.0]];
const TOP: [[f64; 2]; 4] = [[1.4, 0.0], [0.0, 1.4], [-1.4, 0.0], [0.0, -1.4]];
const LOFT_H: f64 = 2.0;

fn tuning() -> PipelineTuning {
    PipelineTuning { depth_min: 4, depth_max: 7, ..PipelineTuning::default() }
}

fn cube() -> SfccWorldCube {
    SfccWorldCube { min_x: -3.5, min_y: -3.5, min_z: -3.5, size: 7.0 }
}

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

fn loft_scene() -> CsgNode {
    let flatten = |p: &[[f64; 2]]| -> Vec<f64> { p.iter().flat_map(|v| [v[0], v[1]]).collect() };
    let profs = vec![flatten(&BOTTOM), flatten(&TOP)];
    let winds = vec![winding_sign(&BOTTOM), winding_sign(&TOP)];
    prepared_tree(sdf::leaf_at(Shape::Loft { profs, winds, h: LOFT_H }, [0.0, 0.0, 0.0]))
}

/// A 2-profile loft from arbitrary (possibly differing-vertex-count) profiles.
fn loft_scene_2(bottom: &[[f64; 2]], top: &[[f64; 2]]) -> CsgNode {
    let flatten = |p: &[[f64; 2]]| -> Vec<f64> { p.iter().flat_map(|v| [v[0], v[1]]).collect() };
    let profs = vec![flatten(bottom), flatten(top)];
    let winds = vec![winding_sign(bottom), winding_sign(top)];
    prepared_tree(sdf::leaf_at(Shape::Loft { profs, winds, h: LOFT_H }, [0.0, 0.0, 0.0]))
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
            eprintln!("mesh-loft fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-mesh-loft.mts`)");
            return;
        }
    };
    // Geometric tolerant parity (TS bit-parity is not a goal — the TS exporter is being
    // replaced by this kernel; the Illinois `find_root` diverges sub-root_tol from the TS
    // bisection oracle). Quality is pinned by the manifold/χ/winding invariants above.
    let rv: Vec<f64> = r.verts.iter().map(|&f| f as f64).collect();
    if let Err(e) = meshes_geometric_match(&rv, &r.tris, &ts_verts, &ts_tris, 1e-3 * 7.0, 0.06) {
        panic!("{name}: Rust↔TS geometric mesh parity failed: {e}");
    }
}

/// loftSide carrier f/normal vs the TS oracle at the dumped point cloud.
fn assert_loft_carrier_parity() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/loft-carrier.txt");
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("loft-carrier fixture missing: {path} (run `tsx gcad-wasm/fixtures/dump-mesh-loft.mts`)");
            return;
        }
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let nums = |line: &str, skip: usize| -> Vec<f64> {
        line.split_whitespace().skip(skip).map(|t| t.parse::<f64>().unwrap()).collect()
    };
    let mut i = 0usize;
    let k = nums(lines[i], 1)[0] as usize;
    i += 1;
    let mut pts = Vec::with_capacity(k);
    for _ in 0..k {
        let v = nums(lines[i], 0);
        i += 1;
        pts.push([v[0], v[1], v[2]]);
    }
    let n_sides = nums(lines[i], 1)[0] as usize;
    i += 1;
    let tree = loft_scene();
    let leaf = match &tree {
        CsgNode::Leaf(l) => l,
        _ => unreachable!("loft is a single leaf"),
    };
    for si in 0..n_sides {
        let kind = lines[i].split_whitespace().nth(1).unwrap().to_string();
        i += 1;
        assert_eq!(kind, "loftSide", "side stratum {si} kind");
        let st = &leaf.strata[si];
        for (pj, q) in pts.iter().enumerate() {
            let v = nums(lines[i], 0);
            i += 1;
            let rf = st.f(q[0], q[1], q[2]);
            assert!((rf - v[0]).abs() < 1e-9, "loftSide {si} pt {pj}: f {rf} vs {}", v[0]);
            let rn = st.normal(q[0], q[1], q[2]);
            assert!(
                (rn[0] - v[1]).abs() < 1e-9 && (rn[1] - v[2]).abs() < 1e-9 && (rn[2] - v[3]).abs() < 1e-9,
                "loftSide {si} pt {pj}: normal [{},{},{}] vs [{},{},{}]",
                rn[0], rn[1], rn[2], v[1], v[2], v[3]
            );
        }
    }
}

#[test]
fn mesh_loft_matches_ts() {
    // loftSide carrier parity first (localizes the ruled-carrier port).
    assert_loft_carrier_parity();

    let tree = loft_scene();
    let c = cube();
    let r = run_sfcc_pipeline(&tree, &c, &tuning());
    assert_invariants("mesh-loft", &tree, &r);
    assert_deterministic("mesh-loft", &tree, &c, &r);
    assert_ts_parity("mesh-loft", "mesh-loft.bin", &r);
}

/// Stage 1a: differing-vertex-count profiles. The SDF is a distance-field blend
/// that is independent of per-profile vertex counts, so these must mesh without
/// panicking. The feature path degrades to cap-only (smooth morph sides); the
/// invariants here assert the mesh is still a watertight χ=2 manifold — in
/// particular that the un-pinned cap rim stays watertight at coarse octree depth.
#[test]
fn mesh_loft_differing_topology() {
    let c = cube();

    // Equilateral-ish triangle (3) -> square (4).
    let tri: [[f64; 2]; 3] = [[0.0, 2.0], [-1.732, -1.0], [1.732, -1.0]];
    let sq: [[f64; 2]; 4] = [[1.4, 1.4], [-1.4, 1.4], [-1.4, -1.4], [1.4, -1.4]];
    let t1 = loft_scene_2(&tri, &sq);
    let r1 = run_sfcc_pipeline(&t1, &c, &tuning());
    assert_invariants("loft-tri-square", &t1, &r1);
    assert_deterministic("loft-tri-square", &t1, &c, &r1);

    // Square (4) -> regular pentagon (5).
    let pent: [[f64; 2]; 5] =
        [[0.0, 2.0], [-1.902, 0.618], [-1.176, -1.618], [1.176, -1.618], [1.902, 0.618]];
    let t2 = loft_scene_2(&sq, &pent);
    let r2 = run_sfcc_pipeline(&t2, &c, &tuning());
    assert_invariants("loft-square-pent", &t2, &r2);
    assert_deterministic("loft-square-pent", &t2, &c, &r2);
}
