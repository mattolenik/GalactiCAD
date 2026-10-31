//! Per-call field costs on the exact bowl (two 114-section lofts under a taper):
//! what one `f`, `grad`, `grad_pair`, interval and pruned query costs near the
//! surface. Diagnostic; run with
//!   cargo test --release -p gcad-kernel --features serde --test bowl_cost -- --ignored --nocapture
#![cfg(feature = "serde")]
use gcad_kernel::scene_bridge::build_csg_tree_from_json;
use gcad_kernel::sdf::{CsgNode, SdfQuery};
use std::time::Instant;

fn load_tree() -> CsgNode {
    let json = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/bowl-taper.json")).unwrap();
    let mut tree = build_csg_tree_from_json(&json).unwrap();
    tree.assign_leaf_indices();
    tree
}

fn time<R>(label: &str, n: usize, mut f: impl FnMut(usize) -> R) {
    let t0 = Instant::now();
    let mut sink = 0.0f64;
    for i in 0..n {
        let _ = f(i);
        sink += 1.0;
    }
    let us = t0.elapsed().as_secs_f64() * 1e6 / n as f64;
    println!("{label:<48} {us:8.2} µs/call  (n={n}, {sink:.0})");
}

#[test]
#[ignore = "diagnostic timing"]
fn bowl_field_costs() {
    let tree = load_tree();
    // Near-surface points: coarse grid over the cube, keep |f| < 1 mm.
    let mut pts: Vec<[f64; 3]> = Vec::new();
    let n = 160;
    for i in 0..n {
        for j in 0..n {
            for k in 0..n {
                let p = [-91.5 + 183.0 * (i as f64 + 0.5) / n as f64, -16.5 + 183.0 * (j as f64 + 0.5) / n as f64, -91.5 + 183.0 * (k as f64 + 0.5) / n as f64];
                if tree.f(p).abs() < 1.0 {
                    pts.push(p);
                }
            }
        }
    }
    println!("near-surface sample points: {}", pts.len());
    let m = pts.len();
    let at = |i: usize| pts[i % m];
    let half9 = [0.1827; 3]; // level-9 half cell on the app's 187 mm lattice
    let half8 = [0.3652; 3];
    let half5 = [2.92; 3];
    let reps = 200_000;
    time("f", reps, |i| tree.f(at(i)));
    time("grad", reps, |i| tree.grad(at(i)));
    time("grad_pair (2 points)", reps / 2, |i| tree.grad_pair(at(2 * i), at(2 * i + 1)));
    time("interval_over_box half=0.18 (level 9)", 50_000, |i| tree.interval_over_box(at(i), half9));
    time("interval_over_box half=0.37 (level 8)", 50_000, |i| tree.interval_over_box(at(i), half8));
    time("checked_partial_interval_over_box half=0.18", 20_000, |i| tree.checked_partial_interval_over_box(at(i), half9));
    time("checked_partial_interval_over_box half=0.37", 20_000, |i| tree.checked_partial_interval_over_box(at(i), half8));
    time("prune_to_box half=2.9 (level 5)", 5_000, |i| tree.prune_to_box(at(i), half5));
    let pruned = tree.prune_to_box(at(0), half5);
    let p0 = at(0);
    time("f on level-5 pruned view (same region)", reps, |i| {
        let q = at(i);
        let d = [(q[0] - p0[0]).clamp(-2.9, 2.9), (q[1] - p0[1]).clamp(-2.9, 2.9), (q[2] - p0[2]).clamp(-2.9, 2.9)];
        pruned.f([p0[0] + d[0], p0[1] + d[1], p0[2] + d[2]])
    });
    time("interval_over_box on pruned view half=0.18", 50_000, |i| {
        let q = at(i);
        let d = [(q[0] - p0[0]).clamp(-2.7, 2.7), (q[1] - p0[1]).clamp(-2.7, 2.7), (q[2] - p0[2]).clamp(-2.7, 2.7)];
        pruned.interval_over_box([p0[0] + d[0], p0[1] + d[1], p0[2] + d[2]], half9)
    });
    time("active_owners_at", 50_000, |i| tree.active_owners_at(at(i), 0.0).len());
}
