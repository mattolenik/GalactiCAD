//! S3a — per-face contouring. Port of `src/export/sfcc/face-contour.mts`.
//!
//! Each canonical octree face is contoured exactly once (the CMS invariant): a
//! CCW boundary walk in the face's (u, v) frame discovers edge iso-crossings on
//! minimal sub-edges, then enter/exit crossings are paired into directed contour
//! segments. Both incident cells consume the same [`FaceRecord`], so the mesh is
//! crack-free and the closedness audit is exact by construction.
//!
//! Segment orientation: in the face's (u, v) frame (u × v = +axis) the walk is
//! CCW viewed from the +axis side and every segment is directed with the f < 0
//! region on its LEFT. The +axis cell consumes segments as stored; the −axis
//! cell reverses them.
//!
//! **Determinism (`canonical_edge_root`)**: a sub-edge's endpoints are
//! canonicalized to lexicographically-least-first BEFORE root-finding, so a
//! shared edge yields a bit-identical crossing from either traversal direction —
//! required for the keyed point table (`crossing_key`) to be first-writer-wins
//! correct under a parallel meshing pass.
//!
//! M4c-2 added the FEATURE paths (gated on `opts.features`, inert on smooth
//! scenes): feature pins (`curve.axisPlaneCrossings` → `record.pins` with an
//! averaged adjacent-strata normal), arc-endpoint recovery
//! (`recoveredCrossingsFor`), stratum tagging (`stratumTagFor`), and the
//! pin-route / per-stratum / pin-anchored-splice pairing branches.

use crate::math::grid::{
    collect_edge_interior_offsets, face_axes, pack_point, point_to_world, stride_at_level, SfccLattice,
};
use crate::sdf::{CsgNode, Pruned, SdfQuery};
use crate::sfcc::feature_set::SfccFeatureSet;
use crate::sfcc::octree::LEVER1_MIN_LEAVES;
use crate::sfcc::octree::{SfccCell, SfccOctree};
use crate::sfcc::point_table::{crossing_key, PointKey, PointTable};
use std::collections::HashMap;

/// A directed contour segment (point ids); f < 0 on the left viewed from +axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FaceSegment {
    pub a: usize,
    pub b: usize,
}

/// A pinned exact curve–face crossing routed through by `segments`.
#[derive(Clone, Copy, Debug)]
pub struct FacePin {
    /// PointTable id of the exact curve–face crossing.
    pub point_id: usize,
    pub curve_id: usize,
    /// Curve parameter at the crossing.
    pub t: f64,
}

/// Per-face contour data, computed once per canonical octree face.
pub struct FaceRecord {
    pub axis: usize,
    /// Lattice key of the face min corner.
    pub key: i64,
    /// Face edge length in lattice units.
    pub len: i64,
    pub segments: Vec<FaceSegment>,
    /// Pinned feature-curve crossings routed through by `segments`.
    pub pins: Vec<FacePin>,
    /// Consumption counters for the S4 face audit (filled by cell meshing).
    pub consumed_fwd: Vec<u32>,
    pub consumed_rev: Vec<u32>,
}

/// A recovered per-stratum boundary crossing of a sub-edge with no tree-f sign
/// change. Port of `RecoveredCrossing`.
#[derive(Clone, Copy, Debug)]
pub struct RecoveredCrossing {
    /// PointTable id.
    pub id: usize,
    /// Position along the canonical (+axis) direction of the sub-edge, t ∈ (0,1).
    pub t: f64,
    /// Stratum whose carrier vanishes here — recovered crossings pair per-stratum.
    pub stratum: usize,
}

/// Face-contour options. The smooth path uses only `root_tol`; the feature paths
/// activate when `features` is `Some`.
#[derive(Clone, Copy)]
pub struct FaceContourOptions<'a> {
    /// Absolute world-space tolerance for edge root-finding.
    pub root_tol: f64,
    /// Feature set for face pinning / recovery / tagging (None = smooth path).
    pub features: Option<&'a SfccFeatureSet>,
    /// Lipschitz pre-cull in `recovered_crossings_for`.
    pub recovery_cull: bool,
}

impl Default for FaceContourOptions<'_> {
    fn default() -> Self {
        FaceContourOptions { root_tol: 0.0, features: None, recovery_cull: true }
    }
}

/// Result of contouring all canonical faces.
pub struct FaceContourResult {
    /// Per axis: face min-corner lattice key → record. NOTE: keys collide across
    /// levels (a face and its min-corner quarter share the key) — consumers must
    /// validate `record.len`.
    pub faces: [HashMap<i64, FaceRecord>; 3],
    /// Faces with ≥3 segments (beyond simple ambiguity) — diagnostics.
    pub multi_run_faces: usize,
    /// Crossings on root-boundary faces (must be 0 — bounds padding violated).
    pub boundary_violations: usize,
    /// Same-key different-size enumeration conflicts (must be 0).
    pub key_collisions: usize,
}

/// One boundary node along the cyclic walk: a crossing point id (or −1 for a
/// lattice sample) plus, for sample nodes, whether f < 0.
#[derive(Clone, Copy)]
struct BoundaryNode {
    /// Crossing point id, or −1 for a lattice sample point.
    crossing: i64,
    /// For sample nodes: whether f < 0.
    inside: bool,
}

/// Pass-wide feature caches shared across all faces (mirroring the TS `Map`s
/// threaded through `FaceContourOptions.recovered` / `.stratumTags`). Built once
/// in [`contour_all_faces`] when a feature set is present.
struct FeatureCaches {
    /// canonical sub-edge key (crossing_key) → recovered crossings.
    recovered: HashMap<i64, Vec<RecoveredCrossing>>,
    /// crossing point id → stratum id (−1 for none).
    stratum_tags: HashMap<usize, i64>,
}

/// Root-find the iso-crossing on a world segment with f0 < 0 ≤ f1 or vice versa.
/// Writes the crossing position into `out[0..3]` and the tree gradient (unit
/// normal) into `out[3..6]`.
///
/// Illinois (modified regula-falsi): a false-position step that halves a retained
/// endpoint's f-value on its second consecutive retention. Converges
/// superlinearly, reaching f64 precision in ~10 `tree.f` evals where the old plain
/// bisection ran the full 60 (the smooth path passes `tol=0`, so the bracket test
/// never early-exited). NOTE: this is intentionally NOT bit-faithful to the TS
/// `findRoot` (bisection) anymore — the crossing differs by a sub-`root_tol`
/// amount. It remains a deterministic pure function of its inputs, so
/// [`canonical_edge_root`]'s direction-independence — the keyed-point-table weld
/// invariant — is preserved.
///
/// Call sites should use [`canonical_edge_root`] so the result is independent of
/// endpoint order.
#[allow(clippy::too_many_arguments)]
pub fn find_root<T: SdfQuery + ?Sized>(
    tree: &T,
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
    f0: f64,
    f1: f64,
    tol: f64,
    out: &mut [f64; 6],
) {
    let mut lo = 0.0f64;
    let mut hi = 1.0f64;
    let mut flo = f0;
    let mut fhi = f1;
    let seg_len = ((bx - ax).powi(2) + (by - ay).powi(2) + (bz - az).powi(2)).sqrt();
    // An endpoint that vanishes IS the crossing (false position can't bracket it);
    // anchor exactly. Otherwise iter 1's interior step always sets `t` first.
    let mut t = if f0 == 0.0 {
        0.0
    } else if f1 == 0.0 {
        1.0
    } else {
        (lo + hi) / 2.0
    };
    if f0 != 0.0 && f1 != 0.0 {
        let mut side = 0i32; // endpoint that moved last: -1 = lo, +1 = hi, 0 = none
        let mut i = 0;
        while i < 60 {
            let denom = fhi - flo;
            // False-position estimate; a degenerate denom (shouldn't occur for
            // opposite-sign endpoints) falls back to the midpoint.
            let cand = if denom != 0.0 { (lo * fhi - hi * flo) / denom } else { (lo + hi) / 2.0 };
            // No strictly-interior step left ⇒ the bracket reached f64 precision.
            if !(cand > lo && cand < hi) {
                break;
            }
            t = cand;
            let fm = tree.f([ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t]);
            if fm == 0.0 {
                break;
            }
            if (fm < 0.0) == (flo < 0.0) {
                lo = t;
                flo = fm;
                if side == -1 {
                    fhi *= 0.5; // hi retained a 2nd time → Illinois halving
                }
                side = -1;
            } else {
                hi = t;
                fhi = fm;
                if side == 1 {
                    flo *= 0.5; // lo retained a 2nd time → Illinois halving
                }
                side = 1;
            }
            i += 1;
            if (hi - lo) * seg_len <= tol {
                break;
            }
        }
    }
    out[0] = ax + (bx - ax) * t;
    out[1] = ay + (by - ay) * t;
    out[2] = az + (bz - az) * t;
    let (_, g) = tree.grad([out[0], out[1], out[2]]);
    out[3] = g[0];
    out[4] = g[1];
    out[5] = g[2];
}

/// Iso-crossing on an axis-aligned sub-edge, computed INDEPENDENTLY of the
/// direction the caller discovered the edge. Port of `canonicalEdgeRoot`.
#[allow(clippy::too_many_arguments)]
pub fn canonical_edge_root<T: SdfQuery + ?Sized>(
    tree: &T,
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
    fa: f64,
    fb: f64,
    tol: f64,
    out: &mut [f64; 6],
) {
    let b_first = bx < ax || (bx == ax && (by < ay || (by == ay && bz < az)));
    if b_first {
        find_root(tree, bx, by, bz, ax, ay, az, fb, fa, tol, out);
    } else {
        find_root(tree, ax, ay, az, bx, by, bz, fa, fb, tol, out);
    }
}

/// Compute (once, cached) the recovered per-stratum boundary crossings of a
/// sub-edge with no tree-f sign change. Port of `recoveredCrossingsFor`.
#[allow(clippy::too_many_arguments)]
fn recovered_crossings_for<T: SdfQuery + ?Sized>(
    cache: &mut HashMap<i64, Vec<RecoveredCrossing>>,
    cache_key: i64,
    a_world: [f64; 3], // canonical sub-edge min endpoint (world)
    b_world: [f64; 3], // canonical sub-edge max endpoint (world)
    tree: &T,
    grad_bound: f64,
    points: &mut PointTable,
    features: &SfccFeatureSet,
    root_tol: f64,
    recovery_cull: bool,
) -> Vec<RecoveredCrossing> {
    if let Some(hit) = cache.get(&cache_key) {
        return hit.clone();
    }

    let edge_len = ((b_world[0] - a_world[0]).powi(2)
        + (b_world[1] - a_world[1]).powi(2)
        + (b_world[2] - a_world[2]).powi(2))
    .sqrt();
    let inflate = edge_len * 2.0;
    let mut out: Vec<RecoveredCrossing> = Vec::new();
    let qmin = [
        a_world[0].min(b_world[0]) - inflate,
        a_world[1].min(b_world[1]) - inflate,
        a_world[2].min(b_world[2]) - inflate,
    ];
    let qmax = [
        a_world[0].max(b_world[0]) + inflate,
        a_world[1].max(b_world[1]) + inflate,
        a_world[2].max(b_world[2]) + inflate,
    ];
    let curve_ids = features.index.curves_in_box(qmin, qmax);
    if curve_ids.is_empty() {
        cache.insert(cache_key, out.clone());
        return out;
    }
    let at_t = |t: f64| -> [f64; 3] {
        [
            a_world[0] + (b_world[0] - a_world[0]) * t,
            a_world[1] + (b_world[1] - a_world[1]) * t,
            a_world[2] + (b_world[2] - a_world[2]) * t,
        ]
    };

    // --- detection: all carrier roots per nearby stratum ---
    const SUBDIV: usize = 8;
    struct Cand {
        t: f64,
        stratum: usize,
        f_abs: f64,
    }
    let mut cand: Vec<Cand> = Vec::new();
    let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for cid in &curve_ids {
        for &sid in &features.curves[*cid].adjacent_strata {
            if !seen.insert(sid) {
                continue;
            }
            let st = &features.strata[sid];
            if recovery_cull {
                let q = at_t(0.5);
                if st.f(q[0], q[1], q[2]).abs() > (edge_len / 2.0) * grad_bound {
                    continue;
                }
            }
            let mut prev_t = 0.0;
            let q0 = at_t(0.0);
            let mut prev_f = st.f(q0[0], q0[1], q0[2]);
            for k in 1..=SUBDIV {
                let tk = k as f64 / SUBDIV as f64;
                let qk = at_t(tk);
                let fk = st.f(qk[0], qk[1], qk[2]);
                if (prev_f < 0.0) != (fk < 0.0) {
                    let mut lo = prev_t;
                    let mut hi = tk;
                    let mut flo = prev_f;
                    let mut i = 0;
                    while i < 50 && (hi - lo) * edge_len > root_tol {
                        let mid = (lo + hi) / 2.0;
                        let qm = at_t(mid);
                        let fm = st.f(qm[0], qm[1], qm[2]);
                        if (fm < 0.0) == (flo < 0.0) {
                            lo = mid;
                            flo = fm;
                        } else {
                            hi = mid;
                        }
                        i += 1;
                    }
                    let t = (lo + hi) / 2.0;
                    let q = at_t(t);
                    let f_abs = tree.f([q[0], q[1], q[2]]).abs();
                    if f_abs <= root_tol * 4.0 {
                        cand.push(Cand { t, stratum: sid, f_abs });
                    }
                }
                prev_t = tk;
                prev_f = fk;
            }
        }
    }
    if cand.is_empty() {
        cache.insert(cache_key, out.clone());
        return out;
    }
    cand.sort_by(|x, y| x.t.partial_cmp(&y.t).unwrap());
    // Dedupe near-coincident candidates (AMBIGUOUS sets only).
    let dd: Vec<Cand> = if cand.len() > 2 {
        let mut dd: Vec<Cand> = Vec::new();
        for c in cand {
            if let Some(last) = dd.last() {
                if (c.t - last.t) * edge_len < root_tol * 2.0 {
                    if c.f_abs < last.f_abs {
                        *dd.last_mut().unwrap() = c;
                    }
                    continue;
                }
            }
            dd.push(c);
        }
        dd
    } else {
        cand
    };

    // --- verification: ground-truth sign flips at gap midpoints ---
    let mut gap_inside: Option<Vec<bool>> = None;
    let survivors: Vec<&Cand> = if dd.len() > 2 {
        let mut ts: Vec<f64> = Vec::with_capacity(dd.len() + 2);
        ts.push(0.0);
        for c in &dd {
            ts.push(c.t);
        }
        ts.push(1.0);
        let mut gi: Vec<bool> = Vec::new();
        for g in 0..ts.len() - 1 {
            let q = at_t((ts[g] + ts[g + 1]) / 2.0);
            gi.push(tree.f([q[0], q[1], q[2]]) < 0.0);
        }
        let s: Vec<&Cand> = dd.iter().enumerate().filter(|(i, _)| gi[*i] != gi[*i + 1]).map(|(_, c)| c).collect();
        gap_inside = Some(gi);
        s
    } else {
        dd.iter().collect()
    };
    // Parity defense: survivors must be even.
    if survivors.is_empty() || !survivors.len().is_multiple_of(2) {
        cache.insert(cache_key, out.clone());
        return out;
    }

    // Structural gate: a crossing pair bounding a material dip must flank a
    // common curve's wedge or share a common corner's strata.
    let is_wedge_pair = |sa: usize, sb: usize| -> bool {
        if sa == sb {
            return false;
        }
        for cid in &curve_ids {
            let adj = &features.curves[*cid].adjacent_strata;
            if adj.contains(&sa) && adj.contains(&sb) {
                return true;
            }
        }
        for corner_id in features.index.corners_in_box(qmin, qmax) {
            let st = &features.corners[corner_id].strata;
            if st.contains(&sa) && st.contains(&sb) {
                return true;
            }
        }
        false
    };
    if survivors.len() > 2 {
        let gi = gap_inside.as_ref().unwrap();
        let end_inside = gi[0];
        let mut s_ts: Vec<f64> = Vec::with_capacity(survivors.len() + 2);
        s_ts.push(0.0);
        for c in &survivors {
            s_ts.push(c.t);
        }
        s_ts.push(1.0);
        let mut ok = true;
        let mut g = 1;
        while g < s_ts.len().wrapping_sub(2) && ok {
            let q = at_t((s_ts[g] + s_ts[g + 1]) / 2.0);
            let inside = tree.f([q[0], q[1], q[2]]) < 0.0;
            if inside != end_inside && !is_wedge_pair(survivors[g - 1].stratum, survivors[g].stratum) {
                ok = false;
            }
            g += 1;
        }
        if !ok {
            cache.insert(cache_key, out.clone());
            return out;
        }
    }

    // --- gating ---
    if survivors.len() == 2 && !is_wedge_pair(survivors[0].stratum, survivors[1].stratum) {
        cache.insert(cache_key, out.clone());
        return out;
    }

    for c in &survivors {
        let q = at_t(c.t);
        let (qx, qy, qz) = (q[0], q[1], q[2]);
        let key = format!("SC:{}:{}:{:.9}", cache_key, c.stratum, c.t);
        let id = points.get_or_create_str(&key, || {
            let (_, g) = tree.grad([qx, qy, qz]);
            [qx, qy, qz, g[0], g[1], g[2]]
        });
        out.push(RecoveredCrossing { id, t: c.t, stratum: c.stratum });
    }
    cache.insert(cache_key, out.clone());
    out
}

/// Stratum tag for a visible (tree-f) crossing. Port of `stratumTagFor`.
#[allow(clippy::too_many_arguments)]
fn stratum_tag_for<T: SdfQuery + ?Sized>(
    cache: &mut HashMap<usize, i64>,
    id: usize,
    a_world: [f64; 3],
    b_world: [f64; 3],
    tree: &T,
    points: &PointTable,
    features: &SfccFeatureSet,
    root_tol: f64,
) -> i64 {
    if let Some(&hit) = cache.get(&id) {
        return hit;
    }
    let edge_len = ((b_world[0] - a_world[0]).powi(2)
        + (b_world[1] - a_world[1]).powi(2)
        + (b_world[2] - a_world[2]).powi(2))
    .sqrt();
    let inflate = edge_len * 2.0;
    let qmin = [
        a_world[0].min(b_world[0]) - inflate,
        a_world[1].min(b_world[1]) - inflate,
        a_world[2].min(b_world[2]) - inflate,
    ];
    let qmax = [
        a_world[0].max(b_world[0]) + inflate,
        a_world[1].max(b_world[1]) + inflate,
        a_world[2].max(b_world[2]) + inflate,
    ];
    let curve_ids = features.index.curves_in_box(qmin, qmax);
    let mut best: i64 = -1;
    if !curve_ids.is_empty() {
        let qx = points.x(id);
        let qy = points.y(id);
        let qz = points.z(id);
        let (_, grad) = tree.grad([qx, qy, qz]);
        let gl = (grad[0] * grad[0] + grad[1] * grad[1] + grad[2] * grad[2]).sqrt();
        let tol = root_tol * 4.0;
        let mut best_abs = f64::INFINITY;
        let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for cid in &curve_ids {
            for &sid in &features.curves[*cid].adjacent_strata {
                if !seen.insert(sid) {
                    continue;
                }
                let st = &features.strata[sid];
                let fv = st.f(qx, qy, qz).abs();
                if fv > tol || fv >= best_abs {
                    continue;
                }
                let n = st.normal(qx, qy, qz);
                if gl > 1e-12 && (grad[0] * n[0] + grad[1] * n[1] + grad[2] * n[2]).abs() / gl < 0.9 {
                    continue;
                }
                best = sid as i64;
                best_abs = fv;
            }
        }
    }
    cache.insert(id, best);
    best
}

/// One boundary edge of a face, in CCW walk order.
struct Walk {
    du: i64,
    dv: i64,
    ax: usize,
    dir: i64,
}

/// A crossing extracted from the cyclic walk: point id + whether it is an enter.
#[derive(Clone, Copy)]
struct Crossing {
    id: usize,
    enter: bool,
}

/// Contour one face. `(gx, gy, gz)` is the face min corner (lattice), `len` its
/// edge length in lattice units. Port of `contourFace`.
#[allow(clippy::too_many_arguments)]
fn contour_face(
    oct: &SfccOctree,
    q: &dyn SdfQuery,
    grad_bound: f64,
    points: &mut PointTable,
    axis: usize,
    gx: i64,
    gy: i64,
    gz: i64,
    len: i64,
    opts: &FaceContourOptions,
    caches: Option<&mut FeatureCaches>,
) -> FaceRecord {
    let lat: &SfccLattice = &oct.lat;
    let [u, v] = face_axes(axis);
    let key = pack_point(lat, gx, gy, gz);

    // `q` is the caller-supplied per-region query tree — the full tree, or a COARSE-cell
    // pruned view built once and reused across all leaves under that coarse cell
    // (`contour_into`). Every tree eval below — sub-edge root-finds, crossing grads,
    // stratum tags, recovery samples, the face-center inside test — lies on THIS cell's
    // faces or interior, hence inside the coarse cell, so a coarse-cell-box prune stays
    // bit-exact here. (The `split_midpoint` Newton drift the old per-face prune guarded
    // against lives in the separate global repair pass, which keeps the full tree.)

    let walks = [
        Walk { du: 0, dv: 0, ax: u, dir: 1 },
        Walk { du: len, dv: 0, ax: v, dir: 1 },
        Walk { du: len, dv: len, ax: u, dir: -1 },
        Walk { du: 0, dv: len, ax: v, dir: -1 },
    ];

    let lattice_of = |du: i64, dv: i64| -> [i64; 3] {
        let mut g = [gx, gy, gz];
        g[u] += du;
        g[v] += dv;
        g
    };

    let mut nodes: Vec<BoundaryNode> = Vec::new();
    // Crossing point id → face boundary side (walk index 0-3).
    let mut node_side: HashMap<usize, usize> = HashMap::new();
    // Crossing point id → stratum id (stratum-tagged crossings pair per-stratum).
    let mut node_stratum: HashMap<usize, usize> = HashMap::new();
    let mut scratch = [0.0f64; 6];
    let mut caches = caches;

    for (walk_index, walk) in walks.iter().enumerate() {
        let start = lattice_of(walk.du, walk.dv);
        let (sgx, sgy, sgz) = (start[0], start[1], start[2]);
        let mut edge_min = [sgx, sgy, sgz];
        if walk.dir == -1 {
            edge_min[walk.ax] -= len;
        }
        let interior = collect_edge_interior_offsets(
            |k| oct.has_sample_key(k),
            lat,
            walk.ax,
            edge_min[0],
            edge_min[1],
            edge_min[2],
            len,
        );
        let mut offsets: Vec<i64> = vec![0];
        if walk.dir == 1 {
            for o in &interior {
                offsets.push(*o);
            }
        } else {
            for i in (0..interior.len()).rev() {
                offsets.push(len - interior[i]);
            }
        }
        offsets.push(len); // end (used for the last sub-edge, not emitted as a node)

        for i in 0..offsets.len() - 1 {
            let o0 = offsets[i];
            let o1 = offsets[i + 1];
            let mut p0 = [sgx, sgy, sgz];
            p0[walk.ax] += walk.dir * o0;
            let mut p1 = [sgx, sgy, sgz];
            p1[walk.ax] += walk.dir * o1;
            let f0 = oct.sample_at(p0[0], p0[1], p0[2]);
            let f1 = oct.sample_at(p1[0], p1[1], p1[2]);
            nodes.push(BoundaryNode { crossing: -1, inside: f0 < 0.0 });
            let min_corner = if walk.dir == 1 { p0 } else { p1 };
            let sub_key = crossing_key(pack_point(lat, min_corner[0], min_corner[1], min_corner[2]), walk.ax);
            if (f0 < 0.0) != (f1 < 0.0) {
                let wa = point_to_world(lat, p0[0], p0[1], p0[2]);
                let wb = point_to_world(lat, p1[0], p1[1], p1[2]);
                let id = points.get_or_create(sub_key, || {
                    canonical_edge_root(
                        q, wa[0], wa[1], wa[2], wb[0], wb[1], wb[2], f0, f1, opts.root_tol, &mut scratch,
                    );
                    scratch
                });
                nodes.push(BoundaryNode { crossing: id as i64, inside: false });
                node_side.insert(id, walk_index);
                if let (Some(features), Some(c)) = (opts.features, caches.as_deref_mut()) {
                    // Stratum-tag the visible crossing. Canonical sub-edge endpoints
                    // (the curve query box).
                    let wa = point_to_world(lat, p0[0], p0[1], p0[2]);
                    let wb = point_to_world(lat, p1[0], p1[1], p1[2]);
                    let tag = stratum_tag_for(&mut c.stratum_tags, id, wa, wb, q, points, features, opts.root_tol);
                    if tag >= 0 {
                        node_stratum.insert(id, tag as usize);
                    }
                }
            } else if let (Some(features), Some(c)) = (opts.features, caches.as_deref_mut()) {
                // Sub-sample arc-endpoint recovery.
                let canon_min = if walk.dir == 1 { p0 } else { p1 };
                let canon_max = if walk.dir == 1 { p1 } else { p0 };
                let wa = point_to_world(lat, canon_min[0], canon_min[1], canon_min[2]);
                let wb = point_to_world(lat, canon_max[0], canon_max[1], canon_max[2]);
                let rec = recovered_crossings_for(
                    &mut c.recovered,
                    sub_key,
                    wa,
                    wb,
                    q,
                    grad_bound,
                    points,
                    features,
                    opts.root_tol,
                    opts.recovery_cull,
                );
                if !rec.is_empty() {
                    if walk.dir == 1 {
                        for r in &rec {
                            nodes.push(BoundaryNode { crossing: r.id as i64, inside: false });
                            node_side.insert(r.id, walk_index);
                            node_stratum.insert(r.id, r.stratum);
                        }
                    } else {
                        for r in rec.iter().rev() {
                            nodes.push(BoundaryNode { crossing: r.id as i64, inside: false });
                            node_side.insert(r.id, walk_index);
                            node_stratum.insert(r.id, r.stratum);
                        }
                    }
                }
            }
        }
    }

    // Extract crossings with enter/exit tags by walking the cyclic node list.
    let mut crossings: Vec<Crossing> = Vec::new();
    let mut state = if !nodes.is_empty() { nodes[0].inside } else { false };
    for n in &nodes {
        if n.crossing >= 0 {
            state = !state;
            crossings.push(Crossing { id: n.crossing as usize, enter: state });
        } else {
            state = n.inside;
        }
    }

    let mut record = FaceRecord {
        axis,
        key,
        len,
        segments: Vec::new(),
        pins: Vec::new(),
        consumed_fwd: Vec::new(),
        consumed_rev: Vec::new(),
    };

    // --- Feature pinning: exact curve–face crossings (computed once, shared) ---
    if let Some(features) = opts.features {
        let min_w = point_to_world(lat, gx, gy, gz);
        let ext = len as f64 * lat.step;
        let max_u = min_w[u] + ext;
        let max_v = min_w[v] + ext;
        let coord = min_w[axis];
        let eps = 1e-12 * lat.world_size;
        let mut q_min = min_w;
        let mut q_max = min_w;
        q_max[u] = max_u;
        q_max[v] = max_v;
        let qmin = [q_min[0] - eps, q_min[1] - eps, q_min[2] - eps];
        let qmax = [q_max[0] + eps, q_max[1] + eps, q_max[2] + eps];
        // Match TS curvesInBox iteration: the set order is unspecified across
        // engines but the resulting pin POINTS are keyed (so identity is
        // order-independent), and record.pins order is reconstructed identically
        // by both cells. Sorting by id makes the Rust run deterministic.
        let mut curve_ids = features.index.curves_in_box(qmin, qmax);
        curve_ids.sort_unstable();
        for curve_id in curve_ids {
            let curve = &features.curves[curve_id];
            let pin_crossings = curve.axis_plane_crossings(axis, coord);
            for cr in &pin_crossings {
                let pos = [cr.x, cr.y, cr.z];
                if pos[u] < min_w[u] || pos[u] > max_u || pos[v] < min_w[v] || pos[v] > max_v {
                    continue;
                }
                let pkey = format!("F{}:{}:{}:{:.12}", axis, key, curve_id, cr.t);
                let (crx, cry, crz) = (cr.x, cr.y, cr.z);
                let sa = features.strata[curve.adjacent_strata[0]];
                let sb = features.strata[curve.adjacent_strata[1]];
                let pid = points.get_or_create_str(&pkey, || {
                    let na = sa.normal(crx, cry, crz);
                    let nb = sb.normal(crx, cry, crz);
                    let mut nx = na[0] + nb[0];
                    let mut ny = na[1] + nb[1];
                    let mut nz = na[2] + nb[2];
                    let nl = (nx * nx + ny * ny + nz * nz).sqrt();
                    if nl > 1e-12 {
                        nx /= nl;
                        ny /= nl;
                        nz /= nl;
                    } else {
                        nx = 0.0;
                        ny = 1.0;
                        nz = 0.0;
                    }
                    [crx, cry, crz, nx, ny, nz]
                });
                record.pins.push(FacePin { point_id: pid, curve_id, t: cr.t });
            }
        }
        // suppress unused-mut warning on q_min when no pins (it is read above).
        let _ = &mut q_min;
    }

    // Route through pinned feature points: the certified case is one pin with one
    // boundary inside-run (exit → pin → enter, a single kinked arc).
    if record.pins.len() == 1 && crossings.len() == 2 {
        let pin = record.pins[0];
        let exit = crossings.iter().find(|c| !c.enter).unwrap();
        let enter = crossings.iter().find(|c| c.enter).unwrap();
        record.segments.push(FaceSegment { a: exit.id, b: pin.point_id });
        record.segments.push(FaceSegment { a: pin.point_id, b: enter.id });
        record.consumed_fwd.push(0);
        record.consumed_fwd.push(0);
        record.consumed_rev.push(0);
        record.consumed_rev.push(0);
        return record;
    }

    if crossings.is_empty() {
        return record;
    }

    // Pair exits with enters.
    let runs = crossings.len() / 2;
    let mut center_inside = false;
    if runs >= 2 {
        // Face center in world space. TS computes `latticeOf(len/2, len/2)` in
        // FLOAT lattice coords (len/2 = 0.5 for a unit-length face), then
        // `pointToWorld` interpolates — so the center must use the fractional
        // half-step, NOT integer division (which would land on the min corner).
        let half = len as f64 / 2.0;
        let mut w = point_to_world(lat, gx, gy, gz);
        w[u] += half * lat.step;
        w[v] += half * lat.step;
        center_inside = q.f([w[0], w[1], w[2]]) < 0.0;
    }
    let n = crossings.len();

    let mut matched_enter = vec![false; n];
    let mut partner_of: HashMap<usize, usize> = HashMap::new(); // exit index → enter id

    // Pass 1: stratum-tagged crossings pair PER-STRATUM (the wedge-side config).
    if !node_stratum.is_empty() {
        let mut tally: HashMap<usize, (Vec<usize>, Vec<usize>)> = HashMap::new();
        for (i, c) in crossings.iter().enumerate() {
            if let Some(&s) = node_stratum.get(&c.id) {
                let e = tally.entry(s).or_insert_with(|| (Vec::new(), Vec::new()));
                if c.enter {
                    e.0.push(i);
                } else {
                    e.1.push(i);
                }
            }
        }
        let ext = len as f64 * lat.step;
        // Iterate in deterministic stratum-id order (HashMap order is unspecified;
        // the wedge-pair matching is independent per-stratum, but the matched set
        // is shared so we fix the order for run-to-run determinism). Pairing each
        // tally entry touches disjoint crossings, so the order does not change the
        // result — only its run-to-run stability.
        let mut strata: Vec<usize> = tally.keys().copied().collect();
        strata.sort_unstable();
        for s in strata {
            let (enters, exits) = &tally[&s];
            if enters.len() == 1 && exits.len() == 1 {
                let ea = crossings[enters[0]].id;
                let xa = crossings[exits[0]].id;
                let mx = (points.x(ea) + points.x(xa)) / 2.0;
                let my = (points.y(ea) + points.y(xa)) / 2.0;
                let mz = (points.z(ea) + points.z(xa)) / 2.0;
                if q.f([mx, my, mz]).abs() > ext * 0.05 {
                    continue;
                }
                matched_enter[enters[0]] = true;
                partner_of.insert(exits[0], ea);
            }
        }
    }

    // Pass 2: everything else pairs by the run rule, over still-unmatched enters.
    // (Index-coupled: `partner_of`/`matched_enter` are keyed by crossing index.)
    #[allow(clippy::needless_range_loop)]
    for i in 0..n {
        let c = crossings[i];
        if c.enter || partner_of.contains_key(&i) {
            continue;
        }
        if runs < 2 || !center_inside {
            // Enter of this exit's own run = nearest unmatched enter BEFORE it.
            for k in 1..=n {
                let j = (i + n - (k % n)) % n;
                if crossings[j].enter && !matched_enter[j] {
                    matched_enter[j] = true;
                    partner_of.insert(i, crossings[j].id);
                    break;
                }
            }
        } else {
            // Center inside: connect across the face to the NEXT unmatched enter.
            for k in 1..=n {
                let j = (i + k) % n;
                if crossings[j].enter && !matched_enter[j] {
                    matched_enter[j] = true;
                    partner_of.insert(i, crossings[j].id);
                    break;
                }
            }
        }
    }

    #[allow(clippy::needless_range_loop)]
    for i in 0..n {
        let c = crossings[i];
        if c.enter {
            continue;
        }
        let partner = partner_of.get(&i).copied();
        // Collinear guard: both endpoints on the SAME boundary side → split with a
        // face-owned, surface-projected midpoint.
        let se = node_side.get(&c.id).copied();
        if let (Some(p), Some(s)) = (partner, se) {
            if Some(s) == node_side.get(&p).copied() {
                let fkey = pack_point(lat, gx, gy, gz);
                let ta = point_merge_token(points, c.id);
                let tb = point_merge_token(points, p);
                let (lo, hi) = if ta <= tb { (&ta, &tb) } else { (&tb, &ta) };
                let mid_key = format!("smid:{axis}:{fkey}:{lo}:{hi}");
                let mid = split_midpoint(q, points, c.id, p, opts.root_tol, &mid_key);
                record.segments.push(FaceSegment { a: c.id, b: mid });
                record.segments.push(FaceSegment { a: mid, b: p });
                record.consumed_fwd.push(0);
                record.consumed_fwd.push(0);
                record.consumed_rev.push(0);
                record.consumed_rev.push(0);
                continue;
            }
        }
        // Faithful to TS: an unmatched exit (partner undefined → −1) is impossible
        // on a parity-clean even crossing set; mirror the sentinel so behavior
        // matches.
        let b = partner.map(|x| x as i64).unwrap_or(-1);
        record.segments.push(FaceSegment { a: c.id, b: if b < 0 { usize::MAX } else { b as usize } });
        record.consumed_fwd.push(0);
        record.consumed_rev.push(0);
    }

    // Pin-anchored splice: a pin is a REAL point of surface ∩ face — the face's
    // arc set must pass through it. Splice each unrouted pin into the segment that
    // crosses its curve's wedge, else the segment nearest to the pin.
    if !record.pins.is_empty() && !record.segments.is_empty() {
        if let Some(features) = opts.features {
            // Iterate pins in stored order (record.pins is reconstructed identically
            // both runs because pin POINTS are keyed; the order here is the
            // sorted-curve emission order).
            let pins = record.pins.clone();
            for pin in &pins {
                if record.segments.iter().any(|s| s.a == pin.point_id || s.b == pin.point_id) {
                    continue;
                }
                let adj = features.curves[pin.curve_id].adjacent_strata;
                let px = points.x(pin.point_id);
                let py = points.y(pin.point_id);
                let pz = points.z(pin.point_id);
                let min_len = opts.root_tol * 8.0;
                for length_floor in [min_len, 0.0] {
                    let mut best_idx: i64 = -1;
                    let mut best_dist = f64::INFINITY;
                    let mut best_cross = false;
                    for (i, s) in record.segments.iter().enumerate() {
                        let dx = points.x(s.b) - points.x(s.a);
                        let dy = points.y(s.b) - points.y(s.a);
                        let dz = points.z(s.b) - points.z(s.a);
                        if length_floor > 0.0 && dx * dx + dy * dy + dz * dz < length_floor * length_floor {
                            continue;
                        }
                        let sa = node_stratum.get(&s.a).copied();
                        let sb = node_stratum.get(&s.b).copied();
                        let cross = match (sa, sb) {
                            (Some(sa), Some(sb)) => sa != sb && adj.contains(&sa) && adj.contains(&sb),
                            _ => false,
                        };
                        if best_cross && !cross {
                            continue;
                        }
                        let d = point_segment_dist(points, px, py, pz, s.a, s.b);
                        if (cross && !best_cross) || d < best_dist {
                            best_idx = i as i64;
                            best_dist = d;
                            best_cross = cross;
                        }
                    }
                    if best_idx < 0 {
                        continue; // every segment below the floor — retry without it
                    }
                    let bi = best_idx as usize;
                    let s = record.segments[bi];
                    record.segments[bi] = FaceSegment { a: s.a, b: pin.point_id };
                    record.segments.insert(bi + 1, FaceSegment { a: pin.point_id, b: s.b });
                    record.consumed_fwd.push(0);
                    record.consumed_rev.push(0);
                    break;
                }
            }
        }
    }

    record
}

/// Distance from a point to the segment between two PointTable points. Port of
/// `pointSegmentDist`.
fn point_segment_dist(points: &PointTable, px: f64, py: f64, pz: f64, a: usize, b: usize) -> f64 {
    let ax = points.x(a);
    let ay = points.y(a);
    let az = points.z(a);
    let dx = points.x(b) - ax;
    let dy = points.y(b) - ay;
    let dz = points.z(b) - az;
    let len2 = dx * dx + dy * dy + dz * dz;
    let t = if len2 > 0.0 {
        (((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    ((px - (ax + t * dx)).powi(2) + (py - (ay + t * dy)).powi(2) + (pz - (az + t * dz)).powi(2)).sqrt()
}

/// Face-owned midpoint between two crossings, Newton-projected onto the surface.
/// Port of `splitMidpoint` (the `axis` arg is unused in TS too — full 3D
/// projection is deliberate).
/// A stable, partition-independent token for a point's GLOBAL identity. Used to key
/// the repair / splice midpoints so the SAME midpoint on a boundary face — computed
/// independently by two separate-table partitions — dedups, while midpoints on
/// DIFFERENT faces (e.g. the two sides of a repaired non-manifold edge) stay distinct.
fn point_merge_token(points: &PointTable, id: usize) -> String {
    match points.key_at(id) {
        PointKey::Num(k) => format!("n{k}"),
        PointKey::Str(s) => format!("s{s}"),
        // Cell-local (no global key) — fall back to the deterministic position so two
        // partitions still agree if such a point ever anchors a split.
        PointKey::Unkeyed => {
            format!("p{}_{}_{}", points.x(id).to_bits(), points.y(id).to_bits(), points.z(id).to_bits())
        }
    }
}

/// Split a face segment with a surface-projected midpoint, created under the GLOBAL,
/// face-scoped key `mid_key` (see [`point_merge_token`]) so the separate-table merge
/// can dedup the same boundary-face midpoint across partitions. In the serial /
/// shared-table paths each `mid_key` is created exactly once, so keying is a no-op
/// there — the point + position are unchanged (byte-identical).
fn split_midpoint<T: SdfQuery + ?Sized>(
    tree: &T,
    points: &mut PointTable,
    a_id: usize,
    b_id: usize,
    root_tol: f64,
    mid_key: &str,
) -> usize {
    let mx = (points.x(a_id) + points.x(b_id)) / 2.0;
    let my = (points.y(a_id) + points.y(b_id)) / 2.0;
    let mz = (points.z(a_id) + points.z(b_id)) / 2.0;
    let seg_len = ((points.x(b_id) - points.x(a_id)).powi(2)
        + (points.y(b_id) - points.y(a_id)).powi(2)
        + (points.z(b_id) - points.z(a_id)).powi(2))
    .sqrt();
    let mut q = [mx, my, mz];
    for _ in 0..6 {
        let fv = tree.f(q);
        if fv.abs() <= root_tol {
            break;
        }
        let (_, grad) = tree.grad(q);
        let g2 = grad[0] * grad[0] + grad[1] * grad[1] + grad[2] * grad[2];
        if g2 < 1e-20 {
            break;
        }
        let k = fv / g2;
        q[0] -= k * grad[0];
        q[1] -= k * grad[1];
        q[2] -= k * grad[2];
    }
    let drift = ((q[0] - mx).powi(2) + (q[1] - my).powi(2) + (q[2] - mz).powi(2)).sqrt();
    if drift > seg_len + root_tol * 8.0 || tree.f(q).abs() > root_tol * 8.0 {
        q = [mx, my, mz];
    }
    let (_, grad) = tree.grad(q);
    points.get_or_create_str(mid_key, || [q[0], q[1], q[2], grad[0], grad[1], grad[2]])
}

/// Enumerate canonical faces of all leaves and contour each exactly once.
/// Port of `contourAllFaces`.
pub fn contour_all_faces(
    oct: &SfccOctree,
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &FaceContourOptions,
) -> FaceContourResult {
    contour_faces_for(oct, tree, points, opts, &[oct.leaves.as_slice()])
}

/// Spatial-partition (#3 slice 1) entry: contour the faces of N disjoint leaf
/// groups into ONE shared face map + point table, sequentially. The shared map
/// dedups faces enumerated from both sides of a group boundary, and — crucially —
/// resolves T-junctions for free: a coarse cell in group A skips its face toward a
/// finer region (`is_internal`), and the finer cells (possibly in group B) contour
/// the sub-faces into the same shared map, so cell-mesh later finds them. The
/// global duplicate-segment repair runs ONCE after all groups. With contiguous
/// groups this is byte-identical to the serial [`contour_all_faces`] (proven by
/// `tests/spatial_partition.rs`); it's the in-process correctness substrate for the
/// eventual separate-table cross-worker merge (which additionally needs halo-aware
/// coarse-side sub-face contouring — see the design doc).
pub fn contour_faces_partitioned(
    oct: &SfccOctree,
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &FaceContourOptions,
    groups: &[std::ops::Range<usize>],
) -> FaceContourResult {
    let leaf_groups: Vec<&[SfccCell]> = groups.iter().map(|r| &oct.leaves[r.clone()]).collect();
    contour_faces_for(oct, tree, points, opts, &leaf_groups)
}

/// Spatial-partition (#3 slice 3) entry: contour ONE leaf group into its OWN,
/// SEPARATE face map + point table (the caller supplies a fresh `points`) — the
/// per-worker view, no shared state. Unlike the shared-table path, a coarse cell in
/// this group at a T-junction toward a FINER region cannot rely on the finer cells
/// (which may live in another group) to populate the sub-faces: so this also
/// contours those finer quarter sub-faces into THIS group's map — the **halo**. The
/// quarter faces are exactly what [`crate::sfcc::cell_mesh::gather_segments`] will
/// look up for the coarse cell, contoured by the identical [`contour_face`] call the
/// finer cell would make (order-independent), so the group meshes bit-identically to
/// the serial run. Crossings/pins carry GLOBAL keys, so merging N groups' partials by
/// key (`PointTable::key_at`) reconstructs the serial mesh.
pub fn contour_subset_separate(
    oct: &SfccOctree,
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &FaceContourOptions,
    group: &[SfccCell],
) -> FaceContourResult {
    let mut faces: [HashMap<i64, FaceRecord>; 3] = [HashMap::new(), HashMap::new(), HashMap::new()];
    let grad_bound = tree.grad_bound();
    let prune = contour_should_prune(tree);
    // Each separate partial owns its caches: `stratum_tags` is keyed by point id,
    // which is table-local, so it cannot be shared across partials. Pure memoization
    // (values are geometry-derived), so per-partial caches only forgo reuse.
    let mut caches = opts
        .features
        .map(|_| FeatureCaches { recovered: HashMap::new(), stratum_tags: HashMap::new() });

    // 1. The group's own faces (skips faces internal toward a finer region).
    let (mut multi_run_faces, mut boundary_violations, key_collisions) =
        contour_into(oct, tree, grad_bound, prune, points, opts, group, &mut faces, caches.as_mut());

    // 2. Halo: contour the finer quarter sub-faces this group's coarse cells need.
    let lat = oct.lat;
    for cell in group {
        let stride = stride_at_level(&lat, cell.level);
        let base = [cell.ix * stride, cell.iy * stride, cell.iz * stride];
        for axis in 0..3usize {
            let [u, v] = face_axes(axis);
            for side in 0..=1 {
                let mut ncoord = [cell.ix, cell.iy, cell.iz];
                ncoord[axis] += if side == 1 { 1 } else { -1 };
                // Only T-junctions toward a finer region: the coarse face was skipped
                // in step 1; the finer cell that would fill the sub-faces may be in
                // another group, so fill them here.
                if !oct.is_internal(cell.level as i64, ncoord[0], ncoord[1], ncoord[2]) {
                    continue;
                }
                let mut g = base;
                if side == 1 {
                    g[axis] += stride;
                }
                let half = stride / 2;
                if half < 1 {
                    continue;
                }
                for a in 0..=1i64 {
                    for b in 0..=1i64 {
                        let mut q = g;
                        q[u] += a * half;
                        q[v] += b * half;
                        let qkey = pack_point(&lat, q[0], q[1], q[2]);
                        if faces[axis].contains_key(&qkey) {
                            continue; // already contoured (a finer cell in this group, or another quarter)
                        }
                        // Halo is a one-off face per coarse-side T-junction; no coarse
                        // region to amortize over, so evaluate the full tree directly.
                        let rec = contour_face(
                            oct,
                            tree,
                            grad_bound,
                            points,
                            axis,
                            q[0],
                            q[1],
                            q[2],
                            half,
                            opts,
                            caches.as_mut(),
                        );
                        let seg_count = rec.segments.len();
                        if (q[axis] == 0 || q[axis] == lat.res) && seg_count > 0 {
                            boundary_violations += 1;
                        }
                        if seg_count >= 3 {
                            multi_run_faces += 1;
                        }
                        faces[axis].insert(qkey, rec);
                    }
                }
            }
        }
    }

    repair_face_duplicates(&mut faces, tree, points, opts);
    FaceContourResult { faces, multi_run_faces, boundary_violations, key_collisions }
}

/// Shared contour driver: one face map + point table, fed by each group's cell
/// loop, repaired once. The serial path passes one group (`&oct.leaves`); the
/// partitioned path passes N leaf slices. Identical loop either way.
pub(crate) fn contour_faces_for(
    oct: &SfccOctree,
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &FaceContourOptions,
    groups: &[&[SfccCell]],
) -> FaceContourResult {
    let mut faces: [HashMap<i64, FaceRecord>; 3] = [HashMap::new(), HashMap::new(), HashMap::new()];
    let mut multi_run_faces = 0usize;
    let mut boundary_violations = 0usize;
    let mut key_collisions = 0usize;

    // Lever 1: tree-level advisory hoisted once + the per-cell prune gate (the same
    // gate the octree certificates use). `contour_face` builds a fresh per-face
    // pruned view when `prune` is set.
    let grad_bound = tree.grad_bound();
    // Coarse-region pruning gate (see `contour_should_prune`).
    let prune = contour_should_prune(tree);

    // Shared sub-edge recovery + stratum-tag caches for the WHOLE pass (shared
    // across groups — pure memoization, so sharing only saves recomputation).
    let mut caches = opts
        .features
        .map(|_| FeatureCaches { recovered: HashMap::new(), stratum_tags: HashMap::new() });

    for &group in groups {
        let (mr, bv, kc) = contour_into(
            oct,
            tree,
            grad_bound,
            prune,
            points,
            opts,
            group,
            &mut faces,
            caches.as_mut(),
        );
        multi_run_faces += mr;
        boundary_violations += bv;
        key_collisions += kc;
    }

    repair_face_duplicates(&mut faces, tree, points, opts);

    FaceContourResult { faces, multi_run_faces, boundary_violations, key_collisions }
}

/// Contour the faces of one leaf subset into the shared `faces` map (+ `points`).
/// Returns the (multi_run_faces, boundary_violations, key_collisions) deltas. A
/// face already present (enumerated by an earlier cell/group) is skipped — first
/// enumerator wins, and `contour_face` is pure of enumeration order, so the result
/// is independent of how leaves are grouped.
/// Coarse octree level at which the contour prune view is built and reused. A leaf at
/// `level ≥ CONTOUR_PRUNE_LEVEL` shares the pruned view of its level-`CONTOUR_PRUNE_LEVEL`
/// ancestor with every other leaf under that ancestor (amortizing the `prune_to_box`
/// build — the cost that sank the per-cell Lever 1); a coarser leaf is its own region.
///
/// The level trades build count against prune tightness, and the build cost
/// (`prune_to_box` is `O(tree²)` per region) dominates, so COARSER wins. MEASURED on mech
/// (d4-9, ~240k crossings), contour phase vs the full-tree baseline (3863 ms): level 6 =
/// +5% (too many builds, net-NEGATIVE), level 4 = −6%, **level 5 = −9% (3508 ms)** — the
/// sweet spot (few enough builds, still prunes mech's spatially-distributed tree to a
/// small local subset). Bit-exact (`tris` identical, all parity/determinism suites green).
const CONTOUR_PRUNE_LEVEL: u32 = 5;

/// Coarse-region pruning pays off only when the tree is large enough that a coarse cell
/// touches a small fraction of it. Below a handful of leaves the full-tree tight loop
/// wins (the per-region build + `Pruned::f` indirection never amortize). Unlike the
/// per-cell Lever 1 (`lever1_should_prune`, OFF), the build here is shared across a whole
/// coarse region's leaves, so the amortization that sank Lever 1 is no longer the issue.
fn contour_should_prune(tree: &CsgNode) -> bool {
    tree.leaf_count() > LEVER1_MIN_LEAVES
}

/// Cache key for a leaf's coarse-prune region (its `CONTOUR_PRUNE_LEVEL` ancestor).
fn contour_coarse_key(cell: &SfccCell) -> u64 {
    let l = cell.level.min(CONTOUR_PRUNE_LEVEL);
    let s = cell.level - l;
    let cix = ((cell.ix >> s) as u64) & 0xFFFFF;
    let ciy = ((cell.iy >> s) as u64) & 0xFFFFF;
    let ciz = ((cell.iz >> s) as u64) & 0xFFFFF;
    ((l as u64) << 60) | (cix << 40) | (ciy << 20) | ciz
}

/// World box (center, half) of a leaf's coarse-prune region: the coarse cell, padded by
/// a small margin (crossings/grads sit on the leaf's faces — inside the coarse cell — so
/// only a thin boundary margin is needed for points exactly on a coarse face). Bit-exact
/// over this box ⇒ bit-exact for every `contour_face` eval of a leaf under it.
fn contour_coarse_box(lat: &SfccLattice, cell: &SfccCell, root_tol: f64) -> ([f64; 3], [f64; 3]) {
    let l = cell.level.min(CONTOUR_PRUNE_LEVEL);
    let s = cell.level - l;
    let cix = cell.ix >> s;
    let ciy = cell.iy >> s;
    let ciz = cell.iz >> s;
    let stride = stride_at_level(lat, l);
    let wmin = point_to_world(lat, cix * stride, ciy * stride, ciz * stride);
    let wmax = point_to_world(lat, (cix + 1) * stride, (ciy + 1) * stride, (ciz + 1) * stride);
    let cs = wmax[0] - wmin[0]; // cubic lattice ⇒ uniform per axis
    let m = cs * 0.1 + root_tol * 8.0;
    let center = [(wmin[0] + wmax[0]) * 0.5, (wmin[1] + wmax[1]) * 0.5, (wmin[2] + wmax[2]) * 0.5];
    (center, [cs * 0.5 + m, cs * 0.5 + m, cs * 0.5 + m])
}

#[allow(clippy::too_many_arguments)]
fn contour_into(
    oct: &SfccOctree,
    tree: &CsgNode,
    grad_bound: f64,
    prune: bool,
    points: &mut PointTable,
    opts: &FaceContourOptions,
    leaves: &[SfccCell],
    faces: &mut [HashMap<i64, FaceRecord>; 3],
    mut caches: Option<&mut FeatureCaches>,
) -> (usize, usize, usize) {
    let lat = oct.lat;
    let mut multi_run_faces = 0usize;
    let mut boundary_violations = 0usize;
    let mut key_collisions = 0usize;
    // Coarse-region pruned views, built lazily on first touch and reused across every
    // leaf under the same `CONTOUR_PRUNE_LEVEL` ancestor.
    let mut prune_cache: HashMap<u64, Pruned> = HashMap::new();
    for (ci, cell) in leaves.iter().enumerate() {
        // Cooperative cancel (every ~1k leaves so the check is free): stop and return the
        // partial face map; the pipeline driver re-checks after contouring and bails.
        if ci & 0x3FF == 0 && crate::sfcc::cancel::is_cancelled() {
            break;
        }
        let stride = stride_at_level(&lat, cell.level);
        let base = [cell.ix * stride, cell.iy * stride, cell.iz * stride];
        let q: &dyn SdfQuery = if prune {
            &*prune_cache.entry(contour_coarse_key(cell)).or_insert_with(|| {
                let (c, h) = contour_coarse_box(&lat, cell, opts.root_tol);
                tree.prune_to_box(c, h)
            })
        } else {
            tree
        };
        for axis in 0..3usize {
            for side in 0..=1 {
                let mut ncoord = [cell.ix, cell.iy, cell.iz];
                ncoord[axis] += if side == 1 { 1 } else { -1 };
                if oct.is_internal(cell.level as i64, ncoord[0], ncoord[1], ncoord[2]) {
                    continue;
                }
                let mut g = base;
                if side == 1 {
                    g[axis] += stride;
                }
                let key = pack_point(&lat, g[0], g[1], g[2]);
                if let Some(existing) = faces[axis].get(&key) {
                    if existing.len != stride {
                        key_collisions += 1;
                    }
                    continue;
                }
                let rec = contour_face(
                    oct,
                    q,
                    grad_bound,
                    points,
                    axis,
                    g[0],
                    g[1],
                    g[2],
                    stride,
                    opts,
                    caches.as_deref_mut(),
                );
                let seg_count = rec.segments.len();
                let on_root_boundary = g[axis] == 0 || g[axis] == lat.res;
                if on_root_boundary && seg_count > 0 {
                    boundary_violations += 1;
                }
                if seg_count >= 3 {
                    multi_run_faces += 1;
                }
                faces[axis].insert(key, rec);
            }
        }
    }
    (multi_run_faces, boundary_violations, key_collisions)
}

/// Global duplicate-segment repair: two faces must never emit the same undirected
/// (a, b) segment. Split EVERY occurrence with its own face-owned midpoint. Port of
/// the `pairOwners` dedup pass. Runs ONCE over the fully-populated face map (after
/// all partition groups), so the result is partition-independent.
fn repair_face_duplicates(
    faces: &mut [HashMap<i64, FaceRecord>; 3],
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &FaceContourOptions,
) {
    const EDGE_BASE: i64 = 0x8000000;
    let mut pair_owners: HashMap<i64, Vec<(usize, i64, usize)>> = HashMap::new(); // edge key → (axis, face key, seg idx)
    for (axis, per_axis) in faces.iter().enumerate() {
        for (&fkey, rec) in per_axis.iter() {
            for (i, s) in rec.segments.iter().enumerate() {
                let (a, b) = (s.a as i64, s.b as i64);
                let k = if a < b { a * EDGE_BASE + b } else { b * EDGE_BASE + a };
                pair_owners.entry(k).or_default().push((axis, fkey, i));
            }
        }
    }
    let mut dup_keys: Vec<i64> = pair_owners.iter().filter(|(_, v)| v.len() >= 2).map(|(&k, _)| k).collect();
    dup_keys.sort_unstable();
    for k in dup_keys {
        let mut list = pair_owners.remove(&k).unwrap();
        // Split later occurrences first so stored indices stay valid per record.
        list.sort_by_key(|x| std::cmp::Reverse(x.2));
        for (axis, fkey, idx) in list {
            let s = faces[axis].get(&fkey).unwrap().segments[idx];
            let ta = point_merge_token(points, s.a);
            let tb = point_merge_token(points, s.b);
            let (lo, hi) = if ta <= tb { (&ta, &tb) } else { (&tb, &ta) };
            let mid_key = format!("rmid:{axis}:{fkey}:{lo}:{hi}");
            let mid = split_midpoint(tree, points, s.a, s.b, opts.root_tol, &mid_key);
            let rec = faces[axis].get_mut(&fkey).unwrap();
            rec.segments[idx] = FaceSegment { a: s.a, b: mid };
            rec.segments.insert(idx + 1, FaceSegment { a: mid, b: s.b });
            rec.consumed_fwd.push(0);
            rec.consumed_rev.push(0);
        }
    }
}
