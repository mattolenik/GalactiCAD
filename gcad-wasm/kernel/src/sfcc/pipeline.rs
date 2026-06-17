//! S4 — the full pipeline driver + MeshData assembly. Port of `runSfccPipeline`
//! (`src/export/sfcc/assemble.mts`).
//!
//! Runs feature-set compilation → feature-aware octree → feature-aware face
//! contour → feature-aware cell mesh → audits (coincident-pair drop, debris drop,
//! sliver flip) → [`PointTable::build_mesh`], returning verts (stride-8 f32),
//! tris, [`SfccStats`], and a [`ManifoldReport`]. On featureless scenes (no
//! curves/corners) every feature path is inert, so the output is byte-identical
//! to the prior smooth-only driver.
//!
//! M4c-2: the feature paths landed — feature-set compilation, the feature-aware
//! refine criteria (i)/(ii) + corner-claim, corner/edge-cell meshing, the
//! feature-hugging debris drop, and the forced-split re-refinement of failed +
//! (round-0) fallback cells.

use crate::math::grid::{cell_aabb, cell_size_at_level, make_lattice, SfccLattice};
use crate::sdf::CsgNode;
use crate::sfcc::cell_mesh::{mesh_all_cells, CellMeshOptions, CellMeshResult, InteriorVertexMode};
use crate::sfcc::face_contour::{contour_all_faces, FaceContourOptions, FaceContourResult};
use crate::sfcc::feature_set::{compile_feature_set, SfccFeatureSet};
use crate::sfcc::manifold_check::{check_manifold, ManifoldReport};
use crate::sfcc::octree::{build_octree, CellDecision, OctreeBuildOptions, SfccCell, SfccOctree};
use crate::sfcc::point_table::PointTable;
use crate::sfcc::refine_criteria::{
    classify_cell_features, has_corner_sign_change, make_probe, needs_split_smooth, FeatureCriteriaOptions,
    SmoothCriteriaOptions,
};
use crate::sfcc::sliver_flip::flip_sliver_triangles;
use crate::tolerances::resolve_tolerances;
use crate::tuning::SfccTuning;
use std::collections::HashMap;
use std::f64::consts::PI;

/// The smooth-only world cube (root bounds before padding). Port of `SfccWorldCube`.
#[derive(Clone, Copy, Debug)]
pub struct SfccWorldCube {
    pub min_x: f64,
    pub min_y: f64,
    pub min_z: f64,
    pub size: f64,
}

/// The driver knobs the smooth pipeline reads. Port of the consumed subset of
/// `SfccTuning` (the feature/seam/driver-policy knobs are M4).
#[derive(Clone, Copy, Debug)]
pub struct PipelineTuning {
    pub depth_min: u32,
    pub depth_max: u32,
    pub bounds_padding_mm: f64,
    pub enforce_edge_balance: bool,
    pub normal_variation_deg: f64,
    pub blend_curvature_refine: bool,
    pub blend_curvature_deg: f64,
    /// Lever 2: use the analytic closed-form blend-curvature bound instead of the
    /// sampled ∇f cone (opt-in; default OFF — the sampled cone stays the proven path).
    pub blend_curvature_analytic: bool,
    /// Lever 2: analytic per-stratum normal-variation bound (κ·cellSize) for the
    /// smoothCrit (iii-b) cert instead of the sampled ∇f cone (opt-in; default OFF).
    pub normal_variation_analytic: bool,
    pub surface_tol_mm: f64,
    pub edge_root_tol_fraction: f64,
    pub interior_vertex_mode: InteriorVertexMode,
    pub project_max_iters: u32,
    pub re_refine_max_rounds: u32,
    pub check_vertex_links: bool,
    // Feature-path knobs (M4c-2).
    pub tangential_epsilon: f64,
    pub feature_query_inflate: f64,
    pub curve_chord_tol_mm: f64,
    pub max_polyline_points_per_cell: usize,
    pub recovery_cull: bool,
    pub probe_delta_factor: f64,
    pub min_dihedral_deg: f64,
    pub min_tangency_angle_deg: f64,
    pub corner_merge_tol_diag_fraction: f64,
    pub seed_cell_size_mm: f64,
    pub max_trace_steps: u32,
}

impl Default for PipelineTuning {
    /// Mirrors `DEFAULT_SFCC_TUNING` for the consumed subset.
    fn default() -> Self {
        PipelineTuning {
            depth_min: 5,
            depth_max: 8,
            bounds_padding_mm: 2.0,
            enforce_edge_balance: true,
            normal_variation_deg: 18.0,
            blend_curvature_refine: true,
            blend_curvature_deg: 18.0,
            blend_curvature_analytic: false,
            normal_variation_analytic: false,
            surface_tol_mm: 0.01,
            edge_root_tol_fraction: 1e-3,
            interior_vertex_mode: InteriorVertexMode::Project,
            project_max_iters: 8,
            re_refine_max_rounds: 2,
            check_vertex_links: false,
            tangential_epsilon: 0.05,
            feature_query_inflate: 0.25,
            curve_chord_tol_mm: 0.02,
            max_polyline_points_per_cell: 16,
            recovery_cull: true,
            probe_delta_factor: 10.0,
            min_dihedral_deg: 15.0,
            min_tangency_angle_deg: 2.0,
            corner_merge_tol_diag_fraction: 1e-6,
            seed_cell_size_mm: 0.0,
            max_trace_steps: 20_000,
        }
    }
}

/// Pipeline statistics (port of `SfccStats`, the consumed subset).
pub struct SfccStats {
    pub leaves: usize,
    pub degenerate_cells: usize,
    pub faces: usize,
    pub cross_points: usize,
    pub tris: usize,
    pub failed_cells: usize,
    pub multi_loop_cells: usize,
    pub multi_run_faces: usize,
    pub boundary_violations: usize,
    pub face_audit_failures: usize,
    pub feature_curves: usize,
    pub edge_cells: usize,
    pub corner_cells: usize,
    pub feature_cell_fallbacks: usize,
    pub re_refine_rounds: u32,
}

/// The assembled smooth-mesh result.
pub struct SfccPipelineResult {
    /// Stride-8 vertex buffer (pos, pad, normal, pad) as f32.
    pub verts: Vec<f32>,
    pub tris: Vec<u32>,
    pub stats: SfccStats,
    pub manifold: ManifoldReport,
    pub ok: bool,
}

/// Remove coincident triangle pairs with opposite winding (zero-volume pancakes
/// whose every edge is non-manifold). Port of `dropCoincidentTrianglePairs`.
fn drop_coincident_triangle_pairs(tris: &[usize]) -> Vec<usize> {
    // Group by UNORDERED vertex triple. The sorted triple is the key — packed
    // into a single i128 (ids stay small; an i128 product is always exact).
    let mut by_verts: HashMap<i128, Vec<usize>> = HashMap::new();
    let mut max_id = 0usize;
    for &t in tris {
        if t > max_id {
            max_id = t;
        }
    }
    let base = (max_id as i128) + 1;
    let mut t = 0;
    while t < tris.len() {
        let mut a = tris[t];
        let mut b = tris[t + 1];
        let mut c = tris[t + 2];
        if a > b {
            std::mem::swap(&mut a, &mut b);
        }
        if b > c {
            std::mem::swap(&mut b, &mut c);
        }
        if a > b {
            std::mem::swap(&mut a, &mut b);
        }
        let k = (a as i128 * base + b as i128) * base + c as i128;
        by_verts.entry(k).or_default().push(t);
        t += 3;
    }
    // (a,b,c) is an even permutation of the sorted order. The three explicit
    // cases mirror the TS `orient` verbatim — kept un-simplified for parity.
    #[allow(clippy::nonminimal_bool)]
    let orient = |t: usize| -> bool {
        let a = tris[t];
        let b = tris[t + 1];
        let c = tris[t + 2];
        (a < b && b < c) || (b < c && c < a) || (c < a && a < b)
    };
    let mut drop: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for list in by_verts.values() {
        if list.len() < 2 {
            continue;
        }
        let mut even: Vec<usize> = Vec::new();
        let mut odd: Vec<usize> = Vec::new();
        for &t in list {
            if orient(t) {
                even.push(t);
            } else {
                odd.push(t);
            }
        }
        let pairs = even.len().min(odd.len());
        for i in 0..pairs {
            drop.insert(even[i]);
            drop.insert(odd[i]);
        }
    }
    if drop.is_empty() {
        return tris.to_vec();
    }
    let mut out = Vec::with_capacity(tris.len());
    let mut t = 0;
    while t < tris.len() {
        if !drop.contains(&t) {
            out.push(tris[t]);
            out.push(tris[t + 1]);
            out.push(tris[t + 2]);
        }
        t += 3;
    }
    out
}

/// Drop debris components. Two classes: micro (AABB diagonal below `max_diag`)
/// and feature-hugging tubes (small components, ≤ `hug_max_verts`, every vertex
/// within `hug_dist` of a feature curve). Never drops the dominant component.
/// Port of `dropDebrisComponents`.
fn drop_debris_components(
    points: &PointTable,
    tris: &[usize],
    max_diag: f64,
    features: &SfccFeatureSet,
    hug_dist: f64,
    hug_max_verts: usize,
) -> Vec<usize> {
    if tris.is_empty() {
        return tris.to_vec();
    }
    let mut parent: HashMap<usize, usize> = HashMap::new();
    fn find(parent: &mut HashMap<usize, usize>, v: usize) -> usize {
        let mut r = *parent.get(&v).unwrap_or(&v);
        if r != v {
            r = find(parent, r);
            parent.insert(v, r);
        }
        r
    }
    let union = |parent: &mut HashMap<usize, usize>, a: usize, b: usize| {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent.insert(ra, rb);
        }
    };
    let mut t = 0;
    while t < tris.len() {
        union(&mut parent, tris[t], tris[t + 1]);
        union(&mut parent, tris[t + 1], tris[t + 2]);
        t += 3;
    }
    let mut bounds: HashMap<usize, [f64; 6]> = HashMap::new();
    let mut members: HashMap<usize, std::collections::HashSet<usize>> = HashMap::new();
    for &v in tris {
        let root = find(&mut parent, v);
        let b = bounds
            .entry(root)
            .or_insert([f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY]);
        members.entry(root).or_default().insert(v);
        let x = points.x(v);
        let y = points.y(v);
        let z = points.z(v);
        if x < b[0] {
            b[0] = x;
        }
        if y < b[1] {
            b[1] = y;
        }
        if z < b[2] {
            b[2] = z;
        }
        if x > b[3] {
            b[3] = x;
        }
        if y > b[4] {
            b[4] = y;
        }
        if z > b[5] {
            b[5] = z;
        }
    }
    // Never drop the dominant component. Iterate roots in sorted order so the
    // pick is deterministic run-to-run (the double-run bit-identical guard).
    let mut roots: Vec<usize> = members.keys().copied().collect();
    roots.sort_unstable();
    let mut main_root = usize::MAX;
    let mut main_size: i64 = -1;
    for root in &roots {
        let size = members[root].len() as i64;
        if size > main_size {
            main_size = size;
            main_root = *root;
        }
    }
    let mut drop: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for &root in &roots {
        if root == main_root {
            continue;
        }
        let b = &bounds[&root];
        if hypot3(b[3] - b[0], b[4] - b[1], b[5] - b[2]) < max_diag {
            drop.insert(root);
            continue;
        }
        let verts = &members[&root];
        if verts.len() > hug_max_verts {
            continue;
        }
        // Feature-hugging tube: every vertex within hug_dist of a feature curve.
        // Iterate vertices in sorted order so the early-out is deterministic.
        let mut vlist: Vec<usize> = verts.iter().copied().collect();
        vlist.sort_unstable();
        let mut hugging = true;
        for &v in &vlist {
            let x = points.x(v);
            let y = points.y(v);
            let z = points.z(v);
            let mut near = false;
            let qmin = [x - hug_dist, y - hug_dist, z - hug_dist];
            let qmax = [x + hug_dist, y + hug_dist, z + hug_dist];
            for cid in features.index.curves_in_box(qmin, qmax) {
                let (_, dist) = features.curves[cid].project(x, y, z);
                if dist <= hug_dist {
                    near = true;
                    break;
                }
            }
            if !near {
                hugging = false;
                break;
            }
        }
        if hugging {
            drop.insert(root);
        }
    }
    if drop.is_empty() {
        return tris.to_vec();
    }
    let mut out = Vec::with_capacity(tris.len());
    let mut t = 0;
    while t < tris.len() {
        let root = find(&mut parent, tris[t]);
        if !drop.contains(&root) {
            out.push(tris[t]);
            out.push(tris[t + 1]);
            out.push(tris[t + 2]);
        }
        t += 3;
    }
    out
}

/// A forced-split marker from a prior round's failed / fallback cell: any leaf
/// containing this point at ≤ `level` must split. Port of the TS `forced` array.
#[derive(Clone, Copy)]
struct ForcedMarker {
    x: f64,
    y: f64,
    z: f64,
    level: u32,
}

/// Run the full feature-aware SFCC pipeline. Port of `runSfccPipeline`. On a
/// featureless scene (no curves/corners) every feature path is inert, so the
/// output equals the prior smooth-only driver byte-for-byte.
pub fn run_sfcc_pipeline(tree: &CsgNode, cube: &SfccWorldCube, tuning: &PipelineTuning) -> SfccPipelineResult {
    let pad = tuning.bounds_padding_mm;
    // Lattice-degeneracy guard: offset the root cube by distinct irrational
    // fractions of a max-depth cell so rational geometry never coincides with
    // the dyadic lattice. Deterministic. (Same expression as the TS oracle.)
    let total_size = cube.size + 2.0 * pad;
    let step = total_size / ((1u64 << tuning.depth_max) as f64);
    let jx = (std::f64::consts::SQRT_2 - 1.0) * 0.25 * step;
    let jy = (3.0f64.sqrt() - 1.0) * 0.25 * step;
    let jz = (5.0f64.sqrt() - 2.0) * 0.25 * step;
    let lat: SfccLattice = make_lattice(
        tuning.depth_max,
        cube.min_x - pad - jx,
        cube.min_y - pad - jy,
        cube.min_z - pad - jz,
        total_size,
    );

    // Feature compilation (native curves + traced boolean seams, CSG-trimmed).
    let scene_diag = hypot3(cube.size, cube.size, cube.size);
    let sfcc_tuning = SfccTuning {
        depth_min: tuning.depth_min,
        depth_max: tuning.depth_max,
        bounds_padding_mm: tuning.bounds_padding_mm,
        enforce_edge_balance: tuning.enforce_edge_balance,
        normal_variation_deg: tuning.normal_variation_deg,
        blend_curvature_refine: tuning.blend_curvature_refine,
        blend_curvature_deg: tuning.blend_curvature_deg,
        blend_curvature_analytic: tuning.blend_curvature_analytic,
        tangential_epsilon: tuning.tangential_epsilon,
        feature_query_inflate: tuning.feature_query_inflate,
        surface_tol_mm: tuning.surface_tol_mm,
        curve_chord_tol_mm: tuning.curve_chord_tol_mm,
        probe_delta_factor: tuning.probe_delta_factor,
        min_dihedral_deg: tuning.min_dihedral_deg,
        min_tangency_angle_deg: tuning.min_tangency_angle_deg,
        corner_merge_tol_diag_fraction: tuning.corner_merge_tol_diag_fraction,
        seed_cell_size_mm: tuning.seed_cell_size_mm,
        max_trace_steps: tuning.max_trace_steps,
    };
    let tol = resolve_tolerances(&sfcc_tuning, scene_diag);
    let (features, _diag) = compile_feature_set(tree, &tol);

    let grad_bound = tree.grad_bound();
    let has_blend = tree.has_blend();
    // Lever 1: per-cell CSG pruning gate (default OFF; see lever1_should_prune).
    let prune = crate::sdf::lever1_should_prune(tree, crate::sfcc::octree::LEVER1_MIN_LEAVES);
    // Lever 2: analytic blend-curvature bound (default OFF). On only when the tuning
    // flag is set AND every blend is analytic-eligible (round + plane/sphere/cylinder
    // carriers); otherwise `None` → the proven sampled ∇f cone for the whole tree.
    let blend_curvature_analytic = if tuning.blend_curvature_analytic && tuning.blend_curvature_refine {
        tree.blend_curvature_bound()
    } else {
        None
    };
    let smooth_opts = SmoothCriteriaOptions {
        normal_variation_cos: (tuning.normal_variation_deg * PI / 180.0).cos(),
        blend_normal_variation_cos: if tuning.blend_curvature_refine {
            (tuning.blend_curvature_deg * PI / 180.0).cos()
        } else {
            1.0 // ≥1 disables (iii-d)
        },
        blend_curvature_analytic,
        normal_variation_analytic: tuning.normal_variation_analytic,
    };
    let feature_opts = FeatureCriteriaOptions {
        feature_query_inflate: tuning.feature_query_inflate,
        tangential_epsilon: tuning.tangential_epsilon,
    };

    let max_depth = tuning.depth_max.min(lat.max_depth);

    // Forced-split markers accumulate across re-refine rounds.
    let mut forced: Vec<ForcedMarker> = Vec::new();
    let forced_split = |forced: &[ForcedMarker], cell: &SfccCell| -> bool {
        if forced.is_empty() {
            return false;
        }
        let size = total_size / ((1u64 << cell.level) as f64);
        let min_x = lat.origin_x + cell.ix as f64 * size;
        let min_y = lat.origin_y + cell.iy as f64 * size;
        let min_z = lat.origin_z + cell.iz as f64 * size;
        for f in forced {
            if cell.level <= f.level
                && f.x >= min_x
                && f.x <= min_x + size
                && f.y >= min_y
                && f.y <= min_y + size
                && f.z >= min_z
                && f.z <= min_z + size
            {
                return true;
            }
        }
        false
    };

    let mut oct: SfccOctree;
    let mut points: PointTable;
    let mut face_result: FaceContourResult;
    let mut cell_result: CellMeshResult;
    let mut re_refine_rounds = 0u32;
    let mut round = 0u32;
    loop {
        let forced_snapshot = forced.clone();
        oct = build_octree(
            tree,
            &lat,
            OctreeBuildOptions {
                depth_min: tuning.depth_min,
                depth_max: max_depth,
                enforce_edge_balance: tuning.enforce_edge_balance,
            },
            // The full feature-aware needsSplit, mirroring runSfccPipeline. Pure
            // read over the immutable feature set + the pre-populated sample cache,
            // so the octree driver runs this DECISION over the round's frontier in
            // parallel (rayon, `threads` feature) — the ~67% classifyCellFeatures
            // hot path. Returns the split decision + the feature tags to stamp.
            |cell, sampler| {
                let cls = classify_cell_features(&features, &lat, cell.level, cell.ix, cell.iy, cell.iz, &feature_opts);
                if cls.split {
                    let mut feature_corner = cls.corner;
                    if cell.level >= max_depth && cls.corner < 0 {
                        // Multi-curve cell that can never split apart: claim a
                        // nearby corner if one exists (curves CONVERGE at corners).
                        let claim = cell_aabb(&lat, cell.level, cell.ix, cell.iy, cell.iz);
                        let cell_size = cell_size_at_level(&lat, cell.level);
                        let reach = cell_size * 1.25;
                        let mut best_corner: i64 = -1;
                        let mut best_d = f64::INFINITY;
                        let qmin = [claim[0] - reach, claim[1] - reach, claim[2] - reach];
                        let qmax = [claim[3] + reach, claim[4] + reach, claim[5] + reach];
                        for corner_id in features.index.corners_in_box(qmin, qmax) {
                            let c = &features.corners[corner_id];
                            let dx = (claim[0] - c.x).max(0.0).max(c.x - claim[3]);
                            let dy = (claim[1] - c.y).max(0.0).max(c.y - claim[4]);
                            let dz = (claim[2] - c.z).max(0.0).max(c.z - claim[5]);
                            let d = (dx * dx + dy * dy + dz * dz).sqrt();
                            if d < best_d {
                                best_d = d;
                                best_corner = corner_id as i64;
                            }
                        }
                        if best_corner >= 0 && best_d <= reach {
                            feature_corner = best_corner;
                        }
                    }
                    return CellDecision { split: true, feature_curve: cls.curve, feature_corner };
                }
                if forced_split(&forced_snapshot, cell) {
                    // Forced split discards the cell (tags unused below max_depth;
                    // a degenerate forced cell at max_depth carried no cls tags in
                    // the serial path either, so keep them unset).
                    return CellDecision { split: true, feature_curve: -1, feature_corner: -1 };
                }
                // Lever 1: one pruned view over this cell's box, reused across the
                // certificate evals (all query points lie inside the cell box, where
                // the pruned view is bit-exact). Prune FRESH per cell.
                let pruned: Option<crate::sdf::Pruned> = if prune {
                    let half = cell_size_at_level(&lat, cell.level) / 2.0;
                    let c = crate::math::grid::cell_center_world(&lat, cell.level, cell.ix, cell.iy, cell.iz);
                    Some(tree.prune_to_box(c, [half, half, half]))
                } else {
                    None
                };
                let q: &dyn crate::sdf::SdfQuery = match &pruned {
                    Some(p) => p,
                    None => tree,
                };
                let probe = make_probe(
                    &lat,
                    q,
                    |gx, gy, gz| sampler.sample_at(gx, gy, gz),
                    cell.level,
                    cell.ix,
                    cell.iy,
                    cell.iz,
                );
                if cls.corner >= 0 {
                    // Corner cells exempt from per-stratum + sign-change gates.
                    return CellDecision { split: false, feature_curve: cls.curve, feature_corner: cls.corner };
                }
                if cls.curve >= 0 && !has_corner_sign_change(&probe) {
                    return CellDecision { split: true, feature_curve: cls.curve, feature_corner: cls.corner };
                }
                let split = needs_split_smooth(q, &probe, &smooth_opts, grad_bound, has_blend);
                CellDecision { split, feature_curve: cls.curve, feature_corner: cls.corner }
            },
        );
        points = PointTable::new();
        let root_tol = (tuning.edge_root_tol_fraction * lat.step).min(tuning.surface_tol_mm * 0.1);
        face_result = contour_all_faces(
            &oct,
            tree,
            &mut points,
            &FaceContourOptions { root_tol, features: Some(&features), recovery_cull: tuning.recovery_cull },
        );
        cell_result = mesh_all_cells(
            &oct,
            &mut face_result.faces,
            tree,
            &mut points,
            &CellMeshOptions {
                surface_tol: tuning.surface_tol_mm,
                interior_vertex_mode: tuning.interior_vertex_mode,
                project_max_iters: tuning.project_max_iters,
                curve_chord_tol: tuning.curve_chord_tol_mm,
                max_polyline_points_per_cell: tuning.max_polyline_points_per_cell,
                features: Some(&features),
            },
        );
        // Failed cells re-refine every round; fallback cells get ONE forced round.
        let mut suspects: Vec<SfccCell> = Vec::new();
        for c in &cell_result.failed_cells {
            if c.level < max_depth {
                suspects.push(*c);
            }
        }
        if round == 0 {
            for c in &cell_result.fallback_cells {
                if c.level < max_depth {
                    suspects.push(*c);
                }
            }
        }
        if round >= tuning.re_refine_max_rounds || suspects.is_empty() {
            break;
        }
        re_refine_rounds += 1;
        for c in &suspects {
            let size = total_size / ((1u64 << c.level) as f64);
            forced.push(ForcedMarker {
                x: lat.origin_x + (c.ix as f64 + 0.5) * size,
                y: lat.origin_y + (c.iy as f64 + 0.5) * size,
                z: lat.origin_z + (c.iz as f64 + 0.5) * size,
                level: c.level,
            });
        }
        round += 1;
    }

    // Face-segment audit: interior segments must be consumed once forward and
    // once reversed. (Faces adjacent to a failed cell legitimately miss one.)
    let mut face_audit_failures = 0usize;
    let mut face_count = 0usize;
    if cell_result.failed_cells.is_empty() {
        for per_axis in &face_result.faces {
            for rec in per_axis.values() {
                face_count += 1;
                for i in 0..rec.segments.len() {
                    if rec.consumed_fwd[i] != 1 || rec.consumed_rev[i] != 1 {
                        face_audit_failures += 1;
                    }
                }
            }
        }
    } else {
        for per_axis in &face_result.faces {
            face_count += per_axis.len();
        }
    }

    // S4 cleanups (same call order/args as the oracle so winding/topology match):
    // coincident-pair drop → debris drop → coincident-pair drop → sliver flip.
    let deduped1 = drop_coincident_triangle_pairs(&cell_result.tris);
    let filtered = drop_debris_components(&points, &deduped1, lat.step * 4.0, &features, lat.step * 2.0, 600);
    let deduped2 = drop_coincident_triangle_pairs(&filtered);
    let (flipped, _flips) = flip_sliver_triangles(&points, &deduped2, 4);

    let (verts, out_tris) = points.build_mesh(&flipped);
    let manifold = check_manifold(&out_tris, tuning.check_vertex_links);

    let stats = SfccStats {
        leaves: oct.leaves.len(),
        degenerate_cells: oct.degenerate_cells,
        faces: face_count,
        cross_points: points.count(),
        tris: out_tris.len() / 3,
        failed_cells: cell_result.failed_cells.len(),
        multi_loop_cells: cell_result.multi_loop_cells,
        multi_run_faces: face_result.multi_run_faces,
        boundary_violations: face_result.boundary_violations,
        face_audit_failures,
        feature_curves: features.curves.len(),
        edge_cells: cell_result.edge_cells,
        corner_cells: cell_result.corner_cells,
        feature_cell_fallbacks: cell_result.feature_cell_fallbacks,
        re_refine_rounds,
    };
    let ok = manifold.ok
        && face_audit_failures == 0
        && cell_result.failed_cells.is_empty()
        && face_result.boundary_violations == 0;

    SfccPipelineResult { verts, tris: out_tris, stats, manifold, ok }
}

fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}
