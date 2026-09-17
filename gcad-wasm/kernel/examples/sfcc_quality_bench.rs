//! Native release benchmark for a serialized scene, using the existing kernel.
//! cargo run --release --features serde --example sfcc_quality_bench -- scene.json x y z size baseline|audit|triangulation|all [runs]
#[cfg(feature = "serde")]
fn main() {
    use gcad_kernel::{
        scene_bridge::build_csg_tree_from_json,
        sfcc::pipeline::{run_sfcc_pipeline_profiled_progress, PipelineTuning, SfccWorldCube},
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
    #[cfg(feature = "sfcc-profile")]
    gcad_kernel::sfcc::perf::set_disabled(std::env::var("SFCC_PERF_DISABLE").ok().map_or(0, |s| s.parse().unwrap()));
    let clock = std::time::Instant::now();
    let now = || clock.elapsed().as_secs_f64() * 1000.;
    let mut timings = Vec::new();
    for run in 0..=runs {
        #[cfg(feature = "sfcc-profile")]
        gcad_kernel::sfcc::perf::reset();
        let start = now();
        let result = run_sfcc_pipeline_profiled_progress(&tree, &cube, &tuning, &now, &|phase, label, elapsed_ms| {
            println!("{}", serde_json::json!({"event":"progress", "mode":mode, "run":run,
                "phase":phase, "label":label, "elapsedMs":elapsed_ms}));
        });
        println!("{}", serde_json::json!({"event":"stats", "mode":mode, "run":run,
            "leaves":result.stats.leaves, "featureCurves":result.stats.feature_curves,
            "reRefineRounds":result.stats.re_refine_rounds,
            "octreeDecideMs":result.phase_octree_decide_ms,
            "octreeApplyMs":result.phase_octree_apply_ms}));
        let ms = now() - start;
        #[cfg(feature = "sfcc-profile")]
        println!("{}", serde_json::json!({"event":"workCounters", "run":run, "counts":gcad_kernel::sfcc::perf::snapshot()}));
        if run > 0 {
            timings.push(ms);
        }
        println!("{{\"backend\":\"native release\",\"mode\":\"{mode}\",\"run\":{run},\"warmup\":{},\"ms\":{ms},\"triangles\":{},\"outputBytes\":{},\"phaseFeatureMs\":{},\"phaseOctreeMs\":{},\"phaseContourMs\":{},\"phaseCellmeshMs\":{},\"phaseAssembleMs\":{},\"validation\":{}}}",run==0,result.tris.len()/3,result.verts.len()*4+result.tris.len()*4,result.phase_feature_ms,result.phase_octree_ms,result.phase_contour_ms,result.phase_cellmesh_ms,result.phase_assemble_ms,result.validation.to_json());
        // Untimed exact comparison artifacts, including feature memberships.
        if let Some(dir) = std::env::var_os("SFCC_BENCH_ARTIFACTS") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            let mut bytes = Vec::new();
            for n in [result.verts.len(), result.tris.len(), result.feature_edges.len()] {
                bytes.extend_from_slice(&(n as u64).to_le_bytes());
            }
            for v in &result.verts { bytes.extend_from_slice(&v.to_bits().to_le_bytes()); }
            for v in &result.tris { bytes.extend_from_slice(&v.to_le_bytes()); }
            for e in &result.feature_edges {
                for v in e.vertices { bytes.extend_from_slice(&v.to_le_bytes()); }
                bytes.extend_from_slice(&(e.interval.curve_id as u64).to_le_bytes());
                bytes.extend_from_slice(&e.interval.start.to_bits().to_le_bytes());
                bytes.extend_from_slice(&e.interval.end.to_bits().to_le_bytes());
            }
            std::fs::write(dir.join(format!("{mode}-{run}.bin")), bytes).unwrap();
            std::fs::write(dir.join(format!("{mode}-{run}.json")), result.validation.to_json()).unwrap();
        }
    }
    if timings.is_empty() { return; } // runs=0: one diagnostic/artifact export, no timing claim.
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
