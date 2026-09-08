//! Native release benchmark for a serialized scene, using the existing kernel.
//! cargo run --release --features serde --example sfcc_quality_bench -- scene.json x y z size baseline|audit|triangulation|all [runs]
#[cfg(feature = "serde")]
fn main() {
    use gcad_kernel::{
        scene_bridge::build_csg_tree_from_json,
        sfcc::pipeline::{run_sfcc_pipeline_profiled, PipelineTuning, SfccWorldCube},
    };
    let args: Vec<_> = std::env::args().collect();
    assert!(
        args.len() == 7 || args.len() == 8,
        "scene.json x y z size mode [runs]"
    );
    let tree = build_csg_tree_from_json(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let cube = SfccWorldCube {
        min_x: args[2].parse().unwrap(),
        min_y: args[3].parse().unwrap(),
        min_z: args[4].parse().unwrap(),
        size: args[5].parse().unwrap(),
    };
    let mode = args[6].as_str();
    assert!(["baseline", "audit", "triangulation", "all"].contains(&mode));
    let tuning = PipelineTuning {
        quality_audit: mode == "audit",
        quality_triangulation: mode == "triangulation" || mode == "all",
        quality_refinement: mode == "all",
        quality_remeshing: mode == "all",
        ..Default::default()
    };
    let runs: usize = args.get(7).map_or(5, |s| s.parse().unwrap());
    assert!(runs > 0);
    let clock = std::time::Instant::now();
    let now = || clock.elapsed().as_secs_f64() * 1000.;
    let mut timings = Vec::new();
    for run in 0..=runs {
        let start = now();
        let result = run_sfcc_pipeline_profiled(&tree, &cube, &tuning, &now);
        let ms = now() - start;
        if run > 0 {
            timings.push(ms);
        }
        println!("{{\"backend\":\"native release\",\"mode\":\"{mode}\",\"run\":{run},\"warmup\":{},\"ms\":{ms},\"triangles\":{},\"outputBytes\":{},\"phaseFeatureMs\":{},\"phaseOctreeMs\":{},\"phaseContourMs\":{},\"phaseCellmeshMs\":{},\"phaseAssembleMs\":{},\"validation\":{}}}",run==0,result.tris.len()/3,result.verts.len()*4+result.tris.len()*4,result.phase_feature_ms,result.phase_octree_ms,result.phase_contour_ms,result.phase_cellmesh_ms,result.phase_assemble_ms,result.validation.to_json());
    }
    timings.sort_by(f64::total_cmp);
    println!(
        "{{\"medianMs\":{},\"timings\":{:?}}}",
        timings[timings.len() / 2],
        timings
    );
}
#[cfg(not(feature = "serde"))]
fn main() {
    panic!("enable --features serde to read a serialized scene");
}
