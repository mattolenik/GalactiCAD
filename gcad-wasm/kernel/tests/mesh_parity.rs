//! TS↔Rust full-mesh parity (M3c): rebuild the same SMOOTH scenes + tuning that
//! `gcad-wasm/fixtures/dump-mesh.mts` ran through the TS `runSfccPipeline`, run
//! the Rust smooth pipeline, and verify the result.
//!
//! Two gate tiers, by whether the TS oracle uses M4 feature refinement on the
//! scene (the smooth Rust pipeline omits it deliberately):
//!
//!   - SPHERE (TS `featureCurves == 0`, truly featureless) — the FULL gate:
//!       * topology + geometry: `meshes_equivalent(rust, ts, pos_eps = small)`,
//!         a small eps absorbing V8↔Rust libm ULP drift in the interior-vertex
//!         projection; topology and winding match EXACTLY;
//!       * manifold: closed 2-manifold, χ = 2;
//!       * determinism: the Rust pipeline run twice is bit-identical (eps = 0).
//!
//!   - OVERLAPPING UNION (TS `featureCurves == 1` — the hard-`min` seam circle is
//!     a boolean feature TS REFINES around, which is M4) — the INVARIANT gate
//!     (the TS exact triangle set legitimately differs at higher seam
//!     resolution): closed 2-manifold with χ = 2, every vertex on the surface to
//!     `surfaceTol`, every triangle wound outward (∇f · faceNormal ≥ 0), plus the
//!     Rust double-run bit-identical guard. Exact TS-topology parity here is an
//!     M4 deliverable (feature-aware refine/contour/cell-mesh).
//!
//! Soft-skips the TS-fixture comparison if the fixture is absent
//! (run `tsx gcad-wasm/fixtures/dump-mesh.mts`); the invariant + determinism
//! checks run regardless.

use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::parity::{load_fixture, meshes_equivalent, CanonicalizeOptions};
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::manifold_check::check_manifold;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccPipelineResult, SfccWorldCube};
use gcad_kernel::strata::{Stratum, StratumIdentity};

/// Pipeline tuning matching `dump-mesh.mts` (DEFAULT_SFCC_TUNING with depthMin 5,
/// depthMax 8, no padding).
fn tuning() -> PipelineTuning {
    PipelineTuning { depth_min: 5, depth_max: 8, bounds_padding_mm: 0.0, ..PipelineTuning::default() }
}

const SURFACE_TOL: f64 = 0.01;

/// A sphere leaf at `c` with its world-space sphere carrier — mirrors what
/// `compileCpuSdf` builds for `Sphere(pos, {r})` under an identity similarity:
/// `f = sphereDist(p − pos, r)`, stratum = Sphere(center = pos, r).
fn sphere_leaf(id: usize, leaf_index: usize, c: [f64; 3], r: f64) -> CsgNode {
    let strata = vec![Stratum::sphere(
        StratumIdentity { id, owner_node_id: -1, leaf_index, local_index: 0, sign: 1.0 },
        c[0],
        c[1],
        c[2],
        r,
    )];
    sdf::leaf_with_strata(Shape::Sphere { r }, Similarity::identity(), c, strata)
}

/// Sphere r=8 at the origin.
fn sphere_scene() -> CsgNode {
    let mut t = sphere_leaf(0, 0, [0.0, 0.0, 0.0], 8.0);
    t.assign_leaf_indices();
    t
}

/// Hard union of two overlapping r=3 spheres (the "overlapping smooth union"
/// scene — `Union([Sphere([-1.4,0.2,0.1],3), Sphere([1.5,-0.3,0.2],3)])`).
fn smooth_union_scene() -> CsgNode {
    let mut t = sdf::union(vec![
        sphere_leaf(0, 0, [-1.4, 0.2, 0.1], 3.0),
        sphere_leaf(1, 1, [1.5, -0.3, 0.2], 3.0),
    ]);
    t.assign_leaf_indices();
    t
}

/// Closed 2-manifold with χ=2 per component, all vertices on the surface to
/// `surfaceTol`, every triangle wound outward (∇f·faceNormal ≥ 0). Mirrors the
/// TS `assertSmoothInvariants`.
fn assert_smooth_invariants(name: &str, tree: &CsgNode, r: &SfccPipelineResult, expect_components: usize) {
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
    assert_eq!(r.manifold.components, expect_components, "{name}: component count");
    assert_eq!(r.manifold.euler_per_component, vec![2i64; expect_components], "{name}: χ per component must be 2");

    // Vertex-link manifold check on the shipped index buffer.
    let m2 = check_manifold(&r.tris, true);
    assert!(m2.ok && m2.non_manifold_vertices == 0, "{name}: vertex-link manifold check on shipped buffer");

    // Every vertex on the surface to tolerance.
    let mut max_abs_f = 0.0f64;
    let mut i = 0;
    while i < r.verts.len() {
        let f = tree.f([r.verts[i] as f64, r.verts[i + 1] as f64, r.verts[i + 2] as f64]).abs();
        if f > max_abs_f {
            max_abs_f = f;
        }
        i += 8;
    }
    assert!(max_abs_f <= SURFACE_TOL, "{name}: max |f| at vertices = {max_abs_f}");

    // Outward winding: triangle normal agrees with ∇f at the centroid.
    let mut flipped = 0usize;
    let mut t = 0;
    while t < r.tris.len() {
        let a = r.tris[t] as usize * 8;
        let b = r.tris[t + 1] as usize * 8;
        let c = r.tris[t + 2] as usize * 8;
        let abx = (r.verts[b] - r.verts[a]) as f64;
        let aby = (r.verts[b + 1] - r.verts[a + 1]) as f64;
        let abz = (r.verts[b + 2] - r.verts[a + 2]) as f64;
        let acx = (r.verts[c] - r.verts[a]) as f64;
        let acy = (r.verts[c + 1] - r.verts[a + 1]) as f64;
        let acz = (r.verts[c + 2] - r.verts[a + 2]) as f64;
        let nx = aby * acz - abz * acy;
        let ny = abz * acx - abx * acz;
        let nz = abx * acy - aby * acx;
        let cx = (r.verts[a] + r.verts[b] + r.verts[c]) as f64 / 3.0;
        let cy = (r.verts[a + 1] + r.verts[b + 1] + r.verts[c + 1]) as f64 / 3.0;
        let cz = (r.verts[a + 2] + r.verts[b + 2] + r.verts[c + 2]) as f64 / 3.0;
        let (_, g) = tree.grad([cx, cy, cz]);
        if nx * g[0] + ny * g[1] + nz * g[2] < 0.0 {
            flipped += 1;
        }
        t += 3;
    }
    assert_eq!(flipped, 0, "{name}: {flipped}/{} triangles wound inward", r.tris.len() / 3);
}

/// The Rust double-run must be bit-identical (the determinism guard, pos_eps = 0).
fn assert_deterministic(name: &str, tree: &CsgNode, cube: &SfccWorldCube, r: &SfccPipelineResult) {
    let r2 = run_sfcc_pipeline(tree, cube, &tuning());
    let rv: Vec<f64> = r.verts.iter().map(|&f| f as f64).collect();
    let rv2: Vec<f64> = r2.verts.iter().map(|&f| f as f64).collect();
    let exact = CanonicalizeOptions { pos_eps: 0.0, compare_normals: true, ..CanonicalizeOptions::default() };
    meshes_equivalent(&rv, &r.tris, &rv2, &r2.tris, &exact)
        .unwrap_or_else(|e| panic!("{name}: Rust double-run NOT bit-identical: {e}"));
    assert_eq!(r.verts, r2.verts, "{name}: double-run vertex buffer not byte-identical");
    assert_eq!(r.tris, r2.tris, "{name}: double-run triangle buffer not byte-identical");
}

#[test]
fn mesh_sphere_matches_ts() {
    // Truly featureless: the full gate, including EXACT topology parity vs TS.
    let tree = sphere_scene();
    let cube = SfccWorldCube { min_x: -12.0, min_y: -12.0, min_z: -12.0, size: 24.0 };
    let r = run_sfcc_pipeline(&tree, &cube, &tuning());

    assert_smooth_invariants("mesh-sphere", &tree, &r, 1);
    assert_deterministic("mesh-sphere", &tree, &cube, &r);

    // Topology + geometry vs the TS oracle (soft-skip if the fixture is absent).
    let full = format!("{}/../fixtures/mesh-sphere.bin", env!("CARGO_MANIFEST_DIR"));
    let (ts_verts, ts_tris) = match load_fixture(&full) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("mesh fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-mesh.mts`)");
            return;
        }
    };
    // pos_eps ≈ a small fraction of the scene scale: it dwarfs cross-engine libm
    // ULP drift (and the f32 fixture rounding) yet stays far below the cell size,
    // so topology/winding can't slip. Topology, winding, and counts match exactly.
    let pos_eps = 1e-4 * 24.0;
    let opts = CanonicalizeOptions { pos_eps, ..CanonicalizeOptions::default() };
    let rv: Vec<f64> = r.verts.iter().map(|&f| f as f64).collect();
    if let Err(e) = meshes_equivalent(&rv, &r.tris, &ts_verts, &ts_tris, &opts) {
        panic!(
            "mesh-sphere: Rust↔TS mesh mismatch (pos_eps={pos_eps}): {e}\n  rust: {} verts {} tris | ts: {} verts {} tris",
            rv.len() / 8,
            r.tris.len() / 3,
            ts_verts.len() / 8,
            ts_tris.len() / 3
        );
    }
}

#[test]
fn mesh_smooth_union_is_closed_and_deterministic() {
    // The hard-`min` seam circle is a boolean feature TS REFINES around (TS
    // reports featureCurves == 1); that feature-aware refinement is M4, so the
    // smooth Rust mesh is legitimately coarser at the seam and the EXACT TS
    // triangle set differs. Gate on the geometric invariants the smooth mesh
    // MUST satisfy regardless — closed 2-manifold, χ=2, on-surface, outward —
    // plus the Rust double-run determinism guard. (Exact TS-topology parity for
    // this scene is an M4 deliverable.)
    let tree = smooth_union_scene();
    let cube = SfccWorldCube { min_x: -8.0, min_y: -8.0, min_z: -8.0, size: 16.0 };
    let r = run_sfcc_pipeline(&tree, &cube, &tuning());

    assert_smooth_invariants("mesh-smooth-union", &tree, &r, 1);
    assert_deterministic("mesh-smooth-union", &tree, &cube, &r);
}
