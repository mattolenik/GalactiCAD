//! M5 SCENE-BRIDGE native gate. Feeds the SERIALIZED scene fixtures
//! (`bridge-<name>.json`, written by `gcad-wasm/fixtures/dump-bridge.mts`) through
//! `scene_bridge::build_csg_tree_from_json` → `run_sfcc_pipeline` and asserts the
//! Rust mesh matches the TS SFCC reference mesh (`bridge-<name>.bin`) via
//! `parity::meshes_equivalent` with a small `pos_eps` (V8↔Rust libm ULP drift).
//!
//! This proves the boundary INPUT path — serialized scene → Rust CsgNode → mesh —
//! WITHOUT the app: the same five acceptance scenes the M4 parity suite covers
//! (box / box−sphere / lathe / extrude-twist / loft), but rebuilt by the bridge
//! from JSON instead of hand-constructed in Rust.
//!
//! Requires the `serde` feature (the bridge's JSON ingestion):
//!     cargo test -p gcad-kernel --features serde --test scene_bridge_parity
//! Without it the file compiles to nothing (the geometry kernel stays dep-free).
//!
//! Soft-skips a scene whose fixtures are absent (run the dumper first).

#![cfg(feature = "serde")]

use gcad_kernel::parity::{load_fixture, meshes_equivalent, CanonicalizeOptions};
use gcad_kernel::scene_bridge::build_csg_tree_from_json;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};

/// All five scenes share depthMin 4 / depthMax 7 (the dumper's `D47`).
fn tuning() -> PipelineTuning {
    PipelineTuning { depth_min: 4, depth_max: 7, ..PipelineTuning::default() }
}

/// Feed `bridge-<name>.json` through the bridge + pipeline and assert mesh parity
/// against `bridge-<name>.bin`. Soft-skips if either fixture is missing.
fn assert_bridge_parity(name: &str, cube: SfccWorldCube) {
    let dir = format!("{}/../fixtures", env!("CARGO_MANIFEST_DIR"));
    let json = match std::fs::read_to_string(format!("{dir}/bridge-{name}.json")) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("bridge fixture missing: bridge-{name}.json (run `tsx gcad-wasm/fixtures/dump-bridge.mts`)");
            return;
        }
    };
    let (ts_verts, ts_tris) = match load_fixture(&format!("{dir}/bridge-{name}.bin")) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("bridge fixture missing: bridge-{name}.bin (run `tsx gcad-wasm/fixtures/dump-bridge.mts`)");
            return;
        }
    };

    let tree = build_csg_tree_from_json(&json)
        .unwrap_or_else(|e| panic!("bridge-{name}: scene_bridge rejected the serialized scene: {e}"));
    let r = run_sfcc_pipeline(&tree, &cube, &tuning());

    assert!(!r.tris.is_empty(), "bridge-{name}: produced triangles");
    assert_eq!(r.stats.failed_cells, 0, "bridge-{name}: no failed cells");
    assert!(r.ok, "bridge-{name}: pipeline ok");

    // Topology + winding match the TS oracle EXACTLY; pos_eps ≈ 1e-4·scene absorbs
    // cross-engine libm ULP drift + f32 fixture rounding, far below the cell size.
    let pos_eps = 1e-4 * cube.size;
    let opts = CanonicalizeOptions { pos_eps, ..CanonicalizeOptions::default() };
    let rv: Vec<f64> = r.verts.iter().map(|&f| f as f64).collect();
    if let Err(e) = meshes_equivalent(&rv, &r.tris, &ts_verts, &ts_tris, &opts) {
        panic!(
            "bridge-{name}: Rust(bridge)↔TS mesh mismatch (pos_eps={pos_eps}): {e}\n  rust: {} verts {} tris | ts: {} verts {} tris",
            rv.len() / 8,
            r.tris.len() / 3,
            ts_verts.len() / 8,
            ts_tris.len() / 3
        );
    }
}

#[test]
fn bridge_box_matches_ts() {
    assert_bridge_parity("box", SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 });
}

#[test]
fn bridge_box_minus_sphere_matches_ts() {
    assert_bridge_parity("box-minus-sphere", SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 });
}

#[test]
fn bridge_lathe_matches_ts() {
    assert_bridge_parity("lathe", SfccWorldCube { min_x: -3.0, min_y: -3.0, min_z: -3.0, size: 6.0 });
}

#[test]
fn bridge_extrude_twist_matches_ts() {
    assert_bridge_parity("extrude-twist", SfccWorldCube { min_x: -3.5, min_y: -3.5, min_z: -3.5, size: 7.0 });
}

#[test]
fn bridge_loft_matches_ts() {
    assert_bridge_parity("loft", SfccWorldCube { min_x: -3.5, min_y: -3.5, min_z: -3.5, size: 7.0 });
}
