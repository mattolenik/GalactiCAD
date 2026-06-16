//! TS↔Rust face-contour parity: rebuild the same smooth scene + lattice + refine
//! tuning that `gcad-wasm/fixtures/dump-contour.mts` built in the TS oracle, run
//! the certified adaptive octree + `contour_all_faces`, and require — per
//! canonical face (axis + lattice key + len) — the SAME set of contour segments.
//!
//! Endpoint positions are matched to a small tolerance (ULP / libm-hypot drift
//! between V8 and Rust is expected); face keys, segment counts, and the segment
//! topology must match exactly. Soft-skips if the fixture is absent.

use gcad_kernel::math::grid::make_lattice;
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::face_contour::{contour_all_faces, FaceContourOptions};
use gcad_kernel::sfcc::octree::{build_octree, CellDecision, OctreeBuildOptions};
use gcad_kernel::sfcc::point_table::PointTable;
use gcad_kernel::sfcc::refine_criteria::{make_probe, needs_split_smooth, SmoothCriteriaOptions};
use gcad_kernel::strata::{Stratum, StratumIdentity};
use std::collections::HashMap;
use std::fs;

/// One face's expected contour: key fields plus the segment endpoint positions.
struct ExpFace {
    len: i32,
    /// Segment endpoints (ax, ay, az, bx, by, bz) per segment.
    segs: Vec<[f64; 6]>,
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
    root_tol: f64,
    /// (axis, lattice key) → expected face.
    faces: HashMap<(u32, i64), ExpFace>,
    multi_run_faces: u32,
    boundary_violations: u32,
    key_collisions: u32,
    point_count: u32,
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
    let root_tol = rd_f64(off);
    off += 8;
    let face_count = rd_u32(off) as usize;
    off += 4;

    let mut faces = HashMap::new();
    for _ in 0..face_count {
        let axis = rd_u32(off);
        off += 4;
        let key = rd_f64(off) as i64;
        off += 8;
        let len = rd_i32(off);
        off += 4;
        let seg_count = rd_u32(off) as usize;
        off += 4;
        let mut segs = Vec::with_capacity(seg_count);
        for _ in 0..seg_count {
            let s = [
                rd_f64(off),
                rd_f64(off + 8),
                rd_f64(off + 16),
                rd_f64(off + 24),
                rd_f64(off + 32),
                rd_f64(off + 40),
            ];
            off += 48;
            segs.push(s);
        }
        // Faces can share a key across axes only; (axis, key) is unique per the
        // dumper enumeration (canonical-face selection guarantees one record).
        assert!(faces.insert((axis, key), ExpFace { len, segs }).is_none(), "fixture has a duplicate (axis,key)");
    }
    let multi_run_faces = rd_u32(off);
    let boundary_violations = rd_u32(off + 4);
    let key_collisions = rd_u32(off + 8);
    let point_count = rd_u32(off + 12);

    Some(Fixture {
        max_depth,
        depth_min,
        depth_max,
        enforce_edge_balance,
        origin,
        world_size,
        normal_variation_cos,
        blend_normal_variation_cos,
        root_tol,
        faces,
        multi_run_faces,
        boundary_violations,
        key_collisions,
        point_count,
    })
}

/// Sphere r=8 at the origin (matches dump-contour.mts via dump-octree.mts).
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

/// Box half=6 at the origin (matches dump-contour.mts via dump-octree.mts).
fn box_tree() -> CsgNode {
    let h = 6.0;
    let id = |i: usize| StratumIdentity { id: i, owner_node_id: -1, leaf_index: 0, local_index: i, sign: 1.0 };
    let strata = vec![
        Stratum::plane(id(0), 1.0, 0.0, 0.0, -h),
        Stratum::plane(id(1), -1.0, 0.0, 0.0, -h),
        Stratum::plane(id(2), 0.0, 1.0, 0.0, -h),
        Stratum::plane(id(3), 0.0, -1.0, 0.0, -h),
        Stratum::plane(id(4), 0.0, 0.0, 1.0, -h),
        Stratum::plane(id(5), 0.0, 0.0, -1.0, -h),
    ];
    let mut t = sdf::leaf_with_strata(Shape::Cuboid { half: [h, h, h] }, Similarity::identity(), [0.0, 0.0, 0.0], strata);
    t.assign_leaf_indices();
    t
}

/// Canonicalize a segment's endpoints to lexicographically-least-first so the
/// segment SET compares independent of stored a/b order (a face arc is undirected
/// for set-matching; orientation is verified separately by the cell-mesh audit).
fn canon_seg(s: [f64; 6]) -> [f64; 6] {
    let a = [s[0], s[1], s[2]];
    let b = [s[3], s[4], s[5]];
    let a_first = a[0] < b[0] || (a[0] == b[0] && (a[1] < b[1] || (a[1] == b[1] && a[2] <= b[2])));
    if a_first {
        [a[0], a[1], a[2], b[0], b[1], b[2]]
    } else {
        [b[0], b[1], b[2], a[0], a[1], a[2]]
    }
}

/// Match each expected segment to a got segment within `tol` (greedy, by closest
/// endpoint distance over the canonicalized pair). Returns true iff every
/// expected segment finds a distinct got partner and counts match.
fn segments_match(exp: &[[f64; 6]], got: &[[f64; 6]], tol: f64) -> bool {
    if exp.len() != got.len() {
        return false;
    }
    let exp_c: Vec<[f64; 6]> = exp.iter().map(|&s| canon_seg(s)).collect();
    let got_c: Vec<[f64; 6]> = got.iter().map(|&s| canon_seg(s)).collect();
    let mut used = vec![false; got_c.len()];
    for e in &exp_c {
        let mut found = false;
        for (j, g) in got_c.iter().enumerate() {
            if used[j] {
                continue;
            }
            let d: f64 = (0..6).map(|k| (e[k] - g[k]).powi(2)).sum::<f64>().sqrt();
            if d <= tol {
                used[j] = true;
                found = true;
                break;
            }
        }
        if !found {
            return false;
        }
    }
    true
}

fn run_parity(name: &str, tree: CsgNode) {
    let full = format!("{}/../fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let Some(fix) = load(&full) else {
        eprintln!("contour fixture missing: {full} (run `tsx gcad-wasm/fixtures/dump-contour.mts`)");
        return;
    };

    let lat = make_lattice(fix.max_depth, fix.origin[0], fix.origin[1], fix.origin[2], fix.world_size);
    let grad_bound = tree.grad_bound();
    let has_blend = tree.has_blend();
    let smooth_opts = SmoothCriteriaOptions {
        normal_variation_cos: fix.normal_variation_cos,
        blend_normal_variation_cos: fix.blend_normal_variation_cos,
        blend_curvature_analytic: None,
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
            let probe =
                make_probe(&lat, &tree, |gx, gy, gz| sampler.sample_at(gx, gy, gz), cell.level, cell.ix, cell.iy, cell.iz);
            let split = needs_split_smooth(&tree, &probe, &smooth_opts, grad_bound, has_blend);
            CellDecision { split, feature_curve: -1, feature_corner: -1 }
        },
    );

    let mut points = PointTable::new();
    let result = contour_all_faces(&oct, &tree, &mut points, &FaceContourOptions { root_tol: fix.root_tol, ..FaceContourOptions::default() });

    // Diagnostics counters must match exactly.
    assert_eq!(
        result.multi_run_faces, fix.multi_run_faces as usize,
        "{name}: multiRunFaces — Rust {} vs TS {}",
        result.multi_run_faces, fix.multi_run_faces
    );
    assert_eq!(
        result.boundary_violations, fix.boundary_violations as usize,
        "{name}: boundaryViolations — Rust {} vs TS {}",
        result.boundary_violations, fix.boundary_violations
    );
    assert_eq!(
        result.key_collisions, fix.key_collisions as usize,
        "{name}: keyCollisions — Rust {} vs TS {}",
        result.key_collisions, fix.key_collisions
    );

    // Flatten Rust faces into (axis, key) → segment endpoint positions.
    let mut got: HashMap<(u32, i64), (i64, Vec<[f64; 6]>)> = HashMap::new();
    for (axis, per_axis) in result.faces.iter().enumerate() {
        for (&key, rec) in per_axis.iter() {
            let segs: Vec<[f64; 6]> = rec
                .segments
                .iter()
                .map(|s| {
                    [
                        points.x(s.a),
                        points.y(s.a),
                        points.z(s.a),
                        points.x(s.b),
                        points.y(s.b),
                        points.z(s.b),
                    ]
                })
                .collect();
            got.insert((axis as u32, key), (rec.len as i64, segs));
        }
    }

    // Same set of face keys.
    assert_eq!(got.len(), fix.faces.len(), "{name}: face count — Rust {} vs TS {}", got.len(), fix.faces.len());

    // Tolerance: ULP / libm-hypot drift between engines. rootTol bounds the
    // bisection residual, so a few × rootTol is a comfortable, topology-safe
    // band (positions sit on the same surface to within the root tolerance).
    let tol = fix.root_tol * 16.0 + 1e-7;

    let mut mismatches = 0usize;
    let mut missing = 0usize;
    let mut len_mismatch = 0usize;
    for ((axis, key), exp) in &fix.faces {
        match got.get(&(*axis, *key)) {
            None => missing += 1,
            Some((len, segs)) => {
                if *len != exp.len as i64 {
                    len_mismatch += 1;
                }
                if !segments_match(&exp.segs, segs, tol) {
                    mismatches += 1;
                }
            }
        }
    }
    assert_eq!(missing, 0, "{name}: {missing} TS faces absent in Rust");
    assert_eq!(len_mismatch, 0, "{name}: {len_mismatch} faces with a key-colliding len mismatch");
    assert_eq!(mismatches, 0, "{name}: {mismatches} faces with a mismatched segment set (tol={tol})");

    // Point pool size matches (every crossing/midpoint created in the same order).
    assert_eq!(points.count(), fix.point_count as usize, "{name}: point count — Rust {} vs TS {}", points.count(), fix.point_count);
}

#[test]
fn contour_sphere_matches_ts() {
    run_parity("contour-sphere.bin", sphere_tree());
}

#[test]
fn contour_box_matches_ts() {
    run_parity("contour-box.bin", box_tree());
}

#[test]
fn contour_sphere_drift_is_sub_ulp_scale() {
    // Diagnostic: assert the max per-endpoint distance between TS and Rust
    // segments is far below the matching tolerance (i.e. positions agree to
    // root-find precision, not just topology). Soft-skips if fixture absent.
    let full = format!("{}/../fixtures/contour-sphere.bin", env!("CARGO_MANIFEST_DIR"));
    let Some(fix) = load(&full) else { return; };
    let tree = sphere_tree();
    let lat = make_lattice(fix.max_depth, fix.origin[0], fix.origin[1], fix.origin[2], fix.world_size);
    let grad_bound = tree.grad_bound();
    let has_blend = tree.has_blend();
    let smooth_opts = SmoothCriteriaOptions {
        normal_variation_cos: fix.normal_variation_cos,
        blend_normal_variation_cos: fix.blend_normal_variation_cos,
        blend_curvature_analytic: None,
    };
    let oct = build_octree(&tree, &lat, OctreeBuildOptions { depth_min: fix.depth_min, depth_max: fix.depth_max, enforce_edge_balance: fix.enforce_edge_balance }, |cell, sampler| {
        let probe = make_probe(&lat, &tree, |gx, gy, gz| sampler.sample_at(gx, gy, gz), cell.level, cell.ix, cell.iy, cell.iz);
        let split = needs_split_smooth(&tree, &probe, &smooth_opts, grad_bound, has_blend);
        CellDecision { split, feature_curve: -1, feature_corner: -1 }
    });
    let mut points = PointTable::new();
    let result = contour_all_faces(&oct, &tree, &mut points, &FaceContourOptions { root_tol: fix.root_tol, ..FaceContourOptions::default() });
    let mut got: HashMap<(u32, i64), Vec<[f64;6]>> = HashMap::new();
    for (axis, per_axis) in result.faces.iter().enumerate() {
        for (&key, rec) in per_axis.iter() {
            got.insert((axis as u32, key), rec.segments.iter().map(|s| [points.x(s.a), points.y(s.a), points.z(s.a), points.x(s.b), points.y(s.b), points.z(s.b)]).collect());
        }
    }
    let mut maxd = 0.0f64;
    for ((axis, key), exp) in &fix.faces {
        if let Some(segs) = got.get(&(*axis, *key)) {
            for (e, g) in exp.segs.iter().zip(segs.iter()) {
                let ec = canon_seg(*e); let gc = canon_seg(*g);
                let d: f64 = (0..6).map(|k| (ec[k]-gc[k]).powi(2)).sum::<f64>().sqrt();
                if d > maxd { maxd = d; }
            }
        }
    }
    eprintln!("contour-sphere max TS↔Rust endpoint drift = {maxd:e} (rootTol={:e})", fix.root_tol);
    assert!(maxd < fix.root_tol * 4.0, "drift {maxd:e} exceeds 4×rootTol");
}
