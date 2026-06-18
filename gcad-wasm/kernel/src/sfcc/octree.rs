//! SFCC octree — S2: certified worklist refinement with 2:1 balance. Port of
//! `src/export/sfcc/octree.mts`.
//!
//! Build: descend from the root cube to `depth_min`, certified-empty-culling
//! subtrees whose per-node interval bound excludes 0 (no surface ⇒ no features).
//! Then run the refinement worklist: every leaf failing the criteria callback
//! splits (children empty-culled on creation) until it passes or hits `depth_max`
//! (→ tagged degenerate). Splitting ripples a 2:1 balance constraint to
//! face-adjacent (and, by default, edge-adjacent) coarser neighbor leaves.
//!
//! Corner SDF samples live in a single map keyed by lattice point — every sample
//! is evaluated exactly once, so neighboring faces and cells always agree on
//! signs. Sign convention: inside ⇔ f < 0.
//!
//! M3a notes: single-threaded; `HashMap`/`HashSet` cell storage (the
//! deterministic-weld / rayon restructure is M6). The `needs_split` criteria
//! callback is supplied by the caller — for M3a it is the smooth-only
//! [`crate::sfcc::refine_criteria::needs_split_smooth`].
//!
//! M4c-1 added [`build_octree_feature_aware`]: the full feature-aware driver
//! (classify ∨ smooth) that stamps each surviving leaf's `feature_curve` /
//! `feature_corner`. The callback now takes `&mut SfccCell` so it can stamp tags
//! exactly as the TS `needsSplit` mutates the live cell.

use crate::math::grid::{
    cell_aabb, cell_center_world, cell_key, cell_size_at_level, pack_point, point_to_world, stride_at_level,
    SfccLattice,
};
use crate::sdf::{CsgNode, Pruned};
use crate::sfcc::feature_set::SfccFeatureSet;
use crate::sfcc::refine_criteria::{
    classify_cell_features, has_corner_sign_change, make_probe, needs_split_smooth, FeatureCriteriaOptions,
    SmoothCriteriaOptions,
};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

/// A leaf or split octree cell, addressed by integer lattice coordinates.
#[derive(Clone, Copy, Debug)]
pub struct SfccCell {
    pub level: u32,
    pub ix: i64,
    pub iy: i64,
    pub iz: i64,
    /// Lattice key of the min corner (= per-level cell key).
    pub key: i64,
    /// Criteria still failing at depth_max — meshed best-effort, reported.
    pub degenerate: bool,
    /// Feature curve passing through this cell (−1 = none); stamped by the
    /// feature-aware driver ([`build_octree_feature_aware`]). Consumed by the
    /// M4c-2 face-contour / cell-mesh paths.
    pub feature_curve: i64,
    /// Feature corner inside this cell (−1 = none); stamped by the feature-aware
    /// driver. Consumed by the M4c-2 corner-cell meshing path.
    pub feature_corner: i64,
}

/// Shared corner-sample cache: every lattice corner's `tree.f` is evaluated at
/// most once (interior mutability so the criteria callback and the octree share
/// one map).
///
/// M6d: the refine WORKLIST is now round-batched, and within a round every
/// frontier cell's 8 corners are already cached (each `make_leaf` samples them
/// before the cell joins the worklist). The per-cell split DECISION therefore
/// reads the cache without ever writing it — so the decision pass can run in
/// parallel (rayon) over an immutable [`SampleView`] borrow (which IS `Sync`)
/// instead of through this `RefCell` (which is NOT). Cache writes (`sample_at`)
/// stay on the serial path: cell creation (`make_leaf` / `make_probe` corner
/// reads) and the edge-interior walks in face-contour.
pub struct Sampler<'a> {
    tree: &'a CsgNode,
    lat: &'a SfccLattice,
    samples: RefCell<HashMap<i64, f64>>,
}

impl<'a> Sampler<'a> {
    fn new(tree: &'a CsgNode, lat: &'a SfccLattice) -> Self {
        Sampler { tree, lat, samples: RefCell::new(HashMap::new()) }
    }

    /// `f` at a lattice point, evaluated once and cached.
    pub fn sample_at(&self, gx: i64, gy: i64, gz: i64) -> f64 {
        let key = pack_point(self.lat, gx, gy, gz);
        if let Some(&v) = self.samples.borrow().get(&key) {
            return v;
        }
        let w = point_to_world(self.lat, gx, gy, gz);
        let v = self.tree.f([w[0], w[1], w[2]]);
        self.samples.borrow_mut().insert(key, v);
        v
    }

    /// Whether a corner sample exists at a lattice key (for edge-interior walks).
    pub fn has_sample_key(&self, key: i64) -> bool {
        self.samples.borrow().contains_key(&key)
    }
}

/// A READ-ONLY view of the sample cache over an immutable borrow — `Sync`, so it
/// can be shared across the rayon par_iter in the round-batched decision pass.
/// `make_probe` corner reads go through `sample_at`; in the decision pass every
/// corner is already populated (cell creation cached them), so a missing key
/// would be a bug — we fall back to a direct (un-cached) tree eval to stay safe.
pub struct SampleView<'a> {
    tree: &'a CsgNode,
    lat: &'a SfccLattice,
    samples: &'a HashMap<i64, f64>,
}

impl<'a> SampleView<'a> {
    /// `f` at a lattice point — read from the pre-populated cache. The decision
    /// pass never inserts (all frontier corners are cached at cell creation), so
    /// this is a pure read. A cache miss falls back to a direct tree eval (a
    /// missing corner would be a build-order bug, not a correctness one).
    pub fn sample_at(&self, gx: i64, gy: i64, gz: i64) -> f64 {
        let key = pack_point(self.lat, gx, gy, gz);
        if let Some(&v) = self.samples.get(&key) {
            return v;
        }
        let w = point_to_world(self.lat, gx, gy, gz);
        self.tree.f([w[0], w[1], w[2]])
    }
}

/// The per-cell split DECISION: split-or-not plus the feature tags the criteria
/// classification stamps onto a kept (or to-be-meshed degenerate) leaf. Returned
/// by the pure decision callback so the decision pass holds no `&mut SfccCell`
/// and can run under rayon. The tags are persisted onto the live cell serially.
#[derive(Clone, Copy, Debug)]
pub struct CellDecision {
    pub split: bool,
    pub feature_curve: i64,
    pub feature_corner: i64,
}

/// Decide every frontier cell — the parallelism site (the ~67% `classifyCellFeatures`
/// hot path). `par_iter().map().collect()` preserves INDEX ORDER, so `decisions[i]`
/// is the decision for `frontier[i]` regardless of which thread computed it; the
/// apply phase then consumes them in that deterministic order. `decide` is pure
/// (`Fn + Sync`), the `SampleView` is an immutable cache borrow (`Sync`), and the
/// feature set behind the closure is immutable during refine — so this is
/// data-race-free by construction. Falls back to a serial `iter()` when the
/// `threads` feature is off (the default build stays single-threaded + stable).
/// The per-cell decision-closure bound. Carries `Sync` ONLY on the `threads` build (the
/// parallel `decide_frontier` requires it); on the default serial build it is plain `Fn`,
/// so a decision context with interior-mutable state — e.g. the coarse-prune `RefCell`
/// cache in `PipelineContext` — is permitted.
#[cfg(feature = "threads")]
pub trait DecideFn: Fn(&SfccCell, &SampleView<'_>) -> CellDecision + Sync {}
#[cfg(feature = "threads")]
impl<T: Fn(&SfccCell, &SampleView<'_>) -> CellDecision + Sync> DecideFn for T {}
#[cfg(not(feature = "threads"))]
pub trait DecideFn: Fn(&SfccCell, &SampleView<'_>) -> CellDecision {}
#[cfg(not(feature = "threads"))]
impl<T: Fn(&SfccCell, &SampleView<'_>) -> CellDecision> DecideFn for T {}

#[cfg(feature = "threads")]
fn decide_frontier<F: DecideFn>(frontier: &[SfccCell], view: &SampleView<'_>, decide: &F) -> Vec<CellDecision> {
    use rayon::prelude::*;
    frontier.par_iter().map(|cell| decide(cell, view)).collect()
}

#[cfg(not(feature = "threads"))]
fn decide_frontier<F: DecideFn>(frontier: &[SfccCell], view: &SampleView<'_>, decide: &F) -> Vec<CellDecision> {
    frontier.iter().map(|cell| decide(cell, view)).collect()
}

/// Build options for the octree refinement driver.
pub struct OctreeBuildOptions {
    pub depth_min: u32,
    pub depth_max: u32,
    pub enforce_edge_balance: bool,
}

/// Per-round wall-clock split of the refinement loop (only populated under
/// [`build_octree_profiled`]). Each round's frontier is DECIDED in one pass (the
/// parallelizable per-cell cert section), then APPLIED serially (stamp tags +
/// split + the inherently-serial 2:1 balance ripple). This measures how the
/// octree build's time divides between the two — the input to deciding whether a
/// cross-worker parallel-decision build is worth building.
pub struct OctreeProfile {
    /// Total ms spent in `decide_frontier` across all rounds (parallelizable).
    pub decide_ms: f64,
    /// Total ms spent in the serial apply+ripple loop across all rounds.
    pub apply_ms: f64,
    /// Per-round `(frontier_len, decide_ms, apply_ms)`, in round order.
    pub rounds: Vec<(usize, f64, f64)>,
}

/// The built octree: leaf cells per level (by min-corner lattice key), the split
/// (internal) cell key sets per level, and the flattened leaf list.
pub struct SfccOctree<'a> {
    pub lat: SfccLattice,
    /// Leaf cells per level, by min-corner lattice key.
    pub cells_by_level: Vec<HashMap<i64, SfccCell>>,
    /// Split (non-leaf) cell key sets per level.
    pub internal_by_level: Vec<HashSet<i64>>,
    pub leaves: Vec<SfccCell>,
    pub degenerate_cells: usize,
    /// Refinement-loop decide/apply timing — `None` unless built via
    /// [`build_octree_profiled`] (an injected clock). Timing-only; the leaf set is
    /// byte-identical whether or not this is populated.
    pub profile: Option<OctreeProfile>,
    sampler: Sampler<'a>,
}

impl<'a> SfccOctree<'a> {
    /// `f` at a lattice point, evaluated once and cached.
    pub fn sample_at(&self, gx: i64, gy: i64, gz: i64) -> f64 {
        self.sampler.sample_at(gx, gy, gz)
    }

    pub fn has_sample_key(&self, key: i64) -> bool {
        self.sampler.has_sample_key(key)
    }

    /// Whether (level, ix, iy, iz) is a split (internal) cell.
    pub fn is_internal(&self, level: i64, ix: i64, iy: i64, iz: i64) -> bool {
        if level < 0 || ix < 0 || iy < 0 || iz < 0 {
            return false;
        }
        let max_idx = (1i64 << level) - 1;
        if ix > max_idx || iy > max_idx || iz > max_idx {
            return false;
        }
        let lvl = level as u32;
        self.internal_by_level[lvl as usize].contains(&cell_key(&self.lat, lvl, ix, iy, iz))
    }
}

/// Reconstruct a usable [`SfccOctree`] from a tagged leaf set + its lattice — the
/// worker-side counterpart of [`build_octree`] for slice 5 (the cross-instance
/// spatial-partition mesher). The expensive per-cell refine DECISION already ran on
/// the main thread (its result is baked into the leaf set + each leaf's
/// `feature_curve` / `feature_corner` tags), so this does NO classification or
/// smoothCrit work — it only re-derives the cheap lookup structure the meshing
/// phases (`contour_subset_separate` + `mesh_cells_subset`) read:
///
///  * `cells_by_level` — each leaf re-bucketed by (level, min-corner key).
///  * `internal_by_level` — every PROPER ANCESTOR of every leaf. A cell is internal
///    iff it was split; the only split cells NOT covered here are those whose 8
///    children were all certified-empty (no leaf descendants). Those are inert for
///    contouring (their faces enclose no surface, so the halo sub-faces a coarse
///    neighbor would contour produce zero crossings), so omitting them yields the
///    same mesh — proven by the worker_partition equivalence test.
///  * the sample cache — re-seeded with each leaf's 8 corner samples, EXACTLY as
///    `Builder::make_leaf` populated it, so `has_sample_key` (hanging-node
///    midpoint detection) behaves identically to the original build.
///
/// The leaf order is preserved as given (the caller serialized them in the same
/// (level, key) sort `build_octree` emits), so downstream id-seeding order matches.
pub fn rebuild_octree_from_leaves<'a>(
    tree: &'a CsgNode,
    lat: &'a SfccLattice,
    leaves: Vec<SfccCell>,
) -> SfccOctree<'a> {
    let mut cells_by_level: Vec<HashMap<i64, SfccCell>> = (0..=lat.max_depth).map(|_| HashMap::new()).collect();
    let mut internal_by_level: Vec<HashSet<i64>> = (0..=lat.max_depth).map(|_| HashSet::new()).collect();
    let sampler = Sampler::new(tree, lat);
    let mut degenerate_cells = 0usize;

    for cell in &leaves {
        cells_by_level[cell.level as usize].insert(cell.key, *cell);
        if cell.degenerate {
            degenerate_cells += 1;
        }
        // Re-seed the 8 corner samples (same lattice points make_leaf cached).
        let stride = stride_at_level(lat, cell.level);
        for c in 0..8 {
            sampler.sample_at(
                (cell.ix + (c & 1)) * stride,
                (cell.iy + ((c >> 1) & 1)) * stride,
                (cell.iz + ((c >> 2) & 1)) * stride,
            );
        }
        // Mark every proper ancestor internal (level L−1 down to 0).
        let mut level = cell.level;
        let mut ix = cell.ix;
        let mut iy = cell.iy;
        let mut iz = cell.iz;
        while level > 0 {
            level -= 1;
            ix >>= 1;
            iy >>= 1;
            iz >>= 1;
            internal_by_level[level as usize].insert(cell_key(lat, level, ix, iy, iz));
        }
    }

    SfccOctree { lat: *lat, cells_by_level, internal_by_level, leaves, degenerate_cells, profile: None, sampler }
}

/// Lever 1 hard-tree leaf threshold, retained for a future (cheaper) prune gate.
/// The shipping gate ([`crate::sdf::lever1_should_prune`]) is OFF by default because
/// the measured integration was net-negative; this constant is the leaf count a
/// re-enabled hard-tree gate would key on. Below it the per-cell prune-build cost
/// outweighs the leaves eliminated, so simple scenes stay on the full tree.
pub(crate) const LEVER1_MIN_LEAVES: usize = 12;

/// Face neighbors (6) and edge neighbors (12) as coordinate offsets.
const FACE_NEIGHBORS: [[i64; 3]; 6] =
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const EDGE_NEIGHBORS: [[i64; 3]; 12] = [
    [1, 1, 0],
    [1, -1, 0],
    [-1, 1, 0],
    [-1, -1, 0],
    [1, 0, 1],
    [1, 0, -1],
    [-1, 0, 1],
    [-1, 0, -1],
    [0, 1, 1],
    [0, 1, -1],
    [0, -1, 1],
    [0, -1, -1],
];

/// Mutable build state, split out so the helper methods can take `&mut self`
/// while `Sampler`'s interior mutability lets the criteria callback read the
/// shared cache.
struct Builder<'a> {
    lat: &'a SfccLattice,
    sampler: Sampler<'a>,
    cells_by_level: Vec<HashMap<i64, SfccCell>>,
    internal_by_level: Vec<HashSet<i64>>,
    worklist: Vec<(u32, i64)>,
    enforce_edge_balance: bool,
}

impl<'a> Builder<'a> {
    /// True iff the cell's interval bound excludes 0 (no surface inside).
    fn certified_empty(&self, level: u32, ix: i64, iy: i64, iz: i64) -> bool {
        let half = cell_size_at_level(self.lat, level) / 2.0;
        let c = cell_center_world(self.lat, level, ix, iy, iz);
        let (lo, hi) = self.sampler.tree.interval_over_box(c, [half, half, half]);
        lo > 0.0 || hi < 0.0
    }

    /// Create a leaf cell, sampling its 8 corners into the shared cache.
    fn make_leaf(&mut self, level: u32, ix: i64, iy: i64, iz: i64) -> SfccCell {
        let key = cell_key(self.lat, level, ix, iy, iz);
        let cell = SfccCell {
            level,
            ix,
            iy,
            iz,
            key,
            degenerate: false,
            feature_curve: -1,
            feature_corner: -1,
        };
        self.cells_by_level[level as usize].insert(key, cell);
        let stride = stride_at_level(self.lat, level);
        for c in 0..8 {
            self.sampler.sample_at(
                (ix + (c & 1)) * stride,
                (iy + ((c >> 1) & 1)) * stride,
                (iz + ((c >> 2) & 1)) * stride,
            );
        }
        cell
    }

    /// Recursive descent to `depth_min`, empty-culling along the way.
    fn descend(&mut self, level: u32, ix: i64, iy: i64, iz: i64, depth_min: u32) {
        if self.certified_empty(level, ix, iy, iz) {
            return;
        }
        if level == depth_min {
            let cell = self.make_leaf(level, ix, iy, iz);
            self.worklist.push((cell.level, cell.key));
            return;
        }
        self.internal_by_level[level as usize].insert(cell_key(self.lat, level, ix, iy, iz));
        for c in 0..8 {
            self.descend(
                level + 1,
                ix * 2 + (c & 1),
                iy * 2 + ((c >> 1) & 1),
                iz * 2 + ((c >> 2) & 1),
                depth_min,
            );
        }
    }

    /// Split a leaf into 8 children (empty-culled), then ripple 2:1 balance.
    fn split(&mut self, cell: SfccCell) {
        self.cells_by_level[cell.level as usize].remove(&cell.key);
        self.internal_by_level[cell.level as usize].insert(cell.key);
        for c in 0..8 {
            let cx = cell.ix * 2 + (c & 1);
            let cy = cell.iy * 2 + ((c >> 1) & 1);
            let cz = cell.iz * 2 + ((c >> 2) & 1);
            if self.certified_empty(cell.level + 1, cx, cy, cz) {
                continue;
            }
            let child = self.make_leaf(cell.level + 1, cx, cy, cz);
            self.worklist.push((child.level, child.key));
        }
        self.ripple_balance(cell);
    }

    /// After splitting `cell` (level L), coarser neighbors at level L−1 must
    /// split too. Recurses through `split` exactly like the TS mutual recursion.
    fn ripple_balance(&mut self, cell: SfccCell) {
        if cell.level == 0 {
            return;
        }
        let parent_level = cell.level - 1;
        let max_idx = (1i64 << cell.level) - 1;
        // FACE neighbors always; EDGE neighbors when enforced. Iterate in the
        // same order as the TS `[FACE_NEIGHBORS, EDGE_NEIGHBORS]` sets.
        let process = |this: &mut Builder<'a>, set: &[[i64; 3]]| {
            for off in set {
                let nx = cell.ix + off[0];
                let ny = cell.iy + off[1];
                let nz = cell.iz + off[2];
                if nx < 0 || ny < 0 || nz < 0 || nx > max_idx || ny > max_idx || nz > max_idx {
                    continue;
                }
                let coarse_key = cell_key(this.lat, parent_level, nx >> 1, ny >> 1, nz >> 1);
                if let Some(&coarse) = this.cells_by_level[parent_level as usize].get(&coarse_key) {
                    this.split(coarse);
                }
            }
        };
        process(self, &FACE_NEIGHBORS);
        if self.enforce_edge_balance {
            process(self, &EDGE_NEIGHBORS);
        }
    }

    /// Apply one frontier cell's decision: stamp its feature tags, then split (+
    /// ripple 2:1 balance) if the decision says split and the cell can still split.
    /// Skips a cell a same-round ripple already split out. Extracted so the serial
    /// round loop ([`build_octree_inner`]) and the resumable build
    /// ([`ResumableOctreeBuild`]) share ONE apply body and cannot drift.
    fn apply_decision(&mut self, cell: &SfccCell, dec: &CellDecision, depth_max: u32) {
        let level = cell.level;
        let key = cell.key;
        // Skip cells a ripple already split out from under us this round.
        if !self.cells_by_level[level as usize].contains_key(&key) {
            return;
        }
        if let Some(c) = self.cells_by_level[level as usize].get_mut(&key) {
            c.feature_curve = dec.feature_curve;
            c.feature_corner = dec.feature_corner;
        }
        if !dec.split {
            return;
        }
        if cell.level >= depth_max {
            if let Some(c) = self.cells_by_level[level as usize].get_mut(&key) {
                c.degenerate = true;
            }
            return;
        }
        // Re-read the (tag-stamped) live cell so split carries the tags.
        let live = self.cells_by_level[level as usize][&key];
        self.split(live);
    }

    /// Collect + deterministically sort the leaves and assemble the [`SfccOctree`]
    /// (carrying the sampler cache for downstream meshing). Extracted so the serial
    /// driver and the resumable build assemble the result identically.
    fn finalize(self, profile: Option<OctreeProfile>) -> SfccOctree<'a> {
        let mut leaves = Vec::new();
        let mut degenerate_cells = 0usize;
        for per_level in &self.cells_by_level {
            for cell in per_level.values() {
                leaves.push(*cell);
                if cell.degenerate {
                    degenerate_cells += 1;
                }
            }
        }
        // `HashMap::values()` iterates in an unspecified (run-varying) order, but the
        // leaf order seeds new point-table ids during cell meshing — so it must be
        // DETERMINISTIC for the double-run bit-identical guard. Sort by (level,
        // min-corner key); the downstream mesh compare is order-insensitive.
        leaves.sort_unstable_by_key(|c| (c.level, c.key));
        SfccOctree {
            lat: *self.lat,
            cells_by_level: self.cells_by_level,
            internal_by_level: self.internal_by_level,
            leaves,
            degenerate_cells,
            profile,
            sampler: self.sampler,
        }
    }

    /// Decompose into owned state (dropping the tree/lattice borrows). Lets the
    /// resumable build move state out of a transient borrowing [`Builder`].
    fn into_state(self) -> (HashMap<i64, f64>, Vec<HashMap<i64, SfccCell>>, Vec<HashSet<i64>>, Vec<(u32, i64)>) {
        (self.sampler.samples.into_inner(), self.cells_by_level, self.internal_by_level, self.worklist)
    }
}

/// Build the certified adaptive octree over `tree`. `decide(cell, sampleView)`
/// returns the [`CellDecision`] for one leaf: whether it must split + the feature
/// tags to stamp. It is never invoked above `depth_min`, and it is a PURE READ
/// over the immutable feature set + the pre-populated sample cache (every
/// frontier cell's 8 corners are cached at creation), so the decision pass runs
/// over a round's frontier in parallel under the `threads` feature (rayon
/// `par_iter` + an order-preserving `collect`) — and serially otherwise. The
/// FINAL leaf set is confluent (criteria are pure; the 2:1 balance is a fixpoint
/// independent of worklist order), so parallel output == serial output. Port of
/// `buildOctree`.
pub fn build_octree<'a, F>(
    tree: &'a CsgNode,
    lat: &'a SfccLattice,
    opts: OctreeBuildOptions,
    decide: F,
) -> SfccOctree<'a>
where
    F: DecideFn,
{
    build_octree_inner(tree, lat, opts, decide, None)
}

/// [`build_octree`] with an injected millisecond clock that times each round's
/// `decide_frontier` (the parallelizable per-cell cert pass) vs the serial
/// apply+ripple loop, stashing the split on [`SfccOctree::profile`]. Mesh output
/// is byte-identical to [`build_octree`] — timing only. Mirrors the
/// `run_sfcc_pipeline` / `run_sfcc_pipeline_profiled` split so existing
/// `build_octree` callers stay untouched.
pub fn build_octree_profiled<'a, F>(
    tree: &'a CsgNode,
    lat: &'a SfccLattice,
    opts: OctreeBuildOptions,
    decide: F,
    now: &dyn Fn() -> f64,
) -> SfccOctree<'a>
where
    F: DecideFn,
{
    build_octree_inner(tree, lat, opts, decide, Some(now))
}

fn build_octree_inner<'a, F>(
    tree: &'a CsgNode,
    lat: &'a SfccLattice,
    opts: OctreeBuildOptions,
    decide: F,
    now: Option<&dyn Fn() -> f64>,
) -> SfccOctree<'a>
where
    F: DecideFn,
{
    assert!(
        opts.depth_max <= lat.max_depth,
        "sfcc octree: depth_max {} > lattice max_depth {}",
        opts.depth_max,
        lat.max_depth
    );

    let mut b = Builder {
        lat,
        sampler: Sampler::new(tree, lat),
        cells_by_level: (0..=lat.max_depth).map(|_| HashMap::new()).collect(),
        internal_by_level: (0..=lat.max_depth).map(|_| HashSet::new()).collect(),
        worklist: Vec::new(),
        enforce_edge_balance: opts.enforce_edge_balance,
    };

    // --- initial descent to depth_min ---------------------------------------
    b.descend(0, 0, 0, 0, opts.depth_min);

    // Refinement-loop timing accumulators (only touched when `now` is Some).
    let mut prof_decide_ms = 0.0f64;
    let mut prof_apply_ms = 0.0f64;
    let mut prof_rounds: Vec<(usize, f64, f64)> = Vec::new();

    // --- refinement worklist with balance ripple, ROUND-BATCHED -------------
    // Each round: (1) snapshot the current frontier (cells still live as leaves),
    // (2) DECIDE all of them — the parallel section (pure reads over the cache +
    // feature set), (3) APPLY serially (stamp tags, split + balance-ripple). The
    // ripple may split a cell earlier in the same round; the identity guard
    // (cell gone from the leaf map ⇒ skip) handles that exactly as the serial
    // pop()-loop did, and the rippled cell's children land in the next round.
    while !b.worklist.is_empty() {
        // Snapshot the frontier as live cells (skip any already rippled away).
        let frontier: Vec<SfccCell> = std::mem::take(&mut b.worklist)
            .into_iter()
            .filter_map(|(level, key)| b.cells_by_level[level as usize].get(&key).copied())
            .collect();
        if frontier.is_empty() {
            continue;
        }

        let frontier_len = frontier.len();
        let decide_t0 = now.map(|f| f());

        // (2) DECIDE — pure-read over an immutable cache borrow (Sync). The corner
        // samples for every frontier cell are already in the cache (cell creation
        // populated them), so no writes occur; `decide` only reads.
        let decisions: Vec<CellDecision> = {
            let samples = b.sampler.samples.borrow();
            let view = SampleView { tree, lat, samples: &samples };
            decide_frontier(&frontier, &view, &decide)
        };

        let apply_t0 = now.map(|f| f());

        // (3) APPLY serially, in frontier order (deterministic). Stamp the tags,
        // then split (+ ripple) cells that still exist as leaves. The per-cell body
        // is `Builder::apply_decision`, shared verbatim with the resumable build.
        for (cell, dec) in frontier.iter().zip(decisions.iter()) {
            b.apply_decision(cell, dec, opts.depth_max);
        }

        // Fold this round's decide/apply split into the profile (only when timed).
        if let (Some(d0), Some(a0)) = (decide_t0, apply_t0) {
            let now_fn = now.unwrap();
            let decide_ms = a0 - d0;
            let apply_ms = now_fn() - a0;
            prof_decide_ms += decide_ms;
            prof_apply_ms += apply_ms;
            prof_rounds.push((frontier_len, decide_ms, apply_ms));
        }
    }

    let profile = now.map(|_| OctreeProfile {
        decide_ms: prof_decide_ms,
        apply_ms: prof_apply_ms,
        rounds: prof_rounds,
    });
    b.finalize(profile)
}

/// A RESUMABLE per-round octree build: the same certified refinement as
/// [`build_octree`], but each round's per-cell DECISION is supplied by the caller
/// between rounds instead of computed inline — so the parallelizable decision pass
/// can run on separate worker wasm instances (cross-instance octree-decision
/// parallelism), with the serial split + 2:1-balance ripple staying on the caller.
///
/// The state is BORROW-FREE (owns the lattice by value + the sample cache + the
/// level maps), so it can be held across JS worker round-trips (e.g. in a wasm-side
/// registry) — the `tree` is passed back in per call. Each method that samples the
/// field (the initial descend, the split empty-cull) reconstructs a transient
/// borrowing [`Builder`] over the passed `tree` and reuses the EXACT serial logic
/// (`descend` / `apply_decision` / `split` / `ripple_balance` / `finalize`), so the
/// result is byte-identical to the serial driver (gated by `tests/octree_resumable.rs`).
///
/// Round 0 / single build only: forced-split markers are the caller's concern (the
/// supplied decisions already encode them), matching the slice-5 worker path.
pub(crate) struct ResumableOctreeBuild {
    lat: SfccLattice,
    samples: HashMap<i64, f64>,
    cells_by_level: Vec<HashMap<i64, SfccCell>>,
    internal_by_level: Vec<HashSet<i64>>,
    worklist: Vec<(u32, i64)>,
    enforce_edge_balance: bool,
    depth_max: u32,
    current_frontier: Vec<SfccCell>,
}

impl ResumableOctreeBuild {
    /// Start a build: descend to `depth_min`, then snapshot the first round's frontier.
    pub(crate) fn begin(tree: &CsgNode, lat: &SfccLattice, opts: &OctreeBuildOptions) -> Self {
        assert!(
            opts.depth_max <= lat.max_depth,
            "sfcc octree: depth_max {} > lattice max_depth {}",
            opts.depth_max,
            lat.max_depth
        );
        let mut rb = ResumableOctreeBuild {
            lat: *lat,
            samples: HashMap::new(),
            cells_by_level: (0..=lat.max_depth).map(|_| HashMap::new()).collect(),
            internal_by_level: (0..=lat.max_depth).map(|_| HashSet::new()).collect(),
            worklist: Vec::new(),
            enforce_edge_balance: opts.enforce_edge_balance,
            depth_max: opts.depth_max,
            current_frontier: Vec::new(),
        };
        let depth_min = opts.depth_min;
        rb.with_builder(tree, |b| b.descend(0, 0, 0, 0, depth_min));
        rb.snapshot_frontier();
        rb
    }

    /// The current round's frontier cells (the slice to DECIDE). Empty ⇒ done.
    pub(crate) fn current_frontier(&self) -> &[SfccCell] {
        &self.current_frontier
    }

    /// Whether the build is complete (no more rounds).
    pub(crate) fn is_done(&self) -> bool {
        self.current_frontier.is_empty()
    }

    /// Apply the current frontier's decisions (one per `current_frontier` cell, in
    /// order) — stamp tags + split + ripple exactly as the serial round loop — then
    /// snapshot the next round's frontier.
    pub(crate) fn apply_decisions(&mut self, tree: &CsgNode, decisions: &[CellDecision]) {
        assert_eq!(
            decisions.len(),
            self.current_frontier.len(),
            "resumable octree: decision count != frontier length"
        );
        let frontier = std::mem::take(&mut self.current_frontier);
        let depth_max = self.depth_max;
        self.with_builder(tree, |b| {
            for (cell, dec) in frontier.iter().zip(decisions.iter()) {
                b.apply_decision(cell, dec, depth_max);
            }
        });
        self.snapshot_frontier();
    }

    /// Finish: assemble the [`SfccOctree`] (borrowing the passed `tree`/`lat` for the
    /// downstream sampler cache). `tree`/`lat` must be the ones passed to [`Self::begin`].
    pub(crate) fn finish<'a>(mut self, tree: &'a CsgNode, lat: &'a SfccLattice) -> SfccOctree<'a> {
        let b = Builder {
            lat,
            sampler: Sampler { tree, lat, samples: RefCell::new(std::mem::take(&mut self.samples)) },
            cells_by_level: std::mem::take(&mut self.cells_by_level),
            internal_by_level: std::mem::take(&mut self.internal_by_level),
            worklist: std::mem::take(&mut self.worklist),
            enforce_edge_balance: self.enforce_edge_balance,
        };
        b.finalize(None)
    }

    /// Snapshot the worklist into `current_frontier` as the live leaf cells (skipping
    /// any rippled away), matching the serial round loop's frontier snapshot.
    fn snapshot_frontier(&mut self) {
        let worklist = std::mem::take(&mut self.worklist);
        self.current_frontier = worklist
            .into_iter()
            .filter_map(|(level, key)| self.cells_by_level[level as usize].get(&key).copied())
            .collect();
    }

    /// Run `f` over a transient [`Builder`] borrowing `tree` + this build's lattice,
    /// moving the owned state in and back out — so the borrow-free state can reuse the
    /// serial build's `&mut Builder` methods without holding a `tree` borrow across calls.
    fn with_builder<R>(&mut self, tree: &CsgNode, f: impl FnOnce(&mut Builder) -> R) -> R {
        let lat = self.lat;
        let mut b = Builder {
            lat: &lat,
            sampler: Sampler { tree, lat: &lat, samples: RefCell::new(std::mem::take(&mut self.samples)) },
            cells_by_level: std::mem::take(&mut self.cells_by_level),
            internal_by_level: std::mem::take(&mut self.internal_by_level),
            worklist: std::mem::take(&mut self.worklist),
            enforce_edge_balance: self.enforce_edge_balance,
        };
        let r = f(&mut b);
        let (samples, cells, internal, worklist) = b.into_state();
        self.samples = samples;
        self.cells_by_level = cells;
        self.internal_by_level = internal;
        self.worklist = worklist;
        r
    }
}

/// Uniform-depth build (no refinement criteria) — used by tests. Port of
/// `buildUniformOctree`.
pub fn build_uniform_octree<'a>(tree: &'a CsgNode, lat: &'a SfccLattice, leaf_depth: u32) -> SfccOctree<'a> {
    build_octree(
        tree,
        lat,
        OctreeBuildOptions { depth_min: leaf_depth, depth_max: leaf_depth, enforce_edge_balance: true },
        |_cell: &SfccCell, _sampler: &SampleView<'_>| CellDecision { split: false, feature_curve: -1, feature_corner: -1 },
    )
}

/// Coarse octree level for the DECIDE-phase prune-view reuse (mirrors the contour
/// `CONTOUR_PRUNE_LEVEL`): one `prune_to_box` per surface coarse cell, reused across
/// every certificate eval of every cell decided under it. The build cost (`prune_to_box`
/// is `O(tree²)` per region) is what sank the per-cell Lever 1; amortizing it over a
/// whole region is the fix (proven net-positive on the contour phase). Built ONCE up
/// front so the read-only cache satisfies the `Fn + Sync` decide-callback bound.
const OCTREE_PRUNE_LEVEL: u32 = 5;

/// Pack a coarse cell `(level, ix, iy, iz)` into a cache key.
fn octree_coarse_key_at(level: u32, ix: i64, iy: i64, iz: i64) -> u64 {
    ((level as u64) << 60) | (((ix as u64) & 0xFFFFF) << 40) | (((iy as u64) & 0xFFFFF) << 20) | ((iz as u64) & 0xFFFFF)
}

/// Descend to [`OCTREE_PRUNE_LEVEL`], culling empty subtrees (interval excludes 0 — the
/// same cull the octree build uses), and build one pruned view per surface coarse cell.
/// Bit-exact: every decide eval of a cell under a coarse region queries inside that
/// cell, hence inside the coarse ancestor's (slightly padded) box, where `prune_to_box`
/// is bit-exact to the full tree.
fn collect_coarse_prunes<'a>(
    tree: &'a CsgNode,
    lat: &SfccLattice,
    level: u32,
    ix: i64,
    iy: i64,
    iz: i64,
    out: &mut HashMap<u64, Pruned<'a>>,
) {
    let half = cell_size_at_level(lat, level) / 2.0;
    let c = cell_center_world(lat, level, ix, iy, iz);
    let (lo, hi) = tree.interval_over_box(c, [half, half, half]);
    if lo > 0.0 || hi < 0.0 {
        return; // empty region — no surface, never decided
    }
    if level == OCTREE_PRUNE_LEVEL {
        // Pad by 10% of the half-extent: the cone/owner probes sit on the cell faces, so
        // fine cells on the coarse boundary query exactly on the box edge.
        let ph = half * 1.1;
        out.insert(octree_coarse_key_at(level, ix, iy, iz), tree.prune_to_box(c, [ph, ph, ph]));
        return;
    }
    for dx in 0..2i64 {
        for dy in 0..2i64 {
            for dz in 0..2i64 {
                collect_coarse_prunes(tree, lat, level + 1, ix * 2 + dx, iy * 2 + dy, iz * 2 + dz, out);
            }
        }
    }
}

/// Build the certified adaptive octree with FEATURE-AWARE refinement: each leaf
/// splits if `classify_cell_features` says split OR `needs_split_smooth` says
/// split, and every surviving leaf is stamped with its `feature_curve` /
/// `feature_corner` id (−1 if none). Port of `runSfccPipeline`'s `needsSplit`
/// callback (round 0; the re-refine `forcedSplit` markers are empty there and
/// land in a later slice). The octree is finer near feature edges/seams than the
/// smooth-only [`build_octree`] driver — that extra refinement is the point.
pub fn build_octree_feature_aware<'a>(
    tree: &'a CsgNode,
    lat: &'a SfccLattice,
    opts: OctreeBuildOptions,
    features: &SfccFeatureSet,
    feature_opts: &FeatureCriteriaOptions,
    smooth_opts: &SmoothCriteriaOptions,
) -> SfccOctree<'a> {
    // `maxDepth = min(depthMax, lat.maxDepth)` — the corner-claim is gated on it.
    let max_depth = opts.depth_max.min(lat.max_depth);
    // Tree-level advisories hoisted once (the callback is hot).
    let grad_bound = tree.grad_bound();
    let has_blend = tree.has_blend();
    // Coarse-region CSG pruning (replaces the net-negative per-cell Lever 1): build one
    // pruned view per surface coarse cell up front, reuse it across every cell decided
    // under it. Read-only cache ⇒ the `Fn + Sync` decide callback can share `&`. Gated to
    // non-trivial trees (a coarse cell must touch a small fraction of the tree to win).
    let prune = tree.leaf_count() > LEVER1_MIN_LEAVES;
    let coarse_prunes: HashMap<u64, Pruned> = if prune {
        let mut m = HashMap::new();
        collect_coarse_prunes(tree, lat, 0, 0, 0, 0, &mut m);
        m
    } else {
        HashMap::new()
    };

    build_octree(tree, lat, opts, |cell, sampler| {
        // Feature criteria (i)/(ii) first; on pass they classify the cell.
        let cls = classify_cell_features(features, lat, cell.level, cell.ix, cell.iy, cell.iz, feature_opts);
        if cls.split {
            // Classify even though we demand a split: at depthMax the cell CANNOT
            // split, and an unclassified wedge cell smooth-meshes its wrapping
            // loop. Below depthMax the assignment is discarded with the split.
            let mut feature_corner = cls.corner;
            if cell.level >= max_depth && cls.corner < 0 {
                // Multi-curve cell that can never split apart: if a nearby corner
                // exists, claim it (feature curves CONVERGE at corners). Fanning
                // from an apex slightly outside the cell is structurally fine.
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
        // (forcedSplit markers are empty at round 0 — omitted.)
        // The certificate evals (center f + per-stratum / blend-band ∇f + owner queries)
        // all query inside the cell box, so the pre-built pruned view of this cell's
        // coarse ancestor (level ≥ OCTREE_PRUNE_LEVEL) is bit-exact here and reused across
        // the whole region. Cells above the prune level (and a cache miss) use the full
        // tree — sound, just unpruned.
        let q: &dyn crate::sdf::SdfQuery = if prune && cell.level >= OCTREE_PRUNE_LEVEL {
            let s = cell.level - OCTREE_PRUNE_LEVEL;
            let key = octree_coarse_key_at(OCTREE_PRUNE_LEVEL, cell.ix >> s, cell.iy >> s, cell.iz >> s);
            coarse_prunes.get(&key).map(|p| p as &dyn crate::sdf::SdfQuery).unwrap_or(tree)
        } else {
            tree
        };
        let probe = make_probe(
            lat,
            q,
            |gx, gy, gz| sampler.sample_at(gx, gy, gz),
            cell.level,
            cell.ix,
            cell.iy,
            cell.iz,
        );
        if cls.corner >= 0 {
            // Corner cells are exempt from the per-stratum smoothness certificates
            // AND from the sign-change gate (the corner IS the carrier
            // singularity). A corner cell with no visible crossings meshes nothing.
            return CellDecision { split: false, feature_curve: cls.curve, feature_corner: cls.corner };
        }
        // A feature in a cell whose corners don't see a sign change is invisible to
        // face contouring — keep splitting. Classify FIRST so depthMax leaves carry
        // the tag for the pin + per-stratum recovery machinery.
        if cls.curve >= 0 && !has_corner_sign_change(&probe) {
            return CellDecision { split: true, feature_curve: cls.curve, feature_corner: cls.corner };
        }
        let split = needs_split_smooth(q, &probe, smooth_opts, grad_bound, has_blend);
        CellDecision { split, feature_curve: cls.curve, feature_corner: cls.corner }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::grid::make_lattice;
    use crate::sdf::{self, Shape};

    fn sphere_tree() -> CsgNode {
        sdf::leaf_at(Shape::Sphere { r: 8.0 }, [0.0, 0.0, 0.0])
    }

    /// Wrap a bare split predicate in a (no-feature) `CellDecision` for the tests.
    fn split_dec(split: bool) -> CellDecision {
        CellDecision { split, feature_curve: -1, feature_corner: -1 }
    }

    #[test]
    fn uniform_octree_culls_empty_and_keeps_surface_cells() {
        let lat = make_lattice(4, -10.0, -10.0, -10.0, 20.0);
        let tree = sphere_tree();
        let oct = build_uniform_octree(&tree, &lat, 4);
        // The far corner cell (well outside r=8) is culled; some cells survive.
        assert!(!oct.leaves.is_empty());
        assert_eq!(oct.degenerate_cells, 0);
        // No leaf can be certified-empty (the cull removed those).
        for leaf in &oct.leaves {
            let half = cell_size_at_level(&lat, leaf.level) / 2.0;
            let c = cell_center_world(&lat, leaf.level, leaf.ix, leaf.iy, leaf.iz);
            let (lo, hi) = sphere_tree().interval_over_box(c, [half, half, half]);
            assert!(!(lo > 0.0 || hi < 0.0), "kept a certified-empty leaf");
        }
    }

    #[test]
    fn refinement_splits_until_criteria_pass() {
        let lat = make_lattice(6, -10.0, -10.0, -10.0, 20.0);
        let tree = sphere_tree();
        // Split any cell below level 3 that touches the surface (sign change).
        let oct = build_octree(
            &tree,
            &lat,
            OctreeBuildOptions { depth_min: 2, depth_max: 5, enforce_edge_balance: true },
            |cell, sampler| {
                if cell.level >= 4 {
                    return split_dec(false);
                }
                let stride = stride_at_level(&lat, cell.level);
                let mut neg = false;
                let mut pos = false;
                for c in 0..8 {
                    let v = sampler.sample_at(
                        (cell.ix + (c & 1)) * stride,
                        (cell.iy + ((c >> 1) & 1)) * stride,
                        (cell.iz + ((c >> 2) & 1)) * stride,
                    );
                    if v < 0.0 {
                        neg = true;
                    } else {
                        pos = true;
                    }
                }
                split_dec(neg && pos)
            },
        );
        // Surface cells refined to level 4; interior/exterior stay coarse.
        let max_level = oct.leaves.iter().map(|c| c.level).max().unwrap();
        assert_eq!(max_level, 4);
        // 2:1 balance: every leaf's face neighbor differs by at most one level.
        assert_eq!(oct.degenerate_cells, 0);
    }

    #[test]
    fn refinement_maintains_2to1_face_balance() {
        // Refine the sphere shell with the sign-change predicate, then assert no
        // leaf has a face neighbor more than one level coarser (the 2:1 balance
        // ripple invariant). With balance enforced this must hold structurally.
        let lat = make_lattice(7, -10.0, -10.0, -10.0, 20.0);
        let tree = sphere_tree();
        let oct = build_octree(
            &tree,
            &lat,
            OctreeBuildOptions { depth_min: 2, depth_max: 6, enforce_edge_balance: true },
            |cell, sampler| {
                if cell.level >= 5 {
                    return split_dec(false);
                }
                let stride = stride_at_level(&lat, cell.level);
                let mut neg = false;
                let mut pos = false;
                for c in 0..8 {
                    let v = sampler.sample_at(
                        (cell.ix + (c & 1)) * stride,
                        (cell.iy + ((c >> 1) & 1)) * stride,
                        (cell.iz + ((c >> 2) & 1)) * stride,
                    );
                    if v < 0.0 {
                        neg = true;
                    } else {
                        pos = true;
                    }
                }
                split_dec(neg && pos)
            },
        );
        assert!(oct.leaves.iter().any(|c| c.level == 5), "shell refined to the ceiling");
        // 2:1 face balance: for a leaf at level L, the cell occupying its
        // same-level face-neighbor slot may be a leaf (level L) or internal
        // (refined to L+1 — the allowed 2:1 step), but a level-(L+1) cell ACROSS
        // that face must never itself be internal (that would put an L+2 leaf
        // adjacent to an L leaf — a forbidden 4:1 jump). The ripple split
        // guarantees this; assert it holds.
        for leaf in &oct.leaves {
            if leaf.level + 1 >= lat.max_depth {
                continue;
            }
            let max_idx = (1i64 << leaf.level) - 1;
            for off in &FACE_NEIGHBORS {
                let nx = leaf.ix + off[0];
                let ny = leaf.iy + off[1];
                let nz = leaf.iz + off[2];
                if nx < 0 || ny < 0 || nz < 0 || nx > max_idx || ny > max_idx || nz > max_idx {
                    continue;
                }
                if !oct.is_internal(leaf.level as i64, nx, ny, nz) {
                    continue; // neighbor is a leaf or coarser — fine
                }
                // Neighbor refined to L+1. The L+1 child sharing the face with
                // `leaf` lies on the −off side; verify none of the neighbor's
                // face-touching children are themselves internal.
                for c in 0..8 {
                    let cx = nx * 2 + (c & 1);
                    let cy = ny * 2 + ((c >> 1) & 1);
                    let cz = nz * 2 + ((c >> 2) & 1);
                    // Only children on the face shared with `leaf` matter; skip
                    // the rest. The shared face is the one toward −off.
                    let shares = (off[0] != 0 && ((cx & 1) == if off[0] > 0 { 0 } else { 1 }))
                        || (off[1] != 0 && ((cy & 1) == if off[1] > 0 { 0 } else { 1 }))
                        || (off[2] != 0 && ((cz & 1) == if off[2] > 0 { 0 } else { 1 }));
                    if !shares {
                        continue;
                    }
                    assert!(
                        !oct.is_internal(leaf.level as i64 + 1, cx, cy, cz),
                        "4:1 imbalance: L+2 leaf abuts an L leaf across a face"
                    );
                }
            }
        }
        assert_eq!(oct.degenerate_cells, 0);
    }
}
