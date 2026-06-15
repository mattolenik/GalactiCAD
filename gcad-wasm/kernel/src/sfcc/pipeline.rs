//! S4 — the smooth-only pipeline driver + MeshData assembly. Port of the
//! featureless paths of `runSfccPipeline` (`src/export/sfcc/assemble.mts`).
//!
//! Runs octree → face contour → cell mesh → audits (coincident-pair drop,
//! debris drop, sliver flip) → [`PointTable::build_mesh`], returning verts
//! (stride-8 f32), tris, [`SfccStats`], and a [`ManifoldReport`].
//!
//! DEFERRED to M4 (the feature paths — absent on smooth scenes): feature-set
//! compilation, the feature-aware refine criteria (i)/(ii) + corner-claim, the
//! corner/edge-cell meshing, feature-hugging debris drop, and the forced-split
//! re-refinement of fallback cells (only loop-broken `failed_cells` re-refine on
//! the smooth path, and smooth scenes never produce any).

use crate::math::grid::{make_lattice, SfccLattice};
use crate::sdf::CsgNode;
use crate::sfcc::cell_mesh::{mesh_all_cells, CellMeshOptions, CellMeshResult, InteriorVertexMode};
use crate::sfcc::face_contour::{contour_all_faces, FaceContourOptions, FaceContourResult};
use crate::sfcc::manifold_check::{check_manifold, ManifoldReport};
use crate::sfcc::octree::{build_octree, OctreeBuildOptions, SfccOctree};
use crate::sfcc::point_table::PointTable;
use crate::sfcc::refine_criteria::{make_probe, needs_split_smooth, SmoothCriteriaOptions};
use crate::sfcc::sliver_flip::flip_sliver_triangles;
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
    pub surface_tol_mm: f64,
    pub edge_root_tol_fraction: f64,
    pub interior_vertex_mode: InteriorVertexMode,
    pub project_max_iters: u32,
    pub re_refine_max_rounds: u32,
    pub check_vertex_links: bool,
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
            surface_tol_mm: 0.01,
            edge_root_tol_fraction: 1e-3,
            interior_vertex_mode: InteriorVertexMode::Project,
            project_max_iters: 8,
            re_refine_max_rounds: 2,
            check_vertex_links: false,
        }
    }
}

/// Pipeline statistics (smooth-only subset of `SfccStats`).
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

/// Drop debris components (SMOOTH path: the feature-hugging-tube class needs a
/// feature set, absent here, so only the micro-extent class runs — components
/// whose AABB diagonal is below `max_diag`, never the dominant one). Port of the
/// smooth subset of `dropDebrisComponents`.
fn drop_debris_components(points: &PointTable, tris: &[usize], max_diag: f64) -> Vec<usize> {
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
    let mut members: HashMap<usize, usize> = HashMap::new();
    let mut seen: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    for &v in tris {
        let root = find(&mut parent, v);
        let b = bounds
            .entry(root)
            .or_insert([f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY]);
        if seen.insert((root, v)) {
            *members.entry(root).or_insert(0) += 1;
        }
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
    // pick is deterministic run-to-run (the double-run bit-identical guard); on
    // the smooth corpus there is one dominant component so the `>` tie-break is
    // moot, but sorting removes any hash-order dependence.
    let mut roots: Vec<usize> = members.keys().copied().collect();
    roots.sort_unstable();
    let mut main_root = usize::MAX;
    let mut main_size = 0usize;
    for root in &roots {
        let size = members[root];
        if size > main_size {
            main_size = size;
            main_root = *root;
        }
    }
    let mut drop: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (&root, b) in &bounds {
        if root == main_root {
            continue;
        }
        if hypot3(b[3] - b[0], b[4] - b[1], b[5] - b[2]) < max_diag {
            drop.insert(root);
        }
        // SMOOTH path: the feature-hugging-tube branch (features.index /
        // curve.project) is M4. With no curves it never fires, so a non-micro
        // off-body component is simply kept (smooth corpus has none).
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

/// Run the smooth-only SFCC pipeline. Port of `runSfccPipeline` (featureless path).
pub fn run_sfcc_pipeline(tree: &CsgNode, cube: &SfccWorldCube, tuning: &PipelineTuning) -> SfccPipelineResult {
    let pad = tuning.bounds_padding_mm;
    // Lattice-degeneracy guard: offset the root cube by distinct irrational
    // fractions of a max-depth cell so rational geometry never coincides with
    // the dyadic lattice. Deterministic. (Same expression as the TS oracle.)
    let step = (cube.size + 2.0 * pad) / ((1u64 << tuning.depth_max) as f64);
    let jx = (std::f64::consts::SQRT_2 - 1.0) * 0.25 * step;
    let jy = (3.0f64.sqrt() - 1.0) * 0.25 * step;
    let jz = (5.0f64.sqrt() - 2.0) * 0.25 * step;
    let lat: SfccLattice = make_lattice(
        tuning.depth_max,
        cube.min_x - pad - jx,
        cube.min_y - pad - jy,
        cube.min_z - pad - jz,
        cube.size + 2.0 * pad,
    );

    let grad_bound = tree.grad_bound();
    let has_blend = tree.has_blend();
    let smooth_opts = SmoothCriteriaOptions {
        normal_variation_cos: (tuning.normal_variation_deg * PI / 180.0).cos(),
        blend_normal_variation_cos: if tuning.blend_curvature_refine {
            (tuning.blend_curvature_deg * PI / 180.0).cos()
        } else {
            1.0 // ≥1 disables (iii-d)
        },
    };

    let max_depth = tuning.depth_max.min(lat.max_depth);

    // SMOOTH path: the forced-split markers from prior rounds' fallback cells are
    // M4 (fallback cells are feature artifacts). Only loop-broken `failed_cells`
    // re-refine here, and smooth scenes never produce any — so the loop runs once.
    let mut oct: SfccOctree;
    let mut points: PointTable;
    let mut face_result: FaceContourResult;
    let mut cell_result: CellMeshResult;
    let mut re_refine_rounds = 0u32;
    let mut round = 0u32;
    loop {
        oct = build_octree(
            tree,
            &lat,
            OctreeBuildOptions {
                depth_min: tuning.depth_min,
                depth_max: max_depth,
                enforce_edge_balance: tuning.enforce_edge_balance,
            },
            |cell, sampler| {
                let probe = make_probe(
                    &lat,
                    tree,
                    |gx, gy, gz| sampler.sample_at(gx, gy, gz),
                    cell.level,
                    cell.ix,
                    cell.iy,
                    cell.iz,
                );
                needs_split_smooth(tree, &probe, &smooth_opts, grad_bound, has_blend)
            },
        );
        points = PointTable::new();
        let root_tol = (tuning.edge_root_tol_fraction * lat.step).min(tuning.surface_tol_mm * 0.1);
        face_result = contour_all_faces(&oct, tree, &mut points, &FaceContourOptions { root_tol });
        cell_result = mesh_all_cells(
            &oct,
            &mut face_result.faces,
            tree,
            &mut points,
            &CellMeshOptions {
                surface_tol: tuning.surface_tol_mm,
                interior_vertex_mode: tuning.interior_vertex_mode,
                project_max_iters: tuning.project_max_iters,
            },
        );
        // SMOOTH path: only loop-broken failed cells re-refine (fallback cells
        // are M4). Soft cap on rounds; smooth scenes break here on round 0.
        let suspects: usize = cell_result.failed_cells.iter().filter(|c| c.level < max_depth).count();
        if round >= tuning.re_refine_max_rounds || suspects == 0 {
            break;
        }
        re_refine_rounds += 1;
        // (Forced-split marker injection is M4; with no fallback path there is
        // nothing to force here — a failed cell on a smooth scene would loop
        // without progress, so cap via re_refine_max_rounds.)
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
    let filtered = drop_debris_components(&points, &deduped1, lat.step * 4.0);
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
