//! M4c-1 TS↔Rust FEATURE-AWARE octree parity: build the same scene + lattice +
//! tuning + tolerances that `gcad-wasm/fixtures/dump-octree-feat.mts` built in
//! the TS oracle, run the feature-aware octree driver (`classify_cell_features`
//! ∨ `needs_split_smooth`), and require the LEAF-CELL set PLUS each leaf's
//! `feature_curve` / `feature_corner` tags to match EXACTLY. This octree is
//! finer near edges/seams than the smooth-only one (`octree_parity.rs`) — that
//! extra refinement is the point. Soft-skips if the fixture is absent;
//! regenerate with `tsx gcad-wasm/fixtures/dump-octree-feat.mts`.

use gcad_kernel::math::grid::make_lattice;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::{build_leaf_strata, compile_feature_set};
use gcad_kernel::sfcc::octree::{build_octree_feature_aware, OctreeBuildOptions};
use gcad_kernel::sfcc::refine_criteria::{FeatureCriteriaOptions, SmoothCriteriaOptions};
use gcad_kernel::tolerances::ResolvedTolerances;
use std::collections::BTreeMap;
use std::fs;

/// Attach each leaf's smooth analytic strata via `build_leaf_strata`, in
/// left-to-right CSG traversal order — the same order `compile_native_features`
/// uses, so the smooth refine path sees the same carriers the TS tree does
/// (`compileCpuSdf` builds the strata onto the leaves). Without this the raw
/// `leaf_at` leaves carry no strata and the smooth certificate would diverge.
fn attach_strata(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
    match node {
        CsgNode::Leaf(l) => {
            let strata = build_leaf_strata(&Leaf { strata: Vec::new(), ..l.clone() }, *leaf_index, *first_id);
            *first_id += strata.len();
            *leaf_index += 1;
            l.strata = strata;
        }
        CsgNode::Min(ch) | CsgNode::Max(ch) => {
            for c in ch.iter_mut() {
                attach_strata(c, leaf_index, first_id);
            }
        }
        CsgNode::Blend { children, .. } => {
            for c in children.iter_mut() {
                attach_strata(c, leaf_index, first_id);
            }
        }
    }
}

fn prepared_tree(mut tree: CsgNode) -> CsgNode {
    tree.assign_leaf_indices();
    let mut leaf_index = 0usize;
    let mut first_id = 0usize;
    attach_strata(&mut tree, &mut leaf_index, &mut first_id);
    tree
}

struct Fixture {
    max_depth: u32,
    depth_min: u32,
    depth_max: u32,
    enforce_edge_balance: bool,
    origin: [f64; 3],
    world_size: f64,
    normal_variation_cos: f64,
    blend_normal_variation_cos: f64,
    feature_query_inflate: f64,
    tangential_epsilon: f64,
    tol: ResolvedTolerances,
    /// (level, ix, iy, iz) → (feature_curve, feature_corner).
    leaves: BTreeMap<(u32, i32, i32, i32), (i32, i32)>,
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
    let feature_query_inflate = rd_f64(off);
    off += 8;
    let tangential_epsilon = rd_f64(off);
    off += 8;
    // 9 f64 tolerance fields, then 1 u32 maxTraceSteps.
    let tol = ResolvedTolerances {
        surface_tol: rd_f64(off),
        max_chord_error: rd_f64(off + 8),
        curve_eps: rd_f64(off + 16),
        probe_delta: rd_f64(off + 24),
        min_dihedral_cos: rd_f64(off + 32),
        native_crease_cos: rd_f64(off + 40),
        min_tangency_sin: rd_f64(off + 48),
        corner_merge_tol: rd_f64(off + 56),
        seed_cell_size: rd_f64(off + 64),
        max_trace_steps: rd_u32(off + 72),
    };
    off += 72 + 4;
    let count = rd_u32(off) as usize;
    off += 4;
    let mut leaves = BTreeMap::new();
    for _ in 0..count {
        let level = rd_u32(off);
        let ix = rd_i32(off + 4);
        let iy = rd_i32(off + 8);
        let iz = rd_i32(off + 12);
        let fc = rd_i32(off + 16);
        let fk = rd_i32(off + 20);
        leaves.insert((level, ix, iy, iz), (fc, fk));
        off += 24;
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
        feature_query_inflate,
        tangential_epsilon,
        tol,
        leaves,
    })
}

fn run_parity(name: &str, tree: CsgNode) {
    let full = format!("{}/../fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let Some(fix) = load(&full) else {
        eprintln!("octree-feat fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-octree-feat.mts`)");
        return;
    };
    let lat = make_lattice(fix.max_depth, fix.origin[0], fix.origin[1], fix.origin[2], fix.world_size);
    let (features, _diag) = compile_feature_set(&tree, &fix.tol);

    let feature_opts = FeatureCriteriaOptions {
        feature_query_inflate: fix.feature_query_inflate,
        tangential_epsilon: fix.tangential_epsilon,
    };
    let smooth_opts = SmoothCriteriaOptions {
        normal_variation_cos: fix.normal_variation_cos,
        blend_normal_variation_cos: fix.blend_normal_variation_cos,
        blend_curvature_analytic: None,
        normal_variation_analytic: false,
    };

    let oct = build_octree_feature_aware(
        &tree,
        &lat,
        OctreeBuildOptions {
            depth_min: fix.depth_min,
            depth_max: fix.depth_max,
            enforce_edge_balance: fix.enforce_edge_balance,
        },
        &features,
        &feature_opts,
        &smooth_opts,
    );

    let got: BTreeMap<(u32, i32, i32, i32), (i32, i32)> = oct
        .leaves
        .iter()
        .map(|c| ((c.level, c.ix as i32, c.iy as i32, c.iz as i32), (c.feature_curve as i32, c.feature_corner as i32)))
        .collect();

    assert_eq!(
        got.len(),
        fix.leaves.len(),
        "{name}: leaf count mismatch — Rust {} vs TS {}",
        got.len(),
        fix.leaves.len()
    );

    // Leaf-cell set must match exactly.
    let got_keys: std::collections::BTreeSet<_> = got.keys().copied().collect();
    let exp_keys: std::collections::BTreeSet<_> = fix.leaves.keys().copied().collect();
    if got_keys != exp_keys {
        let only_rust = got_keys.difference(&exp_keys).count();
        let only_ts = exp_keys.difference(&got_keys).count();
        panic!("{name}: leaf-cell set mismatch — {only_rust} only in Rust, {only_ts} only in TS");
    }

    // Feature tags must match exactly on every leaf.
    let mut tag_mismatches = 0usize;
    let mut first: Option<String> = None;
    for (k, gv) in &got {
        let ev = fix.leaves[k];
        if *gv != ev {
            tag_mismatches += 1;
            if first.is_none() {
                first = Some(format!("cell {k:?}: Rust (curve {}, corner {}) vs TS (curve {}, corner {})", gv.0, gv.1, ev.0, ev.1));
            }
        }
    }
    assert_eq!(tag_mismatches, 0, "{name}: {tag_mismatches} feature-tag mismatches; first: {}", first.unwrap_or_default());
}

#[test]
fn octree_feat_box_matches_ts() {
    // Box half=10 at the origin.
    let tree = prepared_tree(sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]));
    run_parity("octree-feat-box.bin", tree);
}

#[test]
fn octree_feat_box_minus_sphere_matches_ts() {
    // Subtract(Box([0,0,0],[10,10,10]), Sphere([5,5,5],6)) — 12 edges + 8 corners
    // + 3 traced seam circles; refines finer near the seams.
    let tree = prepared_tree(sdf::subtract(
        sdf::leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
        sdf::leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
    ));
    run_parity("octree-feat-box-minus-sphere.bin", tree);
}
