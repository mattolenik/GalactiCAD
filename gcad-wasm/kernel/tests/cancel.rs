//! Cooperative cancellation: with a cancel hook installed the pipeline bails at a
//! checkpoint and returns an empty `cancelled` result; with no hook (the default on
//! every other path) it runs to completion unchanged.

use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::cancel;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
use gcad_kernel::strata::{Stratum, StratumIdentity};

fn sphere_scene() -> CsgNode {
    let strata = vec![Stratum::sphere(
        StratumIdentity { id: 0, owner_node_id: -1, leaf_index: 0, local_index: 0, sign: 1.0 },
        0.0,
        0.0,
        0.0,
        8.0,
    )];
    let mut t = sdf::leaf_with_strata(Shape::Sphere { r: 8.0 }, Similarity::identity(), [0.0, 0.0, 0.0], strata);
    t.assign_leaf_indices();
    t
}

fn tuning() -> PipelineTuning {
    PipelineTuning { depth_min: 4, depth_max: 7, bounds_padding_mm: 0.0, ..PipelineTuning::default() }
}

fn cube() -> SfccWorldCube {
    SfccWorldCube { min_x: -12.0, min_y: -12.0, min_z: -12.0, size: 24.0 }
}

#[test]
fn cancel_hook_bails_with_empty_result() {
    let tree = sphere_scene();
    // Hook always requests cancel → the first octree round checkpoint fires.
    let _g = cancel::CancelGuard::install(Box::new(|| true));
    let r = run_sfcc_pipeline(&tree, &cube(), &tuning());
    assert!(r.cancelled, "result must be flagged cancelled");
    assert!(!r.ok, "a cancelled export is not certified");
    assert!(r.tris.is_empty(), "cancelled export yields no triangles");
    assert!(r.verts.is_empty(), "cancelled export yields no vertices");
}

#[test]
fn no_hook_runs_to_completion() {
    // The guard from the previous test is dropped (hook cleared); make sure a fresh run
    // with no hook is a normal, complete export.
    cancel::set_hook(None);
    let tree = sphere_scene();
    let r = run_sfcc_pipeline(&tree, &cube(), &tuning());
    assert!(!r.cancelled, "no hook ⇒ not cancelled");
    assert!(!r.tris.is_empty(), "complete export produces triangles");
    assert!(r.ok, "sphere export certifies");
}
