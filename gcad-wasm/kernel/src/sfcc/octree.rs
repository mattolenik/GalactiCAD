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
use crate::sdf::CsgNode;
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
/// one map). The deterministic-weld restructure for rayon is M6.
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

/// Build options for the octree refinement driver.
pub struct OctreeBuildOptions {
    pub depth_min: u32,
    pub depth_max: u32,
    pub enforce_edge_balance: bool,
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
}

/// Build the certified adaptive octree over `tree`. `needs_split(cell, sampler)`
/// returns true when the leaf must split; it is never invoked above `depth_min`.
/// The callback receives `&mut SfccCell` so it can stamp `feature_curve` /
/// `feature_corner` exactly as the TS `needsSplit` mutates the live cell — those
/// tags persist on the surviving leaf. Port of `buildOctree`.
pub fn build_octree<'a, F>(
    tree: &'a CsgNode,
    lat: &'a SfccLattice,
    opts: OctreeBuildOptions,
    mut needs_split: F,
) -> SfccOctree<'a>
where
    F: FnMut(&mut SfccCell, &Sampler<'a>) -> bool,
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

    // --- refinement worklist with balance ripple ----------------------------
    while let Some((level, key)) = b.worklist.pop() {
        // The cell may have been split by a balance ripple while queued (in
        // which case it's gone from the leaf map → skip). Matches the TS
        // identity guard `cellsByLevel[level].get(key) !== cell`.
        let mut cell = match b.cells_by_level[level as usize].get(&key) {
            Some(&c) => c,
            None => continue,
        };
        // The callback may stamp feature tags on `cell` (mirrors the TS callback
        // mutating the live cell). Persist them back whether or not it splits.
        let want_split = needs_split(&mut cell, &b.sampler);
        if let Some(c) = b.cells_by_level[level as usize].get_mut(&key) {
            c.feature_curve = cell.feature_curve;
            c.feature_corner = cell.feature_corner;
        }
        if !want_split {
            continue;
        }
        if cell.level >= opts.depth_max {
            if let Some(c) = b.cells_by_level[level as usize].get_mut(&key) {
                c.degenerate = true;
            }
            continue;
        }
        b.split(cell);
    }

    let mut leaves = Vec::new();
    let mut degenerate_cells = 0usize;
    for per_level in &b.cells_by_level {
        for cell in per_level.values() {
            leaves.push(*cell);
            if cell.degenerate {
                degenerate_cells += 1;
            }
        }
    }
    // `HashMap::values()` iterates in an unspecified (run-varying) order, but the
    // leaf order seeds new point-table ids during cell meshing — so the order
    // must be DETERMINISTIC for the double-run bit-identical guard. Sort by
    // (level, min-corner key). The downstream mesh compare is order-insensitive,
    // so this need not match the TS Map-insertion order — only be stable.
    leaves.sort_unstable_by_key(|c| (c.level, c.key));

    SfccOctree {
        lat: *lat,
        cells_by_level: b.cells_by_level,
        internal_by_level: b.internal_by_level,
        leaves,
        degenerate_cells,
        sampler: b.sampler,
    }
}

/// Uniform-depth build (no refinement criteria) — used by tests. Port of
/// `buildUniformOctree`.
pub fn build_uniform_octree<'a>(tree: &'a CsgNode, lat: &'a SfccLattice, leaf_depth: u32) -> SfccOctree<'a> {
    build_octree(
        tree,
        lat,
        OctreeBuildOptions { depth_min: leaf_depth, depth_max: leaf_depth, enforce_edge_balance: true },
        |_cell: &mut SfccCell, _sampler| false,
    )
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

    build_octree(tree, lat, opts, |cell, sampler| {
        // Feature criteria (i)/(ii) first; on pass they classify the cell.
        let cls = classify_cell_features(features, lat, cell.level, cell.ix, cell.iy, cell.iz, feature_opts);
        if cls.split {
            // Classify even though we demand a split: at depthMax the cell CANNOT
            // split, and an unclassified wedge cell smooth-meshes its wrapping
            // loop. Below depthMax the assignment is discarded with the split.
            cell.feature_curve = cls.curve;
            cell.feature_corner = cls.corner;
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
                    cell.feature_corner = best_corner;
                }
            }
            return true;
        }
        // (forcedSplit markers are empty at round 0 — omitted.)
        let probe = make_probe(
            lat,
            tree,
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
            cell.feature_curve = cls.curve;
            cell.feature_corner = cls.corner;
            return false;
        }
        // A feature in a cell whose corners don't see a sign change is invisible to
        // face contouring — keep splitting. Classify FIRST so depthMax leaves carry
        // the tag for the pin + per-stratum recovery machinery.
        cell.feature_curve = cls.curve;
        cell.feature_corner = cls.corner;
        if cls.curve >= 0 && !has_corner_sign_change(&probe) {
            return true;
        }
        needs_split_smooth(tree, &probe, smooth_opts, grad_bound, has_blend)
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
                    return false;
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
                neg && pos
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
                    return false;
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
                neg && pos
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
