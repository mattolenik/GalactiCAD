//! Analytic per-stratum smoothCrit cert A/B on CURVED-PRIMITIVE scenes — the
//! organic/mechanical regime where smoothCrit dominates (53–56% of car/mechwarrior
//! per the phase profiling). For each scene × θ we time the SAMPLED ∇f normal cone
//! vs the ANALYTIC κ·cellSize bound and print leaves + ms, answering "does the
//! closed-form per-stratum bound cut the dominant phase?".
//!
//!   cargo run -p gcad-kernel --release --example smoothcrit_analytic_bench

use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
use std::time::Instant;

fn attach_strata(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
    match node {
        CsgNode::Leaf(l) => {
            let strata = build_leaf_strata(&Leaf { strata: Vec::new(), ..l.clone() }, *leaf_index, *first_id);
            *first_id += strata.len();
            *leaf_index += 1;
            l.strata = strata;
        }
        CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter_mut().for_each(|c| attach_strata(c, leaf_index, first_id)),
        CsgNode::Blend { children, .. } => children.iter_mut().for_each(|c| attach_strata(c, leaf_index, first_id)),
    }
}

fn prepared(mut tree: CsgNode) -> CsgNode {
    tree.assign_leaf_indices();
    let (mut li, mut fi) = (0usize, 0usize);
    attach_strata(&mut tree, &mut li, &mut fi);
    tree
}

/// Hard union of curved primitives (no blend) — many spherical/cylindrical strata,
/// the way an organic/mechanical part loads the per-stratum smoothCrit cert.
fn curved_part() -> CsgNode {
    let mut parts = vec![
        sdf::leaf_at(Shape::Sphere { r: 4.0 }, [0.0, 0.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 2.5 }, [5.0, 1.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 2.0 }, [-4.0, -2.0, 1.0]),
        sdf::leaf_at(Shape::Cylinder { r: 1.6, h: 9.0 }, [2.0, 0.0, 3.0]),
        sdf::leaf_at(Shape::Cylinder { r: 1.2, h: 7.0 }, [-3.0, 2.0, -2.0]),
        sdf::leaf_at(Shape::Cone { r: 3.0, h: 6.0 }, [0.0, 4.0, 0.0]),
    ];
    parts.rotate_left(0);
    sdf::union(parts)
}

fn run(name: &str, tree: &CsgNode, c: &SfccWorldCube, deg: f64, analytic: bool, reps: u32) {
    let tuning = PipelineTuning {
        depth_min: 4,
        depth_max: 8,
        blend_curvature_refine: false, // pure-primitive scenes: exercise smoothCrit only
        normal_variation_deg: deg,
        normal_variation_analytic: analytic,
        ..PipelineTuning::default()
    };
    let r0 = run_sfcc_pipeline(tree, c, &tuning); // warm
    let mut best = f64::INFINITY;
    for _ in 0..reps {
        let t = Instant::now();
        let r = run_sfcc_pipeline(tree, c, &tuning);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        if ms < best {
            best = ms;
        }
        std::hint::black_box(r.tris.len());
    }
    let mode = if analytic { "analytic" } else { "sampled " };
    println!("  {name:<14} θ={deg:>3}°  {mode}  {best:8.1} ms   leaves={:<6} tris={}", r0.stats.leaves, r0.tris.len() / 3);
}

fn main() {
    println!("=== analytic vs sampled per-stratum smoothCrit, curved primitives (depth_max=8, min-of-3) ===");
    let big = SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 };
    let scenes: Vec<(&str, CsgNode, SfccWorldCube)> = vec![
        ("sphere r6", prepared(sdf::leaf_at(Shape::Sphere { r: 6.0 }, [0.1, -0.2, 0.05])), big),
        ("cylinder", prepared(sdf::leaf_at(Shape::Cylinder { r: 5.0, h: 10.0 }, [0.0, 0.0, 0.0])), big),
        ("cone", prepared(sdf::leaf_at(Shape::Cone { r: 5.0, h: 10.0 }, [0.0, 0.0, 0.0])), big),
        ("curved-part", prepared(curved_part()), big),
    ];
    for (name, tree, cube) in &scenes {
        for &deg in &[3.0_f64, 2.0_f64] {
            run(name, tree, cube, deg, false, 3);
            run(name, tree, cube, deg, true, 3);
        }
        println!();
    }
}
