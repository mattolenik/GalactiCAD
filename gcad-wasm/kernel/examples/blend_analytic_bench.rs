//! Analytic blend-curvature cert A/B on MANY-BLEND scenes (the "very many smooth
//! unions" slow case the single-blend tests never covered). For each scene × θ we
//! time the SAMPLED ∇f cone vs the ANALYTIC κ bound and print leaves + ms, so the
//! question "does the cheaper cert net positive once the CSG tree is big?" is
//! answered directly.
//!
//!   cargo run -p gcad-kernel --release --example blend_analytic_bench

use gcad_kernel::primitives::smin::SminMode;
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

/// grid of overlapping CUBOIDS, round smooth union — plane-plane fillets (the
/// realistic many-blend CAD case; analytic ties on cells here).
fn box_blob(nx: i64, ny: i64, nz: i64, spacing: f64, half: f64, blend: f64) -> CsgNode {
    let mut parts = Vec::new();
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                let p = [
                    (i as f64 - (nx - 1) as f64 / 2.0) * spacing,
                    (j as f64 - (ny - 1) as f64 / 2.0) * spacing,
                    (k as f64 - (nz - 1) as f64 / 2.0) * spacing,
                ];
                parts.push(sdf::leaf_at(Shape::Cuboid { half: [half, half, half] }, p));
            }
        }
    }
    sdf::union_smooth(parts, SminMode::Round, blend, 2.0)
}

/// grid of overlapping SPHERES, round smooth union — curved fillets (the
/// unfavorable bracket; analytic over-refines vs the adaptive cone here).
fn sphere_blob(nx: i64, ny: i64, nz: i64, spacing: f64, r: f64, blend: f64) -> CsgNode {
    let mut parts = Vec::new();
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                let p = [
                    (i as f64 - (nx - 1) as f64 / 2.0) * spacing,
                    (j as f64 - (ny - 1) as f64 / 2.0) * spacing,
                    (k as f64 - (nz - 1) as f64 / 2.0) * spacing,
                ];
                parts.push(sdf::leaf_at(Shape::Sphere { r }, p));
            }
        }
    }
    sdf::union_smooth(parts, SminMode::Round, blend, 2.0)
}

/// DEEP nested binary smooth-union chain — biggest tree per eval, so the sampled
/// cone's 9× per-cell owner/grad walk costs the most; where analytic should help.
fn nested_chain(n: i64, spacing: f64, r: f64, blend: f64) -> CsgNode {
    let mut acc = sdf::leaf_at(Shape::Sphere { r }, [0.0, 0.0, 0.0]);
    for i in 1..n {
        let p = [(i as f64) * spacing * 0.55, ((i % 3) as f64 - 1.0) * spacing, ((i % 2) as f64) * spacing];
        acc = sdf::union_smooth(vec![acc, sdf::leaf_at(Shape::Sphere { r }, p)], SminMode::Round, blend, 2.0);
    }
    acc
}

fn run(name: &str, tree: &CsgNode, c: &SfccWorldCube, deg: f64, analytic: bool, reps: u32) {
    let tuning = PipelineTuning {
        depth_min: 4,
        depth_max: 7,
        blend_curvature_refine: true,
        blend_curvature_deg: deg,
        blend_curvature_analytic: analytic,
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
    println!("  {name:<20} θ={deg:>3}°  {mode}  {best:8.1} ms   leaves={:<6} tris={}", r0.stats.leaves, r0.tris.len() / 3);
}

fn main() {
    println!("=== analytic vs sampled blend cert, many-blend scenes (depth_max=7, min-of-2) ===");
    let scenes: Vec<(&str, CsgNode, SfccWorldCube)> = vec![
        ("box-blob 4x4x2", prepared(box_blob(4, 4, 2, 1.4, 1.0, 0.5)), SfccWorldCube { min_x: -6.0, min_y: -6.0, min_z: -4.0, size: 12.0 }),
        ("sphere-blob 4x4x3", prepared(sphere_blob(4, 4, 3, 2.6, 1.6, 0.9)), SfccWorldCube { min_x: -8.0, min_y: -8.0, min_z: -6.0, size: 16.0 }),
        ("nested-chain 32", prepared(nested_chain(32, 2.2, 1.5, 0.8)), SfccWorldCube { min_x: -6.0, min_y: -8.0, min_z: -6.0, size: 44.0 }),
    ];
    for (name, tree, cube) in &scenes {
        for &deg in &[2.0_f64, 1.0_f64] {
            run(name, tree, cube, deg, false, 2);
            run(name, tree, cube, deg, true, 2);
        }
        println!();
    }
}
