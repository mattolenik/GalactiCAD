//! TS↔Rust octree parity: build the same smooth scene + lattice + tuning in Rust
//! that `gcad-wasm/fixtures/dump-octree.mts` built in the TS oracle, run the
//! certified adaptive octree under the smooth-only refinement criteria, and
//! require the LEAF-CELL set to match exactly (same count, same (level,ix,iy,iz)
//! keys). Soft-skips if the fixture is absent.

use gcad_kernel::math::grid::make_lattice;
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::octree::{build_octree, OctreeBuildOptions};
use gcad_kernel::sfcc::refine_criteria::{make_probe, needs_split_smooth, SmoothCriteriaOptions};
use gcad_kernel::strata::{Stratum, StratumIdentity};
use std::collections::BTreeSet;
use std::fs;

struct Fixture {
    max_depth: u32,
    depth_min: u32,
    depth_max: u32,
    enforce_edge_balance: bool,
    origin: [f64; 3],
    world_size: f64,
    normal_variation_cos: f64,
    blend_normal_variation_cos: f64,
    leaves: BTreeSet<(u32, i32, i32, i32)>,
}

fn load(path: &str) -> Option<Fixture> {
    let bytes = fs::read(path).ok()?;
    let rd_u32 = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let rd_i32 = |o: usize| i32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let rd_f64 = |o: usize| {
        f64::from_le_bytes([
            bytes[o],
            bytes[o + 1],
            bytes[o + 2],
            bytes[o + 3],
            bytes[o + 4],
            bytes[o + 5],
            bytes[o + 6],
            bytes[o + 7],
        ])
    };
    let max_depth = rd_u32(0);
    let depth_min = rd_u32(4);
    let depth_max = rd_u32(8);
    let enforce_edge_balance = rd_u32(12) != 0;
    let mut off = 16;
    let origin = [rd_f64(off), rd_f64(off + 8), rd_f64(off + 16)];
    off += 24;
    let world_size = rd_f64(off);
    off += 8;
    let normal_variation_cos = rd_f64(off);
    off += 8;
    let blend_normal_variation_cos = rd_f64(off);
    off += 8;
    let count = rd_u32(off) as usize;
    off += 4;
    let mut leaves = BTreeSet::new();
    for _ in 0..count {
        let level = rd_u32(off);
        let ix = rd_i32(off + 4);
        let iy = rd_i32(off + 8);
        let iz = rd_i32(off + 12);
        leaves.insert((level, ix, iy, iz));
        off += 16;
    }
    assert_eq!(leaves.len(), count, "fixture has duplicate leaf keys");
    Some(Fixture {
        max_depth,
        depth_min,
        depth_max,
        enforce_edge_balance,
        origin,
        world_size,
        normal_variation_cos,
        blend_normal_variation_cos,
        leaves,
    })
}

/// Sphere r=8 at the origin, with its single sphere-carrier stratum — mirrors
/// `compileCpuSdf`'s Sphere leaf (identity sim ⇒ center = pos, r = r).
fn sphere_tree() -> CsgNode {
    let r = 8.0;
    let strata = vec![Stratum::sphere(
        StratumIdentity { id: 0, owner_node_id: -1, leaf_index: 0, local_index: 0, sign: 1.0 },
        0.0,
        0.0,
        0.0,
        r,
    )];
    let mut t = sdf::leaf_with_strata(Shape::Sphere { r }, Similarity::identity(), [0.0, 0.0, 0.0], strata);
    t.assign_leaf_indices();
    t
}

/// Box half=6 at the origin, with its 6 plane-carrier strata — mirrors
/// `compileCpuSdf`'s Box leaf (identity sim ⇒ worldPlane offset = local offset).
fn box_tree() -> CsgNode {
    let h = 6.0;
    let id = |i: usize| StratumIdentity { id: i, owner_node_id: -1, leaf_index: 0, local_index: i, sign: 1.0 };
    // pos = 0, so each plane offset = ∓(0 + h) = −h (TS: −(px+hx), px−hx, …).
    let strata = vec![
        Stratum::plane(id(0), 1.0, 0.0, 0.0, -h),  // +x: −(px+hx)
        Stratum::plane(id(1), -1.0, 0.0, 0.0, -h), // −x:  px−hx
        Stratum::plane(id(2), 0.0, 1.0, 0.0, -h),  // +y
        Stratum::plane(id(3), 0.0, -1.0, 0.0, -h), // −y
        Stratum::plane(id(4), 0.0, 0.0, 1.0, -h),  // +z
        Stratum::plane(id(5), 0.0, 0.0, -1.0, -h), // −z
    ];
    let mut t = sdf::leaf_with_strata(Shape::Cuboid { half: [h, h, h] }, Similarity::identity(), [0.0, 0.0, 0.0], strata);
    t.assign_leaf_indices();
    t
}

fn run_parity(name: &str, tree: CsgNode) {
    let full = format!("{}/../fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let Some(fix) = load(&full) else {
        eprintln!("octree fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-octree.mts`)");
        return;
    };
    let lat = make_lattice(fix.max_depth, fix.origin[0], fix.origin[1], fix.origin[2], fix.world_size);
    let grad_bound = tree.grad_bound();
    let has_blend = tree.has_blend();
    let opts = SmoothCriteriaOptions {
        normal_variation_cos: fix.normal_variation_cos,
        blend_normal_variation_cos: fix.blend_normal_variation_cos,
    };

    let oct = build_octree(
        &tree,
        &lat,
        OctreeBuildOptions {
            depth_min: fix.depth_min,
            depth_max: fix.depth_max,
            enforce_edge_balance: fix.enforce_edge_balance,
        },
        |cell, sampler| {
            let probe = make_probe(&lat, &tree, |gx, gy, gz| sampler.sample_at(gx, gy, gz), cell.level, cell.ix, cell.iy, cell.iz);
            needs_split_smooth(&tree, &probe, &opts, grad_bound, has_blend)
        },
    );

    let got: BTreeSet<(u32, i32, i32, i32)> =
        oct.leaves.iter().map(|c| (c.level, c.ix as i32, c.iy as i32, c.iz as i32)).collect();

    assert_eq!(
        got.len(),
        fix.leaves.len(),
        "{name}: leaf count mismatch — Rust {} vs TS {}",
        got.len(),
        fix.leaves.len()
    );
    if got != fix.leaves {
        let only_rust = got.difference(&fix.leaves).count();
        let only_ts = fix.leaves.difference(&got).count();
        panic!("{name}: leaf-cell set mismatch — {only_rust} only in Rust, {only_ts} only in TS");
    }
}

#[test]
fn octree_sphere_matches_ts() {
    run_parity("octree-sphere.bin", sphere_tree());
}

#[test]
fn octree_box_matches_ts() {
    run_parity("octree-box.bin", box_tree());
}
