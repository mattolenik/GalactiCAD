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
//! DEFERRED to M4: the feature criteria (i)/(ii), `classify_cell_features`,
//! feature curves/corners.

use crate::math::grid::{
    cell_center_world, cell_size_at_level, corner_offset, point_to_world, stride_at_level, SfccLattice, CELL_EDGES,
};
use crate::sdf::CsgNode;
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
pub fn make_probe<F: Fn(i64, i64, i64) -> f64>(
    lat: &SfccLattice,
    tree: &CsgNode,
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
pub fn active_strata<'a>(tree: &'a CsgNode, probe: &RefineProbe, grad_bound: f64) -> Vec<&'a Stratum> {
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
pub fn tree_normal_variation_ok(tree: &CsgNode, probe: &RefineProbe, min_cos: f64, grad_bound: f64) -> bool {
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
pub fn tree_blend_band_normal_variation_ok(tree: &CsgNode, probe: &RefineProbe, min_cos: f64, grad_bound: f64) -> bool {
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
pub fn needs_split_smooth(
    tree: &CsgNode,
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
