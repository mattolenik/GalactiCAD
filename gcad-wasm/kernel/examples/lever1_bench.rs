//! Lever 1 A/B benchmark: time the SFCC pipeline on a blend-heavy scene (the prune
//! target) plus the simple + twist scenes (the no-regression guard). Run it twice
//! in one binary via the `SFCC_LEVER1` escape hatch and diff:
//!
//!   SFCC_LEVER1=0 cargo run -p gcad-kernel --release --example lever1_bench  # full tree
//!   SFCC_LEVER1=1 cargo run -p gcad-kernel --release --example lever1_bench  # pruned
//!
//! (unset SFCC_LEVER1 uses the real conditional gate.) Hashes are printed so the
//! A/B run is also a byte-identity check — pruning must not change geometry.

use gcad_kernel::primitives::polygon2d::winding_sign;
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

fn hash_mesh(verts: &[f32], tris: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut feed = |b: u8| {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    };
    for v in verts {
        for b in v.to_le_bytes() {
            feed(b);
        }
    }
    for t in tris {
        for b in t.to_le_bytes() {
            feed(b);
        }
    }
    h
}

fn bench(name: &str, tree: &CsgNode, c: &SfccWorldCube, tuning: &PipelineTuning, reps: u32) {
    // Warm one run (also the hash witness), then time `reps` runs and take the min.
    let r0 = run_sfcc_pipeline(tree, c, tuning);
    let hash = hash_mesh(&r0.verts, &r0.tris);
    let mut best = f64::INFINITY;
    for _ in 0..reps {
        let t = Instant::now();
        let r = run_sfcc_pipeline(tree, c, tuning);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        if ms < best {
            best = ms;
        }
        std::hint::black_box(r.tris.len());
    }
    println!("{name:<28} {best:8.1} ms   tris={:<7} leaves={:<6} hash={hash:016x}", r0.tris.len() / 3, r0.stats.leaves);
}

/// A grid of smoothly-unioned spheres — the "many blended unions" signature where
/// every f/grad/interval re-walks the whole blend, so per-cell pruning bites.
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

/// A DEEP nested blend: each sphere is folded in via its own BINARY smooth union,
/// so `f`/`grad` at one point re-walk a long chain of blend combiners. This is the
/// shape pruning should help most — a region touches a short SUFFIX of the chain,
/// so the full-tree walk does far more per eval than the pruned view.
fn nested_blend_chain(n: i64, spacing: f64, r: f64, blend: f64) -> CsgNode {
    let mut acc = sdf::leaf_at(Shape::Sphere { r }, [0.0, 0.0, 0.0]);
    for i in 1..n {
        let p = [(i as f64) * spacing * 0.55, ((i % 3) as f64 - 1.0) * spacing, ((i % 2) as f64) * spacing];
        let next = sdf::leaf_at(Shape::Sphere { r }, p);
        acc = sdf::union_smooth(vec![acc, next], SminMode::Round, blend, 2.0);
    }
    acc
}

fn main() {
    let lever = std::env::var("SFCC_LEVER1").unwrap_or_else(|_| "<gate>".into());
    println!("=== Lever 1 bench (SFCC_LEVER1={lever}) ===");

    let tuning = PipelineTuning { depth_min: 4, depth_max: 7, ..PipelineTuning::default() };

    // --- BLEND-HEAVY (the prune target) ---
    // 4×4×3 = 48 smoothly-unioned spheres.
    let blob = prepared(sphere_blob(4, 4, 3, 2.6, 1.6, 0.9));
    bench("blend: 48-sphere blob", &blob, &SfccWorldCube { min_x: -8.0, min_y: -8.0, min_z: -6.0, size: 16.0 }, &tuning, 3);
    // 6×6 = 36-sphere sheet (wider, shallower — many faces per cell on one plane).
    let sheet = prepared(sphere_blob(6, 6, 1, 2.4, 1.5, 0.8));
    bench("blend: 36-sphere sheet", &sheet, &SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -3.0, size: 20.0 }, &tuning, 3);
    // 32-sphere DEEP nested binary blend chain (long combiner chain per eval).
    let chain = prepared(nested_blend_chain(32, 2.2, 1.5, 0.8));
    bench("blend: 32-sphere nested chain", &chain, &SfccWorldCube { min_x: -6.0, min_y: -8.0, min_z: -6.0, size: 44.0 }, &tuning, 3);

    // --- NO-REGRESSION GUARD (simple + twist) ---
    let cube20 = SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 };
    bench("simple: box", &prepared(sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0])), &cube20, &tuning, 3);
    bench("simple: sphere", &prepared(sdf::leaf_at(Shape::Sphere { r: 9.0 }, [0.0, 0.0, 0.0])), &cube20, &tuning, 3);
    bench(
        "simple: box-minus-sphere",
        &prepared(sdf::subtract(
            sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
            sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
        )),
        &cube20,
        &tuning,
        3,
    );
    let l_poly: [[f64; 2]; 6] = [[-3.0, -3.0], [3.0, -3.0], [3.0, 0.0], [0.0, 0.0], [0.0, 3.0], [-3.0, 3.0]];
    let lv: Vec<f64> = l_poly.iter().flat_map(|v| [v[0], v[1]]).collect();
    let twisted_l = prepared(sdf::leaf_at(
        Shape::Extrude { verts: lv, wind: winding_sign(&l_poly), h: 5.0, twist_rad: std::f64::consts::FRAC_PI_2 },
        [0.0, 0.0, 0.0],
    ));
    bench("twist: twisted-l", &twisted_l, &SfccWorldCube { min_x: -6.0, min_y: -6.0, min_z: -6.0, size: 12.0 }, &tuning, 3);
}
