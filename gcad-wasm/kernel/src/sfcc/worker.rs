//! Slice 5 / Stage A — the cargo-testable Rust boundary for cross-INSTANCE
//! (later: Web Worker) SFCC meshing.
//!
//! The faithful worker split is three phases, each a plain kernel function here
//! (so they unit-test natively) with a thin wasm wrapper in `gcad-wasm/wasm`:
//!
//!  * [`prepare`] — the serial ~60%: compile the feature set + build the tagged
//!    octree (the expensive per-cell DECISION: classify_cell_features + smoothCrit),
//!    using the SAME [`crate::sfcc::pipeline::build_pipeline_context`] /
//!    `decide_cell` the serial driver uses (no divergence), then serialize the
//!    tagged leaves + the lattice params to a byte buffer. Runs ONCE on the main
//!    thread; workers receive the result and must NOT redo the decision.
//!  * [`mesh_partition`] — one worker's share: reconstruct the octree from the
//!    tagged leaves (cheap — [`crate::sfcc::octree::rebuild_octree_from_leaves`]
//!    does NO decision work), Morton-partition the leaves with the EXACT ordering
//!    of the in-process `partition_morton`/`gather_morton_groups`, mesh ONLY
//!    `group_index` into its OWN face map + point table (`contour_subset_separate`
//!    + `mesh_cells_subset`, halo-aware), and serialize a partial mesh.
//!  * [`merge_partials`] — dedup points across partials by global [`PointKey`]
//!    (Num/Str/Unkeyed exactly as the in-process `mesh_groups_separate`), concat
//!    the remapped tris, then run the SAME S4 tail as the serial driver
//!    (coincident-pair drop → debris drop → coincident-pair drop → sliver flip →
//!    build_mesh → check_manifold).
//!
//! What each worker RECOMPUTES vs RECEIVES:
//!  * RECEIVES (from prepare, over the wire): the tagged leaf set + lattice params.
//!    This carries the result of the expensive octree DECISION; no worker re-runs
//!    classify/smoothCrit or the refine loop.
//!  * RECOMPUTES (per worker, locally): the `CsgNode` (from scene_json) and the
//!    feature set (`compile_feature_set`). Feature compilation is the cheap ~6%
//!    phase; recomputing it per worker is acceptable for slice 5 (it avoids
//!    serializing the curve/corner/strata graph). A future slice could serialize it.
//!
//! Wire format is a compact little-endian manual encoding (NOT serde), so these
//! functions stay in the dependency-free default kernel build. The serial pipeline
//! is untouched — these are additive.

use crate::math::grid::{cell_key, make_lattice, SfccLattice};
use crate::sdf::CsgNode;
use crate::sfcc::cell_mesh::{mesh_cells_subset, CellMeshOptions};
use crate::sfcc::face_contour::{contour_subset_separate, FaceContourOptions};
use crate::sfcc::feature_set::SfccFeatureSet;
use crate::sfcc::manifold_check::{check_manifold, ManifoldReport};
use crate::sfcc::octree::{rebuild_octree_from_leaves, CellDecision, ResumableOctreeBuild, SfccCell, SfccOctree};
use crate::sfcc::pipeline::{
    build_pipeline_context, drop_coincident_triangle_pairs, drop_debris_components, morton_partition_indices,
    PipelineTuning, SfccWorldCube,
};
use crate::sfcc::point_table::{PointKey, PointTable};
use crate::sfcc::sliver_flip::flip_sliver_triangles;
use std::cell::RefCell;

// ---------------------------------------------------------------------------
// Little-endian primitive readers/writers (no serde; dep-free default build).
// ---------------------------------------------------------------------------

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_i64(out: &mut Vec<u8>, v: i64) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_f64(out: &mut Vec<u8>, v: f64) {
    out.extend_from_slice(&v.to_le_bytes());
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }
    fn u32(&mut self) -> u32 {
        let v = u32::from_le_bytes(self.buf[self.pos..self.pos + 4].try_into().unwrap());
        self.pos += 4;
        v
    }
    fn u64(&mut self) -> u64 {
        let v = u64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
        self.pos += 8;
        v
    }
    fn i64(&mut self) -> i64 {
        let v = i64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
        self.pos += 8;
        v
    }
    fn f32(&mut self) -> f32 {
        let v = f32::from_le_bytes(self.buf[self.pos..self.pos + 4].try_into().unwrap());
        self.pos += 4;
        v
    }
    fn f64(&mut self) -> f64 {
        let v = f64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
        self.pos += 8;
        v
    }
    fn bytes(&mut self, n: usize) -> &'a [u8] {
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        s
    }
}

const LEAVES_MAGIC: u32 = 0x5346_4C45; // "SFLE"
const PARTIAL_MAGIC: u32 = 0x5346_5052; // "SFPR"

// ---------------------------------------------------------------------------
// Phase 1 — prepare: tagged octree → byte buffer.
// ---------------------------------------------------------------------------

/// The lattice the worker rebuilds the octree on. Serialized alongside the leaves
/// (origin/size/max_depth fully determine the lattice via [`make_lattice`]).
fn put_lattice(out: &mut Vec<u8>, lat: &SfccLattice) {
    put_u32(out, lat.max_depth);
    put_f64(out, lat.origin_x);
    put_f64(out, lat.origin_y);
    put_f64(out, lat.origin_z);
    put_f64(out, lat.world_size);
}

fn get_lattice(r: &mut Reader) -> SfccLattice {
    let max_depth = r.u32();
    let ox = r.f64();
    let oy = r.f64();
    let oz = r.f64();
    let world_size = r.f64();
    make_lattice(max_depth, ox, oy, oz, world_size)
}

/// Serialize one tagged leaf. `key` is NOT stored — it is a pure function of
/// (level, ix, iy, iz, lattice) and recomputed on rebuild. Per leaf: level (u32),
/// degenerate (u32 0/1), ix/iy/iz (i64), feature_curve (i64), feature_corner (i64).
fn put_leaf(out: &mut Vec<u8>, c: &SfccCell) {
    put_u32(out, c.level);
    put_u32(out, c.degenerate as u32);
    put_i64(out, c.ix);
    put_i64(out, c.iy);
    put_i64(out, c.iz);
    put_i64(out, c.feature_curve);
    put_i64(out, c.feature_corner);
}

fn get_leaf(r: &mut Reader, lat: &SfccLattice) -> SfccCell {
    let level = r.u32();
    let degenerate = r.u32() != 0;
    let ix = r.i64();
    let iy = r.i64();
    let iz = r.i64();
    let feature_curve = r.i64();
    let feature_corner = r.i64();
    let key = cell_key(lat, level, ix, iy, iz);
    SfccCell { level, ix, iy, iz, key, degenerate, feature_curve, feature_corner }
}

/// Serialize a tagged leaf set + its lattice to a compact byte buffer. The output
/// of [`prepare`] and the worker-facing payload. Layout:
///   magic u32 | lattice | leaf_count u64 | leaf*leaf_count
pub fn encode_tagged_leaves(lat: &SfccLattice, leaves: &[SfccCell]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 36 + leaves.len() * 44);
    put_u32(&mut out, LEAVES_MAGIC);
    put_lattice(&mut out, lat);
    put_u64(&mut out, leaves.len() as u64);
    for c in leaves {
        put_leaf(&mut out, c);
    }
    out
}

/// Inverse of [`encode_tagged_leaves`]: the lattice + the tagged leaf Vec.
pub fn decode_tagged_leaves(buf: &[u8]) -> (SfccLattice, Vec<SfccCell>) {
    let mut r = Reader::new(buf);
    let magic = r.u32();
    assert_eq!(magic, LEAVES_MAGIC, "worker: bad tagged-leaves buffer magic");
    let lat = get_lattice(&mut r);
    let n = r.u64() as usize;
    let mut leaves = Vec::with_capacity(n);
    for _ in 0..n {
        leaves.push(get_leaf(&mut r, &lat));
    }
    (lat, leaves)
}

/// Phase 1 (the serial ~60%): compile the feature set + build the tagged octree
/// (the expensive per-cell DECISION), via the SAME pipeline context the serial
/// driver uses, then serialize the tagged leaves + lattice. The returned buffer is
/// handed to every worker; it carries the DECISION result so no worker re-runs
/// classify/smoothCrit. Does NOT run the re-refine loop (round 0 only — the worker
/// path is the single-build separate-table mesher, matching the in-process
/// `run_sfcc_pipeline_separate_partitioned_morton` whose re-refine is exercised by
/// the serial driver; for slice 5 the forced-split markers are empty, as in the TS
/// round-0 needsSplit). Returns the encoded buffer.
pub fn prepare(tree: &CsgNode, cube: &SfccWorldCube, tuning: &PipelineTuning) -> Vec<u8> {
    let ctx = build_pipeline_context(tree, cube, tuning);
    let oct = ctx.build_tagged_octree(tuning);
    encode_tagged_leaves(&oct.lat, &oct.leaves)
}

/// Slice 5b stage B gate / reference: drive the RESUMABLE per-round octree build to
/// completion IN-PROCESS, deciding each round's frontier via the worker primitive
/// ([`crate::sfcc::pipeline::PipelineContext::decide_partition`] — the same un-cached
/// path a real worker uses). Returns the tagged leaves in the SAME
/// [`encode_tagged_leaves`] wire format as [`prepare`], and BYTE-IDENTICAL to it
/// (proven by `tests/octree_resumable.rs`). The JS per-round BSP orchestration (stage
/// B proper) is this exact loop with the in-process `decide_partition` replaced by a
/// scatter/gather over worker wasm instances — so this proves the round-by-round
/// build reconstructs the serial octree before any JS exists.
pub fn build_octree_resumable_inprocess(tree: &CsgNode, cube: &SfccWorldCube, tuning: &PipelineTuning) -> Vec<u8> {
    let ctx = build_pipeline_context(tree, cube, tuning);
    let oct = ctx.build_tagged_octree_resumable(tuning);
    encode_tagged_leaves(&oct.lat, &oct.leaves)
}

// ---------------------------------------------------------------------------
// Octree-DECISION worker primitive — decide a frontier slice.
// ---------------------------------------------------------------------------
// The gate (commit 3a9ba4d6) measured `decide_frontier` (classify + smoothCrit) at
// ~50% of total export and the serial apply+ripple at only ~10%. This primitive is
// the parallelizable half: given a round's frontier and a contiguous `[start,end)`
// slice, a worker (separate wasm instance) decides its slice independently; the main
// thread concatenates the slices' decisions and applies split+ripple. The decision is
// a pure per-cell function (no cross-cell reads, confluent), so the split is exact.

const DECISIONS_MAGIC: u32 = 0x5346_4443; // "SFDC"

/// Serialize a frontier's per-cell decisions. Layout: magic u32 | count u64 |
/// per decision: split (u8 0/1), feature_curve (i64), feature_corner (i64).
pub fn encode_decisions(decisions: &[CellDecision]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + decisions.len() * 17);
    put_u32(&mut out, DECISIONS_MAGIC);
    put_u64(&mut out, decisions.len() as u64);
    for d in decisions {
        out.push(d.split as u8);
        put_i64(&mut out, d.feature_curve);
        put_i64(&mut out, d.feature_corner);
    }
    out
}

/// Inverse of [`encode_decisions`].
pub fn decode_decisions(buf: &[u8]) -> Vec<CellDecision> {
    let mut r = Reader::new(buf);
    assert_eq!(r.u32(), DECISIONS_MAGIC, "worker: bad decisions buffer magic");
    let n = r.u64() as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let split = r.bytes(1)[0] != 0;
        let feature_curve = r.i64();
        let feature_corner = r.i64();
        out.push(CellDecision { split, feature_curve, feature_corner });
    }
    out
}

/// Decide cells `[start, end)` of a serialized frontier (the `encode_tagged_leaves`
/// wire format — input tags are ignored; the cells' level/ix/iy/iz are what matter).
/// Rebuilds the pipeline context (CsgNode from the caller, feature set recompiled —
/// the cheap ~6% phase, same as [`mesh_partition`]), then runs the pure per-cell
/// DECISION over the slice via `PipelineContext::decide_partition` (a direct,
/// un-cached sampler — bit-identical to the serial cached pass). Returns the encoded
/// decisions for the slice; concatenating disjoint slices reconstructs the whole
/// frontier's decisions exactly.
pub fn decide_partition_bytes(
    tree: &CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
    frontier_bytes: &[u8],
    start: usize,
    end: usize,
) -> Vec<u8> {
    let ctx = build_pipeline_context(tree, cube, tuning);
    let (_lat, frontier) = decode_tagged_leaves(frontier_bytes);
    let decisions = ctx.decide_partition(&frontier, start, end);
    encode_decisions(&decisions)
}

// ---------------------------------------------------------------------------
// Phase 2 — mesh_partition: one Morton group → partial mesh buffer.
// ---------------------------------------------------------------------------

/// A worker's partial mesh, serialized. Carries every point in the worker's own
/// point table (stride-8 f32 vertex + its global [`PointKey`]) and the triangle
/// index list (LOCAL ids into that point list), plus the per-group meshing counters
/// the merge sums for `ok`/stats. The merge dedups points across partials by key,
/// remaps tris, and runs the S4 tail — exactly the in-process `mesh_groups_separate`
/// loop body, decomposed across calls. Layout:
///   magic u32
///   point_count u64
///   per point: x,y,z, _pad, nx,ny,nz, _pad  (8 f32, stride-8)   ← matches MeshData
///   per point: key (tag u8 + payload)
///   tri_count u64 | tri*tri_count (u32 local ids)
///   counters: failed_cells u64, multi_loop_cells u64, edge_cells u64,
///             corner_cells u64, feature_cell_fallbacks u64, multi_run_faces u64,
///             boundary_violations u64
struct PartialCounters {
    failed_cells: u64,
    multi_loop_cells: u64,
    edge_cells: u64,
    corner_cells: u64,
    feature_cell_fallbacks: u64,
    multi_run_faces: u64,
    boundary_violations: u64,
}

fn put_key(out: &mut Vec<u8>, key: &PointKey) {
    match key {
        PointKey::Num(k) => {
            out.push(0u8);
            put_i64(out, *k);
        }
        PointKey::Str(s) => {
            out.push(1u8);
            let b = s.as_bytes();
            put_u64(out, b.len() as u64);
            out.extend_from_slice(b);
        }
        PointKey::Unkeyed => {
            out.push(2u8);
        }
    }
}

fn get_key(r: &mut Reader) -> PointKey {
    let tag = r.bytes(1)[0];
    match tag {
        0 => PointKey::Num(r.i64()),
        1 => {
            let n = r.u64() as usize;
            let s = std::str::from_utf8(r.bytes(n)).expect("worker: bad utf8 point key").to_string();
            PointKey::Str(s)
        }
        2 => PointKey::Unkeyed,
        _ => panic!("worker: bad point-key tag {tag}"),
    }
}

/// Serialize a worker partial: the point table (positions+normals+keys), the local
/// tri list, and the meshing counters.
fn encode_partial(pt: &PointTable, tris: &[usize], counters: &PartialCounters) -> Vec<u8> {
    let n = pt.count();
    let mut out = Vec::with_capacity(16 + n * (32 + 9) + tris.len() * 4 + 64);
    put_u32(&mut out, PARTIAL_MAGIC);
    put_u64(&mut out, n as u64);
    // Stride-8 f32 vertices (pos, pad, normal, pad) — the MeshData vertex layout.
    for id in 0..n {
        put_f32(&mut out, pt.x(id) as f32);
        put_f32(&mut out, pt.y(id) as f32);
        put_f32(&mut out, pt.z(id) as f32);
        put_f32(&mut out, 0.0);
        put_f32(&mut out, pt.nx(id) as f32);
        put_f32(&mut out, pt.ny(id) as f32);
        put_f32(&mut out, pt.nz(id) as f32);
        put_f32(&mut out, 0.0);
    }
    for id in 0..n {
        put_key(&mut out, pt.key_at(id));
    }
    put_u64(&mut out, tris.len() as u64);
    for &t in tris {
        put_u32(&mut out, t as u32);
    }
    put_u64(&mut out, counters.failed_cells);
    put_u64(&mut out, counters.multi_loop_cells);
    put_u64(&mut out, counters.edge_cells);
    put_u64(&mut out, counters.corner_cells);
    put_u64(&mut out, counters.feature_cell_fallbacks);
    put_u64(&mut out, counters.multi_run_faces);
    put_u64(&mut out, counters.boundary_violations);
    out
}

/// A decoded partial: stride-8 f32 verts, parallel keys, local tris, counters.
struct DecodedPartial {
    verts: Vec<f32>, // stride-8
    keys: Vec<PointKey>,
    tris: Vec<u32>,
    counters: PartialCounters,
}

fn decode_partial(buf: &[u8]) -> DecodedPartial {
    let mut r = Reader::new(buf);
    let magic = r.u32();
    assert_eq!(magic, PARTIAL_MAGIC, "worker: bad partial buffer magic");
    let n = r.u64() as usize;
    let mut verts = Vec::with_capacity(n * 8);
    for _ in 0..n * 8 {
        verts.push(r.f32());
    }
    let mut keys = Vec::with_capacity(n);
    for _ in 0..n {
        keys.push(get_key(&mut r));
    }
    let tn = r.u64() as usize;
    let mut tris = Vec::with_capacity(tn);
    for _ in 0..tn {
        tris.push(r.u32());
    }
    let counters = PartialCounters {
        failed_cells: r.u64(),
        multi_loop_cells: r.u64(),
        edge_cells: r.u64(),
        corner_cells: r.u64(),
        feature_cell_fallbacks: r.u64(),
        multi_run_faces: r.u64(),
        boundary_violations: r.u64(),
    };
    DecodedPartial { verts, keys, tris, counters }
}

/// Build the face-contour + cell-mesh options exactly as the serial driver's S2/S3
/// step (same `root_tol`, `recovery_cull`, interior mode, etc.).
fn mesh_opts<'a>(
    lat: &SfccLattice,
    tuning: &PipelineTuning,
    features: &'a SfccFeatureSet,
) -> (FaceContourOptions<'a>, CellMeshOptions<'a>) {
    let root_tol = (tuning.edge_root_tol_fraction * lat.step).min(tuning.surface_tol_mm * 0.1);
    let fc = FaceContourOptions { root_tol, features: Some(features), recovery_cull: tuning.recovery_cull };
    let cm = CellMeshOptions {
        surface_tol: tuning.surface_tol_mm,
        interior_vertex_mode: tuning.interior_vertex_mode,
        project_max_iters: tuning.project_max_iters,
        curve_chord_tol: tuning.curve_chord_tol_mm,
        max_polyline_points_per_cell: tuning.max_polyline_points_per_cell,
        features: Some(features),
    };
    (fc, cm)
}

/// Mesh ONE Morton group into its own face map + point table, returning the serialized
/// partial. The worker RECOMPUTES the `CsgNode` (caller passes it, parsed from scene_json)
/// and the feature set (`compile_feature_set` inside `build_pipeline_context`), then
/// reconstructs the octree from the tagged leaves (no decision work) and partitions the
/// leaves with the SAME Morton ordering as the in-process `partition_morton`. Only
/// `group_index` of `group_count` is meshed — exactly one iteration of the in-process
/// `mesh_groups_separate` loop.
pub fn mesh_partition(
    tree: &CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
    leaves_bytes: &[u8],
    group_index: usize,
    group_count: usize,
) -> Vec<u8> {
    assert!(group_index < group_count.max(1), "worker: group_index {group_index} >= group_count {group_count}");
    // Recompute the feature set (cheap ~6% phase) — same context as serial/prepare,
    // so curve/corner/strata ids line up with the tags baked into the leaves.
    let ctx = build_pipeline_context(tree, cube, tuning);
    let features = &ctx.features;
    let (lat, leaves) = decode_tagged_leaves(leaves_bytes);

    // Reconstruct a usable octree from the tagged leaves (cheap — re-derives the
    // lookup maps + re-seeds the corner-sample cache, NO decision work).
    let oct: SfccOctree = rebuild_octree_from_leaves(tree, &lat, leaves);

    // Morton-partition with the EXACT ordering of the in-process partition_morton,
    // then gather THIS group's leaves (Copy + tiny).
    let groups = morton_partition_indices(&oct, group_count.max(1));
    let my_idxs = &groups[group_index];
    let group: Vec<SfccCell> = my_idxs.iter().map(|&i| oct.leaves[i]).collect();

    // Mesh into THIS partial's own face map + point table (halo-aware) — one
    // iteration of mesh_groups_separate.
    let (fc_opts, cm_opts) = mesh_opts(&lat, tuning, features);
    let mut pt = PointTable::new();
    let mut fr = contour_subset_separate(&oct, tree, &mut pt, &fc_opts, &group);
    let cm = mesh_cells_subset(&oct, &mut fr.faces, tree, &mut pt, &cm_opts, &group);

    let counters = PartialCounters {
        failed_cells: cm.failed_cells.len() as u64,
        multi_loop_cells: cm.multi_loop_cells as u64,
        edge_cells: cm.edge_cells as u64,
        corner_cells: cm.corner_cells as u64,
        feature_cell_fallbacks: cm.feature_cell_fallbacks as u64,
        multi_run_faces: fr.multi_run_faces as u64,
        boundary_violations: fr.boundary_violations as u64,
    };
    encode_partial(&pt, &cm.tris, &counters)
}

// ---------------------------------------------------------------------------
// Phase 3 — merge: partials → final mesh.
// ---------------------------------------------------------------------------

/// The merged-mesh result the wasm wrapper exposes (mirrors `SfccExportResult`).
pub struct MergedMesh {
    pub verts: Vec<f32>,
    pub tris: Vec<u32>,
    pub manifold: ManifoldReport,
    pub ok: bool,
    pub failed_cells: usize,
    pub boundary_violations: usize,
    pub multi_run_faces: usize,
    pub multi_loop_cells: usize,
    pub edge_cells: usize,
    pub corner_cells: usize,
    pub feature_cell_fallbacks: usize,
    pub cross_points: usize,
    pub feature_curves: usize,
}

/// Phase 3 convenience entry: rebuild the feature set + lattice from the same
/// scene_json/tuning/cube the prepare step used (the wasm wrapper has these), then
/// [`merge_partials`]. Feature compilation is recomputed once here (cheap ~6%);
/// only the debris-drop feature-hugging test reads it. The lattice is taken from the
/// rebuilt context (identical to the one serialized into the leaf buffer).
pub fn merge(tree: &CsgNode, cube: &SfccWorldCube, tuning: &PipelineTuning, partials: &[Vec<u8>]) -> MergedMesh {
    let ctx = build_pipeline_context(tree, cube, tuning);
    merge_partials(&ctx.features, &ctx.lat, tuning.check_vertex_links, partials)
}

/// Merge the worker partials into one mesh. Dedups points across partials by global
/// [`PointKey`] (Num/Str dedup boundary crossings + feature pins/corners contoured
/// from both sides; Unkeyed cell-local points are appended uniquely) — EXACTLY the
/// in-process `mesh_groups_separate` merge — then concats the remapped tris and runs
/// the SAME S4 tail as `run_sfcc_pipeline_impl` (coincident-pair drop → debris drop
/// → coincident-pair drop → sliver flip → build_mesh → check_manifold).
///
/// Needs `features` (debris drop's feature-hugging tube test) + `lat.step` (debris
/// thresholds) + `check_vertex_links` — the wasm wrapper rebuilds those from the same
/// scene_json/tuning/cube the prepare step used (see [`merge`]).
pub fn merge_partials(
    features: &SfccFeatureSet,
    lat: &SfccLattice,
    check_vertex_links: bool,
    partials: &[Vec<u8>],
) -> MergedMesh {
    let mut merged = PointTable::new();
    let mut tris: Vec<usize> = Vec::new();
    let mut failed_cells = 0usize;
    let mut multi_loop_cells = 0usize;
    let mut edge_cells = 0usize;
    let mut corner_cells = 0usize;
    let mut feature_cell_fallbacks = 0usize;
    let mut multi_run_faces = 0usize;
    let mut boundary_violations = 0usize;

    for buf in partials {
        let p = decode_partial(buf);
        let n = p.keys.len();
        let mut local_to_global = vec![0usize; n];
        for id in 0..n {
            let o = id * 8;
            let x = p.verts[o] as f64;
            let y = p.verts[o + 1] as f64;
            let z = p.verts[o + 2] as f64;
            let nx = p.verts[o + 4] as f64;
            let ny = p.verts[o + 5] as f64;
            let nz = p.verts[o + 6] as f64;
            let gid = match &p.keys[id] {
                PointKey::Num(k) => merged.get_or_create(*k, || [x, y, z, nx, ny, nz]),
                PointKey::Str(s) => merged.get_or_create_str(s, || [x, y, z, nx, ny, nz]),
                PointKey::Unkeyed => merged.add(x, y, z, nx, ny, nz),
            };
            local_to_global[id] = gid;
        }
        for &t in &p.tris {
            tris.push(local_to_global[t as usize]);
        }
        failed_cells += p.counters.failed_cells as usize;
        multi_loop_cells += p.counters.multi_loop_cells as usize;
        edge_cells += p.counters.edge_cells as usize;
        corner_cells += p.counters.corner_cells as usize;
        feature_cell_fallbacks += p.counters.feature_cell_fallbacks as usize;
        multi_run_faces += p.counters.multi_run_faces as usize;
        boundary_violations += p.counters.boundary_violations as usize;
    }

    // S4 cleanups — same call order/args as the serial driver.
    let deduped1 = drop_coincident_triangle_pairs(&tris);
    let filtered = drop_debris_components(&merged, &deduped1, lat.step * 4.0, features, lat.step * 2.0, 600);
    let deduped2 = drop_coincident_triangle_pairs(&filtered);
    let (flipped, _flips) = flip_sliver_triangles(&merged, &deduped2, 4);

    let (verts, out_tris) = merged.build_mesh(&flipped);
    let manifold = check_manifold(&out_tris, check_vertex_links);

    // The separate-table path has no shared face map to audit (face_audit_failures
    // is 0, as in run_sfcc_pipeline's Separate strategy); `ok` mirrors the driver.
    let ok = manifold.ok && failed_cells == 0 && boundary_violations == 0;

    MergedMesh {
        verts,
        tris: out_tris,
        manifold,
        ok,
        failed_cells,
        boundary_violations,
        multi_run_faces,
        multi_loop_cells,
        edge_cells,
        corner_cells,
        feature_cell_fallbacks,
        cross_points: merged.count(),
        feature_curves: features.curves.len(),
    }
}

// ---------------------------------------------------------------------------
// Slice 5b stage B2a — resumable octree-DECISION session (wasm-holdable).
// ---------------------------------------------------------------------------
// A single-slot, thread-local session holding the BORROW-FREE
// `ResumableOctreeBuild` + the owned `CsgNode` + lattice ACROSS JS worker
// round-trips — the wasm-side state the per-round BSP loop (stage B2b) drives:
//   octree_session_begin → loop { current_frontier → (workers decide via
//   `sfcc_decide_partition`) → apply_decisions until done } → finish → leaves → mesh.
// The expensive DECISION runs worker-side; the main thread only begins, applies
// split+ripple, and finishes. Byte-identical to serial `prepare` (the same tagged
// leaves), proven by `tests/octree_session.rs`. Thread-local so it's sound under
// cargo's per-test threads and the single-threaded wasm main thread alike; `begin`
// overwrites any prior slot, so a panicked/abandoned session can't poison the next.

struct OctreeSession {
    tree: CsgNode,
    lat: SfccLattice,
    build: ResumableOctreeBuild,
}

thread_local! {
    static OCTREE_SESSION: RefCell<Option<OctreeSession>> = const { RefCell::new(None) };
}

/// Begin a resumable octree-decision session: build the pipeline context (compile
/// features + lattice — identical to `prepare`/serial), begin the borrow-free
/// resumable build (descend to depth_min + snapshot round 0's frontier), and store it
/// with the OWNED tree + lattice in the thread-local single slot (overwriting any
/// prior session). The first frontier is then available via [`octree_session_current_frontier`].
pub fn octree_session_begin(tree: CsgNode, cube: &SfccWorldCube, tuning: &PipelineTuning) {
    // Build the context transiently (borrows `&tree`) to derive the lattice + opts and
    // begin the borrow-free build; both outputs are owned/Copy, so the `&tree` borrow
    // is released before `tree` is moved into the session.
    let (lat, build) = {
        let ctx = build_pipeline_context(&tree, cube, tuning);
        (ctx.lat, ctx.begin_resumable_octree(tuning))
    };
    OCTREE_SESSION.with(|s| *s.borrow_mut() = Some(OctreeSession { tree, lat, build }));
}

/// The current round's frontier — the cells to DECIDE — in the [`encode_tagged_leaves`]
/// wire format (the same `sfcc_decide_partition` consumes). An empty leaf set means the
/// build is complete (mirrors [`octree_session_apply_decisions`] returning `done`).
pub fn octree_session_current_frontier() -> Vec<u8> {
    OCTREE_SESSION.with(|s| {
        let g = s.borrow();
        let session = g.as_ref().expect("octree session: current_frontier with no active session");
        encode_tagged_leaves(&session.lat, session.build.current_frontier())
    })
}

/// Apply the current frontier's decisions (one per current-frontier cell, in order —
/// the [`encode_decisions`] wire format the workers produce): stamp tags + split +
/// 2:1-balance ripple on the main thread, then advance to the next round. Returns
/// `true` when the build is complete (no further rounds → call [`octree_session_finish`]).
pub fn octree_session_apply_decisions(decisions_bytes: &[u8]) -> bool {
    let decisions = decode_decisions(decisions_bytes);
    OCTREE_SESSION.with(|s| {
        let mut g = s.borrow_mut();
        let session = g.as_mut().expect("octree session: apply_decisions with no active session");
        // Disjoint field borrows: &mut build + &tree.
        session.build.apply_decisions(&session.tree, &decisions);
        session.build.is_done()
    })
}

/// Finish the session: assemble the tagged octree and return its leaves in the
/// [`encode_tagged_leaves`] wire format — identical to [`prepare`]'s output, fed to the
/// mesh phase. Consumes the session (the slot is left empty).
pub fn octree_session_finish() -> Vec<u8> {
    OCTREE_SESSION.with(|s| {
        let session = s.borrow_mut().take().expect("octree session: finish with no active session");
        let OctreeSession { tree, lat, build } = session;
        // `tree`/`lat` are locals here; the borrowed `SfccOctree` is consumed by the
        // encode before they drop at end of scope.
        let oct = build.finish(&tree, &lat);
        encode_tagged_leaves(&oct.lat, &oct.leaves)
    })
}
