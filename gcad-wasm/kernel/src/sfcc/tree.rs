//! A `CpuSdfTree`-equivalent *view* over a built `CsgNode`: the flattened leaf
//! list (each with its world AABB + smooth strata), the global stratum list,
//! and the per-pair on-locus blend-seam displacement matrix. Port of the
//! tree-level structure assembled by `compileCpuSdf` (`src/export/sfcc/cpu-sdf.mts`)
//! that the seam tracer + trimmer consume (`tree.leaves`, `leaf.aabb`,
//! `leaf.strata`, `tree.blendSeamDisplacement`, `tree.f/grad/activeOwnersAt`).
//!
//! The strata-build order matches `compile_native_features` (per leaf, in
//! left-to-right CSG traversal order) so curve `adjacent_strata` ids agree.

use crate::primitives::smin::smin;
use crate::sdf::{CsgNode, Leaf, Shape};
use crate::strata::Stratum;

/// Per-leaf view: the leaf's world AABB and the half-open stratum-id range
/// `[strata_start, strata_end)` into the tree's global stratum list.
#[derive(Clone, Debug)]
pub struct LeafView {
    /// `[minX,minY,minZ,maxX,maxY,maxZ]`, conservative world AABB of the surface.
    pub aabb: [f64; 6],
    pub strata_start: usize,
    pub strata_end: usize,
}

/// A built CSG tree plus the feature-compilation scaffolding the seam pipeline
/// reads. Borrows the root `CsgNode` (owns the derived strata/views/matrix).
pub struct SfccTree<'a> {
    pub root: &'a CsgNode,
    pub leaves: Vec<LeafView>,
    /// All strata across all leaves; index = stratum id.
    pub strata: Vec<Stratum>,
    /// `leaf_count × leaf_count` on-locus seam displacement (0 at hard combiners).
    seam_disp: Vec<f64>,
    leaf_count: usize,
}

impl<'a> SfccTree<'a> {
    /// Signed field of the full tree.
    pub fn f(&self, x: f64, y: f64, z: f64) -> f64 {
        self.root.f([x, y, z])
    }

    /// One-sided unit gradient of the full tree.
    pub fn grad(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        self.root.grad([x, y, z]).1
    }

    /// On-locus seam displacement at the lowest common combiner of leaves a, b
    /// (indices into `leaves`); 0 at hard min/max.
    pub fn blend_seam_displacement(&self, a: usize, b: usize) -> f64 {
        self.seam_disp.get(a * self.leaf_count + b).copied().unwrap_or(0.0)
    }

    /// CSG-aware winner set at a point. Delegates to [`CsgNode::active_owners_at`].
    pub fn active_owners_at(&self, x: f64, y: f64, z: f64, tol: f64) -> Vec<crate::sdf::ActiveOwner<'_>> {
        self.root.active_owners_at([x, y, z], tol)
    }

    /// Strata of leaf `i` (slice into the global list).
    pub fn leaf_strata(&self, i: usize) -> &[Stratum] {
        &self.strata[self.leaves[i].strata_start..self.leaves[i].strata_end]
    }
}

/// Local-box → world AABB by transforming the 8 corners. Port of
/// `worldAabbOfLocalBox`.
fn world_aabb_of_local_box(leaf: &Leaf, c: [f64; 3], h: [f64; 3]) -> [f64; 6] {
    let mut out = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for i in 0..8 {
        let p = leaf.sim.apply_point(
            c[0] + if i & 1 != 0 { h[0] } else { -h[0] },
            c[1] + if i & 2 != 0 { h[1] } else { -h[1] },
            c[2] + if i & 4 != 0 { h[2] } else { -h[2] },
        );
        for a in 0..3 {
            if p[a] < out[a] {
                out[a] = p[a];
            }
            if p[a] > out[a + 3] {
                out[a + 3] = p[a];
            }
        }
    }
    out
}

/// The local-box `(center, half-extents)` for a leaf's AABB. Port of the
/// per-primitive `aabbLocal` in `cpu-sdf.mts` over the full v1 shape subset.
pub fn local_aabb_box(shape: &Shape, pos: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let [px, py, pz] = pos;
    match shape {
        Shape::Cuboid { half } => ([px, py, pz], *half),
        Shape::Sphere { r } => ([px, py, pz], [*r, *r, *r]),
        Shape::Cylinder { r, h } => ([px, py, pz], [*r, *h, *r]),
        Shape::Cone { r, h } => ([px, py + h * 0.5, pz], [*r, h * 0.5, *r]),
        Shape::Extrude { verts, h, .. } => {
            // Twist sweeps the polygon within its circumradius.
            let mut r_max = 0.0f64;
            for i in 0..(verts.len() / 2) {
                r_max = r_max.max(verts[i * 2].hypot(verts[i * 2 + 1]));
            }
            ([px, py, pz], [r_max, *h, r_max])
        }
        Shape::Loft { profs, h, .. } => {
            let mut r_max_x = 0.0f64;
            let mut r_max_z = 0.0f64;
            for pr in profs {
                for i in 0..(pr.len() / 2) {
                    r_max_x = r_max_x.max(pr[i * 2].abs());
                    r_max_z = r_max_z.max(pr[i * 2 + 1].abs());
                }
            }
            ([px, py, pz], [r_max_x, *h, r_max_z])
        }
        Shape::Lathe { edges } => {
            let mut max_r = 0.0f64;
            let mut min_y = f64::INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            // Each edge runs vertex k → k+1; (r0,y0) covers every vertex over the loop.
            for e in edges {
                max_r = max_r.max(e.r0.abs());
                min_y = min_y.min(e.y0);
                max_y = max_y.max(e.y0);
            }
            ([px, py + (min_y + max_y) * 0.5, pz], [max_r, (max_y - min_y) * 0.5, max_r])
        }
    }
}

/// Collect leaves in left-to-right CSG traversal order (matches the strata-build
/// order and `assign_leaf_indices`).
fn collect_leaves<'a>(node: &'a CsgNode, out: &mut Vec<&'a Leaf>) {
    match node {
        CsgNode::Leaf(l) => out.push(l),
        CsgNode::Min(ch) | CsgNode::Max(ch) => {
            for c in ch {
                collect_leaves(c, out);
            }
        }
        CsgNode::Blend { children, .. } => {
            for c in children {
                collect_leaves(c, out);
            }
        }
    }
}

/// Bottom-up fill of the symmetric per-pair seam-displacement matrix. Every
/// cross-child leaf pair of a combiner has that combiner as its LCA. Port of
/// `buildSeamDisplacementMap`.
fn build_seam_displacement(root: &CsgNode, leaf_count: usize, leaf_index_of: &dyn Fn(&Leaf) -> usize) -> Vec<f64> {
    let mut map = vec![0.0f64; leaf_count * leaf_count];
    visit_seam(root, &mut map, leaf_count, leaf_index_of);
    map
}

fn visit_seam(node: &CsgNode, map: &mut [f64], leaf_count: usize, leaf_index_of: &dyn Fn(&Leaf) -> usize) -> Vec<usize> {
    match node {
        CsgNode::Leaf(l) => vec![leaf_index_of(l)],
        CsgNode::Min(ch) | CsgNode::Max(ch) => {
            let child_sets: Vec<Vec<usize>> = ch.iter().map(|c| visit_seam(c, map, leaf_count, leaf_index_of)).collect();
            // Hard combiner: displacement 0 (matrix already zero).
            child_sets.into_iter().flatten().collect()
        }
        CsgNode::Blend { mode, r, n, .. } => {
            let children = match node {
                CsgNode::Blend { children, .. } => children,
                _ => unreachable!(),
            };
            let child_sets: Vec<Vec<usize>> =
                children.iter().map(|c| visit_seam(c, map, leaf_count, leaf_index_of)).collect();
            let disp = smin(*mode, 0.0, 0.0, *r, *n).abs();
            for i in 0..child_sets.len() {
                for j in (i + 1)..child_sets.len() {
                    for &a in &child_sets[i] {
                        for &b in &child_sets[j] {
                            map[a * leaf_count + b] = disp;
                            map[b * leaf_count + a] = disp;
                        }
                    }
                }
            }
            child_sets.into_iter().flatten().collect()
        }
    }
}

/// Build the tree view: per-leaf AABBs/strata-ranges, the global stratum list,
/// and the seam-displacement matrix. `build_leaf_strata` produces each leaf's
/// strata given `(leaf, leaf_index, first_id)` — the same builder
/// `compile_native_features` uses, so ids agree.
pub fn build_tree<'a>(
    root: &'a CsgNode,
    mut build_leaf_strata: impl FnMut(&Leaf, usize, usize) -> Vec<Stratum>,
) -> SfccTree<'a> {
    let mut leaf_refs: Vec<&Leaf> = Vec::new();
    collect_leaves(root, &mut leaf_refs);
    let leaf_count = leaf_refs.len();

    let mut strata: Vec<Stratum> = Vec::new();
    let mut leaves: Vec<LeafView> = Vec::with_capacity(leaf_count);
    for (leaf_index, leaf) in leaf_refs.iter().enumerate() {
        let first_id = strata.len();
        let leaf_strata = build_leaf_strata(leaf, leaf_index, first_id);
        let strata_start = first_id;
        let strata_end = first_id + leaf_strata.len();
        strata.extend(leaf_strata);
        let (c, h) = local_aabb_box(&leaf.shape, leaf.pos);
        leaves.push(LeafView { aabb: world_aabb_of_local_box(leaf, c, h), strata_start, strata_end });
    }

    // Map each leaf reference to its traversal index (by pointer identity in the
    // same left-to-right order collect_leaves produced).
    let leaf_index_of = |target: &Leaf| -> usize {
        leaf_refs.iter().position(|l| std::ptr::eq(*l, target)).expect("leaf in tree")
    };
    let seam_disp = build_seam_displacement(root, leaf_count, &leaf_index_of);

    SfccTree { root, leaves, strata, seam_disp, leaf_count }
}
