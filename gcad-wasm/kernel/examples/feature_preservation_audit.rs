//! Diagnose compiled-curve preservation on an explicitly supplied bridge tree.
#[cfg(feature = "serde")]
fn main() {
    use gcad_kernel::{
        scene_bridge::build_csg_tree_from_json,
        sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube},
    };
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(args.len(), 6, "usage: feature_preservation_audit scene.json minX minY minZ size");
    let tree = build_csg_tree_from_json(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let value = |i: usize| args[i].parse::<f64>().unwrap();
    let cube = SfccWorldCube { min_x: value(2), min_y: value(3), min_z: value(4), size: value(5) };
    let result = run_sfcc_pipeline(&tree, &cube, &PipelineTuning::default());
    println!("{}", result.validation.to_json());
    let (features, _) = gcad_kernel::sfcc::feature_set::compile_feature_set(
        &tree,
        &gcad_kernel::tolerances::resolve_tolerances(
            &gcad_kernel::tuning::SfccTuning::default(),
            cube.size * 3f64.sqrt(),
        ),
    );
    for issue in &result.validation.feature_chains.as_ref().unwrap().issues {
        let curve = &features.curves[issue.curve_id];
        let a = curve.point_at(issue.range[0]);
        let b = curve.point_at(issue.range[1]);
        eprintln!(
            "curve={} kind={} range={:?} length={} p0={a:?} p1={b:?} corners={:?}",
            issue.curve_id,
            issue.kind,
            issue.range,
            curve.param_distance(issue.range[0], issue.range[1]),
            [curve.corner_start, curve.corner_end]
        );
    }
}
#[cfg(not(feature = "serde"))]
fn main() {
    panic!("enable --features serde to read a serialized scene");
}
