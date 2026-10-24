//! Inspect the restricted seam gate on source-pinned acceptance scene data.
//! cargo run --release --features serde,sfcc-profile --example sfcc_loft_seam_diagnosis -- CASE_DIR PROBES_JSON
#[cfg(all(feature = "serde", feature = "sfcc-profile"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use serde_json::{json, Value};
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("expected CASE_DIR PROBES_JSON".into());
    }
    let config: Value = serde_json::from_slice(&std::fs::read(
        std::path::Path::new(&args[1]).join("effective-config.json"),
    )?)?;
    let scene = gcad_kernel::scene_bridge::build_csg_tree_from_json(
        config["sceneJson"].as_str().ok_or("sceneJson")?,
    )?;
    let side = config["cube"]["max"][0].as_f64().ok_or("cube max")?
        - config["cube"]["min"][0].as_f64().ok_or("cube min")?;
    let tol = gcad_kernel::tolerances::resolve_tolerances(
        &gcad_kernel::tuning::SfccTuning::default(),
        side * 3f64.sqrt(),
    );
    let (features, _) = gcad_kernel::sfcc::feature_set::compile_feature_set(&scene, &tol);
    let probes: Vec<Value> = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    for probe in probes {
        let a = probe["a"].as_u64().ok_or("a")? as usize;
        let b = probe["b"].as_u64().ok_or("b")? as usize;
        let axis = probe["axis"].as_u64().ok_or("axis")? as usize;
        let lo: [f64; 3] = serde_json::from_value(probe["lo"].clone())?;
        let hi: [f64; 3] = serde_json::from_value(probe["hi"].clone())?;
        let proof = gcad_kernel::sfcc::diagnosis::loft_seam_gate(&features, a, b, lo, hi, axis);
        println!(
            "{}",
            json!({"probe":probe,"generatorGraph":proof.is_some(),"atMostOneFaceRoot":proof})
        );
    }
    Ok(())
}
#[cfg(not(all(feature = "serde", feature = "sfcc-profile")))]
fn main() {
    panic!("requires serde,sfcc-profile");
}
