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

use crate::math::grid::{cell_aabb, cell_size_at_level, make_lattice, stride_at_level, SfccLattice};
use crate::sdf::CsgNode;
use crate::sfcc::cell_mesh::{
    mesh_all_cells, mesh_cells_for, mesh_cells_partitioned, mesh_cells_subset, CellMeshOptions, CellMeshResult,
    InteriorVertexMode,
};
use crate::sfcc::face_contour::{
    contour_all_faces, contour_faces_for, contour_faces_partitioned, contour_subset_separate, FaceContourOptions,
    FaceContourResult,
};
use crate::sfcc::feature_set::{compile_feature_set, SfccFeatureSet};
use crate::sfcc::manifold_check::{check_manifold, ManifoldReport};
use crate::sfcc::octree::{
    build_octree, build_octree_profiled, CellDecision, OctreeBuildOptions, SfccCell, SfccOctree,
};
use crate::sfcc::point_table::{PointKey, PointTable};
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
    /// Phase wall-clock split in ms (zeros unless run via [`run_sfcc_pipeline_profiled`]).
    /// Measured from an injected clock so the dep-free kernel needs no time source.
    /// `contour`+`cellmesh` are the spatial-partition-PARALLELIZABLE phases; feature
    /// compile, octree build, and assemble (S4 merge/audits) stay serial.
    pub phase_feature_ms: f64,
    pub phase_octree_ms: f64,
    pub phase_contour_ms: f64,
    pub phase_cellmesh_ms: f64,
    pub phase_assemble_ms: f64,
    /// Within `phase_octree_ms`: the refinement loop's parallelizable per-cell
    /// DECIDE pass vs the inherently-serial APPLY+ripple loop, summed across rounds
    /// (and across re-refine rounds when there are several). Zero unless profiled.
    pub phase_octree_decide_ms: f64,
    pub phase_octree_apply_ms: f64,
    /// Per-round `(frontier_len, decide_ms, apply_ms)` of the octree build, in round
    /// order. Empty unless profiled. With re-refine rounds the rounds of every build
    /// are concatenated (mech has reRefineRounds=0 → one build).
    pub octree_rounds: Vec<(usize, f64, f64)>,
}

/// Remove coincident triangle pairs with opposite winding (zero-volume pancakes
/// whose every edge is non-manifold). Port of `dropCoincidentTrianglePairs`.
pub(crate) fn drop_coincident_triangle_pairs(tris: &[usize]) -> Vec<usize> {
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
pub(crate) fn drop_debris_components(
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

/// The immutable per-export context the feature-aware needsSplit DECISION reads.
/// Built once by [`build_pipeline_context`] and shared by BOTH the serial driver
/// ([`run_sfcc_pipeline_impl`]) and the worker `prepare` path so the two can never
/// drift — the decision (classify_cell_features + smoothCrit, the expensive ~60%)
/// is computed by exactly one code path. Holds only borrows + cheap scalars; no
/// per-round mutable state (the `forced` markers are passed separately, since they
/// accumulate across re-refine rounds).
pub(crate) struct PipelineContext<'a> {
    pub lat: SfccLattice,
    pub features: SfccFeatureSet,
    feature_opts: FeatureCriteriaOptions,
    smooth_opts: SmoothCriteriaOptions,
    grad_bound: f64,
    has_blend: bool,
    prune: bool,
    max_depth: u32,
    total_size: f64,
    tree: &'a CsgNode,
}

impl<'a> PipelineContext<'a> {
    /// The feature-aware split DECISION for one frontier cell — the SINGLE source
    /// of truth shared by the serial pipeline and the worker `prepare`. Mirrors
    /// `runSfccPipeline`'s `needsSplit` exactly (classify (i)/(ii) → corner-claim
    /// at max_depth → forced-split → corner exemption → sign-change gate →
    /// per-stratum smoothCrit), returning the split flag + the tags to stamp.
    ///
    /// `forced` is the accumulated forced-split marker list for the current round
    /// (empty on round 0 / the worker's single build); `sample` reads the shared
    /// corner-sample cache (the [`crate::sfcc::octree::SampleView`] in the parallel
    /// decision pass).
    fn decide_cell<S: Fn(i64, i64, i64) -> f64>(
        &self,
        cell: &SfccCell,
        sample: &S,
        forced: &[ForcedMarker],
    ) -> CellDecision {
        let lat = &self.lat;
        let features = &self.features;
        let cls =
            classify_cell_features(features, lat, cell.level, cell.ix, cell.iy, cell.iz, &self.feature_opts);
        if cls.split {
            let mut feature_corner = cls.corner;
            if cell.level >= self.max_depth && cls.corner < 0 {
                // Multi-curve cell that can never split apart: claim a nearby corner
                // if one exists (curves CONVERGE at corners).
                let claim = cell_aabb(lat, cell.level, cell.ix, cell.iy, cell.iz);
                let cell_size = cell_size_at_level(lat, cell.level);
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
        if forced_split(forced, cell, lat, self.total_size) {
            // Forced split discards the cell (tags unused below max_depth; a
            // degenerate forced cell at max_depth carried no cls tags in the serial
            // path either, so keep them unset).
            return CellDecision { split: true, feature_curve: -1, feature_corner: -1 };
        }
        // Lever 1: one pruned view over this cell's box, reused across the
        // certificate evals (all query points lie inside the cell box, where the
        // pruned view is bit-exact). Prune FRESH per cell.
        let pruned: Option<crate::sdf::Pruned> = if self.prune {
            let half = cell_size_at_level(lat, cell.level) / 2.0;
            let c = crate::math::grid::cell_center_world(lat, cell.level, cell.ix, cell.iy, cell.iz);
            Some(self.tree.prune_to_box(c, [half, half, half]))
        } else {
            None
        };
        let q: &dyn crate::sdf::SdfQuery = match &pruned {
            Some(p) => p,
            None => self.tree,
        };
        let probe = make_probe(lat, q, |gx, gy, gz| sample(gx, gy, gz), cell.level, cell.ix, cell.iy, cell.iz);
        if cls.corner >= 0 {
            // Corner cells exempt from per-stratum + sign-change gates.
            return CellDecision { split: false, feature_curve: cls.curve, feature_corner: cls.corner };
        }
        if cls.curve >= 0 && !has_corner_sign_change(&probe) {
            return CellDecision { split: true, feature_curve: cls.curve, feature_corner: cls.corner };
        }
        let split = needs_split_smooth(q, &probe, &self.smooth_opts, self.grad_bound, self.has_blend);
        CellDecision { split, feature_curve: cls.curve, feature_corner: cls.corner }
    }

    /// Build the tagged octree (round 0, empty forced markers) using this context's
    /// shared [`Self::decide_cell`]. This is exactly the serial driver's first
    /// `build_octree` call — the expensive per-cell DECISION + tag stamping — minus
    /// the re-refine loop. Used by the worker [`crate::sfcc::worker::prepare`]; the
    /// serial driver runs the equivalent `build_octree` inline (so it can re-refine).
    pub(crate) fn build_tagged_octree(&self, tuning: &PipelineTuning) -> SfccOctree<'_> {
        let forced: Vec<ForcedMarker> = Vec::new();
        build_octree(
            self.tree,
            &self.lat,
            OctreeBuildOptions {
                depth_min: tuning.depth_min,
                depth_max: self.max_depth,
                enforce_edge_balance: tuning.enforce_edge_balance,
            },
            |cell, sampler| self.decide_cell(cell, &|gx, gy, gz| sampler.sample_at(gx, gy, gz), &forced),
        )
    }
}

/// Whether a leaf must be force-split by a prior round's marker (free function so
/// it's callable from both [`PipelineContext::decide_cell`] and the serial driver).
fn forced_split(forced: &[ForcedMarker], cell: &SfccCell, lat: &SfccLattice, total_size: f64) -> bool {
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
}

/// Build the shared per-export context: lattice (with the degeneracy jitter),
/// feature-set compilation, and all the cached split-decision advisories. Shared by
/// the serial driver and the worker `prepare` so the expensive DECISION is defined
/// in exactly one place. Returns the context (owning the compiled feature set) and
/// the resolved `max_depth` ceiling.
pub(crate) fn build_pipeline_context<'a>(
    tree: &'a CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
) -> PipelineContext<'a> {
    let pad = tuning.bounds_padding_mm;
    // Lattice-degeneracy guard: offset the root cube by distinct irrational
    // fractions of a max-depth cell so rational geometry never coincides with the
    // dyadic lattice. Deterministic. (Same expression as the TS oracle.)
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
    let prune = crate::sdf::lever1_should_prune(tree, crate::sfcc::octree::LEVER1_MIN_LEAVES);
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

    PipelineContext {
        lat,
        features,
        feature_opts,
        smooth_opts,
        grad_bound,
        has_blend,
        prune,
        max_depth,
        total_size,
        tree,
    }
}

/// Run the full feature-aware SFCC pipeline. Port of `runSfccPipeline`. On a
/// featureless scene (no curves/corners) every feature path is inert, so the
/// output equals the prior smooth-only driver byte-for-byte.
/// How the per-cell meshing (contour + cell-mesh) is decomposed. The octree build +
/// re-refine loop + S4 cleanups are identical across all three; only the meshing step
/// differs, and all three produce the same mesh.
enum MeshStrategy {
    /// Single pass over all leaves (the original serial path).
    Serial,
    /// #3 slice 1: N contiguous groups sharing ONE face map + point table.
    Shared(usize),
    /// #3 slice 3: N contiguous groups, each meshed into its OWN face map + point
    /// table (the per-worker view), then merged by global provenance key.
    Separate(usize),
    /// #3 slice 2: N Morton/Z-order (spatially-compact, count-balanced) groups sharing
    /// ONE face map + point table. Canonically equal to serial (cell order reorders).
    SharedMorton(usize),
    /// #3 slice 2 over the slice-3 separate-table view: N Morton/Z-order groups, each
    /// meshed into its OWN face map + point table, then merged by global provenance
    /// key. This is the partition shape the eventual JS workers (slice 5) will use.
    SeparateMorton(usize),
}

pub fn run_sfcc_pipeline(tree: &CsgNode, cube: &SfccWorldCube, tuning: &PipelineTuning) -> SfccPipelineResult {
    run_sfcc_pipeline_impl(tree, cube, tuning, MeshStrategy::Serial, None)
}

/// Serial pipeline with phase wall-clock timing populated in the result's `phase_*_ms`
/// fields. `now` is an injected monotonic-ish millisecond clock (the dep-free kernel has
/// no time source): native callers pass an `Instant`/`SystemTime` closure, the wasm crate
/// passes `js_sys::Date::now`. The mesh output is identical to [`run_sfcc_pipeline`];
/// only the timing is captured. Used to measure the spatial-partition (#3) Amdahl ceiling
/// — the parallelizable contour+cellmesh fraction vs the serial feature/octree/assemble.
pub fn run_sfcc_pipeline_profiled(
    tree: &CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
    now: &dyn Fn() -> f64,
) -> SfccPipelineResult {
    run_sfcc_pipeline_impl(tree, cube, tuning, MeshStrategy::Serial, Some(now))
}

/// Spatial-partition (#3 slice 1) in-process driver: mesh the surface leaves in
/// `partitions` contiguous groups (shared face map + point table), instead of one
/// pass, combining their partial contour/cell-mesh in group order. `partitions <=
/// 1` is the serial path. The result is byte-identical to [`run_sfcc_pipeline`] for
/// ANY `partitions` (contiguous groups preserve cell order, the shared face map
/// stitches group boundaries + T-junctions) — this is the determinism substrate the
/// eventual cross-worker, separate-table version (slices 2/4/5) must reproduce.
pub fn run_sfcc_pipeline_partitioned(
    tree: &CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
    partitions: usize,
) -> SfccPipelineResult {
    let strategy = if partitions.max(1) <= 1 { MeshStrategy::Serial } else { MeshStrategy::Shared(partitions) };
    run_sfcc_pipeline_impl(tree, cube, tuning, strategy, None)
}

/// Spatial-partition (#3 slice 3) in-process driver: mesh the surface leaves in
/// `partitions` contiguous groups, each into its OWN, SEPARATE face map + point table
/// (exactly what a Web Worker would hold — no shared state), then MERGE the partials
/// by global provenance key into one mesh and run the shared S4 cleanups. This proves
/// the separate-table decomposition (with halo-aware coarse-side sub-face contouring)
/// reconstructs the serial mesh — the correctness gate the eventual JS worker
/// orchestration (slice 5) needs before it can be trusted. The octree build (+ the
/// re-refine loop) stays serial/global, as the design doc requires. `partitions <= 1`
/// is the serial path. Result is mesh-equivalent to [`run_sfcc_pipeline`] for any N.
pub fn run_sfcc_pipeline_separate_partitioned(
    tree: &CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
    partitions: usize,
) -> SfccPipelineResult {
    let strategy = if partitions.max(1) <= 1 { MeshStrategy::Serial } else { MeshStrategy::Separate(partitions) };
    run_sfcc_pipeline_impl(tree, cube, tuning, strategy, None)
}

/// #3 slice 2: like [`run_sfcc_pipeline_partitioned`] (shared face map) but the leaves
/// are grouped by **Morton/Z-order** — spatially compact AND count-balanced — instead
/// of contiguous `(level,key)`-order index ranges. Mesh-equivalent to serial for any N
/// (CANONICAL, not byte-identical: spatial grouping reorders the cell-processing order,
/// hence the triangle buffer, but the point keys are global so the mesh is the same).
pub fn run_sfcc_pipeline_partitioned_morton(
    tree: &CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
    partitions: usize,
) -> SfccPipelineResult {
    let strategy = if partitions.max(1) <= 1 { MeshStrategy::Serial } else { MeshStrategy::SharedMorton(partitions) };
    run_sfcc_pipeline_impl(tree, cube, tuning, strategy, None)
}

/// #3 slice 2 over the slice-3 separate-table view: like
/// [`run_sfcc_pipeline_separate_partitioned`] but with **Morton/Z-order** leaf groups
/// — the spatially-compact, count-balanced partition shape the eventual JS Web Workers
/// (slice 5) will hand to each instance (compact groups minimize each worker's halo +
/// shared-boundary merge surface). Mesh-equivalent to serial for any N (canonical).
pub fn run_sfcc_pipeline_separate_partitioned_morton(
    tree: &CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
    partitions: usize,
) -> SfccPipelineResult {
    let strategy =
        if partitions.max(1) <= 1 { MeshStrategy::Serial } else { MeshStrategy::SeparateMorton(partitions) };
    run_sfcc_pipeline_impl(tree, cube, tuning, strategy, None)
}

/// One partial mesh's merge into the global point table is by GLOBAL provenance key:
/// `Num`/`Str` keys dedup boundary crossings + feature pins/corners contoured from
/// both sides; `Unkeyed` (cell-local) points are appended uniquely. Output is the
/// merged point table + cell-mesh result, fed into the same S4 as every strategy.
struct MergedSeparate {
    points: PointTable,
    cell_result: CellMeshResult,
    multi_run_faces: usize,
    boundary_violations: usize,
}

/// Mesh each leaf group into its own separate face map + point table, then merge the
/// partials by global provenance key (`PointTable::key_at`). The merged triangle
/// order equals the serial cell order (groups are contiguous and processed in order),
/// and merged ids are key-consistent, so the S4 cleanups downstream behave identically.
fn mesh_groups_separate(
    oct: &SfccOctree,
    tree: &CsgNode,
    fc_opts: &FaceContourOptions,
    cm_opts: &CellMeshOptions,
    groups: &[&[SfccCell]],
) -> MergedSeparate {
    let mut merged = PointTable::new();
    let mut tris: Vec<usize> = Vec::new();
    let mut failed_cells: Vec<SfccCell> = Vec::new();
    let mut fallback_cells: Vec<SfccCell> = Vec::new();
    let mut multi_loop_cells = 0usize;
    let mut edge_cells = 0usize;
    let mut corner_cells = 0usize;
    let mut feature_cell_fallbacks = 0usize;
    let mut multi_run_faces = 0usize;
    let mut boundary_violations = 0usize;

    for &group in groups {
        // Per-group separate state — mirrors one worker.
        let mut pt = PointTable::new();
        let mut fr = contour_subset_separate(oct, tree, &mut pt, fc_opts, group);
        let cm = mesh_cells_subset(oct, &mut fr.faces, tree, &mut pt, cm_opts, group);
        multi_run_faces += fr.multi_run_faces;
        boundary_violations += fr.boundary_violations;

        // Merge this partial into the global table by global provenance key.
        let n = pt.count();
        let mut local_to_global = vec![0usize; n];
        for id in 0..n {
            let (x, y, z) = (pt.x(id), pt.y(id), pt.z(id));
            let (nx, ny, nz) = (pt.nx(id), pt.ny(id), pt.nz(id));
            // Keyed points (boundary crossings, feature pins/corners, and the now
            // face-scoped-keyed repair/splice midpoints) dedup across partitions by
            // their GLOBAL key. Unkeyed points are cell-local (interior apex, feature
            // polyline samples) — each cell lives in one group, so they're appended
            // uniquely, exactly as the serial run keeps them distinct.
            let gid = match pt.key_at(id).clone() {
                PointKey::Num(k) => merged.get_or_create(k, || [x, y, z, nx, ny, nz]),
                PointKey::Str(s) => merged.get_or_create_str(&s, || [x, y, z, nx, ny, nz]),
                PointKey::Unkeyed => merged.add(x, y, z, nx, ny, nz),
            };
            local_to_global[id] = gid;
        }
        for &t in &cm.tris {
            tris.push(local_to_global[t]);
        }
        failed_cells.extend(cm.failed_cells);
        fallback_cells.extend(cm.fallback_cells);
        multi_loop_cells += cm.multi_loop_cells;
        edge_cells += cm.edge_cells;
        corner_cells += cm.corner_cells;
        feature_cell_fallbacks += cm.feature_cell_fallbacks;
    }

    MergedSeparate {
        points: merged,
        cell_result: CellMeshResult {
            tris,
            failed_cells,
            multi_loop_cells,
            edge_cells,
            corner_cells,
            feature_cell_fallbacks,
            fallback_cells,
        },
        multi_run_faces,
        boundary_violations,
    }
}

/// Split `[0, n)` into `k` contiguous index ranges, as even as possible (the first
/// `n % k` ranges get one extra element). The simplest spatial-partition leaf
/// grouping; [`partition_morton`] (slice 2) is the spatially-compact alternative.
fn partition_contiguous(n: usize, k: usize) -> Vec<std::ops::Range<usize>> {
    let k = k.max(1);
    let base = n / k;
    let rem = n % k;
    let mut ranges = Vec::with_capacity(k);
    let mut start = 0usize;
    for i in 0..k {
        let len = base + if i < rem { 1 } else { 0 };
        ranges.push(start..start + len);
        start += len;
    }
    ranges
}

/// Interleave three coords (each ≤ 42 bits, ample for any lattice depth) into a 126-bit
/// Morton (Z-order) code. Cells close in 3-space get close codes, so sorting by code
/// then chunking yields spatially-compact groups.
fn morton3(x: u64, y: u64, z: u64) -> u128 {
    fn spread(v: u64) -> u128 {
        let mut r: u128 = 0;
        let mut b = 0u32;
        while b < 42 {
            r |= (((v >> b) & 1) as u128) << (3 * b);
            b += 1;
        }
        r
    }
    spread(x) | (spread(y) << 1) | (spread(z) << 2)
}

/// Morton/Z-order leaf partition (#3 slice 2): group the octree leaves into `k`
/// balanced, SPATIALLY-COMPACT chunks (returned as leaf-index lists). Each leaf is
/// keyed by the Morton code of its min corner in max-depth lattice units (so a coarse
/// cell and the fine cells around it sort together, ACROSS levels — unlike the
/// `(level,key)`-ordered contiguous split, which groups whole levels), then the Morton
/// order is split into `k` equal-count chunks. Spatial compactness shrinks each group's
/// shared-boundary surface → smaller halo + cheaper merge; equal count load-balances
/// the eventual workers. Deterministic (Morton, then leaf-index tie-break).
///
/// Correctness is grouping-INDEPENDENT: every leaf is meshed and the by-key merge (or
/// the global shared face map) reconstructs the same mesh regardless of how leaves are
/// grouped, so this only affects load balance + halo size, never the output. (Deferred
/// refinement: balance by SURFACE-leaf count rather than all leaves — empty interior
/// leaves are near-free to mesh, so count-balance slightly over-weights them.)
fn partition_morton(oct: &SfccOctree, k: usize) -> Vec<Vec<usize>> {
    let n = oct.leaves.len();
    let code = |c: &SfccCell| -> u128 {
        // min corner in max-depth lattice units: ix * (1 << (max_depth - level)).
        let stride = stride_at_level(&oct.lat, c.level) as u64;
        morton3(c.ix as u64 * stride, c.iy as u64 * stride, c.iz as u64 * stride)
    };
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| code(&oct.leaves[a]).cmp(&code(&oct.leaves[b])).then(a.cmp(&b)));
    partition_contiguous(n, k).into_iter().map(|r| order[r].to_vec()).collect()
}

/// Public re-export of [`partition_morton`] for the cross-instance worker mesher
/// ([`crate::sfcc::worker::mesh_partition`]): the SAME Morton/Z-order leaf grouping
/// the in-process `SeparateMorton` strategy uses, so a worker meshing `group_index`
/// of `k` covers exactly one in-process group — the determinism this slice relies on.
pub fn morton_partition_indices(oct: &SfccOctree, k: usize) -> Vec<Vec<usize>> {
    partition_morton(oct, k)
}

/// [`partition_morton`] then materialize each index group as an owned `Vec<SfccCell>`
/// (Morton groups are non-contiguous, so they can't borrow a slice of `oct.leaves`).
/// `SfccCell` is `Copy` and tiny, so this is a cheap gather; the caller borrows these
/// as `&[&[SfccCell]]` for the shared- or separate-table meshers.
fn gather_morton_groups(oct: &SfccOctree, k: usize) -> Vec<Vec<SfccCell>> {
    partition_morton(oct, k)
        .into_iter()
        .map(|idxs| idxs.into_iter().map(|i| oct.leaves[i]).collect())
        .collect()
}

/// Accumulate `now() - *last` into `bucket` and advance `*last` to `now()`, but only
/// when a clock is injected. No-op (zero overhead, zero timing) when `now` is `None`.
fn phase_mark(now: Option<&dyn Fn() -> f64>, last: &mut Option<f64>, bucket: &mut f64) {
    if let Some(f) = now {
        let n = f();
        if let Some(l) = *last {
            *bucket += n - l;
        }
        *last = Some(n);
    }
}

fn run_sfcc_pipeline_impl(
    tree: &CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
    strategy: MeshStrategy,
    now: Option<&dyn Fn() -> f64>,
) -> SfccPipelineResult {
    // Phase wall-clock accumulators (populated only when `now` is Some).
    let mut ph_feature = 0.0f64;
    let mut ph_octree = 0.0f64;
    let mut ph_contour = 0.0f64;
    let mut ph_cellmesh = 0.0f64;
    let mut ph_assemble = 0.0f64;
    // Octree refine-loop decide/apply split (within `ph_octree`), summed over every
    // build (re-refine rounds concatenate). Populated only when `now` is Some.
    let mut ph_oct_decide = 0.0f64;
    let mut ph_oct_apply = 0.0f64;
    let mut oct_rounds: Vec<(usize, f64, f64)> = Vec::new();
    let mut ph_last: Option<f64> = now.map(|f| f());

    // The shared per-export context (lattice + feature set + split-decision
    // advisories). Identical to what the worker `prepare` builds — the DECISION
    // closure below delegates to `ctx.decide_cell`, the single source of truth.
    let ctx = build_pipeline_context(tree, cube, tuning);
    let lat = ctx.lat;
    let features = &ctx.features;
    let total_size = ctx.total_size;
    let max_depth = ctx.max_depth;

    // Forced-split markers accumulate across re-refine rounds.
    let mut forced: Vec<ForcedMarker> = Vec::new();

    let mut oct: SfccOctree;
    let mut points: PointTable;
    let mut face_result: FaceContourResult;
    let mut cell_result: CellMeshResult;
    let mut re_refine_rounds = 0u32;
    phase_mark(now, &mut ph_last, &mut ph_feature);
    let mut round = 0u32;
    loop {
        let forced_snapshot = forced.clone();
        let opts = OctreeBuildOptions {
            depth_min: tuning.depth_min,
            depth_max: max_depth,
            enforce_edge_balance: tuning.enforce_edge_balance,
        };
        // The full feature-aware needsSplit, mirroring runSfccPipeline. Delegates
        // to `ctx.decide_cell` — the SINGLE source of truth shared with the worker
        // `prepare` path so the expensive DECISION (classify + smoothCrit) can
        // never drift between serial and partitioned exports. Pure read over the
        // immutable feature set + the pre-populated sample cache, so the octree
        // driver runs it over the round's frontier in parallel (rayon, `threads`).
        let decide_cb =
            |cell: &SfccCell, sampler: &crate::sfcc::octree::SampleView<'_>| {
                ctx.decide_cell(cell, &|gx, gy, gz| sampler.sample_at(gx, gy, gz), &forced_snapshot)
            };
        oct = match now {
            // Profiled: time each round's decide vs apply, then fold the split in.
            Some(f) => build_octree_profiled(tree, &lat, opts, decide_cb, f),
            None => build_octree(tree, &lat, opts, decide_cb),
        };
        if let Some(p) = oct.profile.take() {
            ph_oct_decide += p.decide_ms;
            ph_oct_apply += p.apply_ms;
            oct_rounds.extend(p.rounds);
        }
        phase_mark(now, &mut ph_last, &mut ph_octree);
        points = PointTable::new();
        let root_tol = (tuning.edge_root_tol_fraction * lat.step).min(tuning.surface_tol_mm * 0.1);
        let fc_opts = FaceContourOptions { root_tol, features: Some(features), recovery_cull: tuning.recovery_cull };
        let cm_opts = CellMeshOptions {
            surface_tol: tuning.surface_tol_mm,
            interior_vertex_mode: tuning.interior_vertex_mode,
            project_max_iters: tuning.project_max_iters,
            curve_chord_tol: tuning.curve_chord_tol_mm,
            max_polyline_points_per_cell: tuning.max_polyline_points_per_cell,
            features: Some(features),
        };
        match &strategy {
            MeshStrategy::Serial => {
                face_result = contour_all_faces(&oct, tree, &mut points, &fc_opts);
                phase_mark(now, &mut ph_last, &mut ph_contour);
                cell_result = mesh_all_cells(&oct, &mut face_result.faces, tree, &mut points, &cm_opts);
                phase_mark(now, &mut ph_last, &mut ph_cellmesh);
            }
            MeshStrategy::Shared(n) => {
                // #3 slice 1: mesh the surface leaves in N contiguous groups, sharing
                // ONE face map + point table. Byte-identical to the serial path.
                let groups = partition_contiguous(oct.leaves.len(), *n);
                face_result = contour_faces_partitioned(&oct, tree, &mut points, &fc_opts, &groups);
                cell_result = mesh_cells_partitioned(&oct, &mut face_result.faces, tree, &mut points, &cm_opts, &groups);
            }
            MeshStrategy::Separate(n) => {
                // #3 slice 3: mesh each contiguous group into its OWN separate face map
                // + point table (the per-worker view, halo-aware), then merge by global
                // provenance key. `points` is replaced by the merged table; the empty
                // table created above is discarded. The face map is consumed inside the
                // merge, so the post-loop face audit has nothing to walk (it runs on the
                // shared/serial maps only) — the manifold check is the topology gate here.
                let ranges = partition_contiguous(oct.leaves.len(), *n);
                let leaf_groups: Vec<&[SfccCell]> = ranges.iter().map(|r| &oct.leaves[r.clone()]).collect();
                let merged = mesh_groups_separate(&oct, tree, &fc_opts, &cm_opts, &leaf_groups);
                points = merged.points;
                cell_result = merged.cell_result;
                face_result = FaceContourResult {
                    faces: [HashMap::new(), HashMap::new(), HashMap::new()],
                    multi_run_faces: merged.multi_run_faces,
                    boundary_violations: merged.boundary_violations,
                    key_collisions: 0,
                };
            }
            MeshStrategy::SharedMorton(n) => {
                // #3 slice 2: Morton/Z-order groups (spatially compact + count-balanced)
                // over the slice-1 shared face map. Same global keys → canonically equal
                // to serial; the group order (hence triangle buffer) reorders.
                let owned = gather_morton_groups(&oct, *n);
                let leaf_groups: Vec<&[SfccCell]> = owned.iter().map(|g| g.as_slice()).collect();
                face_result = contour_faces_for(&oct, tree, &mut points, &fc_opts, &leaf_groups);
                cell_result = mesh_cells_for(&oct, &mut face_result.faces, tree, &mut points, &cm_opts, &leaf_groups);
            }
            MeshStrategy::SeparateMorton(n) => {
                // #3 slice 2 over the slice-3 separate-table view: Morton/Z-order groups,
                // each meshed into its own table (the worker view), merged by global key.
                let owned = gather_morton_groups(&oct, *n);
                let leaf_groups: Vec<&[SfccCell]> = owned.iter().map(|g| g.as_slice()).collect();
                let merged = mesh_groups_separate(&oct, tree, &fc_opts, &cm_opts, &leaf_groups);
                points = merged.points;
                cell_result = merged.cell_result;
                face_result = FaceContourResult {
                    faces: [HashMap::new(), HashMap::new(), HashMap::new()],
                    multi_run_faces: merged.multi_run_faces,
                    boundary_violations: merged.boundary_violations,
                    key_collisions: 0,
                };
            }
        }
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
    let filtered = drop_debris_components(&points, &deduped1, lat.step * 4.0, features, lat.step * 2.0, 600);
    let deduped2 = drop_coincident_triangle_pairs(&filtered);
    let (flipped, _flips) = flip_sliver_triangles(&points, &deduped2, 4);

    let (verts, out_tris) = points.build_mesh(&flipped);
    let manifold = check_manifold(&out_tris, tuning.check_vertex_links);
    phase_mark(now, &mut ph_last, &mut ph_assemble);

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

    SfccPipelineResult {
        verts,
        tris: out_tris,
        stats,
        manifold,
        ok,
        phase_feature_ms: ph_feature,
        phase_octree_ms: ph_octree,
        phase_contour_ms: ph_contour,
        phase_cellmesh_ms: ph_cellmesh,
        phase_assemble_ms: ph_assemble,
        phase_octree_decide_ms: ph_oct_decide,
        phase_octree_apply_ms: ph_oct_apply,
        octree_rounds: oct_rounds,
    }
}

fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}
