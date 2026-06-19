//! S1 native feature compilation. Port of `compileNativeFeatures`
//! (`src/export/sfcc/feature-set.mts`), recomputed analytically from the baked
//! similarities.
//!
//! M4a: **box / cylinder / cone / sphere** native features + per-shape strata
//! builders. Box = 12 segment edges + 8 valence-3 corners; cylinder = 2 rim
//! circles; cone = base circle + apex corner; sphere = no curves, one carrier.
//! Each leaf contributes its strata to the global `strata` list (matching the TS
//! evaluator's per-leaf `buildStrata` order), so curve `adjacent_strata` indices
//! line up with the TS tree. Strata CARRIER geometry (f/normal) is now
//! parity-verified against TS (`tests/strata_parity.rs`), closing the earlier gap.
//!
//! DEFERRED to later M4 slices: lathe rings + extrude/loft (traced curves, newton,
//! twistedSide/loftSide ruled carriers), boolean seams (seam-trace + trim), and
//! the feature-aware refine/contour/cell-mesh honoring paths.

use crate::math::similarity::Similarity;
use crate::primitives::polygon2d::{outward_edge_normal_2d, polygon_dist_2d};
use crate::primitives::shapes::{LatheEdgeKind, LatheProfileEdge, LATHE_AXIS_R};
use crate::sdf::{CsgNode, Leaf, Shape};
use crate::sfcc::feature_curves::{
    make_circle_curve, make_segment_curve, make_traced_curve, FeatureCurve, TracedRefine,
};
use crate::sfcc::seam_trace::trace_all_seams;
use crate::sfcc::spatial_index::SfccSpatialIndex;
use crate::sfcc::tree::{build_tree, SfccTree};
use crate::sfcc::trim::trim_and_wire;
use crate::strata::{Stratum, StratumIdentity};
use crate::tolerances::ResolvedTolerances;

#[derive(Clone, Debug)]
pub struct SfccCorner {
    pub id: usize,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Incident stratum ids.
    pub strata: Vec<usize>,
    /// (curve_id, end) where end ∈ {0,1}.
    pub curve_ends: Vec<(usize, u8)>,
}

/// Monotonic id stamped onto every compiled [`SfccFeatureSet`] (its `run_id`).
/// Sole use: cache-keying the per-run `axis_plane_crossings` memo so a later
/// export's curve ids can't be served stale crossings from a prior run. Starts at
/// 1 (the memo treats 0 as "unset"); wraparound is harmless (4e18 exports).
static NEXT_FEATURE_SET_RUN_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_feature_set_run_id() -> u64 {
    NEXT_FEATURE_SET_RUN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

pub struct SfccFeatureSet {
    pub curves: Vec<FeatureCurve>,
    pub corners: Vec<SfccCorner>,
    pub index: SfccSpatialIndex,
    /// All strata of the compiled tree (curve.adjacent_strata index into this).
    pub strata: Vec<Stratum>,
    /// Unique per compiled set; keys the per-run `axis_plane_crossings` memo (see
    /// [`FeatureCurve::axis_plane_crossings_cached`]). Set via [`next_feature_set_run_id`].
    pub run_id: u64,
}

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

/// Similarity transform of a local plane `n·local + off = 0` into world space:
/// `(R·n)·world + (s·off − (R·n)·t) = 0` (R·n stays unit).
fn world_plane(ident: StratumIdentity, sim: &Similarity, nx: f64, ny: f64, nz: f64, off: f64) -> Stratum {
    let wn = sim.rotate_vector(nx, ny, nz);
    let woff = -(wn[0] * sim.t[0] + wn[1] * sim.t[1] + wn[2] * sim.t[2]) + sim.s * off;
    Stratum::plane(ident, wn[0], wn[1], wn[2], woff)
}

/// The 6 box face planes, order +x,−x,+y,−y,+z,−z (local_index 0..5).
fn build_box_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, half: [f64; 3]) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let [hx, hy, hz] = half;
    let mk = |i: usize, nx: f64, ny: f64, nz: f64, off: f64| {
        world_plane(
            StratumIdentity { id: first_id + i, owner_node_id: -1, leaf_index, local_index: i, sign: leaf.sign },
            &leaf.sim,
            nx,
            ny,
            nz,
            off,
        )
    };
    vec![
        mk(0, 1.0, 0.0, 0.0, -(px + hx)),
        mk(1, -1.0, 0.0, 0.0, px - hx),
        mk(2, 0.0, 1.0, 0.0, -(py + hy)),
        mk(3, 0.0, -1.0, 0.0, py - hy),
        mk(4, 0.0, 0.0, 1.0, -(pz + hz)),
        mk(5, 0.0, 0.0, -1.0, pz - hz),
    ]
}

fn sid(id: usize, leaf_index: usize, local_index: usize, sign: f64) -> StratumIdentity {
    StratumIdentity { id, owner_node_id: -1, leaf_index, local_index, sign }
}

/// On-locus refine tolerances for NATIVE traced curves (twisted-extrude helices,
/// curved loft morphs). Mirrors the hardcoded `projectToCarrierPair(…, 1e-10,
/// 1e-3, 0.5, …)` arguments in feature-set.mts's `makeTracedCurve` callbacks.
fn traced_native_refine() -> TracedRefine {
    TracedRefine { curve_eps: 1e-10, min_cross: 1e-3, max_displacement: 0.5 }
}

/// Grow `diag` by the leaf's world-AABB diagonal (the TS `compileNativeFeatures`
/// derives its spatial-index cell size from `leaf.aabb` for every shape).
fn track_leaf_diag(leaf: &Leaf, diag: &mut f64) {
    let (c, half) = crate::sfcc::tree::local_aabb_box(&leaf.shape, leaf.pos);
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for i in 0..8 {
        let p = leaf.sim.apply_point(
            c[0] + if i & 1 != 0 { half[0] } else { -half[0] },
            c[1] + if i & 2 != 0 { half[1] } else { -half[1] },
            c[2] + if i & 4 != 0 { half[2] } else { -half[2] },
        );
        for a in 0..3 {
            lo[a] = lo[a].min(p[a]);
            hi[a] = hi[a].max(p[a]);
        }
    }
    let d = (hi[0] - lo[0]).hypot(hi[1] - lo[1]).hypot(hi[2] - lo[2]);
    if d > *diag {
        *diag = d;
    }
}

/// Cylinder strata: [mantle, cap +y, cap −y] (local_index 0,1,2), matching the
/// evaluator's `buildStrata` order in cpu-sdf.mts.
fn build_cylinder_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, r: f64, h: f64) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let a = leaf.sim.apply_point(px, py, pz);
    let u = leaf.sim.rotate_vector(0.0, 1.0, 0.0);
    vec![
        Stratum::cylinder(sid(first_id, leaf_index, 0, leaf.sign), a[0], a[1], a[2], u[0], u[1], u[2], leaf.sim.s * r),
        world_plane(sid(first_id + 1, leaf_index, 1, leaf.sign), &leaf.sim, 0.0, 1.0, 0.0, -(py + h)),
        world_plane(sid(first_id + 2, leaf_index, 2, leaf.sign), &leaf.sim, 0.0, -1.0, 0.0, py - h),
    ]
}

/// Cone strata: [mantle, base plane] (local_index 0,1). Half-angle from L=hypot(h,r):
/// sin = r/L, cos = h/L; apex at +h, axis `u` points apex→base (local −y).
fn build_cone_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, r: f64, h: f64) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let apex = leaf.sim.apply_point(px, py + h, pz);
    let u = leaf.sim.rotate_vector(0.0, -1.0, 0.0);
    let l = h.hypot(r);
    vec![
        Stratum::cone(sid(first_id, leaf_index, 0, leaf.sign), apex[0], apex[1], apex[2], u[0], u[1], u[2], r / l, h / l),
        world_plane(sid(first_id + 1, leaf_index, 1, leaf.sign), &leaf.sim, 0.0, -1.0, 0.0, py),
    ]
}

/// Lathe strata: one carrier per non-axis profile edge, in edge order (the
/// skip-"none" layout `compile_native_features` re-derives via the edge list).
/// Each carrier's normal matches the edge's outward profile normal — edges
/// whose outward points toward the axis (bores) fold a flip into `sign`. Port
/// of the Lathe `buildStrata` in cpu-sdf.mts.
fn build_lathe_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, edges: &[LatheProfileEdge]) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let a = leaf.sim.apply_point(px, py, pz);
    let u = leaf.sim.rotate_vector(0.0, 1.0, 0.0);
    let mut out: Vec<Stratum> = Vec::new();
    for e in edges {
        if e.kind == LatheEdgeKind::None {
            continue;
        }
        let ident = sid(first_id + out.len(), leaf_index, out.len(), leaf.sign);
        match e.kind {
            LatheEdgeKind::Plane => {
                let ny3 = if e.ny > 0.0 { 1.0 } else { -1.0 };
                out.push(world_plane(ident, &leaf.sim, 0.0, ny3, 0.0, -ny3 * (py + (e.y0 + e.y1) * 0.5)));
            }
            LatheEdgeKind::Cylinder => {
                let flip = if e.nr > 0.0 { 1.0 } else { -1.0 };
                out.push(Stratum::cylinder(
                    StratumIdentity { sign: leaf.sign * flip, ..ident },
                    a[0],
                    a[1],
                    a[2],
                    u[0],
                    u[1],
                    u[2],
                    leaf.sim.s * ((e.r0 + e.r1) * 0.5).abs(),
                ));
            }
            LatheEdgeKind::Cone => {
                // Apex where the edge's supporting line meets the axis; uw points
                // from the apex toward the edge.
                let dr = e.r1 - e.r0;
                let dy = e.y1 - e.y0;
                let y_apex = e.y0 - e.r0 * (dy / dr);
                let apex = leaf.sim.apply_point(px, py + y_apex, pz);
                let uw = leaf.sim.rotate_vector(0.0, if dy * dr > 0.0 { 1.0 } else { -1.0 }, 0.0);
                let flip = if e.nr > 0.0 { 1.0 } else { -1.0 };
                out.push(Stratum::cone(
                    StratumIdentity { sign: leaf.sign * flip, ..ident },
                    apex[0],
                    apex[1],
                    apex[2],
                    uw[0],
                    uw[1],
                    uw[2],
                    dr.abs() / e.len,
                    dy.abs() / e.len,
                ));
            }
            LatheEdgeKind::None => unreachable!(),
        }
    }
    out
}

/// Extrude strata: N side carriers (planes when untwisted, twisted-side ruled
/// carriers otherwise) + cap +y + cap −y. Port of the Extrude `buildStrata`.
fn build_extrude_strata(
    leaf: &Leaf,
    leaf_index: usize,
    first_id: usize,
    verts: &[f64],
    wind: f64,
    h: f64,
    twist_rad: f64,
) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let n = verts.len() / 2;
    let mut out: Vec<Stratum> = Vec::with_capacity(n + 2);
    for i in 0..n {
        let v0x = verts[i * 2];
        let v0z = verts[i * 2 + 1];
        let v1x = verts[((i + 1) % n) * 2];
        let v1z = verts[((i + 1) % n) * 2 + 1];
        let [nx2, nz2] = outward_edge_normal_2d(v1x - v0x, v1z - v0z, wind);
        let ident = sid(first_id + i, leaf_index, i, leaf.sign);
        if twist_rad == 0.0 {
            out.push(world_plane(ident, &leaf.sim, nx2, 0.0, nz2, -(nx2 * (px + v0x) + nz2 * (pz + v0z))));
        } else {
            out.push(Stratum::twisted_side(
                ident,
                crate::strata::TwistedSideParams {
                    sim: leaf.sim,
                    pos_x: px,
                    pos_y: py,
                    pos_z: pz,
                    h,
                    twist_rad,
                    v0x,
                    v0z,
                    nx2,
                    nz2,
                },
            ));
        }
    }
    out.push(world_plane(sid(first_id + n, leaf_index, n, leaf.sign), &leaf.sim, 0.0, 1.0, 0.0, -(py + h)));
    out.push(world_plane(sid(first_id + n + 1, leaf_index, n + 1, leaf.sign), &leaf.sim, 0.0, -1.0, 0.0, py - h));
    out
}

/// One side carrier of a loft segment: blends lower-profile edge `a_edge` with
/// upper-profile edge `b_edge` (supporting lines: point `*_x,*_z`, outward unit
/// normal `*_nx,*_nz`). `event_lower`/`event_vertex` identify the carrier's
/// starting boundary with the previous carrier (cyclic): a lower-profile corner
/// when `event_lower`, else an upper-profile corner.
#[derive(Clone, Copy)]
struct LoftCarrier {
    a_edge: usize,
    a_x: f64,
    a_z: f64,
    a_nx: f64,
    a_nz: f64,
    b_edge: usize,
    b_x: f64,
    b_z: f64,
    b_nx: f64,
    b_nz: f64,
    event_lower: bool,
    event_vertex: usize,
}

/// Side carriers of one loft segment between lower profile `a` and upper profile
/// `b`, as an angular cyclic merge of the two profiles' corners — a monotone
/// `(a_edge, b_edge)` staircase of length `na + nb`. Pure and deterministic, so
/// the strata builder ([`build_loft_strata_general`]) and the feature emitter
/// ([`emit_loft_features_general`]) agree on carrier ids. Each profile is assumed
/// star-shaped about its centroid (corners in angular order); other shapes still
/// yield a well-formed staircase, with any mispairing filtered by the SDF/label
/// gates in the crease tracer (creases are only ever dropped, never wrong).
fn loft_seg_carriers(a: &[f64], wa: f64, b: &[f64], wb: f64) -> Vec<LoftCarrier> {
    use std::f64::consts::TAU;
    // Supporting line of edge `e` (n verts): start vertex + outward unit normal.
    let edge_line = |v: &[f64], w: f64, n: usize, e: usize| -> (f64, f64, f64, f64) {
        let v0x = v[e * 2];
        let v0z = v[e * 2 + 1];
        let e1 = (e + 1) % n;
        let [nx, nz] = outward_edge_normal_2d(v[e1 * 2] - v0x, v[e1 * 2 + 1] - v0z, w);
        (v0x, v0z, nx, nz)
    };
    // Sorted-by-angle corner order, those angles, and each angular sector's active
    // edge (sector i spans corners ord[i]..ord[i+1]; its edge connects them).
    let sectors = |v: &[f64], n: usize| -> (Vec<usize>, Vec<f64>, Vec<usize>) {
        let (mut cx, mut cz) = (0.0, 0.0);
        for j in 0..n {
            cx += v[j * 2];
            cz += v[j * 2 + 1];
        }
        cx /= n as f64;
        cz /= n as f64;
        let ang: Vec<f64> = (0..n)
            .map(|j| {
                let t = (v[j * 2 + 1] - cz).atan2(v[j * 2] - cx);
                if t < 0.0 { t + TAU } else { t }
            })
            .collect();
        let mut ord: Vec<usize> = (0..n).collect();
        ord.sort_by(|&i, &j| ang[i].partial_cmp(&ang[j]).unwrap().then(i.cmp(&j)));
        let sorted_ang: Vec<f64> = ord.iter().map(|&i| ang[i]).collect();
        let sector_edge: Vec<usize> = (0..n)
            .map(|i| {
                let j = ord[i];
                let jn = ord[(i + 1) % n];
                if (j + 1) % n == jn { j } else { jn }
            })
            .collect();
        (ord, sorted_ang, sector_edge)
    };
    let na = a.len() / 2;
    let nb = b.len() / 2;
    let (a_ord, a_ang, a_se) = sectors(a, na);
    let (b_ord, b_ang, b_se) = sectors(b, nb);
    struct Ev {
        ang: f64,
        lower: bool,
        vertex: usize,
        edge: usize,
    }
    let mut evs: Vec<Ev> = Vec::with_capacity(na + nb);
    for i in 0..na {
        evs.push(Ev { ang: a_ang[i], lower: true, vertex: a_ord[i], edge: a_se[i] });
    }
    for k in 0..nb {
        evs.push(Ev { ang: b_ang[k], lower: false, vertex: b_ord[k], edge: b_se[k] });
    }
    evs.sort_by(|x, y| {
        x.ang
            .partial_cmp(&y.ang)
            .unwrap()
            .then(y.lower.cmp(&x.lower)) // tie: lower (A) event before upper (B)
            .then(x.vertex.cmp(&y.vertex))
    });
    // Active edges of the sector containing angle 0 (the wrap sector n-1).
    let mut ea = a_se[na - 1];
    let mut eb = b_se[nb - 1];
    let mut out: Vec<LoftCarrier> = Vec::with_capacity(na + nb);
    for ev in &evs {
        if ev.lower {
            ea = ev.edge;
        } else {
            eb = ev.edge;
        }
        let (ax, az, anx, anz) = edge_line(a, wa, na, ea);
        let (bx, bz, bnx, bnz) = edge_line(b, wb, nb, eb);
        out.push(LoftCarrier {
            a_edge: ea,
            a_x: ax,
            a_z: az,
            a_nx: anx,
            a_nz: anz,
            b_edge: eb,
            b_x: bx,
            b_z: bz,
            b_nx: bnx,
            b_nz: bnz,
            event_lower: ev.lower,
            event_vertex: ev.vertex,
        });
    }
    out
}

/// Loft strata for differing-vertex-count profiles: per-segment correspondence
/// carriers from [`loft_seg_carriers`] (plane when the two edges share a
/// supporting line, loft-side ruled carrier otherwise), laid out by prefix-sum
/// offset per segment, then cap +y, cap −y.
fn build_loft_strata_general(
    leaf: &Leaf,
    leaf_index: usize,
    first_id: usize,
    profs: &[Vec<f64>],
    winds: &[f64],
    h: f64,
) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let m = profs.len();
    let seg_h = (2.0 * h) / (m as f64 - 1.0);
    let mut out: Vec<Stratum> = Vec::new();
    let mut local = 0usize;
    for seg in 0..(m - 1) {
        let seg_y0 = -h + seg as f64 * seg_h;
        let carriers = loft_seg_carriers(&profs[seg], winds[seg], &profs[seg + 1], winds[seg + 1]);
        for car in &carriers {
            let ident = sid(first_id + local, leaf_index, local, leaf.sign);
            if car.a_nx == car.b_nx && car.a_nz == car.b_nz && car.a_x == car.b_x && car.a_z == car.b_z {
                out.push(world_plane(
                    ident,
                    &leaf.sim,
                    car.a_nx,
                    0.0,
                    car.a_nz,
                    -(car.a_nx * (px + car.a_x) + car.a_nz * (pz + car.a_z)),
                ));
            } else {
                out.push(Stratum::loft_side(
                    ident,
                    crate::strata::LoftSideParams {
                        sim: leaf.sim,
                        pos_x: px,
                        pos_y: py,
                        pos_z: pz,
                        seg_y0,
                        seg_h,
                        a_x: car.a_x,
                        a_z: car.a_z,
                        a_nx: car.a_nx,
                        a_nz: car.a_nz,
                        b_x: car.b_x,
                        b_z: car.b_z,
                        b_nx: car.b_nx,
                        b_nz: car.b_nz,
                    },
                ));
            }
            local += 1;
        }
    }
    out.push(world_plane(sid(first_id + local, leaf_index, local, leaf.sign), &leaf.sim, 0.0, 1.0, 0.0, -(py + h)));
    local += 1;
    out.push(world_plane(sid(first_id + local, leaf_index, local, leaf.sign), &leaf.sim, 0.0, -1.0, 0.0, py - h));
    out
}

/// Loft strata: per-segment per-edge side carriers (plane when both profiles
/// share the supporting line, loft-side ruled carrier otherwise), laid out
/// `side(seg,j) = seg·N + j`, then cap +y, cap −y. Port of the Loft `buildStrata`.
fn build_loft_strata(
    leaf: &Leaf,
    leaf_index: usize,
    first_id: usize,
    profs: &[Vec<f64>],
    winds: &[f64],
    h: f64,
) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    // Differing-vertex-count profiles have no 1:1 edge correspondence, so the
    // per-edge ruled-carrier model below (indexed by a single shared n) doesn't
    // apply and would in fact panic out-of-bounds. Route them through the
    // correspondence-based general builder (Stage 1b). Uniform lofts keep the
    // original bit-identical path.
    if !profs.iter().all(|p| p.len() == profs[0].len()) {
        return build_loft_strata_general(leaf, leaf_index, first_id, profs, winds, h);
    }
    let m = profs.len();
    let n = profs[0].len() / 2;
    let seg_h = (2.0 * h) / (m as f64 - 1.0);
    let mut out: Vec<Stratum> = Vec::new();
    // Edge supporting line (point + outward unit 2D normal) of profile `verts`,
    // edge j: returns (v0x, v0z, nx, nz).
    let edge = |verts: &[f64], wind: f64, j: usize| -> (f64, f64, f64, f64) {
        let j1 = (j + 1) % n;
        let v0x = verts[j * 2];
        let v0z = verts[j * 2 + 1];
        let [nx, nz] = outward_edge_normal_2d(verts[j1 * 2] - v0x, verts[j1 * 2 + 1] - v0z, wind);
        (v0x, v0z, nx, nz)
    };
    for seg in 0..(m - 1) {
        for j in 0..n {
            let (a_x, a_z, a_nx, a_nz) = edge(&profs[seg], winds[seg], j);
            let (b_x, b_z, b_nx, b_nz) = edge(&profs[seg + 1], winds[seg + 1], j);
            let li = seg * n + j;
            let ident = sid(first_id + li, leaf_index, li, leaf.sign);
            if a_nx == b_nx && a_nz == b_nz && a_x == b_x && a_z == b_z {
                out.push(world_plane(ident, &leaf.sim, a_nx, 0.0, a_nz, -(a_nx * (px + a_x) + a_nz * (pz + a_z))));
            } else {
                out.push(Stratum::loft_side(
                    ident,
                    crate::strata::LoftSideParams {
                        sim: leaf.sim,
                        pos_x: px,
                        pos_y: py,
                        pos_z: pz,
                        seg_y0: -h + seg as f64 * seg_h,
                        seg_h,
                        a_x,
                        a_z,
                        a_nx,
                        a_nz,
                        b_x,
                        b_z,
                        b_nx,
                        b_nz,
                    },
                ));
            }
        }
    }
    let cap_base = (m - 1) * n;
    out.push(world_plane(
        sid(first_id + cap_base, leaf_index, cap_base, leaf.sign),
        &leaf.sim,
        0.0,
        1.0,
        0.0,
        -(py + h),
    ));
    out.push(world_plane(
        sid(first_id + cap_base + 1, leaf_index, cap_base + 1, leaf.sign),
        &leaf.sim,
        0.0,
        -1.0,
        0.0,
        py - h,
    ));
    out
}

/// Sphere stratum: a single sphere carrier (sphere has no native curves/corners).
fn build_sphere_strata(leaf: &Leaf, leaf_index: usize, first_id: usize, r: f64) -> Vec<Stratum> {
    let [px, py, pz] = leaf.pos;
    let c = leaf.sim.apply_point(px, py, pz);
    vec![Stratum::sphere(sid(first_id, leaf_index, 0, leaf.sign), c[0], c[1], c[2], leaf.sim.s * r)]
}

/// Per-leaf strata for the M4a shape subset, dispatched by shape. Shared by
/// `compile_native_features` and the seam tree view ([`crate::sfcc::tree`]) so
/// stratum ids agree across both. Extrude/Loft/Lathe strata are M4c+.
pub fn build_leaf_strata(leaf: &Leaf, leaf_index: usize, first_id: usize) -> Vec<Stratum> {
    match &leaf.shape {
        Shape::Cuboid { half } => build_box_strata(leaf, leaf_index, first_id, *half),
        Shape::Sphere { r } => build_sphere_strata(leaf, leaf_index, first_id, *r),
        Shape::Cylinder { r, h } => build_cylinder_strata(leaf, leaf_index, first_id, *r, *h),
        Shape::Cone { r, h } => build_cone_strata(leaf, leaf_index, first_id, *r, *h),
        Shape::Extrude { verts, wind, h, twist_rad } => {
            build_extrude_strata(leaf, leaf_index, first_id, verts, *wind, *h, *twist_rad)
        }
        Shape::Loft { profs, winds, h } => build_loft_strata(leaf, leaf_index, first_id, profs, winds, *h),
        Shape::Lathe { edges } => build_lathe_strata(leaf, leaf_index, first_id, edges),
    }
}

/// Native features of a Loft leaf: cap/junction corners, vertical morph curves
/// (segments where the locus is straight, traced otherwise — both validity- and
/// straightness-gated), junction creases, and cap rims. Port of the Loft branch
/// of `compileNativeFeatures`. `strata` is the leaf's strata (global id =
/// `first_id + local_index`).
#[allow(clippy::too_many_arguments)]
fn emit_loft_features(
    leaf: &Leaf,
    first_id: usize,
    profs: &[Vec<f64>],
    winds: &[f64],
    h: f64,
    strata: &[Stratum],
    curves: &mut Vec<FeatureCurve>,
    corners: &mut Vec<SfccCorner>,
) {
    // Differing-vertex-count profiles use the correspondence-based emitter (the
    // per-edge emission below indexes profs[pi][j*2] with a single shared n, which
    // would panic out-of-bounds). Uniform lofts keep the original path.
    if !profs.iter().all(|p| p.len() == profs[0].len()) {
        return emit_loft_features_general(leaf, first_id, profs, winds, h, strata, curves, corners);
    }
    let [px, py, pz] = leaf.pos;
    let m = profs.len();
    let n = profs[0].len() / 2;
    let seg_h = (2.0 * h) / (m as f64 - 1.0);
    let y_of = |pi: usize| -h + pi as f64 * seg_h;
    let side_id = |seg: usize, j: i64| -> usize { first_id + seg * n + j.rem_euclid(n as i64) as usize };
    let cap_top = first_id + (m - 1) * n;
    let cap_bottom = first_id + (m - 1) * n + 1;
    let vert_scale = {
        let mut v = 1.0f64;
        for pr in profs {
            for c in 0..(pr.len() / 2) {
                v = v.max(pr[c * 2].abs().max(pr[c * 2 + 1].abs()));
            }
        }
        v
    };
    // True outward unit 2D normal of profile pi's edge e.
    let edge_normal = |pi: usize, e: i64| -> [f64; 2] {
        let vs = &profs[pi];
        let k = e.rem_euclid(n as i64) as usize;
        let ax = vs[k * 2];
        let az = vs[k * 2 + 1];
        let bx = vs[((k + 1) % n) * 2];
        let bz = vs[((k + 1) % n) * 2 + 1];
        outward_edge_normal_2d(bx - ax, bz - az, winds[pi])
    };

    // Corners at every profile vertex.
    let mut corner_idx: Vec<Vec<usize>> = Vec::with_capacity(m);
    for pi in 0..m {
        let mut row = Vec::with_capacity(n);
        for j in 0..n {
            let vx = profs[pi][j * 2];
            let vz = profs[pi][j * 2 + 1];
            let p = leaf.sim.apply_point(px + vx, py + y_of(pi), pz + vz);
            let strata_ids: Vec<usize> = if pi == 0 {
                vec![side_id(0, j as i64 - 1), side_id(0, j as i64), cap_bottom]
            } else if pi == m - 1 {
                vec![side_id(m - 2, j as i64 - 1), side_id(m - 2, j as i64), cap_top]
            } else {
                vec![
                    side_id(pi - 1, j as i64 - 1),
                    side_id(pi - 1, j as i64),
                    side_id(pi, j as i64 - 1),
                    side_id(pi, j as i64),
                ]
            };
            let id = corners.len();
            corners.push(SfccCorner { id, x: p[0], y: p[1], z: p[2], strata: strata_ids, curve_ends: Vec::new() });
            row.push(id);
        }
        corner_idx.push(row);
    }

    // Vertical morph curves: per segment per vertex j, the exact intersection of
    // the two adjacent ruled side carriers (closed-form mixed-line crossing).
    const SAMPLES: usize = 64;
    for seg in 0..(m - 1) {
        for j in 0..n {
            let s_l = side_id(seg, j as i64 - 1);
            let s_r = side_id(seg, j as i64);
            let [n_alx, n_alz] = edge_normal(seg, j as i64 - 1);
            let [n_arx, n_arz] = edge_normal(seg, j as i64);
            let [n_blx, n_blz] = edge_normal(seg + 1, j as i64 - 1);
            let [n_brx, n_brz] = edge_normal(seg + 1, j as i64);
            let v_ax = profs[seg][j * 2];
            let v_az = profs[seg][j * 2 + 1];
            let v_bx = profs[seg + 1][j * 2];
            let v_bz = profs[seg + 1][j * 2 + 1];
            let c_al = n_alx * v_ax + n_alz * v_az;
            let c_ar = n_arx * v_ax + n_arz * v_az;
            let c_bl = n_blx * v_bx + n_blz * v_bz;
            let c_br = n_brx * v_bx + n_brz * v_bz;
            // Mixed-line crossing at height parameter t; None when degenerate.
            let q2_at = |t: f64| -> Option<[f64; 2]> {
                let m1x = (1.0 - t) * n_alx + t * n_blx;
                let m1z = (1.0 - t) * n_alz + t * n_blz;
                let m2x = (1.0 - t) * n_arx + t * n_brx;
                let m2z = (1.0 - t) * n_arz + t * n_brz;
                let c1 = (1.0 - t) * c_al + t * c_bl;
                let c2 = (1.0 - t) * c_ar + t * c_br;
                let det = m1x * m2z - m1z * m2x;
                if det.abs() < 1e-3 * m1x.hypot(m1z) * m2x.hypot(m2z) {
                    return None;
                }
                Some([(c1 * m2z - c2 * m1z) / det, (m1x * c2 - m2x * c1) / det])
            };
            let mut valid = true;
            let mut samples = vec![0.0f64; (SAMPLES + 1) * 3];
            for i in 0..=SAMPLES {
                let t = i as f64 / SAMPLES as f64;
                let pt = match q2_at(t) {
                    Some(p) => p,
                    None => {
                        valid = false;
                        break;
                    }
                };
                // Carrier-model validity: the crossing must lie on the true
                // profile-mix zero set.
                let d_a = polygon_dist_2d(&profs[seg], winds[seg], pt[0], pt[1]).d;
                let d_b = polygon_dist_2d(&profs[seg + 1], winds[seg + 1], pt[0], pt[1]).d;
                if ((1.0 - t) * d_a + t * d_b).abs() > 1e-6 * vert_scale {
                    valid = false;
                    break;
                }
                let p = leaf.sim.apply_point(px + pt[0], py + y_of(seg) + t * seg_h, pz + pt[1]);
                samples[i * 3] = p[0];
                samples[i * 3 + 1] = p[1];
                samples[i * 3 + 2] = p[2];
            }
            if !valid {
                continue;
            }
            // Straightness: collapse to an exact segment when the locus is a line.
            let ax = samples[0];
            let ay = samples[1];
            let az = samples[2];
            let bx = samples[SAMPLES * 3];
            let by = samples[SAMPLES * 3 + 1];
            let bz = samples[SAMPLES * 3 + 2];
            let chord = (bx - ax).hypot(by - ay).hypot(bz - az);
            let mut max_dev = 0.0f64;
            for i in 1..SAMPLES {
                let t = i as f64 / SAMPLES as f64;
                let dev = (samples[i * 3] - (ax + (bx - ax) * t))
                    .hypot(samples[i * 3 + 1] - (ay + (by - ay) * t))
                    .hypot(samples[i * 3 + 2] - (az + (bz - az) * t));
                max_dev = max_dev.max(dev);
            }
            let curve_id = curves.len();
            let mut curve = if max_dev < 1e-9 * chord.max(1.0) {
                make_segment_curve(curve_id, -1, [s_l, s_r], ax, ay, az, bx, by, bz)
            } else {
                make_traced_curve(
                    curve_id,
                    [s_l, s_r],
                    samples,
                    false,
                    strata[s_l - first_id],
                    strata[s_r - first_id],
                    traced_native_refine(),
                    -1,
                )
            };
            curve.native = true;
            curve.corner_start = corner_idx[seg][j] as i64;
            curve.corner_end = corner_idx[seg + 1][j] as i64;
            corners[curve.corner_start as usize].curve_ends.push((curve_id, 0));
            corners[curve.corner_end as usize].curve_ends.push((curve_id, 1));
            curves.push(curve);
        }
    }

    // Junction creases at intermediate profiles, where consecutive segments'
    // carriers genuinely differ (normal kink).
    for pi in 1..(m - 1) {
        for j in 0..n {
            let j2 = (j + 1) % n;
            let s_below = side_id(pi - 1, j as i64);
            let s_above = side_id(pi, j as i64);
            let v0x = profs[pi][j * 2];
            let v0z = profs[pi][j * 2 + 1];
            let v1x = profs[pi][j2 * 2];
            let v1z = profs[pi][j2 * 2 + 1];
            let mid = leaf.sim.apply_point(px + (v0x + v1x) / 2.0, py + y_of(pi), pz + (v0z + v1z) / 2.0);
            let nb = strata[s_below - first_id].normal(mid[0], mid[1], mid[2]);
            let na = strata[s_above - first_id].normal(mid[0], mid[1], mid[2]);
            let dot = nb[0] * na[0] + nb[1] * na[1] + nb[2] * na[2];
            if dot > 1.0 - 1e-9 {
                continue;
            }
            let curve_id = curves.len();
            let a = leaf.sim.apply_point(px + v0x, py + y_of(pi), pz + v0z);
            let b = leaf.sim.apply_point(px + v1x, py + y_of(pi), pz + v1z);
            let mut crease =
                make_segment_curve(curve_id, -1, [s_below, s_above], a[0], a[1], a[2], b[0], b[1], b[2]);
            crease.native = true;
            crease.corner_start = corner_idx[pi][j] as i64;
            crease.corner_end = corner_idx[pi][j2] as i64;
            corners[crease.corner_start as usize].curve_ends.push((curve_id, 0));
            corners[crease.corner_end as usize].curve_ends.push((curve_id, 1));
            curves.push(crease);
        }
    }

    // Cap rim segments (caps are planar; rims are the end profiles' edges).
    for j in 0..n {
        let j2 = (j + 1) % n;
        for &(cap, pi, seg) in &[(cap_bottom, 0usize, 0usize), (cap_top, m - 1, m - 2)] {
            let v0x = profs[pi][j * 2];
            let v0z = profs[pi][j * 2 + 1];
            let v1x = profs[pi][j2 * 2];
            let v1z = profs[pi][j2 * 2 + 1];
            let curve_id = curves.len();
            let a = leaf.sim.apply_point(px + v0x, py + y_of(pi), pz + v0z);
            let b = leaf.sim.apply_point(px + v1x, py + y_of(pi), pz + v1z);
            let mut rim = make_segment_curve(curve_id, -1, [side_id(seg, j as i64), cap], a[0], a[1], a[2], b[0], b[1], b[2]);
            rim.native = true;
            rim.corner_start = corner_idx[pi][j] as i64;
            rim.corner_end = corner_idx[pi][j2] as i64;
            corners[rim.corner_start as usize].curve_ends.push((curve_id, 0));
            corners[rim.corner_end as usize].curve_ends.push((curve_id, 1));
            curves.push(rim);
        }
    }
}

/// Native features of a differing-vertex-count Loft leaf (Stage 1b): corners at
/// every profile vertex, vertical morph creases traced over their valid
/// sub-interval (born at a profile corner, free-ended where the crease flattens),
/// junction creases at interior profiles, and cap rims. Strata ids agree with
/// [`build_loft_strata_general`] because both enumerate carriers via
/// [`loft_seg_carriers`].
#[allow(clippy::too_many_arguments)]
fn emit_loft_features_general(
    leaf: &Leaf,
    first_id: usize,
    profs: &[Vec<f64>],
    winds: &[f64],
    h: f64,
    strata: &[Stratum],
    curves: &mut Vec<FeatureCurve>,
    corners: &mut Vec<SfccCorner>,
) {
    let [px, py, pz] = leaf.pos;
    let m = profs.len();
    let seg_h = (2.0 * h) / (m as f64 - 1.0);
    let y_of = |pi: usize| -h + pi as f64 * seg_h;
    let vert_scale = {
        let mut v = 1.0f64;
        for pr in profs {
            for c in 0..(pr.len() / 2) {
                v = v.max(pr[c * 2].abs().max(pr[c * 2 + 1].abs()));
            }
        }
        v
    };
    let carriers: Vec<Vec<LoftCarrier>> = (0..m - 1)
        .map(|seg| loft_seg_carriers(&profs[seg], winds[seg], &profs[seg + 1], winds[seg + 1]))
        .collect();
    let mut offset = vec![0usize; m - 1];
    for seg in 1..(m - 1) {
        offset[seg] = offset[seg - 1] + carriers[seg - 1].len();
    }
    let total_side: usize = carriers.iter().map(|c| c.len()).sum();
    let cap_top = first_id + total_side;
    let cap_bottom = first_id + total_side + 1;
    let side_id = |seg: usize, c: usize| -> usize { first_id + offset[seg] + c };

    // Corners at every profile vertex, wired to incident side carriers + caps.
    let mut corner_idx: Vec<Vec<usize>> = Vec::with_capacity(m);
    for pi in 0..m {
        let np = profs[pi].len() / 2;
        let mut row = Vec::with_capacity(np);
        for v in 0..np {
            let vx = profs[pi][v * 2];
            let vz = profs[pi][v * 2 + 1];
            let p = leaf.sim.apply_point(px + vx, py + y_of(pi), pz + vz);
            let v_prev = (v + np - 1) % np;
            let mut st: Vec<usize> = Vec::new();
            if pi < m - 1 {
                for (c, car) in carriers[pi].iter().enumerate() {
                    if car.a_edge == v || car.a_edge == v_prev {
                        st.push(side_id(pi, c));
                    }
                }
            }
            if pi > 0 {
                for (c, car) in carriers[pi - 1].iter().enumerate() {
                    if car.b_edge == v || car.b_edge == v_prev {
                        st.push(side_id(pi - 1, c));
                    }
                }
            }
            if pi == 0 {
                st.push(cap_bottom);
            }
            if pi == m - 1 {
                st.push(cap_top);
            }
            let id = corners.len();
            corners.push(SfccCorner { id, x: p[0], y: p[1], z: p[2], strata: st, curve_ends: Vec::new() });
            row.push(id);
        }
        corner_idx.push(row);
    }

    // Vertical morph creases: each carrier boundary, traced over its valid
    // sub-interval. Gate 1 = the crossing lies on the true blend zero set; Gate 2
    // = the crossing's nearest A/B edges are the carrier-boundary's edges (so the
    // crease can never be placed off its patch — non-convex medial-axis kinks are
    // dropped, never mis-emitted).
    const SAMPLES: usize = 64;
    for seg in 0..(m - 1) {
        let cars = &carriers[seg];
        let lc = cars.len();
        let seg_y0 = y_of(seg);
        for c in 0..lc {
            let cprev = &cars[(c + lc - 1) % lc];
            let ccur = &cars[c];
            if cprev.a_edge == ccur.a_edge && cprev.b_edge == ccur.b_edge {
                continue; // degenerate zero-width boundary (exact angle tie)
            }
            let s_l = side_id(seg, (c + lc - 1) % lc);
            let s_r = side_id(seg, c);
            let (n_alx, n_alz, c_al) = (cprev.a_nx, cprev.a_nz, cprev.a_nx * cprev.a_x + cprev.a_nz * cprev.a_z);
            let (n_arx, n_arz, c_ar) = (ccur.a_nx, ccur.a_nz, ccur.a_nx * ccur.a_x + ccur.a_nz * ccur.a_z);
            let (n_blx, n_blz, c_bl) = (cprev.b_nx, cprev.b_nz, cprev.b_nx * cprev.b_x + cprev.b_nz * cprev.b_z);
            let (n_brx, n_brz, c_br) = (ccur.b_nx, ccur.b_nz, ccur.b_nx * ccur.b_x + ccur.b_nz * ccur.b_z);
            let q2_at = |t: f64| -> Option<[f64; 2]> {
                let m1x = (1.0 - t) * n_alx + t * n_blx;
                let m1z = (1.0 - t) * n_alz + t * n_blz;
                let m2x = (1.0 - t) * n_arx + t * n_brx;
                let m2z = (1.0 - t) * n_arz + t * n_brz;
                let c1 = (1.0 - t) * c_al + t * c_bl;
                let c2 = (1.0 - t) * c_ar + t * c_br;
                let det = m1x * m2z - m1z * m2x;
                if det.abs() < 1e-3 * m1x.hypot(m1z) * m2x.hypot(m2z) {
                    return None;
                }
                Some([(c1 * m2z - c2 * m1z) / det, (m1x * c2 - m2x * c1) / det])
            };
            let a_set = [cprev.a_edge, ccur.a_edge];
            let b_set = [cprev.b_edge, ccur.b_edge];
            let mut pts = vec![[0.0f64; 3]; SAMPLES + 1];
            let mut valid = vec![false; SAMPLES + 1];
            for i in 0..=SAMPLES {
                let t = i as f64 / SAMPLES as f64;
                if let Some(pt) = q2_at(t) {
                    let ra = polygon_dist_2d(&profs[seg], winds[seg], pt[0], pt[1]);
                    let rb = polygon_dist_2d(&profs[seg + 1], winds[seg + 1], pt[0], pt[1]);
                    let gate1 = ((1.0 - t) * ra.d + t * rb.d).abs() <= 1e-6 * vert_scale;
                    let gate2 = a_set.contains(&ra.edge) && b_set.contains(&rb.edge);
                    if gate1 && gate2 {
                        let wp = leaf.sim.apply_point(px + pt[0], py + seg_y0 + t * seg_h, pz + pt[1]);
                        pts[i] = [wp[0], wp[1], wp[2]];
                        valid[i] = true;
                    }
                }
            }
            // One curve per maximal contiguous valid run (≥ 2 samples).
            let mut i = 0usize;
            while i <= SAMPLES {
                if !valid[i] {
                    i += 1;
                    continue;
                }
                let i0 = i;
                while i + 1 <= SAMPLES && valid[i + 1] {
                    i += 1;
                }
                let i1 = i;
                i += 1;
                if i1 == i0 {
                    continue;
                }
                let cnt = i1 - i0 + 1;
                let mut samples = Vec::with_capacity(cnt * 3);
                for k in i0..=i1 {
                    samples.extend_from_slice(&pts[k]);
                }
                let ax = samples[0];
                let ay = samples[1];
                let az = samples[2];
                let bx = samples[(cnt - 1) * 3];
                let by = samples[(cnt - 1) * 3 + 1];
                let bz = samples[(cnt - 1) * 3 + 2];
                let chord = (bx - ax).hypot(by - ay).hypot(bz - az);
                let mut max_dev = 0.0f64;
                for k in 1..(cnt - 1) {
                    let tt = k as f64 / (cnt - 1) as f64;
                    let dev = (samples[k * 3] - (ax + (bx - ax) * tt))
                        .hypot(samples[k * 3 + 1] - (ay + (by - ay) * tt))
                        .hypot(samples[k * 3 + 2] - (az + (bz - az) * tt));
                    max_dev = max_dev.max(dev);
                }
                let curve_id = curves.len();
                let mut curve = if max_dev < 1e-9 * chord.max(1.0) {
                    make_segment_curve(curve_id, -1, [s_l, s_r], ax, ay, az, bx, by, bz)
                } else {
                    make_traced_curve(
                        curve_id,
                        [s_l, s_r],
                        samples,
                        false,
                        strata[s_l - first_id],
                        strata[s_r - first_id],
                        traced_native_refine(),
                        -1,
                    )
                };
                curve.native = true;
                // A run reaching t=0 lands on a lower-profile corner (an A-event
                // crease); reaching t=1 lands on an upper-profile corner (B-event).
                let cs: i64 =
                    if i0 == 0 && ccur.event_lower { corner_idx[seg][ccur.event_vertex] as i64 } else { -1 };
                let ce: i64 = if i1 == SAMPLES && !ccur.event_lower {
                    corner_idx[seg + 1][ccur.event_vertex] as i64
                } else {
                    -1
                };
                curve.corner_start = cs;
                curve.corner_end = ce;
                if cs >= 0 {
                    corners[cs as usize].curve_ends.push((curve_id, 0));
                }
                if ce >= 0 {
                    corners[ce as usize].curve_ends.push((curve_id, 1));
                }
                curves.push(curve);
            }
        }
    }

    // Junction creases at interior profiles (M ≥ 3): where the carrier below and
    // above a shared-profile edge kink.
    for pi in 1..(m - 1) {
        let np = profs[pi].len() / 2;
        for e in 0..np {
            let e2 = (e + 1) % np;
            let below = carriers[pi - 1].iter().position(|car| car.b_edge == e);
            let above = carriers[pi].iter().position(|car| car.a_edge == e);
            let (Some(cb), Some(ca)) = (below, above) else { continue };
            let s_below = side_id(pi - 1, cb);
            let s_above = side_id(pi, ca);
            let v0x = profs[pi][e * 2];
            let v0z = profs[pi][e * 2 + 1];
            let v1x = profs[pi][e2 * 2];
            let v1z = profs[pi][e2 * 2 + 1];
            let mid = leaf.sim.apply_point(px + (v0x + v1x) / 2.0, py + y_of(pi), pz + (v0z + v1z) / 2.0);
            let nbelow = strata[s_below - first_id].normal(mid[0], mid[1], mid[2]);
            let nabove = strata[s_above - first_id].normal(mid[0], mid[1], mid[2]);
            let dot = nbelow[0] * nabove[0] + nbelow[1] * nabove[1] + nbelow[2] * nabove[2];
            if dot > 1.0 - 1e-9 {
                continue;
            }
            let curve_id = curves.len();
            let a = leaf.sim.apply_point(px + v0x, py + y_of(pi), pz + v0z);
            let bpt = leaf.sim.apply_point(px + v1x, py + y_of(pi), pz + v1z);
            let mut crease =
                make_segment_curve(curve_id, -1, [s_below, s_above], a[0], a[1], a[2], bpt[0], bpt[1], bpt[2]);
            crease.native = true;
            crease.corner_start = corner_idx[pi][e] as i64;
            crease.corner_end = corner_idx[pi][e2] as i64;
            corners[crease.corner_start as usize].curve_ends.push((curve_id, 0));
            corners[crease.corner_end as usize].curve_ends.push((curve_id, 1));
            curves.push(crease);
        }
    }

    // Cap rim segments (caps are planar; rims are the end profiles' edges).
    for (cap, pi, seg, use_b) in [(cap_bottom, 0usize, 0usize, false), (cap_top, m - 1, m - 2, true)] {
        let np = profs[pi].len() / 2;
        for e in 0..np {
            let e2 = (e + 1) % np;
            let pos = if use_b {
                carriers[seg].iter().position(|car| car.b_edge == e)
            } else {
                carriers[seg].iter().position(|car| car.a_edge == e)
            };
            let Some(cc) = pos else { continue };
            let s_side = side_id(seg, cc);
            let v0x = profs[pi][e * 2];
            let v0z = profs[pi][e * 2 + 1];
            let v1x = profs[pi][e2 * 2];
            let v1z = profs[pi][e2 * 2 + 1];
            let curve_id = curves.len();
            let a = leaf.sim.apply_point(px + v0x, py + y_of(pi), pz + v0z);
            let bpt = leaf.sim.apply_point(px + v1x, py + y_of(pi), pz + v1z);
            let mut rim =
                make_segment_curve(curve_id, -1, [s_side, cap], a[0], a[1], a[2], bpt[0], bpt[1], bpt[2]);
            rim.native = true;
            rim.corner_start = corner_idx[pi][e] as i64;
            rim.corner_end = corner_idx[pi][e2] as i64;
            corners[rim.corner_start as usize].curve_ends.push((curve_id, 0));
            corners[rim.corner_end as usize].curve_ends.push((curve_id, 1));
            curves.push(rim);
        }
    }
}

pub fn compile_native_features(root: &CsgNode) -> SfccFeatureSet {
    let mut leaves: Vec<&Leaf> = Vec::new();
    collect_leaves(root, &mut leaves);

    let mut curves: Vec<FeatureCurve> = Vec::new();
    let mut corners: Vec<SfccCorner> = Vec::new();
    let mut all_strata: Vec<Stratum> = Vec::new();
    let mut diag: f64 = 1.0;

    for (leaf_index, leaf) in leaves.iter().enumerate() {
        let first_id = all_strata.len();
        match &leaf.shape {
            Shape::Cuboid { half } => {
                let half = *half;
                let strata = build_box_strata(leaf, leaf_index, first_id, half);
                let [cx, cy, cz] = leaf.pos;
                let [hx, hy, hz] = half;
                // World corners; bit0=x, bit1=y, bit2=z.
                let mut corner_pos = [[0.0f64; 3]; 8];
                for (i, cp) in corner_pos.iter_mut().enumerate() {
                    *cp = leaf.sim.apply_point(
                        cx + if i & 1 != 0 { hx } else { -hx },
                        cy + if i & 2 != 0 { hy } else { -hy },
                        cz + if i & 4 != 0 { hz } else { -hz },
                    );
                }
                // Track scene diagonal from world corners.
                for a in 0..8 {
                    for b in (a + 1)..8 {
                        let d = (corner_pos[a][0] - corner_pos[b][0])
                            .hypot(corner_pos[a][1] - corner_pos[b][1])
                            .hypot(corner_pos[a][2] - corner_pos[b][2]);
                        if d > diag {
                            diag = d;
                        }
                    }
                }
                let stratum_of = |axis: usize, positive: bool| first_id + axis * 2 + if positive { 0 } else { 1 };
                // 8 corners.
                let corner_ids: Vec<usize> = (0..8)
                    .map(|i| {
                        let id = corners.len();
                        corners.push(SfccCorner {
                            id,
                            x: corner_pos[i][0],
                            y: corner_pos[i][1],
                            z: corner_pos[i][2],
                            strata: vec![
                                stratum_of(0, i & 1 != 0),
                                stratum_of(1, i & 2 != 0),
                                stratum_of(2, i & 4 != 0),
                            ],
                            curve_ends: Vec::new(),
                        });
                        id
                    })
                    .collect();
                // 12 edges: corner pairs differing in one bit.
                for a in 0..8usize {
                    for &bit in &[1usize, 2, 4] {
                        if a & bit != 0 {
                            continue;
                        }
                        let b = a | bit;
                        let axis = if bit == 1 { 0 } else if bit == 2 { 1 } else { 2 };
                        let others: Vec<usize> = (0..3).filter(|&x| x != axis).collect();
                        let strata_pair = [
                            stratum_of(others[0], a & (1 << others[0]) != 0),
                            stratum_of(others[1], a & (1 << others[1]) != 0),
                        ];
                        let curve_id = curves.len();
                        let mut curve = make_segment_curve(
                            curve_id,
                            -1,
                            strata_pair,
                            corner_pos[a][0],
                            corner_pos[a][1],
                            corner_pos[a][2],
                            corner_pos[b][0],
                            corner_pos[b][1],
                            corner_pos[b][2],
                        );
                        curve.native = true;
                        curve.corner_start = corner_ids[a] as i64;
                        curve.corner_end = corner_ids[b] as i64;
                        corners[corner_ids[a]].curve_ends.push((curve_id, 0));
                        corners[corner_ids[b]].curve_ends.push((curve_id, 1));
                        curves.push(curve);
                    }
                }
                all_strata.extend(strata);
            }
            Shape::Sphere { r } => {
                // No native curves/corners; one sphere carrier for the stratum list.
                all_strata.extend(build_sphere_strata(leaf, leaf_index, first_id, *r));
            }
            Shape::Cylinder { r, h } => {
                let (r, h) = (*r, *h);
                all_strata.extend(build_cylinder_strata(leaf, leaf_index, first_id, r, h));
                let rr = r * leaf.sim.s;
                let w = leaf.sim.rotate_vector(0.0, 1.0, 0.0);
                let [px, py, pz] = leaf.pos;
                // Two rim circles: top (cap +y) then bottom (cap −y), each adjacent
                // to [mantle, that cap]. Order matches the TS extraction.
                for (side, local_y) in [(1usize, py + h), (2usize, py - h)] {
                    let c = leaf.sim.apply_point(px, local_y, pz);
                    let cid = curves.len();
                    let mut curve =
                        make_circle_curve(cid, -1, [first_id, first_id + side], c[0], c[1], c[2], w[0], w[1], w[2], rr, None);
                    curve.native = true;
                    curves.push(curve);
                }
            }
            Shape::Cone { r, h } => {
                let (r, h) = (*r, *h);
                all_strata.extend(build_cone_strata(leaf, leaf_index, first_id, r, h));
                let rr = r * leaf.sim.s;
                let w = leaf.sim.rotate_vector(0.0, 1.0, 0.0);
                let [px, py, pz] = leaf.pos;
                // Base rim circle adjacent to [mantle, base].
                let base = leaf.sim.apply_point(px, py, pz);
                let cid = curves.len();
                let mut curve =
                    make_circle_curve(cid, -1, [first_id, first_id + 1], base[0], base[1], base[2], w[0], w[1], w[2], rr, None);
                curve.native = true;
                curves.push(curve);
                // Apex: a 0D corner with only the mantle stratum incident.
                let apex = leaf.sim.apply_point(px, py + h, pz);
                let kid = corners.len();
                corners.push(SfccCorner { id: kid, x: apex[0], y: apex[1], z: apex[2], strata: vec![first_id], curve_ends: Vec::new() });
            }
            Shape::Lathe { edges } => {
                let strata = build_lathe_strata(leaf, leaf_index, first_id, edges);
                track_leaf_diag(leaf, &mut diag);
                let [px, py, pz] = leaf.pos;
                let n = edges.len();
                let w = leaf.sim.rotate_vector(0.0, 1.0, 0.0);
                // edgeStratum[k] = global id of edge k's stratum (None for "none").
                let mut edge_stratum: Vec<Option<usize>> = Vec::with_capacity(n);
                let mut cursor = first_id;
                for e in edges {
                    if e.kind == LatheEdgeKind::None {
                        edge_stratum.push(None);
                    } else {
                        edge_stratum.push(Some(cursor));
                        cursor += 1;
                    }
                }
                for k in 0..n {
                    let r = edges[k].r0;
                    let y = edges[k].y0;
                    let e_prev = &edges[(k + n - 1) % n];
                    let e_next = &edges[k];
                    let s_prev = edge_stratum[(k + n - 1) % n];
                    let s_next = edge_stratum[k];
                    let p = leaf.sim.apply_point(px, py + y, pz);
                    if r.abs() <= LATHE_AXIS_R {
                        // Axis pole: a cone-apex 0D corner when a revolved cone
                        // touches the axis here.
                        let mut strata_ids: Vec<usize> = Vec::new();
                        if let (Some(s), LatheEdgeKind::Cone) = (s_prev, e_prev.kind) {
                            strata_ids.push(s);
                        }
                        if let (Some(s), LatheEdgeKind::Cone) = (s_next, e_next.kind) {
                            strata_ids.push(s);
                        }
                        if !strata_ids.is_empty() {
                            if let (Some(s), true) = (s_prev, e_prev.kind != LatheEdgeKind::Cone) {
                                strata_ids.push(s);
                            }
                            if let (Some(s), true) = (s_next, e_next.kind != LatheEdgeKind::Cone) {
                                strata_ids.push(s);
                            }
                            let kid = corners.len();
                            corners.push(SfccCorner { id: kid, x: p[0], y: p[1], z: p[2], strata: strata_ids, curve_ends: Vec::new() });
                        }
                        continue;
                    }
                    let (sp, sn) = match (s_prev, s_next) {
                        (Some(a), Some(b)) => (a, b),
                        _ => continue,
                    };
                    // Skip exactly-collinear turns (degenerate carrier pair).
                    if e_prev.nr * e_next.nr + e_prev.ny * e_next.ny >= 1.0 - 1e-12 {
                        continue;
                    }
                    let cid = curves.len();
                    let mut curve = make_circle_curve(
                        cid,
                        -1,
                        [sp, sn],
                        p[0],
                        p[1],
                        p[2],
                        w[0],
                        w[1],
                        w[2],
                        leaf.sim.s * r.abs(),
                        None,
                    );
                    curve.native = true;
                    curves.push(curve);
                }
                all_strata.extend(strata);
            }
            Shape::Extrude { verts, wind, h, twist_rad } => {
                let (wind, h, twist_rad) = (*wind, *h, *twist_rad);
                let verts = verts.clone();
                let strata = build_extrude_strata(leaf, leaf_index, first_id, &verts, wind, h, twist_rad);
                track_leaf_diag(leaf, &mut diag);
                let [px, py, pz] = leaf.pos;
                let n = verts.len() / 2;
                let side_id = |i: i64| -> usize { first_id + i.rem_euclid(n as i64) as usize };
                let cap_top = first_id + n;
                let cap_bottom = first_id + n + 1;
                // Twist-applied world point of polygon vertex j at local height y.
                let vertex_at = |j: usize, y: f64| -> [f64; 3] {
                    let t = ((y + h) / (2.0 * h)).clamp(0.0, 1.0);
                    let angle = twist_rad * t;
                    let (ca, sa) = (angle.cos(), angle.sin());
                    let vx = verts[j * 2];
                    let vz = verts[j * 2 + 1];
                    leaf.sim.apply_point(px + ca * vx - sa * vz, py + y, pz + sa * vx + ca * vz)
                };
                let mut bottom_corner_ids: Vec<usize> = Vec::with_capacity(n);
                let mut top_corner_ids: Vec<usize> = Vec::with_capacity(n);
                for j in 0..n {
                    let pb = vertex_at(j, -h);
                    let bid = corners.len();
                    bottom_corner_ids.push(bid);
                    corners.push(SfccCorner {
                        id: bid,
                        x: pb[0],
                        y: pb[1],
                        z: pb[2],
                        strata: vec![side_id(j as i64 - 1), side_id(j as i64), cap_bottom],
                        curve_ends: Vec::new(),
                    });
                    let pt = vertex_at(j, h);
                    let tid = corners.len();
                    top_corner_ids.push(tid);
                    corners.push(SfccCorner {
                        id: tid,
                        x: pt[0],
                        y: pt[1],
                        z: pt[2],
                        strata: vec![side_id(j as i64 - 1), side_id(j as i64), cap_top],
                        curve_ends: Vec::new(),
                    });
                }
                // Vertical edges: segments (untwisted) or traced helices.
                for j in 0..n {
                    let s_a = side_id(j as i64 - 1);
                    let s_b = side_id(j as i64);
                    let curve_id = curves.len();
                    let mut curve = if twist_rad == 0.0 {
                        let a = vertex_at(j, -h);
                        let b = vertex_at(j, h);
                        make_segment_curve(curve_id, -1, [s_a, s_b], a[0], a[1], a[2], b[0], b[1], b[2])
                    } else {
                        let rho = verts[j * 2].hypot(verts[j * 2 + 1]);
                        let max_step = 2.0 * (1.0 - 0.005 / rho.max(1e-6)).clamp(-1.0, 1.0).acos();
                        let nseg = ((twist_rad.abs() / max_step.max(1e-4)).ceil() as usize).clamp(8, 512);
                        let mut samples = vec![0.0f64; (nseg + 1) * 3];
                        for i in 0..=nseg {
                            let p = vertex_at(j, -h + (2.0 * h * i as f64) / nseg as f64);
                            samples[i * 3] = p[0];
                            samples[i * 3 + 1] = p[1];
                            samples[i * 3 + 2] = p[2];
                        }
                        make_traced_curve(
                            curve_id,
                            [s_a, s_b],
                            samples,
                            false,
                            strata[s_a - first_id],
                            strata[s_b - first_id],
                            traced_native_refine(),
                            -1,
                        )
                    };
                    curve.native = true;
                    curve.corner_start = bottom_corner_ids[j] as i64;
                    curve.corner_end = top_corner_ids[j] as i64;
                    corners[bottom_corner_ids[j]].curve_ends.push((curve_id, 0));
                    corners[top_corner_ids[j]].curve_ends.push((curve_id, 1));
                    curves.push(curve);
                }
                // Cap rim segments (flat caps → straight rims, rotated by the cap angle).
                for i in 0..n {
                    let j2 = (i + 1) % n;
                    for &(cap, y_loc, top) in &[(cap_bottom, -h, false), (cap_top, h, true)] {
                        let curve_id = curves.len();
                        let a = vertex_at(i, y_loc);
                        let b = vertex_at(j2, y_loc);
                        let mut rim =
                            make_segment_curve(curve_id, -1, [side_id(i as i64), cap], a[0], a[1], a[2], b[0], b[1], b[2]);
                        rim.native = true;
                        let ids = if top { &top_corner_ids } else { &bottom_corner_ids };
                        rim.corner_start = ids[i] as i64;
                        rim.corner_end = ids[j2] as i64;
                        corners[ids[i]].curve_ends.push((curve_id, 0));
                        corners[ids[j2]].curve_ends.push((curve_id, 1));
                        curves.push(rim);
                    }
                }
                all_strata.extend(strata);
            }
            Shape::Loft { profs, winds, h } => {
                let h = *h;
                let profs = profs.clone();
                let winds = winds.clone();
                let strata = build_loft_strata(leaf, leaf_index, first_id, &profs, &winds, h);
                track_leaf_diag(leaf, &mut diag);
                emit_loft_features(leaf, first_id, &profs, &winds, h, &strata, &mut curves, &mut corners);
                all_strata.extend(strata);
            }
        }
    }

    let mut index = SfccSpatialIndex::new(diag / 32.0);
    for c in &curves {
        index.insert_curve_polyline(c.id, &c.index_polyline);
    }
    for c in &corners {
        index.insert_corner(c.id, c.x, c.y, c.z);
    }
    SfccFeatureSet { curves, corners, index, strata: all_strata, run_id: next_feature_set_run_id() }
}

/// Index cell-size heuristic: scene diagonal / 32. Mirrors `indexCellSize`.
fn index_cell_size(tree: &SfccTree<'_>) -> f64 {
    let mut diag = 1.0f64;
    for lv in &tree.leaves {
        let d = (lv.aabb[3] - lv.aabb[0]).hypot(lv.aabb[4] - lv.aabb[1]).hypot(lv.aabb[5] - lv.aabb[2]);
        if d > diag {
            diag = d;
        }
    }
    diag / 32.0
}

/// Full S1 feature compilation: native curves + traced boolean seams, all
/// CSG-trimmed, with corners derived from trim transitions and surviving native
/// corners, and curves split/wired at them. Port of `compileFeatureSet`.
pub fn compile_feature_set(
    root: &CsgNode,
    tol: &ResolvedTolerances,
) -> (SfccFeatureSet, crate::sfcc::seam_trace::SeamTraceDiagnostics) {
    let native = compile_native_features(root);
    // Mark native curves so the trim crease gate uses nativeCreaseCos for them.
    let mut native_curves = native.curves;
    for c in &mut native_curves {
        c.native = true;
    }
    let tree = build_tree(root, build_leaf_strata);

    let mut next_id = native_curves.len();
    let (seam_curves, diagnostics) = trace_all_seams(&tree, tol, &mut || {
        let id = next_id;
        next_id += 1;
        id
    });

    let mut raw = native_curves;
    raw.extend(seam_curves);
    let trimmed = trim_and_wire(&tree, &raw, &native.corners, tol);

    let mut index = SfccSpatialIndex::new(index_cell_size(&tree));
    for c in &trimmed.curves {
        index.insert_curve_polyline(c.id, &c.index_polyline);
    }
    for c in &trimmed.corners {
        index.insert_corner(c.id, c.x, c.y, c.z);
    }
    let fs = SfccFeatureSet {
        curves: trimmed.curves,
        corners: trimmed.corners,
        index,
        strata: tree.strata,
        run_id: next_feature_set_run_id(),
    };
    (fs, diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sdf::leaf_at;

    #[test]
    fn unit_box_has_12_segments_8_corners() {
        let tree = leaf_at(Shape::Cuboid { half: [1.0, 1.0, 1.0] }, [0.0, 0.0, 0.0]);
        let fs = compile_native_features(&tree);
        assert_eq!(fs.curves.len(), 12);
        assert_eq!(fs.corners.len(), 8);
        assert_eq!(fs.strata.len(), 6);
        // Every edge is a unit-length segment between two ±1 corners.
        for c in &fs.curves {
            assert_eq!(c.kind(), crate::sfcc::feature_curves::CurveKind::Segment);
            assert!((c.param_distance(0.0, 1.0) - 2.0).abs() < 1e-12); // edge length 2 (half=1)
            assert!(c.adjacent_strata.iter().all(|&s| s < 6));
        }
        // Each corner has 3 incident strata and (valence-3) 3 curve ends.
        for k in &fs.corners {
            assert_eq!(k.strata.len(), 3);
            assert_eq!(k.curve_ends.len(), 3);
            assert!((k.x.abs() - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn cylinder_has_2_rim_circles_3_strata() {
        let tree = leaf_at(Shape::Cylinder { r: 4.0, h: 7.0 }, [0.0, 0.0, 0.0]);
        let fs = compile_native_features(&tree);
        assert_eq!(fs.curves.len(), 2);
        assert_eq!(fs.corners.len(), 0);
        assert_eq!(fs.strata.len(), 3);
        for c in &fs.curves {
            assert_eq!(c.kind(), crate::sfcc::feature_curves::CurveKind::Circle);
            // Adjacent to the mantle (0) and one cap (1 or 2).
            assert_eq!(c.adjacent_strata[0], 0);
            assert!(c.adjacent_strata[1] == 1 || c.adjacent_strata[1] == 2);
            // Closed circle of radius 4: a quarter turn moves √2·r.
            let p0 = c.point_at(0.0);
            assert!((p0[0].hypot(p0[2]) - 4.0).abs() < 1e-9);
        }
    }

    #[test]
    fn cone_has_base_circle_and_apex_corner() {
        let tree = leaf_at(Shape::Cone { r: 3.0, h: 5.0 }, [0.0, 0.0, 0.0]);
        let fs = compile_native_features(&tree);
        assert_eq!(fs.curves.len(), 1);
        assert_eq!(fs.corners.len(), 1);
        assert_eq!(fs.strata.len(), 2);
        assert_eq!(fs.curves[0].kind(), crate::sfcc::feature_curves::CurveKind::Circle);
        assert_eq!(fs.curves[0].adjacent_strata, [0, 1]);
        // Apex sits at +h, incident to the mantle only.
        let apex = &fs.corners[0];
        assert!((apex.y - 5.0).abs() < 1e-9);
        assert_eq!(apex.strata, vec![0]);
    }

    #[test]
    fn sphere_has_no_features_one_stratum() {
        let tree = leaf_at(Shape::Sphere { r: 2.0 }, [0.0, 0.0, 0.0]);
        let fs = compile_native_features(&tree);
        assert_eq!(fs.curves.len(), 0);
        assert_eq!(fs.corners.len(), 0);
        assert_eq!(fs.strata.len(), 1);
    }

    #[test]
    fn box_minus_sphere_traces_three_seam_circles() {
        // Subtract(Box([0,0,0],[10,10,10]), Sphere([5,5,5],6)): the carve sphere
        // cuts the +x/+y/+z faces in three closed seam circles; the 12 box edges
        // survive (sphere only carves near the +++ octant), 8 box corners stay.
        let tree = crate::sdf::subtract(
            leaf_at(Shape::Cuboid { half: [10.0, 10.0, 10.0] }, [0.0, 0.0, 0.0]),
            leaf_at(Shape::Sphere { r: 6.0 }, [5.0, 5.0, 5.0]),
        );
        let tol = crate::tolerances::resolve_tolerances(&crate::tuning::SfccTuning::default(), 36.0);
        let (fs, diag) = compile_feature_set(&tree, &tol);
        let segs = fs.curves.iter().filter(|c| c.kind() == crate::sfcc::feature_curves::CurveKind::Segment).count();
        let traced = fs.curves.iter().filter(|c| c.kind() == crate::sfcc::feature_curves::CurveKind::Traced).count();
        assert_eq!(segs, 12, "12 surviving box edges");
        assert_eq!(traced, 3, "3 traced seam circles (sphere ∩ +x/+y/+z faces)");
        assert_eq!(fs.corners.len(), 8, "8 box corners survive");
        assert!(diag.curves_traced >= 3, "tracer found the seam loops");
        // The seam circles are closed loops on the sphere carrier (stratum 6).
        for c in fs.curves.iter().filter(|c| c.kind() == crate::sfcc::feature_curves::CurveKind::Traced) {
            assert!(c.closed, "seam circle is a closed loop");
            assert!(c.adjacent_strata.contains(&6), "seam adjacent to the sphere carrier");
        }
    }
}
