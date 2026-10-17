//! S2 refinement criteria — sampled smooth-surface checks and optional heuristics. Port of the
//! SMOOTH-ONLY paths of `src/export/sfcc/refine-criteria.mts`. Cheap-first
//! ordering; `true` means the cell must split.
//!
//! Criterion (0), the certified empty cull (`CsgNode::interval_over_box` excludes
//! 0), lives in the octree descent itself — culled cells are never created.
//!
//! Implemented here:
//! - Necessary original-tree sphere/box discovery via strict corner signs and
//!   same-sign edge/face exclusion, before feature-corner exemptions.
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
use crate::sdf::{CsgNode, Indeterminate, Leaf, SdfQuery, ZeroOwner};
use crate::sfcc::feature_set::SfccFeatureSet;
use crate::strata::{CarrierKind, Stratum};
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
    // Private: all production probes must use make_probe's actual cell region.
    whole_cell_box: Option<([f64;3], [f64;3])>,
}

impl RefineProbe {
    fn whole_cell_box(&self) -> Option<([f64;3], [f64;3])> {
        let (c,h)=self.whole_cell_box?;
        if c.iter().any(|x|!x.is_finite()) || h.iter().any(|x|!x.is_finite() || *x<0.) { return None; }
        // Public sample coordinates can be edited after construction. Never
        // certify a narrower region if those samples have moved outside it.
        for point in self.pts.chunks_exact(3) {
            for a in 0..3 {
                if !point[a].is_finite() { return None; }
                if point[a]!=c[a] && (point[a]-c[a]).abs().next_up()>h[a] { return None; }
            }
        }
        Some((c,h))
    }
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
    RefineProbe { pts, f, level, cell_size: cell_size_at_level(lat, level),
        whole_cell_box: crate::math::grid::cell_enclosure(lat,level,ix,iy,iz) }
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

/// Necessary primitive visibility only; passing does not certify components.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscoveryCheck {
    NoDiscoveryRejection {
        /// A surviving blend/unsupported scope is outside this guard's theorem.
        opaque: bool,
    },
    NeedsSplit,
    Indeterminate,
}

impl DiscoveryCheck {
    pub fn needs_split(self) -> bool {
        !matches!(self, Self::NoDiscoveryRejection { .. })
    }
}

/// Enclose the actual endpoint coordinates, including midpoint roundoff. Zero
/// extents stay zero for point, edge and face interval queries.
fn enclosing_box(lo: [f64; 3], hi: [f64; 3]) -> Result<([f64; 3], [f64; 3]), Indeterminate> {
    crate::sdf::enclosure::enclosing_box(lo, hi).ok_or(Indeterminate)
}

/// Check original signed sphere/box occurrences, never the sampled winners or
/// a coarse pruned tree. Supported numeric signs enclose the represented real
/// field; primitive visibility is still not a component-coverage certificate.
pub fn discovery_guard(root: &CsgNode, probe: &RefineProbe) -> DiscoveryCheck {
    crate::sfcc::perf::add(18, 1);
    let result = match check_discovery(root, probe) {
        Ok(result) => result,
        Err(Indeterminate) => { #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("discovery_indeterminate", None); DiscoveryCheck::Indeterminate },
    };
    match result {
        DiscoveryCheck::NeedsSplit => crate::sfcc::perf::add(25, 1),
        DiscoveryCheck::Indeterminate => crate::sfcc::perf::add(26, 1),
        _ => {}
    }
    result
}

fn check_discovery(root: &CsgNode, probe: &RefineProbe) -> Result<DiscoveryCheck, Indeterminate> {
    if !probe.cell_size.is_finite() || probe.cell_size <= 0.0 {
        return Err(Indeterminate);
    }
    let point = |i: usize| [probe.pts[i * 3], probe.pts[i * 3 + 1], probe.pts[i * 3 + 2]];
    let lo = point(0);
    let hi = point(7);
    if (0..3).any(|a| lo[a] >= hi[a] || !probe.pts[24 + a].is_finite()
        || probe.pts[24 + a] < lo[a] || probe.pts[24 + a] > hi[a])
    {
        return Err(Indeterminate);
    }
    let (c, half) = probe.whole_cell_box().ok_or(Indeterminate)?;
    for i in 0..8 {
        for a in 0..3 {
            if probe.pts[i * 3 + a] != if i & (1 << a) == 0 { lo[a] } else { hi[a] } {
                return Err(Indeterminate);
            }
        }
    }
    let owners = root.zero_owners_over_box(c, half)?;
    #[cfg(feature = "sfcc-profile")]
    crate::sfcc::perf::add(21, owners.entries.iter().filter(|e| matches!(e, ZeroOwner::Primitive(_))).count());
    if owners.interval.0 > 0.0 || owners.interval.1 < 0.0 {
        crate::sfcc::perf::add(29, 1);
        return Ok(DiscoveryCheck::NoDiscoveryRejection { opaque: false });
    }
    let mut opaque = false;
    let mut corner_signs = Vec::with_capacity(owners.entries.len());
    for owner in owners.entries {
        let ZeroOwner::Primitive(leaf) = owner else {
            opaque = true;
            continue;
        };
        let mut negative = 0u8;
        for i in 0..8 {
            crate::sfcc::perf::add(22, 1);
            let (a, b) = leaf.discovery_interval_over_box(point(i), [0.0; 3])?;
            if b < 0.0 {
                negative |= 1 << i;
            } else if a <= 0.0 {
                #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("discovery_corner_zero_or_uncertain", Some(leaf.index));
                return Ok(DiscoveryCheck::NeedsSplit);
            }
        }
        if negative == 0 || negative == u8::MAX {
            #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("discovery_primitive_no_corner_sign_change", Some(leaf.index));
            return Ok(DiscoveryCheck::NeedsSplit);
        }
        for &[a, b] in &CELL_EDGES {
            if (negative >> a) & 1 == (negative >> b) & 1 {
                let (ec, eh) = enclosing_box(point(a), point(b))?;
                crate::sfcc::perf::add(23, 1);
                let (l, h) = leaf.discovery_interval_over_box(ec, eh)?;
                if l <= 0.0 && h >= 0.0 {
                    #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("discovery_same_sign_edge", Some(leaf.index));
                    return Ok(DiscoveryCheck::NeedsSplit);
                }
            }
        }
        for axis in 0..3 {
            for side in 0..2 {
                let first = side << axis;
                let last = first | (7 ^ (1 << axis));
                let sign = (negative >> first) & 1;
                if (0..8).filter(|i| (i >> axis) & 1 == side).all(|i| (negative >> i) & 1 == sign) {
                    let (fc, fh) = enclosing_box(point(first), point(last))?;
                    crate::sfcc::perf::add(24, 1);
                    let (l, h) = leaf.discovery_interval_over_box(fc, fh)?;
                    if l <= 0.0 && h >= 0.0 {
                        #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("discovery_same_sign_face", Some(leaf.index));
                        return Ok(DiscoveryCheck::NeedsSplit);
                    }
                }
            }
        }
        corner_signs.push((leaf, negative));
    }
    if !opaque {
        // Removed children are strict neutral signs at each retained ancestor
        // (positive at Min, negative at Max). Reuse the reliable leaf signs in
        // original tree order instead of eight extra whole-tree interval queries.
        let mut next = 0;
        let signs = retained_corner_signs(root, &corner_signs, &mut next).ok_or(Indeterminate)?;
        if next != corner_signs.len() {
            return Err(Indeterminate);
        }
        if signs == 0 || signs == u8::MAX {
            #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("discovery_root_no_corner_sign_change", None);
            return Ok(DiscoveryCheck::NeedsSplit);
        }
    }
    Ok(DiscoveryCheck::NoDiscoveryRejection { opaque })
}

fn retained_corner_signs(root: &CsgNode, signs: &[(&Leaf, u8)], next: &mut usize) -> Option<u8> {
    crate::sfcc::perf::add(28, 1);
    match root {
        CsgNode::Leaf(leaf) => {
            let &(candidate, bits) = signs.get(*next)?;
            if std::ptr::eq(leaf, candidate) {
                *next += 1;
                Some(bits)
            } else {
                None
            }
        }
        CsgNode::Min(children) | CsgNode::Max(children) => {
            let mut result = None;
            for child in children {
                if let Some(bits) = retained_corner_signs(child, signs, next) {
                    result = Some(match result {
                        None => bits,
                        Some(prev) if matches!(root, CsgNode::Min(_)) => prev | bits,
                        Some(prev) => prev & bits,
                    });
                }
            }
            result
        }
        CsgNode::Blend { .. } => None,
    }
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
    let mut idx = [0usize; 9];
    let mut m = 0usize;
    for i in 0..9 {
        if probe.f[i].abs() < reach {
            idx[m] = i;
            m += 1;
        }
    }
    let mut ns = [0.0f64; 27];
    let k = cone_normals_via_pairs(tree, probe, &idx[..m], &mut ns);
    pairwise_cos_ok(&ns, k, min_cos)
}

/// Push the normalized tree-∇f normals for `idx` probe points into `ns`, returning the
/// count kept (degenerate ∇f skipped). Evaluates in PAIRS via [`SdfQuery::grad_pair`]
/// — the f64x2 SIMD hook on the concrete trees (scalar otherwise). Pairwise cos is
/// order-independent, so packing kept normals contiguously is sound.
fn cone_normals_via_pairs<T: SdfQuery + ?Sized>(
    tree: &T,
    probe: &RefineProbe,
    idx: &[usize],
    ns: &mut [f64; 27],
) -> usize {
    let pt = |i: usize| [probe.pts[i * 3], probe.pts[i * 3 + 1], probe.pts[i * 3 + 2]];
    let mut k = 0usize;
    let push = |g: [f64; 3], ns: &mut [f64; 27], k: &mut usize| {
        let l = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
        if l >= 1e-12 {
            ns[*k * 3] = g[0] / l;
            ns[*k * 3 + 1] = g[1] / l;
            ns[*k * 3 + 2] = g[2] / l;
            *k += 1;
        }
    };
    let mut j = 0usize;
    while j + 1 < idx.len() {
        let ((_, g0), (_, g1)) = tree.grad_pair(pt(idx[j]), pt(idx[j + 1]));
        push(g0, ns, &mut k);
        push(g1, ns, &mut k);
        j += 2;
    }
    if j < idx.len() {
        let (_, g) = tree.grad(pt(idx[j]));
        push(g, ns, &mut k);
    }
    k
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
    let mut idx = [0usize; 9];
    let mut m = 0usize;
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
        idx[m] = i;
        m += 1;
    }
    let mut ns = [0.0f64; 27];
    let k = cone_normals_via_pairs(tree, probe, &idx[..m], &mut ns);
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
    /// Optional per-carrier curvature heuristic: split if κ·cellSize > θ.
    /// A cell edge is not a certified surface-path length, so this is not an
    /// interval normal-cone certificate. Unsupported carriers use sampled normals.
    pub normal_variation_analytic: bool,
}

/// Discovery followed by P3 criteria: `tree` must be the original full root.
/// `grad_bound` / `has_blend` are the tree-level advisories
/// (`CsgNode::grad_bound` / `CsgNode::has_blend`), hoisted by the caller.
pub fn needs_split_smooth(
    tree: &CsgNode,
    probe: &RefineProbe,
    opts: &SmoothCriteriaOptions,
    grad_bound: f64,
    has_blend: bool,
) -> bool {
    discovery_guard(tree, probe).needs_split()
        || needs_split_smooth_after_discovery(tree, probe, opts, grad_bound, has_blend)
}

/// The feature-aware entries already ran discovery before their corner return.
pub(crate) fn needs_split_smooth_after_discovery<T: SdfQuery + ?Sized>(
    tree: &T,
    probe: &RefineProbe,
    opts: &SmoothCriteriaOptions,
    grad_bound: f64,
    has_blend: bool,
) -> bool {
    if !has_corner_sign_change(probe) {
        // Equal corner signs do not exclude an enclosed component, cavity, or
        // grazing sheet. Resolve every inconclusive box down to the depth ceiling;
        // the octree records an unresolved leaf there instead of silently losing it.
        let Some((c,h)) = probe.whole_cell_box() else { return true; };
        let (lo, hi) = tree.interval_over_box(c, h);
        let split = !(lo > 0.0 || hi < 0.0);
        if split { #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("same_sign_root_interval", None); }
        return split;
    }
    let strata = active_strata(tree, probe, grad_bound);
    if strata.is_empty() {
        // No analytic owner: sample the tree's near-surface normal variation.
        if opts.blend_normal_variation_cos >= 1.0 {
            return false; // (iii-d) disabled
        }
        let split = !tree_normal_variation_ok(tree, probe, opts.blend_normal_variation_cos, grad_bound);
        if split { #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("no_owner_tree_normal_variation", None); }
        return split;
    }
    let nv_theta = opts.normal_variation_cos.clamp(-1.0, 1.0).acos();
    for st in &strata {
        // (iii-b) sampled normals, or the separate optional per-carrier
        // κ·cellSize heuristic. Unsupported carriers retain sampled normals.
        let var_ok = if opts.normal_variation_analytic {
            match st.curvature_bound(&probe.pts, probe.cell_size) {
                Some(kappa) => kappa * probe.cell_size <= nv_theta,
                None => stratum_normal_variation_ok(st, probe, opts.normal_variation_cos),
            }
        } else {
            stratum_normal_variation_ok(st, probe, opts.normal_variation_cos)
        };
        if !var_ok {
            #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("stratum_normal_variation", Some(st.leaf_index));
            return true;
        }
        if !stratum_edge_crossings_ok(st, probe) {
            #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("stratum_edge_crossings", Some(st.leaf_index));
            return true;
        }
    }
    // Loft morph sides: each ruled LoftSide carrier is individually smooth, so the
    // per-carrier cone above passes even where the blended surface kinks BETWEEN
    // adjacent carriers — exactly where a crease is born or dies (the corner-count
    // changes between profiles). The carriers don't fit the true blended surface in
    // that rounding, so the per-stratum test under-refines it to a roughly uniform
    // tessellation. Check the tree's OWN sampled normal variation there to give the
    // apex/merge region the adaptive subdivision a curved surface should get.
    if opts.normal_variation_cos < 1.0
        && strata.iter().any(|st| matches!(st.kind, CarrierKind::LoftSide))
        && !tree_normal_variation_ok(tree, probe, opts.normal_variation_cos, grad_bound)
    {
        #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("loft_tree_normal_variation", None);
        return true;
    }
    // A cell with primitive strata may also contain a blend band.
    if has_blend && opts.blend_normal_variation_cos < 1.0
        && !tree_blend_band_normal_variation_ok(tree, probe, opts.blend_normal_variation_cos, grad_bound)
    {
        #[cfg(feature = "sfcc-profile")] super::diagnosis::reason("blend_band_normal_variation", None);
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
    #[cfg(feature = "sfcc-profile")]
    pub reason: &'static str,
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
                return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_two_corners", split: true, curve: -1, corner: cid as i64 }; // two corners
            }
            corner_in_cell = cid as i64;
        }
    }
    // (No HashSet of the corner's incident curve-ends — a corner cell touches only
    // a few curves, so the membership test below is a direct linear scan over
    // `curve_ends`, which avoids a per-corner-cell heap allocation.)

    let mut through_curve: i64 = -1;
    let curve_ids = features.index.curves_in_box(qmin, qmax);
    for curve_id in curve_ids {
        let curve = &features.curves[curve_id];
        let mut total = 0usize;
        // Faces with exactly one crossing — collected as (axis, coord) for the pin
        // certificate. At most 6 faces → fixed stack array, no per-curve heap alloc.
        let mut crossing_faces: [(usize, f64); 6] = [(0, 0.0); 6];
        let mut crossing_face_count = 0usize;
        for axis in 0..3usize {
            for side in 0..2usize {
                let coord = box_[axis + if side == 1 { 3 } else { 0 }];
                let mut per_face = 0usize;
                let crossings = curve.axis_plane_crossings_cached(axis, coord, curve_id, features.run_id);
                for cr in crossings.iter() {
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
                        return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_tangential_face_crossing", split: true, curve: curve_id as i64, corner: -1 }; // tangential
                    }
                }
                if per_face > 1 {
                    return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_multiple_face_crossings", split: true, curve: curve_id as i64, corner: -1 }; // (ii)
                }
                if per_face == 1 {
                    crossing_faces[crossing_face_count] = (axis, coord);
                    crossing_face_count += 1;
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
            'pin: for &(axis, coord) in &crossing_faces[..crossing_face_count] {
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
                return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_pin_visibility", split: true, curve: curve_id as i64, corner: -1 };
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
                return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_contained_loop_or_segment", split: true, curve: curve_id as i64, corner: -1 }; // contained loop/segment
            }
            continue; // index false positive — curve does not touch the cell
        }
        if corner_in_cell >= 0 {
            // Corner cell: every touching curve must be one of the corner's
            // incident curves, entering once (its other end is the corner). Linear
            // scan over the few incident curve-ends (was a HashSet membership test).
            let incident =
                features.corners[corner_in_cell as usize].curve_ends.iter().any(|e| e.0 == curve_id);
            if !incident || total != 1 {
                return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_corner_incidence", split: true, curve: curve_id as i64, corner: corner_in_cell };
            }
            continue;
        }
        if total != 2 {
            return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_endpoint_or_multi_entry", split: true, curve: curve_id as i64, corner: -1 }; // endpoint inside / multi-entry
        }
        if through_curve >= 0 {
            return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_multiple_curves", split: true, curve: curve_id as i64, corner: -1 }; // (i): two curves
        }
        through_curve = curve_id as i64;
    }
    if corner_in_cell >= 0 {
        return FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_pass", split: false, curve: -1, corner: corner_in_cell };
    }
    FeatureCellClass { #[cfg(feature = "sfcc-profile")] reason: "feature_pass", split: false, curve: through_curve, corner: -1 }
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    use crate::math::similarity::Similarity;
    use crate::primitives::smin::SminMode;
    use crate::sdf::{self, Shape};

    fn probe(tree: &CsgNode, lo: [f64; 3], hi: [f64; 3]) -> RefineProbe {
        let mut pts = [0.0; 27];
        let mut f = [0.0; 9];
        for i in 0..9 {
            let p = std::array::from_fn(|a| {
                if i == 8 { (lo[a] + hi[a]) * 0.5 }
                else if i & (1 << a) == 0 { lo[a] } else { hi[a] }
            });
            pts[i * 3..i * 3 + 3].copy_from_slice(&p);
            f[i] = tree.f(p);
        }
        RefineProbe { pts, f, level: 0, cell_size: hi[0] - lo[0],
            whole_cell_box: enclosing_box(lo,hi).ok() }
    }

    fn sphere(r: f64, pos: [f64; 3]) -> CsgNode {
        sdf::leaf_at(Shape::Sphere { r }, pos)
    }

    const LOOSE: SmoothCriteriaOptions = SmoothCriteriaOptions {
        normal_variation_cos: -1.0,
        blend_normal_variation_cos: 1.0,
        normal_variation_analytic: false,
    };

    #[test]
    fn whole_cell_exclusion_covers_more_than_the_corner_hull() {
        let tree=sphere(1.,[0.;3]);
        let mut p=probe(&tree,[2.,-0.1,-0.1],[2.1,0.1,0.1]);
        // A larger declared cell region contains the exact zero (1,0,0), while
        // its sample corner hull is strictly outside the sphere.
        p.whole_cell_box=enclosing_box([0.,-0.1,-0.1],[2.1,0.1,0.1]).ok();
        assert_eq!(discovery_guard(&tree,&p),DiscoveryCheck::NeedsSplit);
        assert!(needs_split_smooth_after_discovery(&tree,&p,&LOOSE,1.,false));
        p.whole_cell_box=None;
        assert_eq!(discovery_guard(&tree,&p),DiscoveryCheck::Indeterminate);
    }

    #[test]
    fn make_probe_region_includes_the_feature_box_rounding_strip() {
        let lat=crate::math::grid::make_lattice(4,1e15,0.,0.,0.4);
        let tree=sphere(0.125,[1e15+0.625,0.1,0.1]);
        let p=make_probe(&lat,&tree,|x,y,z|tree.f(point_to_world(&lat,x,y,z)),1,1,0,0);
        let b=cell_aabb(&lat,1,1,0,0);
        assert!(b[3]>p.pts[21],"fixture must expose different rounded maps");
        let (c,h)=p.whole_cell_box().expect("factory enclosure");
        assert!(c[0]+h[0]>=b[3]);
        assert!(tree.f([1e15+0.5,0.1,0.1]).abs()==0.);
        assert!(discovery_guard(&tree,&p).needs_split());
    }

    #[test]
    fn hidden_unindexed_primitives_split_even_with_quality_disabled() {
        for tree in [
            sdf::union(vec![
                sdf::leaf_at(Shape::Cuboid { half: [1.25, 3., 3.] }, [-1.75, 0., 0.]),
                sphere(0.1, [0.5, 0., 0.]),
            ]),
            sdf::subtract(
                sdf::leaf_at(Shape::Cuboid { half: [1.75, 3., 3.] }, [-1.25, 0., 0.]),
                sphere(0.1, [0.; 3]),
            ),
        ] {
            let p = probe(&tree, [-1.; 3], [1.; 3]);
            assert!(has_corner_sign_change(&p));
            assert_eq!(discovery_guard(&tree, &p), DiscoveryCheck::NeedsSplit);
            assert!(needs_split_smooth(&tree, &p, &LOOSE, 1.0, false));
        }
    }

    #[test]
    fn ordinary_sphere_and_box_patches_pass() {
        for tree in [sphere(1., [0.; 3]), sdf::leaf_at(Shape::Cuboid { half: [1.; 3] }, [0.; 3])] {
            let p = probe(&tree, [0.8, -0.1, -0.1], [1.2, 0.1, 0.1]);
            assert_eq!(discovery_guard(&tree, &p), DiscoveryCheck::NoDiscoveryRejection { opaque: false });
            assert!(!needs_split_smooth(&tree, &p, &LOOSE, 1., false));
        }
    }

    #[test]
    fn invisible_edge_roots_and_face_loop_request_splits() {
    for (r, lo, hi, face_only) in [
        (1., [0.919, -0.04, -0.04], [0.999, 0.04, 0.04], false),
        (10., [8.99, -0.5, -0.5], [9.99, 0.5, 0.5], true),
    ] {
        let t = sphere(r, [0.; 3]);
        let CsgNode::Leaf(l) = &t else { unreachable!() };
        let p = probe(&t, lo, hi);
        assert!(has_corner_sign_change(&p));
        let high_corner_radius2 = hi[0] * hi[0] + hi[1] * hi[1] + hi[2] * hi[2];
        let high_edge_min_radius2 = hi[0] * hi[0] + hi[1] * hi[1];
        assert!(high_corner_radius2 > r * r);
        assert!(
            hi[0] * hi[0] < r * r,
            "high face has an analytic interior circle"
        );
        assert_eq!(high_edge_min_radius2 > r * r, face_only);
        if face_only {
            for [a, b] in CELL_EDGES {
                if (p.f[a] < 0.) == (p.f[b] < 0.) {
                    let mut min2 = 0.;
                    let mut max2 = 0.;
                    for k in 0..3 {
                        let u = p.pts[a * 3 + k];
                        let v = p.pts[b * 3 + k];
                        min2 += if u.min(v) <= 0. && u.max(v) >= 0. { 0. }
                            else { u.abs().min(v.abs()).powi(2) };
                        max2 += u.abs().max(v.abs()).powi(2);
                    }
                    assert!(max2 < r * r || min2 > r * r);
                }
            }
        }
        let mut uncertain_equal_edges = 0;
        for [a, b] in CELL_EDGES {
            if (p.f[a] < 0.) == (p.f[b] < 0.) {
                let pa = std::array::from_fn(|k| p.pts[a * 3 + k]);
                let pb = std::array::from_fn(|k| p.pts[b * 3 + k]);
                let (c, h) = enclosing_box(pa, pb).unwrap();
                let (l, h) = l.discovery_interval_over_box(c, h).unwrap();
                uncertain_equal_edges += usize::from(l <= 0. && h >= 0.);
            }
        }
        assert_eq!(uncertain_equal_edges == 0, face_only);
        assert_eq!(discovery_guard(&t, &p), DiscoveryCheck::NeedsSplit);
    }
}

    #[test]
    fn opaque_scope_preserves_supported_sibling_guard() {
        let cylinder = sdf::leaf_at(Shape::Cylinder { r: 1., h: 1. }, [0.; 3]);
        let p = probe(&cylinder, [-1.; 3], [1.; 3]);
        let blend = sdf::union_smooth(
            vec![sphere(1., [-0.5, 0., 0.]), sphere(1., [0.5, 0., 0.])],
            SminMode::Round, 0.1, 2.,
        );
        for opaque in [cylinder, blend] {
            assert_eq!(discovery_guard(&opaque, &p), DiscoveryCheck::NoDiscoveryRejection { opaque: true });
            for mixed in [
                sdf::union(vec![opaque.clone(), sphere(0.1, [0.; 3])]),
                sdf::intersect(vec![opaque, sphere(0.1, [0.; 3])]),
            ] {
                assert_eq!(discovery_guard(&mixed, &p), DiscoveryCheck::NeedsSplit);
            }
        }
    }

    #[test]
    fn touching_zero_and_collapsed_cells_are_not_exclusions() {
        let tree = sphere(1., [0.; 3]);
        let p = probe(&tree, [1., 0., 0.], [2., 1., 1.]);
        assert_eq!(discovery_guard(&tree, &p), DiscoveryCheck::NeedsSplit);
        let p = probe(&tree, [1., 0., 0.], [1., 1., 1.]);
        assert_eq!(discovery_guard(&tree, &p), DiscoveryCheck::Indeterminate);
    }

    #[test]
    fn removed_hard_subtree_is_neutral_in_root_sign_fold() {
        let outer = sphere(1., [0.; 3]);
        let p = probe(&outer, [0.8, -0.1, -0.1], [1.2, 0.1, 0.1]);
        let distant = CsgNode::Max(vec![sphere(1., [10.; 3]), sphere(2., [10.; 3])]);
        for tree in [
            CsgNode::Min(vec![distant.clone(), outer.clone()]),
            CsgNode::Min(vec![outer.clone(), distant]),
            CsgNode::Max(vec![CsgNode::Min(vec![sphere(5., [0.; 3]), sphere(6., [0.; 3])]), outer]),
        ] {
            assert_eq!(discovery_guard(&tree, &p), DiscoveryCheck::NoDiscoveryRejection { opaque: false });
        }
    }

    #[test]
    fn every_ancestor_can_exclude_a_nonowning_hidden_occurrence() {
        let patch = sphere(1., [0.; 3]);
        let p = probe(&patch, [0.8, -0.1, -0.1], [1.2, 0.1, 0.1]);
        let hidden = sphere(0.01, [1., 0., 0.]);
        for tree in [
            sdf::union(vec![patch.clone(), sdf::intersect(vec![sphere(1., [100., 0., 0.]), hidden.clone()])]),
            sdf::intersect(vec![sdf::union(vec![hidden, sphere(5., [0.; 3])]), patch]),
        ] {
            assert_eq!(discovery_guard(&tree, &p), DiscoveryCheck::NoDiscoveryRejection { opaque: false });
        }
    }

    #[test]
    fn whole_root_sign_rule_rejects_visible_primitives_but_not_the_hidden_lens_scope_limit() {
        // Every primitive is visible, but the intersection's root corners are all positive.
        let lens = CsgNode::Max(vec![sphere(10.01, [10., 0., 0.]), sphere(10.01, [-10., 0., 0.])]);
        let ring_radius = (10.01_f64.powi(2) - 100.).sqrt();
        assert!(ring_radius > 0.4 && ring_radius < 1.);
        assert!(lens.f([0., ring_radius, 0.]).abs() < 1e-12);
        assert!(lens.f([0.; 3]) < 0. && lens.f([0.02, 0., 0.]) > 0.);
        assert_eq!(discovery_guard(&lens, &probe(&lens, [-1.; 3], [1.; 3])), DiscoveryCheck::NeedsSplit);
        // A separate box supplies mixed root signs; the disjoint lens is still
        // hidden. Passing this necessary guard does not certify its discovery.
        let tree = sdf::union(vec![
            lens,
            sdf::leaf_at(Shape::Cuboid { half: [1.25, 3., 3.] }, [-1.75, 0., 0.]),
        ]);
        let p = probe(&tree, [-1.; 3], [1.; 3]);
        assert!(tree.f([0.; 3]) < 0. && tree.f([-0.25, 0., 0.]) > 0. && tree.f([-0.75, 0., 0.]) < 0.);
        assert!(has_corner_sign_change(&p));
        assert_eq!(discovery_guard(&tree, &p), DiscoveryCheck::NoDiscoveryRejection { opaque: false });
    }

    #[test]
    fn invalid_or_collapsed_supported_geometry_is_indeterminate() {
        let valid = sphere(1., [0.; 3]);
        let p = probe(&valid, [0.8, -0.1, -0.1], [1.2, 0.1, 0.1]);
        let mut bad_sign = valid.clone();
        if let CsgNode::Leaf(l) = &mut bad_sign { l.sign = 0.; }
        for tree in [
            sphere(f64::NAN, [0.; 3]), sphere(0., [0.; 3]), sphere(1., [f64::INFINITY; 3]),
            sphere(0.01, [1e20; 3]),
            sdf::leaf(Shape::Sphere { r: 0.01 }, Similarity::from_translation(1e20, 1e20, 1e20), [0.; 3]),
            sdf::leaf(Shape::Sphere { r: 1. }, Similarity { s: 0., ..Similarity::identity() }, [0.; 3]),
            sdf::leaf(Shape::Sphere { r: 1. }, Similarity { r: [1.; 9], ..Similarity::identity() }, [0.; 3]),
            sdf::leaf(Shape::Sphere { r: 1. }, Similarity {
                r: [-1., 0., 0., 0., 1., 0., 0., 0., 1.], ..Similarity::identity()
            }, [0.; 3]),
            sdf::leaf_at(Shape::Cuboid { half: [1., f64::NAN, 1.] }, [0.; 3]),
            bad_sign,
        ] {
            assert_eq!(discovery_guard(&tree, &p), DiscoveryCheck::Indeterminate);
        }
    }

    #[test]
    fn entity_boxes_enclose_actual_translated_and_subnormal_endpoints() {
        for (lo, hi) in [
            ([1e16, -1e16, 4.], [1e16 + 2., -1e16 + 6., 4.]),
            ([1e16, -1e16, 4.], [1e16 + 2., -1e16, 4.]),
            ([f64::from_bits(1); 3], [f64::from_bits(3); 3]),
        ] {
            let (c, h) = enclosing_box(lo, hi).unwrap();
            for a in 0..3 {
                assert!(c[a] - h[a] <= lo[a] && c[a] + h[a] >= hi[a]);
                assert_eq!(h[a] == 0.0, lo[a] == hi[a]);
            }
        }
        assert!(enclosing_box([1.; 3], [0.; 3]).is_err());
        assert!(enclosing_box([0.; 3], [f64::NAN; 3]).is_err());
    }


    fn cuboid(half: [f64; 3], pos: [f64; 3]) -> CsgNode { sdf::leaf_at(Shape::Cuboid { half }, pos) }

    const PASS: DiscoveryCheck = DiscoveryCheck::NoDiscoveryRejection { opaque: false };

    fn plane_box(right: f64) -> CsgNode {
        sdf::leaf_at(
            Shape::Cuboid {
                half: [1.25, 3., 3.],
            },
            [right - 1.25, 0., 0.],
        )
    }

    fn owners(root: &CsgNode, c: [f64; 3], half: [f64; 3]) -> Vec<&Leaf> {
        root.zero_owners_over_box(c, half)
            .unwrap()
            .entries
            .into_iter()
            .filter_map(|o| match o {
                ZeroOwner::Primitive(l) => Some(l),
                _ => None,
            })
            .collect()
    }

    fn at_path<'a>(mut root: &'a CsgNode, path: &[usize]) -> &'a CsgNode {
        for &i in path {
            root = match root {
                CsgNode::Min(ch) | CsgNode::Max(ch) => &ch[i],
                _ => panic!("invalid test path"),
            };
        }
        root
    }

    fn assert_owner(root: &CsgNode, path: &[usize], witness: [f64; 3]) {
        for n in 0..=path.len() {
            assert!(
                at_path(root, &path[..n]).f(witness).abs() < 1e-12,
                "witness does not reach ancestor {n}"
            );
        }
        let CsgNode::Leaf(target) = at_path(root, path) else {
            panic!("not leaf")
        };
        assert!(owners(root, [0.; 3], [1.; 3])
            .iter()
            .any(|l| std::ptr::eq(*l, target)));
        assert_eq!(target.index, 0);
        assert!(target.strata.is_empty());
    }

    #[test]
    fn center_winner_negative_cavity_nested_subtraction_and_double_negation_keep_zero_owners() {
        let small = sphere(0.1, [0.; 3]);
        let center_winner = sdf::union(vec![plane_box(-0.5), small.clone()]);
        assert!(small.f([0.; 3]) < plane_box(-0.5).f([0.; 3]));
        assert_owner(&center_winner, &[1], [0.1, 0., 0.]);
        let cavity = sdf::subtract(plane_box(0.5), small.clone());
        assert_owner(&cavity, &[1], [0.1, 0., 0.]);
        let subtract_union = sdf::subtract(
            sphere(5., [0.; 3]),
            sdf::union(vec![small.clone(), sphere(0.1, [3., 0., 0.])]),
        );
        assert_owner(&subtract_union, &[1, 0], [0.1, 0., 0.]);
        let subtract_intersection = sdf::subtract(
            sphere(5., [0.; 3]),
            sdf::intersect(vec![small.clone(), sphere(0.2, [0.; 3])]),
        );
        assert_owner(&subtract_intersection, &[1, 0], [0.1, 0., 0.]);
        let nested = sdf::intersect(vec![
            sdf::union(vec![
                plane_box(-0.5),
                sdf::intersect(vec![small.clone(), sphere(2., [0.; 3])]),
            ]),
            sphere(4., [0.; 3]),
        ]);
        assert_owner(&nested, &[0, 1, 0], [0.1, 0., 0.]);
        let double = sdf::negate(sdf::negate(small));
        assert_owner(&double, &[], [0.1, 0., 0.]);
        let loose = SmoothCriteriaOptions {
            normal_variation_cos: -1.,
            blend_normal_variation_cos: 1.,
            normal_variation_analytic: false,
        };
        for t in [
            center_winner,
            cavity,
            subtract_union,
            subtract_intersection,
            nested,
            double,
        ] {
            let p = probe(&t, [-1.; 3], [1.; 3]);
            assert_eq!(discovery_guard(&t, &p), DiscoveryCheck::NeedsSplit);
            assert!(needs_split_smooth(&t, &p, &loose, 1., false));
        }
    }

    #[test]
    fn path_burial_rejects_false_ownership_even_when_leaf_and_root_are_both_zero() {
        let hidden = sphere(0.05, [0.; 3]);
        let patch = plane_box(0.);
        let witness = [0., 0.05, 0.];
        for t in [
            sdf::union(vec![
                patch.clone(),
                sdf::intersect(vec![hidden.clone(), sphere(1., [10.; 3])]),
            ]),
            sdf::intersect(vec![patch, sdf::union(vec![hidden, sphere(10., [0.; 3])])]),
        ] {
            assert_eq!(t.f(witness), 0.);
            let CsgNode::Leaf(target) = at_path(&t, &[1, 0]) else {
                unreachable!()
            };
            assert_eq!(target.f(witness), 0.);
            assert!(!owners(&t, [0.; 3], [0.2; 3])
                .iter()
                .any(|l| std::ptr::eq(*l, target)));
            assert_eq!(
                discovery_guard(&t, &probe(&t, [-0.2; 3], [0.2; 3])),
                DiscoveryCheck::NoDiscoveryRejection { opaque: false }
            );
        }
    }

    #[test]
    fn duplicates_order_opposite_signs_and_thin_shell_never_merge_occurrences() {
        let s = sphere(0.1, [0.; 3]);
        for t in [
            sdf::union(vec![cuboid([0.1; 3], [0.; 3]); 2]),
            sdf::intersect(vec![cuboid([0.1; 3], [0.; 3]); 2]),
            sdf::union(vec![s.clone(), s.clone()]),
            sdf::intersect(vec![s.clone(), s.clone()]),
            sdf::union(vec![s.clone(), sdf::negate(s.clone())]),
            sdf::intersect(vec![s.clone(), sdf::negate(s.clone())]),
            sdf::subtract(sphere(0.100000001, [0.; 3]), s.clone()),
        ] {
            let retained = owners(&t, [0.; 3], [1.; 3]);
            assert_eq!(retained.len(), 2);
            assert!(!std::ptr::eq(retained[0], retained[1]));
            assert_eq!(
                discovery_guard(&t, &probe(&t, [-1.; 3], [1.; 3])),
                DiscoveryCheck::NeedsSplit
            );
        }
        let shell = sdf::subtract(sphere(0.100000001, [0.; 3]), s.clone());
        assert!(shell.f([0.1, 0., 0.]).abs() < 1e-14);
        assert!(shell.f([0.100000001, 0., 0.]).abs() < 1e-14);
        assert!(shell.f([0.1000000005, 0., 0.]) < 0.);
        let ch = vec![plane_box(-0.5), s, sphere(0.1, [10.; 3])];
        let mut reverse = ch.clone();
        reverse.reverse();
        for t in [sdf::union(ch), sdf::union(reverse)] {
            assert_eq!(owners(&t, [0.; 3], [1.; 3]).len(), 2);
            assert_eq!(
                discovery_guard(&t, &probe(&t, [-1.; 3], [1.; 3])),
                DiscoveryCheck::NeedsSplit
            );
        }
    }

    #[test]
    fn rotated_flat_boxes_and_local_world_factorizations_keep_decisions() {
        let angle = 0.37_f64;
        let (s, c) = angle.sin_cos();
        for scale in [1e-9, 1., 1e9] {
            for factor in [0.125, 1., 8.] {
                let sim = Similarity {
                    r: [c, -s, 0., s, c, 0., 0., 0., 1.],
                    t: [-1.98 * c * scale, -1.98 * s * scale, 0.],
                    s: scale * factor,
                };
                let t = sdf::leaf(
                    Shape::Cuboid {
                        half: [2. / factor; 3],
                    },
                    sim,
                    [0.; 3],
                );
                assert_eq!(
                    discovery_guard(&t, &probe(&t, [-0.1 * scale; 3], [0.1 * scale; 3])),
                    PASS,
                    "scale={scale} factor={factor}"
                );
                let t = sdf::leaf(
                    Shape::Sphere { r: 0.125 / factor },
                    Similarity {
                        s: scale * factor,
                        t: [0.; 3],
                        ..sim
                    },
                    [0.; 3],
                );
                assert_eq!(
                    discovery_guard(&t, &probe(&t, [-scale; 3], [scale; 3])),
                    DiscoveryCheck::NeedsSplit
                );
            }
        }
        for scale in [1., 0.001] {
            let shift = [1e9, -1e9, 1e9];
            let sim = Similarity { s: scale, t: shift, ..Similarity::identity() };
            let tree = sdf::union(vec![
                sdf::leaf(Shape::Cuboid { half: [50., 100., 100.] }, sim, [-50., 0., 0.]),
                sdf::leaf(Shape::Sphere { r: 0.01650382162580301 }, sim, [0.04125955406450752, 1.53, 1.53]),
            ]);
            let lo = [-0.08251910812902, 1.447911753179639, 0.749845832607463];
            let hi = [0.71435589187098, 2.244786753179639, 1.546720832607463];
            assert!(discovery_guard(&tree, &probe(&tree,
                std::array::from_fn(|a| lo[a] * scale + shift[a]),
                std::array::from_fn(|a| hi[a] * scale + shift[a]))).needs_split());
        }
        for shift in [1e6, 1e12, 1e15] {
            let t = sphere(0.125, [shift; 3]);
            assert!(
                discovery_guard(&t, &probe(&t, [shift - 1.; 3], [shift + 1.; 3])).needs_split(),
                "translation={shift}"
            );
        }
    }

    #[test]
    fn tiny_features_and_collapsed_translations_stay_uncertain_instead_of_empty() {
        for radius in [1e-30, 1e-100, 1e-300] {
            let tree = sphere(radius, [0.; 3]);
            let p = probe(&tree, [-4. * radius; 3], [4. * radius; 3]);
            assert!(discovery_guard(&tree, &p).needs_split(), "radius={radius}");
        }
        let tree = sphere(2_f64.powi(-20), [1e12; 3]);
        assert_eq!(
            discovery_guard(&tree, &probe(&tree, [1e12 - 1.; 3], [1e12 + 1.; 3])),
            DiscoveryCheck::Indeterminate
        );
    }

    #[test]
    fn strict_ancestor_exclusion_and_malformed_siblings_are_distinct() {
        let opaque = sdf::leaf_at(Shape::Cylinder { r: 1., h: 1. }, [0.; 3]);
        for tree in [
            sdf::union(vec![sphere(5., [0.; 3]), opaque.clone()]),
            sdf::intersect(vec![sphere(1., [10.; 3]), opaque.clone()]),
        ] {
            assert!(tree.zero_owners_over_box([0.; 3], [1.; 3]).unwrap().entries.is_empty());
            assert_eq!(discovery_guard(&tree, &probe(&tree, [-1.; 3], [1.; 3])), PASS);
        }
        let unit = sphere(1., [0.; 3]);
        assert_eq!(discovery_guard(&unit, &probe(&unit, [1.001, 0., 0.], [2.001, 1., 1.])), PASS);
        for bad in [
            sphere(f64::INFINITY, [0.; 3]), sphere(-1., [0.; 3]), sphere(1., [f64::NAN, 0., 0.]),
            sdf::leaf(Shape::Sphere { r: 1. }, Similarity { s: f64::MAX, ..Similarity::identity() }, [0.; 3]),
            CsgNode::Min(vec![]), CsgNode::Max(vec![]),
        ] {
            for tree in [sdf::union(vec![sphere(5., [0.; 3]), bad.clone()]), sdf::intersect(vec![bad, opaque.clone()])] {
                assert_eq!(discovery_guard(&tree, &probe(&unit, [-1.; 3], [1.; 3])), DiscoveryCheck::Indeterminate);
            }
        }
        for index in [0, 3, 24] {
            let mut p = probe(&unit, [-1.; 3], [1.; 3]);
            p.pts[index] = f64::NAN;
            assert_eq!(discovery_guard(&unit, &p), DiscoveryCheck::Indeterminate);
        }
        let mut p = probe(&unit, [-1.; 3], [1.; 3]);
        p.pts[3] = 0.;
        assert_eq!(discovery_guard(&unit, &p), DiscoveryCheck::Indeterminate);
        p = probe(&unit, [-1.; 3], [1.; 3]);
        p.cell_size = 0.;
        assert_eq!(discovery_guard(&unit, &p), DiscoveryCheck::Indeterminate);
    }

    #[cfg(feature = "sfcc-profile")]
    #[test]
    fn discovery_work_is_linear_and_scratch_tracks_peak_pending_candidates() {
        use crate::sfcc::perf;
        let flat = plane_box(0.);
        for n in [1, 4, 16, 64, 256] {
            let tree = sdf::union(vec![flat.clone(); n]);
            let p = probe(&tree, [-1.; 3], [1.; 3]);
            perf::reset();
            assert_eq!(discovery_guard(&tree, &p), PASS);
            let c = perf::snapshot();
            assert_eq!(c[18], 1);
            assert_eq!(c[19], n + 1);
            assert_eq!(c[20], n);
            assert_eq!(c[21], n);
            assert_eq!(c[22], 8 * n);
            assert!(c[23] <= 12 * n && c[24] <= 6 * n);
            assert_eq!(c[27], n);
            assert_eq!(c[28], n + 1);
            assert_eq!(c[30], c[20] + c[22] + c[23] + c[24], "root sign fold adds no interval queries");
        }
        let mut buried = vec![sphere(0.125, [0.; 3]); 256];
        buried.push(cuboid([4.; 3], [0.; 3]));
        let tree = sdf::intersect(vec![sdf::union(buried), flat]);
        perf::reset();
        assert_eq!(discovery_guard(&tree, &probe(&tree, [-1.; 3], [1.; 3])), PASS);
        let c = perf::snapshot();
        assert_eq!(c[19], 260);
        assert_eq!(c[20], 258);
        assert_eq!(c[21], 1);
        assert_eq!(c[22], 8);
        assert!(c[23] <= 12 && c[24] <= 6);
        assert_eq!(c[28], 260);
        assert_eq!(c[30], c[20] + c[22] + c[23] + c[24]);
        assert!(c[27] >= 256, "scratch includes candidates later removed by an ancestor");
    }
}
