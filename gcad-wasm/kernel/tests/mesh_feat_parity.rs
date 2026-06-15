//! M4c-2 TS↔Rust FEATURE-HONORING full-mesh parity: rebuild the same `box` and
//! `box − sphere` scenes + tuning that `gcad-wasm/fixtures/dump-mesh-feat.mts`
//! ran through the TS `runSfccPipeline` (the FULL feature-aware pipeline), run
//! the Rust feature-aware pipeline, and verify:
//!
//!   * topology + winding match the TS oracle EXACTLY (sharp edges + boolean seam
//!     honored), with a small `pos_eps` (1e-4·scene) absorbing V8↔Rust libm ULP
//!     drift in interior/pin/corner vertex projection;
//!   * closed oriented 2-manifold with the correct Euler characteristic
//!     (χ = 2 for the box, χ = −2 for the genus-2 box−sphere);
//!   * the Rust double-run is bit-identical (determinism guard, pos_eps = 0).
//!
//! Soft-skips the TS-fixture comparison if the fixture is absent
//! (run `tsx gcad-wasm/fixtures/dump-mesh-feat.mts`); the invariant + determinism
//! checks run regardless.

use gcad_kernel::parity::{load_fixture, meshes_equivalent, CanonicalizeOptions};
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::manifold_check::check_manifold;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccPipelineResult, SfccWorldCube};

/// Pipeline tuning matching `dump-mesh-feat.mts` (DEFAULT_SFCC_TUNING with
/// depthMin 4, depthMax 7; default padding 2.0).
fn tuning() -> PipelineTuning {
    PipelineTuning { depth_min: 4, depth_max: 7, ..PipelineTuning::default() }
}

/// Tight bounding cube of the box half=10 at the origin (min −10, size 20).
fn cube() -> SfccWorldCube {
    SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 }
}

/// Attach each leaf's smooth analytic strata via `build_leaf_strata`, in
/// left-to-right CSG traversal order (matching `compile_native_features`), so the
/// refine path sees the carriers the TS tree does. (Same helper as
/// octree_feat_parity.rs.)
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

fn box_scene() -> CsgNode {
    prepared_tree(sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]))
}

fn box_minus_sphere_scene() -> CsgNode {
    prepared_tree(sdf::subtract(
        sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
    ))
}

/// Closed oriented 2-manifold with the expected χ; every vertex on the surface;
/// every triangle wound outward (∇f·faceNormal ≥ 0).
fn assert_invariants(name: &str, tree: &CsgNode, r: &SfccPipelineResult, expect_euler: i64, expect_inward: usize) {
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
    assert_eq!(r.manifold.euler_per_component, vec![expect_euler], "{name}: χ must be {expect_euler}");

    let m2 = check_manifold(&r.tris, true);
    assert!(m2.ok && m2.non_manifold_vertices == 0, "{name}: vertex-link manifold check on shipped buffer");

    // Every vertex on the surface to tolerance (sharp-edge pins / corners land
    // exactly on the analytic locus, so |f| there is sub-tol too).
    let mut max_abs_f = 0.0f64;
    let mut i = 0;
    while i < r.verts.len() {
        let f = tree.f([r.verts[i] as f64, r.verts[i + 1] as f64, r.verts[i + 2] as f64]).abs();
        if f > max_abs_f {
            max_abs_f = f;
        }
        i += 8;
    }
    // A touch looser than surfaceTol to absorb f32 fixture/round-trip rounding on
    // the polyline samples; still far below the cell size.
    assert!(max_abs_f <= 0.05, "{name}: max |f| at vertices = {max_abs_f}");

    // Outward winding. The centroid-∇f test is ambiguous AT a boolean crease (the
    // seam where the carve sphere meets a box face — ∇f is discontinuous there, so
    // a tiny triangle straddling it samples a normal that can point either way).
    // So the strict "0 inward" gate only holds on crease-free geometry (the box);
    // the AUTHORITATIVE winding check on the seam scene is the exact
    // (winding-sensitive) TS parity. `assert_ts_parity` carries that — here we just
    // require Rust to be NO WORSE than the TS oracle's own crease-ambiguous count
    // (`expect_inward`), so a real Rust winding regression would still trip.
    let flipped = count_inward(&r.verts, &r.tris, tree);
    assert!(
        flipped <= expect_inward,
        "{name}: {flipped} triangles wound inward (> {expect_inward} crease-ambiguous in the TS oracle)"
    );
}

/// Triangles whose centroid ∇f solidly disagrees with the face normal (cos <
/// −0.25). On crease-free geometry this is 0; at a boolean crease the centroid
/// normal is genuinely ambiguous and a handful appear identically in both meshes.
fn count_inward(verts: &[f32], tris: &[u32], tree: &CsgNode) -> usize {
    let mut flipped = 0usize;
    let mut t = 0;
    while t < tris.len() {
        let a = tris[t] as usize * 8;
        let b = tris[t + 1] as usize * 8;
        let c = tris[t + 2] as usize * 8;
        let abx = (verts[b] - verts[a]) as f64;
        let aby = (verts[b + 1] - verts[a + 1]) as f64;
        let abz = (verts[b + 2] - verts[a + 2]) as f64;
        let acx = (verts[c] - verts[a]) as f64;
        let acy = (verts[c + 1] - verts[a + 1]) as f64;
        let acz = (verts[c + 2] - verts[a + 2]) as f64;
        let nx = aby * acz - abz * acy;
        let ny = abz * acx - abx * acz;
        let nz = abx * acy - aby * acx;
        let nl = (nx * nx + ny * ny + nz * nz).sqrt();
        if nl < 1e-12 {
            t += 3;
            continue;
        }
        let cx = (verts[a] + verts[b] + verts[c]) as f64 / 3.0;
        let cy = (verts[a + 1] + verts[b + 1] + verts[c + 1]) as f64 / 3.0;
        let cz = (verts[a + 2] + verts[b + 2] + verts[c + 2]) as f64 / 3.0;
        let (_, g) = tree.grad([cx, cy, cz]);
        let gl = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
        let cos = if gl > 1e-9 { (nx * g[0] + ny * g[1] + nz * g[2]) / (nl * gl) } else { 0.0 };
        if cos < -0.25 {
            flipped += 1;
        }
        t += 3;
    }
    flipped
}

/// The Rust double-run must be bit-identical (the determinism guard, pos_eps = 0).
fn assert_deterministic(name: &str, tree: &CsgNode, c: &SfccWorldCube, r: &SfccPipelineResult) {
    let r2 = run_sfcc_pipeline(tree, c, &tuning());
    let rv: Vec<f64> = r.verts.iter().map(|&f| f as f64).collect();
    let rv2: Vec<f64> = r2.verts.iter().map(|&f| f as f64).collect();
    let exact = CanonicalizeOptions { pos_eps: 0.0, compare_normals: true, ..CanonicalizeOptions::default() };
    meshes_equivalent(&rv, &r.tris, &rv2, &r2.tris, &exact)
        .unwrap_or_else(|e| panic!("{name}: Rust double-run NOT bit-identical: {e}"));
    assert_eq!(r.verts, r2.verts, "{name}: double-run vertex buffer not byte-identical");
    assert_eq!(r.tris, r2.tris, "{name}: double-run triangle buffer not byte-identical");
}

/// Topology + geometry vs the TS oracle (soft-skip if the fixture is absent).
fn assert_ts_parity(name: &str, fixture: &str, r: &SfccPipelineResult) {
    let full = format!("{}/../fixtures/{fixture}", env!("CARGO_MANIFEST_DIR"));
    let (ts_verts, ts_tris) = match load_fixture(&full) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("mesh-feat fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-mesh-feat.mts`)");
            return;
        }
    };
    // pos_eps ≈ a small fraction of the scene scale: dwarfs cross-engine libm ULP
    // drift + f32 fixture rounding, far below the cell size, so topology/winding
    // can't slip. Topology, winding, and counts must match exactly.
    let pos_eps = 1e-4 * 20.0;
    let opts = CanonicalizeOptions { pos_eps, ..CanonicalizeOptions::default() };
    let rv: Vec<f64> = r.verts.iter().map(|&f| f as f64).collect();
    if let Err(e) = meshes_equivalent(&rv, &r.tris, &ts_verts, &ts_tris, &opts) {
        panic!(
            "{name}: Rust↔TS mesh mismatch (pos_eps={pos_eps}): {e}\n  rust: {} verts {} tris | ts: {} verts {} tris",
            rv.len() / 8,
            r.tris.len() / 3,
            ts_verts.len() / 8,
            ts_tris.len() / 3
        );
    }
}

/// The TS oracle's own crease-ambiguous inward-triangle count from a fixture
/// (the bar Rust must not exceed). 0 if the fixture is absent (soft-skip path).
fn ts_inward(fixture: &str, tree: &CsgNode) -> usize {
    let full = format!("{}/../fixtures/{fixture}", env!("CARGO_MANIFEST_DIR"));
    match load_fixture(&full) {
        Ok((v, t)) => {
            let vf: Vec<f32> = v.iter().map(|&x| x as f32).collect();
            count_inward(&vf, &t, tree)
        }
        Err(_) => 0,
    }
}

#[test]
fn mesh_feat_box_matches_ts() {
    // Crease-free (all-convex sharp edges): zero inward triangles expected.
    let tree = box_scene();
    let c = cube();
    let r = run_sfcc_pipeline(&tree, &c, &tuning());
    assert_invariants("mesh-feat-box", &tree, &r, 2, 0);
    assert_deterministic("mesh-feat-box", &tree, &c, &r);
    assert_ts_parity("mesh-feat-box", "mesh-feat-box.bin", &r);
}

#[test]
fn mesh_feat_box_minus_sphere_matches_ts() {
    let tree = box_minus_sphere_scene();
    let c = cube();
    let r = run_sfcc_pipeline(&tree, &c, &tuning());
    // Box − Sphere carves the +++ corner into a concave pocket: a genus-2 surface
    // (χ = 2 − 2·genus = −2). A handful of triangles straddle the concave boolean
    // crease where the centroid-∇f winding test is genuinely ambiguous; require
    // Rust to be no worse than the TS oracle's own count there.
    let expect_inward = ts_inward("mesh-feat-box-minus-sphere.bin", &tree);
    assert_invariants("mesh-feat-box-minus-sphere", &tree, &r, -2, expect_inward);
    assert_deterministic("mesh-feat-box-minus-sphere", &tree, &c, &r);
    assert_ts_parity("mesh-feat-box-minus-sphere", "mesh-feat-box-minus-sphere.bin", &r);
}
