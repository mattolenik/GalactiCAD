//! S2 refinement criteria — the smooth-surface certificates. Port of the
//! SMOOTH-ONLY paths of `src/export/sfcc/refine-criteria.mts`. Cheap-first
//! ordering; `true` means the cell must split.
//!
//! Criterion (0), the certified empty cull (`CsgNode::interval_over_box` excludes
//! 0), lives in the octree descent itself — culled cells are never created.
//!
//! Implemented here:
//! - (iii-b) per-stratum normal variation: for each smooth patch active near the
//!   cell, stratum normals at the 8 corners + center must agree pairwise to
//!   `normal_variation_cos` (Plantinga–Vegter small-normal-variation surrogate).
//! - (iii-c) per-stratum edge-crossing uniqueness: SIGN-CHANGE edges must have a
//!   monotone directional derivative along the edge.
//! - (iii-d) blend-region curvature: max pairwise deviation of the TREE's own
//!   ∇f over near-surface (and, in the mixed-cell variant, zero-owner) probes.
//!
//! M4c-1 added the FEATURE criteria (i)/(ii) — [`classify_cell_features`]:
//! at-most-one-curve-through + corner-claim (i), per-face transversal
//! single-crossing (ii), and the pin-visibility certificate. The octree driver
//! ([`crate::sfcc::octree::build_octree_feature_aware`]) splits on classify ∨
//! smooth and stamps each leaf's `feature_curve` / `feature_corner`. DEFERRED to
//! M4c-2: the face-contour / cell-mesh paths that consume those tags.

use crate::math::grid::{
    cell_aabb, cell_center_world, cell_size_at_level, corner_offset, point_to_world, stride_at_level, SfccLattice,
    CELL_EDGES,
};
use crate::sdf::SdfQuery;
use crate::sfcc::feature_set::SfccFeatureSet;
use crate::strata::Stratum;
use std::collections::HashSet;

const SQRT_3: f64 = 1.732_050_807_568_877_2;

/// Probe data for one cell: the 8 corners (then the center) world positions and
/// `f` values. Corner f comes from the octree's shared sample cache; the center
/// f is evaluated directly (not lattice-keyed, never shared).
pub struct RefineProbe {
    /// World positions: 8 corners (xyz) then the center (xyz) — 27 floats.
    pub pts: [f64; 27],
    /// f at the 8 corners then the center — 9 floats.
    pub f: [f64; 9],
    pub level: u32,
    pub cell_size: f64,
}

/// Build the probe data for a cell. Corner f values come from the octree's
/// shared sampler `sample_at(gx, gy, gz)`. Port of `makeProbe`.
pub fn make_probe<F: Fn(i64, i64, i64) -> f64, T: SdfQuery + ?Sized>(
    lat: &SfccLattice,
    tree: &T,
    sample_at: F,
    level: u32,
    ix: i64,
    iy: i64,
    iz: i64,
) -> RefineProbe {
    let stride = stride_at_level(lat, level);
    let mut pts = [0.0f64; 27];
    let mut f = [0.0f64; 9];
    for c in 0..8 {
        let gx = (ix + corner_offset(c, 0)) * stride;
        let gy = (iy + corner_offset(c, 1)) * stride;
        let gz = (iz + corner_offset(c, 2)) * stride;
        let w = point_to_world(lat, gx, gy, gz);
        pts[c * 3] = w[0];
        pts[c * 3 + 1] = w[1];
        pts[c * 3 + 2] = w[2];
        f[c] = sample_at(gx, gy, gz);
    }
    // Center f: evaluated directly on the tree (not lattice-keyed, never shared).
    let cw = cell_center_world(lat, level, ix, iy, iz);
    pts[24] = cw[0];
    pts[25] = cw[1];
    pts[26] = cw[2];
    f[8] = tree.f([cw[0], cw[1], cw[2]]);
    RefineProbe { pts, f, level, cell_size: cell_size_at_level(lat, level) }
}

/// Any corner sign change ⇒ the cell touches the surface. Port of `hasCornerSignChange`.
pub fn has_corner_sign_change(probe: &RefineProbe) -> bool {
    let first = probe.f[0] < 0.0;
    for c in 1..8 {
        if (probe.f[c] < 0.0) != first {
            return true;
        }
    }
    false
}

/// Strata active near this cell: for each probe point within √3·cellSize·gradBound
/// of the surface, the winning leaf's closest patch. Deduplicated by stratum id,
/// in first-encounter order. Port of `activeStrata`.
pub fn active_strata<'a, T: SdfQuery + ?Sized>(tree: &'a T, probe: &RefineProbe, grad_bound: f64) -> Vec<&'a Stratum> {
    let mut out: Vec<&Stratum> = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    let reach = SQRT_3 * probe.cell_size * grad_bound;
    for i in 0..9 {
        if probe.f[i].abs() >= reach {
            continue;
        }
        let x = probe.pts[i * 3];
        let y = probe.pts[i * 3 + 1];
        let z = probe.pts[i * 3 + 2];
        for owner in tree.active_owners_at([x, y, z], 0.0) {
            let mut best: Option<&Stratum> = None;
            let mut best_abs = f64::INFINITY;
            for st in owner.leaf.strata.iter() {
                let a = st.f(x, y, z).abs();
                if a < best_abs {
                    best_abs = a;
                    best = Some(st);
                }
            }
            if let Some(b) = best {
                if seen.insert(b.id) {
                    out.push(b);
                }
            }
        }
    }
    out
}

/// (iii-b): max pairwise normal deviation of `stratum` over the 9 probe points.
/// Port of `stratumNormalVariationOk`.
pub fn stratum_normal_variation_ok(stratum: &Stratum, probe: &RefineProbe, min_cos: f64) -> bool {
    let mut n = [0.0f64; 27];
    for i in 0..9 {
        let g = stratum.normal(probe.pts[i * 3], probe.pts[i * 3 + 1], probe.pts[i * 3 + 2]);
        n[i * 3] = g[0];
        n[i * 3 + 1] = g[1];
        n[i * 3 + 2] = g[2];
    }
    for i in 0..9 {
        for j in (i + 1)..9 {
            let dot = n[i * 3] * n[j * 3] + n[i * 3 + 1] * n[j * 3 + 1] + n[i * 3 + 2] * n[j * 3 + 2];
            if dot < min_cos {
                return false;
            }
        }
    }
    true
}

/// (iii-c): per-cell-edge single-crossing check for one stratum, on SIGN-CHANGE
/// edges only: the directional derivative along the edge must not change sign
/// between endpoints. Port of `stratumEdgeCrossingsOk`.
pub fn stratum_edge_crossings_ok(stratum: &Stratum, probe: &RefineProbe) -> bool {
    for &[ca, cb] in CELL_EDGES.iter() {
        let ax = probe.pts[ca * 3];
        let ay = probe.pts[ca * 3 + 1];
        let az = probe.pts[ca * 3 + 2];
        let bx = probe.pts[cb * 3];
        let by = probe.pts[cb * 3 + 1];
        let bz = probe.pts[cb * 3 + 2];
        let fa = stratum.f(ax, ay, az);
        let fb = stratum.f(bx, by, bz);
        if (fa < 0.0) == (fb < 0.0) {
            continue;
        }
        let len = probe.cell_size;
        let ex = (bx - ax) / len;
        let ey = (by - ay) / len;
        let ez = (bz - az) / len;
        let ga = stratum.normal(ax, ay, az);
        let da = ga[0] * ex + ga[1] * ey + ga[2] * ez;
        let gb = stratum.normal(bx, by, bz);
        let db = gb[0] * ex + gb[1] * ey + gb[2] * ez;
        if da * db <= 0.0 {
            return false;
        }
    }
    true
}

/// (iii-d) blend-region curvature: max pairwise deviation of the TREE's own ∇f
/// over near-surface probe points. Port of `treeNormalVariationOk`. Only used
/// where `active_strata` is empty (the blend band).
pub fn tree_normal_variation_ok<T: SdfQuery + ?Sized>(tree: &T, probe: &RefineProbe, min_cos: f64, grad_bound: f64) -> bool {
    let reach = SQRT_3 * probe.cell_size * grad_bound;
    let mut ns = [0.0f64; 27];
    let mut k = 0usize;
    for i in 0..9 {
        if probe.f[i].abs() >= reach {
            continue;
        }
        let (_v, g) = tree.grad([probe.pts[i * 3], probe.pts[i * 3 + 1], probe.pts[i * 3 + 2]]);
        let l = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
        if l < 1e-12 {
            continue;
        }
        ns[k * 3] = g[0] / l;
        ns[k * 3 + 1] = g[1] / l;
        ns[k * 3 + 2] = g[2] / l;
        k += 1;
    }
    pairwise_cos_ok(&ns, k, min_cos)
}

/// (iii-d, mixed-cell variant) blend curvature restricted to "blend-band" probe
/// points (zero analytic owners). Port of `treeBlendBandNormalVariationOk`.
pub fn tree_blend_band_normal_variation_ok<T: SdfQuery + ?Sized>(
    tree: &T,
    probe: &RefineProbe,
    min_cos: f64,
    grad_bound: f64,
) -> bool {
    let reach = SQRT_3 * probe.cell_size * grad_bound;
    let mut ns = [0.0f64; 27];
    let mut k = 0usize;
    for i in 0..9 {
        if probe.f[i].abs() >= reach {
            continue;
        }
        let x = probe.pts[i * 3];
        let y = probe.pts[i * 3 + 1];
        let z = probe.pts[i * 3 + 2];
        if !tree.active_owners_at([x, y, z], 0.0).is_empty() {
            continue; // analytic owner ⇒ not a blend-band point
        }
        let (_v, g) = tree.grad([x, y, z]);
        let l = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
        if l < 1e-12 {
            continue;
        }
        ns[k * 3] = g[0] / l;
        ns[k * 3 + 1] = g[1] / l;
        ns[k * 3 + 2] = g[2] / l;
        k += 1;
    }
    pairwise_cos_ok(&ns, k, min_cos)
}

/// Shared pairwise-dot gate over the first `k` unit normals in a flat buffer.
fn pairwise_cos_ok(ns: &[f64; 27], k: usize, min_cos: f64) -> bool {
    for i in 0..k {
        for j in (i + 1)..k {
            let dot = ns[i * 3] * ns[j * 3] + ns[i * 3 + 1] * ns[j * 3 + 1] + ns[i * 3 + 2] * ns[j * 3 + 2];
            if dot < min_cos {
                return false;
            }
        }
    }
    true
}

/// P3 smooth criteria options (loop-invariant; depend only on tuning).
#[derive(Clone, Copy, Debug)]
pub struct SmoothCriteriaOptions {
    /// cos(normal_variation_deg).
    pub normal_variation_cos: f64,
    /// cos(blend_curvature_deg); ≥1 disables (iii-d).
    pub blend_normal_variation_cos: f64,
}

/// Combined P3 criteria: returns true when the cell needs splitting. Port of
/// `needsSplitSmooth`. `grad_bound` / `has_blend` are the tree-level advisories
/// (`CsgNode::grad_bound` / `CsgNode::has_blend`), hoisted by the caller.
pub fn needs_split_smooth<T: SdfQuery + ?Sized>(
    tree: &T,
    probe: &RefineProbe,
    opts: &SmoothCriteriaOptions,
    grad_bound: f64,
    has_blend: bool,
) -> bool {
    if !has_corner_sign_change(probe) {
        return false; // inactive cell
    }
    let strata = active_strata(tree, probe, grad_bound);
    if strata.is_empty() {
        // Blend region (no analytic carrier): certify the tree surface directly.
        return opts.blend_normal_variation_cos < 1.0
            && !tree_normal_variation_ok(tree, probe, opts.blend_normal_variation_cos, grad_bound);
    }
    for st in &strata {
        if !stratum_normal_variation_ok(st, probe, opts.normal_variation_cos) {
            return true;
        }
        if !stratum_edge_crossings_ok(st, probe) {
            return true;
        }
    }
    // Mixed cell: a stratum is active, but the cell may also straddle a blend
    // band. Certify that band's ∇f curvature — gated to trees that contain a
    // blend so hard/primitive-only geometry stays zero-cost.
    if has_blend
        && opts.blend_normal_variation_cos < 1.0
        && !tree_blend_band_normal_variation_ok(tree, probe, opts.blend_normal_variation_cos, grad_bound)
    {
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Feature criteria (i)/(ii) — design doc §3.2 S2. Port of `classifyCellFeatures`.
// ---------------------------------------------------------------------------

/// Feature-criteria options (loop-invariant; depend only on tuning).
#[derive(Clone, Copy, Debug)]
pub struct FeatureCriteriaOptions {
    /// Cell AABB inflation, in fractions of the cell size, for index queries.
    pub feature_query_inflate: f64,
    /// |tangent·faceNormal| below this counts as tangential → split.
    pub tangential_epsilon: f64,
}

/// Result of classifying a cell against the feature set. Port of `FeatureCellClass`.
#[derive(Clone, Copy, Debug)]
pub struct FeatureCellClass {
    pub split: bool,
    /// Curve passing through the cell (−1 = none). Valid when `!split`.
    pub curve: i64,
    /// Corner inside the cell (−1 = none).
    pub corner: i64,
}

/// Classify a cell against the feature set:
/// - (i) at most one curve passes through (entry/exit = exactly 2 boundary
///   crossings); corners → split until corner cells land;
/// - (ii) each curve crosses each face at most once, transversally; an in-cell
///   curve portion with no boundary crossings (contained loop / endpoint
///   inside) splits;
/// - pin-visibility certificate over the pinned faces.
///
/// Port of `classifyCellFeatures` (`src/export/sfcc/refine-criteria.mts`). The
/// `curvesInBox` set is sorted by id so the (order-independent) classification
/// of a KEPT leaf is also deterministic across runs.
pub fn classify_cell_features(
    features: &SfccFeatureSet,
    lat: &SfccLattice,
    level: u32,
    ix: i64,
    iy: i64,
    iz: i64,
    opts: &FeatureCriteriaOptions,
) -> FeatureCellClass {
    let box_ = cell_aabb(lat, level, ix, iy, iz);
    let size = cell_size_at_level(lat, level);
    let inflate = opts.feature_query_inflate * size;
    let qmin = [box_[0] - inflate, box_[1] - inflate, box_[2] - inflate];
    let qmax = [box_[3] + inflate, box_[4] + inflate, box_[5] + inflate];

    // Corner clause of (i): a cell containing exactly ONE corner passes iff every
    // feature curve touching the cell is incident to that corner.
    let mut corner_in_cell: i64 = -1;
    let corner_ids = features.index.corners_in_box(qmin, qmax);
    for cid in corner_ids {
        let c = &features.corners[cid];
        if c.x >= box_[0]
            && c.x <= box_[3]
            && c.y >= box_[1]
            && c.y <= box_[4]
            && c.z >= box_[2]
            && c.z <= box_[5]
        {
            if corner_in_cell >= 0 {
                return FeatureCellClass { split: true, curve: -1, corner: cid as i64 }; // two corners
            }
            corner_in_cell = cid as i64;
        }
    }
    // The corner's incident curve-end ids, if a corner is in the cell.
    let corner_curves: Option<HashSet<usize>> = if corner_in_cell >= 0 {
        Some(features.corners[corner_in_cell as usize].curve_ends.iter().map(|e| e.0).collect())
    } else {
        None
    };

    let mut through_curve: i64 = -1;
    let mut curve_ids = features.index.curves_in_box(qmin, qmax);
    curve_ids.sort_unstable();
    for curve_id in curve_ids {
        let curve = &features.curves[curve_id];
        let mut total = 0usize;
        // Faces with exactly one crossing — collected as (axis, coord) for the pin
        // certificate. At most 6 faces.
        let mut crossing_faces: Vec<(usize, f64)> = Vec::new();
        for axis in 0..3usize {
            for side in 0..2usize {
                let coord = box_[axis + if side == 1 { 3 } else { 0 }];
                let mut per_face = 0usize;
                let crossings = curve.axis_plane_crossings(axis, coord);
                for cr in &crossings {
                    // In-rect test on the other two axes (closed interval).
                    let px = [cr.x, cr.y, cr.z];
                    let mut inside = true;
                    for a in 0..3usize {
                        if a == axis {
                            continue;
                        }
                        if px[a] < box_[a] || px[a] > box_[a + 3] {
                            inside = false;
                            break;
                        }
                    }
                    if !inside {
                        continue;
                    }
                    per_face += 1;
                    if cr.tangential_dot < opts.tangential_epsilon {
                        return FeatureCellClass { split: true, curve: curve_id as i64, corner: -1 }; // tangential
                    }
                }
                if per_face > 1 {
                    return FeatureCellClass { split: true, curve: curve_id as i64, corner: -1 }; // (ii)
                }
                if per_face == 1 {
                    crossing_faces.push((axis, coord));
                }
                total += per_face;
            }
        }
        // Pin-visibility certificate: on a pinned face, the surface arc through the
        // pin must reach the face boundary on BOTH stratum sides — each adjacent
        // stratum's carrier changes sign over the face corners. Otherwise the arc
        // enters and exits through one boundary sub-edge (an invisible even
        // crossing) and the pin cannot be routed: split.
        if total == 2 {
            let mut pin_split = false;
            'pin: for &(axis, coord) in &crossing_faces {
                for &sid in &curve.adjacent_strata {
                    let st = &features.strata[sid];
                    let mut neg = false;
                    let mut pos = false;
                    let (u, v) = if axis == 0 {
                        (1usize, 2usize)
                    } else if axis == 1 {
                        (0usize, 2usize)
                    } else {
                        (0usize, 1usize)
                    };
                    for cu in 0..2usize {
                        for cv in 0..2usize {
                            let mut pt = [0.0f64; 3];
                            pt[axis] = coord;
                            pt[u] = box_[u + cu * 3];
                            pt[v] = box_[v + cv * 3];
                            if st.f(pt[0], pt[1], pt[2]) < 0.0 {
                                neg = true;
                            } else {
                                pos = true;
                            }
                        }
                    }
                    if !neg || !pos {
                        pin_split = true;
                        break 'pin;
                    }
                }
            }
            if pin_split {
                return FeatureCellClass { split: true, curve: curve_id as i64, corner: -1 };
            }
        }
        if total == 0 {
            // No boundary crossings — is any part of the curve inside the cell?
            let cx = (box_[0] + box_[3]) / 2.0;
            let cy = (box_[1] + box_[4]) / 2.0;
            let cz = (box_[2] + box_[5]) / 2.0;
            let (pr_t, _) = curve.project(cx, cy, cz);
            let q = curve.point_at(pr_t);
            let inside_cell = q[0] >= box_[0]
                && q[0] <= box_[3]
                && q[1] >= box_[1]
                && q[1] <= box_[4]
                && q[2] >= box_[2]
                && q[2] <= box_[5];
            if inside_cell {
                return FeatureCellClass { split: true, curve: curve_id as i64, corner: -1 }; // contained loop/segment
            }
            continue; // index false positive — curve does not touch the cell
        }
        if let Some(cc) = &corner_curves {
            // Corner cell: every touching curve must be one of the corner's
            // incident curves, entering once (its other end is the corner).
            if !cc.contains(&curve_id) || total != 1 {
                return FeatureCellClass { split: true, curve: curve_id as i64, corner: corner_in_cell };
            }
            continue;
        }
        if total != 2 {
            return FeatureCellClass { split: true, curve: curve_id as i64, corner: -1 }; // endpoint inside / multi-entry
        }
        if through_curve >= 0 {
            return FeatureCellClass { split: true, curve: curve_id as i64, corner: -1 }; // (i): two curves
        }
        through_curve = curve_id as i64;
    }
    if corner_in_cell >= 0 {
        return FeatureCellClass { split: false, curve: -1, corner: corner_in_cell };
    }
    FeatureCellClass { split: false, curve: through_curve, corner: -1 }
}
