//! S3a — per-face contouring (SMOOTH path). Port of the featureless paths of
//! `src/export/sfcc/face-contour.mts`.
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
//! DEFERRED to M4 (the feature paths — inert on smooth scenes, so omitted here):
//! feature pins (`curve.axisPlaneCrossings` / `record.pins`), arc-endpoint
//! recovery (`recoveredCrossingsFor`), stratum tagging (`stratumTagFor`), and the
//! pin-route / pin-anchored-splice pairing branches.

use crate::math::grid::{
    collect_edge_interior_offsets, face_axes, pack_point, point_to_world, stride_at_level, SfccLattice,
};
use crate::sdf::CsgNode;
use crate::sfcc::octree::SfccOctree;
use crate::sfcc::point_table::{crossing_key, PointTable};
use std::collections::HashMap;

/// A directed contour segment (point ids); f < 0 on the left viewed from +axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FaceSegment {
    pub a: usize,
    pub b: usize,
}

/// Per-face contour data, computed once per canonical octree face.
pub struct FaceRecord {
    pub axis: usize,
    /// Lattice key of the face min corner.
    pub key: i64,
    /// Face edge length in lattice units.
    pub len: i64,
    pub segments: Vec<FaceSegment>,
    /// Consumption counters for the S4 face audit (filled by cell meshing).
    pub consumed_fwd: Vec<u32>,
    pub consumed_rev: Vec<u32>,
}

/// Smooth-path face-contour options (the feature caches/profiling are M4).
#[derive(Clone, Copy)]
pub struct FaceContourOptions {
    /// Absolute world-space tolerance for edge root-finding.
    pub root_tol: f64,
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

/// Root-find the iso-crossing on a world segment with f0 < 0 ≤ f1 or vice versa.
/// Bit-faithful port of `findRoot`. Writes the crossing position into `out[0..3]`
/// and the tree gradient (unit normal) into `out[3..6]`.
///
/// Call sites should use [`canonical_edge_root`] so the result is independent of
/// endpoint order.
#[allow(clippy::too_many_arguments)]
pub fn find_root(
    tree: &CsgNode,
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
    f0: f64,
    _f1: f64,
    tol: f64,
    out: &mut [f64; 6],
) {
    let mut lo = 0.0f64;
    let mut hi = 1.0f64;
    let mut flo = f0;
    let seg_len = ((bx - ax).powi(2) + (by - ay).powi(2) + (bz - az).powi(2)).sqrt();
    let mut i = 0;
    while i < 60 && (hi - lo) * seg_len > tol {
        let mid = (lo + hi) / 2.0;
        let fm = tree.f([ax + (bx - ax) * mid, ay + (by - ay) * mid, az + (bz - az) * mid]);
        if (fm < 0.0) == (flo < 0.0) {
            lo = mid;
            flo = fm;
        } else {
            hi = mid;
        }
        i += 1;
    }
    let t = (lo + hi) / 2.0;
    out[0] = ax + (bx - ax) * t;
    out[1] = ay + (by - ay) * t;
    out[2] = az + (bz - az) * t;
    let (_, g) = tree.grad([out[0], out[1], out[2]]);
    out[3] = g[0];
    out[4] = g[1];
    out[5] = g[2];
}

/// Iso-crossing on an axis-aligned sub-edge, computed INDEPENDENTLY of the
/// direction the caller discovered the edge: the endpoints are canonicalized to a
/// fixed (lexicographically-least-first) order before root-finding, so a sub-edge
/// shared by faces walking it in opposite directions yields a BIT-IDENTICAL point
/// and normal. Port of `canonicalEdgeRoot`.
#[allow(clippy::too_many_arguments)]
pub fn canonical_edge_root(
    tree: &CsgNode,
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

/// One boundary edge of a face, in CCW walk order.
struct Walk {
    du: i64,
    dv: i64,
    ax: usize,
    dir: i64,
}

/// Contour one face. `(gx, gy, gz)` is the face min corner (lattice), `len` its
/// edge length in lattice units. SMOOTH path only — feature pinning / recovery /
/// stratum tagging are deferred to M4 and inert on featureless scenes.
#[allow(clippy::too_many_arguments)]
pub fn contour_face(
    oct: &SfccOctree,
    tree: &CsgNode,
    points: &mut PointTable,
    axis: usize,
    gx: i64,
    gy: i64,
    gz: i64,
    len: i64,
    opts: &FaceContourOptions,
) -> FaceRecord {
    let lat: &SfccLattice = &oct.lat;
    let [u, v] = face_axes(axis);
    let key = pack_point(lat, gx, gy, gz);

    // The 4 boundary edges in CCW walk order (viewed from +axis):
    // +u at v=0 → +v at u=len → −u at v=len → −v at u=0.
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
    // Crossing point id → face boundary side (walk index 0-3): segments whose
    // endpoints lie on the SAME side run along a shared cell-edge line and must
    // be split with a face-owned midpoint.
    let mut node_side: HashMap<usize, usize> = HashMap::new();
    let mut scratch = [0.0f64; 6];

    let mut walk_index: usize = 0;
    for walk in &walks {
        // Lattice point sequence along this boundary edge: start, interior
        // (existing samples only), end-exclusive (next walk supplies it).
        let start = lattice_of(walk.du, walk.dv);
        let (sgx, sgy, sgz) = (start[0], start[1], start[2]);
        // Min corner of the full edge along walk.ax for interior discovery:
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
        // Offsets along the walk direction, start-inclusive, end-exclusive.
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
            // Canonical sub-edge key: min corner along the edge axis.
            let min_corner = if walk.dir == 1 { p0 } else { p1 };
            let sub_key = crossing_key(pack_point(lat, min_corner[0], min_corner[1], min_corner[2]), walk.ax);
            if (f0 < 0.0) != (f1 < 0.0) {
                let wa = point_to_world(lat, p0[0], p0[1], p0[2]);
                let wb = point_to_world(lat, p1[0], p1[1], p1[2]);
                let id = points.get_or_create(sub_key, || {
                    canonical_edge_root(
                        tree, wa[0], wa[1], wa[2], wb[0], wb[1], wb[2], f0, f1, opts.root_tol, &mut scratch,
                    );
                    scratch
                });
                nodes.push(BoundaryNode { crossing: id as i64, inside: false });
                node_side.insert(id, walk_index);
            }
            // SMOOTH path: the `opts.features && opts.stratumTags` tagging and the
            // `opts.features && opts.recovered` arc-endpoint recovery branches are
            // M4 — inert without a feature set, so omitted.
        }
        walk_index += 1;
    }

    // Extract crossings with enter/exit tags by walking the cyclic node list.
    let mut crossings: Vec<(usize, bool)> = Vec::new(); // (point id, enter)
    let mut state = if !nodes.is_empty() { nodes[0].inside } else { false };
    for n in &nodes {
        if n.crossing >= 0 {
            state = !state;
            crossings.push((n.crossing as usize, state));
        } else {
            state = n.inside;
        }
    }

    let mut record = FaceRecord {
        axis,
        key,
        len,
        segments: Vec::new(),
        consumed_fwd: Vec::new(),
        consumed_rev: Vec::new(),
    };

    // SMOOTH path: feature pinning (record.pins) and the certified one-pin
    // exit→pin→enter route are M4. record.pins is always empty here.

    if crossings.is_empty() {
        return record;
    }

    // Pair exits with enters. With one inside run the rules coincide; with two
    // runs (the classic ambiguous face) the face-center sample decides; more
    // runs follow the same rule (certificates refine these away later).
    let runs = crossings.len() / 2;
    let mut center_inside = false;
    if runs >= 2 {
        let cg = lattice_of(len / 2, len / 2);
        let w = point_to_world(lat, cg[0], cg[1], cg[2]);
        center_inside = tree.f([w[0], w[1], w[2]]) < 0.0;
    }
    let n = crossings.len();

    // Pairing must be a PERFECT matching (every enter consumed exactly once).
    // SMOOTH path: pass 1 (stratum-tagged per-stratum pairing) is inert because
    // node_stratum is always empty — so only the run rule (pass 2) runs.
    let mut matched_enter = vec![false; n];
    let mut partner_of: HashMap<usize, usize> = HashMap::new(); // exit index → enter id

    for i in 0..n {
        let (_, enter) = crossings[i];
        if enter || partner_of.contains_key(&i) {
            continue;
        }
        if runs < 2 || !center_inside {
            // Enter of this exit's own run = nearest unmatched enter BEFORE it.
            for k in 1..=n {
                let j = (i + n - (k % n)) % n;
                if crossings[j].1 && !matched_enter[j] {
                    matched_enter[j] = true;
                    partner_of.insert(i, crossings[j].0);
                    break;
                }
            }
        } else {
            // Center inside: connect across the face to the NEXT unmatched enter.
            for k in 1..=n {
                let j = (i + k) % n;
                if crossings[j].1 && !matched_enter[j] {
                    matched_enter[j] = true;
                    partner_of.insert(i, crossings[j].0);
                    break;
                }
            }
        }
    }

    for i in 0..n {
        let (cid, enter) = crossings[i];
        if enter {
            continue;
        }
        let partner = partner_of.get(&i).copied();
        // Collinear guard: when both endpoints lie on the SAME boundary side of
        // the face (a sliver arc hugging it), the straight segment degenerates
        // onto the shared cell-edge line — split it with a face-owned, surface-
        // projected midpoint so each face's arc is geometrically distinct.
        let se = node_side.get(&cid).copied();
        if let (Some(p), Some(s)) = (partner, se) {
            if Some(s) == node_side.get(&p).copied() {
                let mid = split_midpoint(tree, points, cid, p, opts.root_tol);
                record.segments.push(FaceSegment { a: cid, b: mid });
                record.segments.push(FaceSegment { a: mid, b: p });
                record.consumed_fwd.push(0);
                record.consumed_fwd.push(0);
                record.consumed_rev.push(0);
                record.consumed_rev.push(0);
                continue;
            }
        }
        // Faithful to TS: an unmatched exit (partner === undefined → −1) is
        // impossible on a parity-clean even crossing set, but TS would push
        // `{ a: c.id, b: -1 }`. Mirror that with a sentinel so behavior matches.
        let b = partner.map(|x| x as i64).unwrap_or(-1);
        record.segments.push(FaceSegment { a: cid, b: if b < 0 { usize::MAX } else { b as usize } });
        record.consumed_fwd.push(0);
        record.consumed_rev.push(0);
    }

    // SMOOTH path: pin-anchored splice (record.pins non-empty) is M4.
    record
}

// NOTE: `pointSegmentDist` from the TS is only used by the M4 pin-anchored
// splice; it is deferred with the rest of the feature paths.

/// Face-owned midpoint between two crossings, Newton-projected onto the surface.
/// Port of `splitMidpoint` (the `axis` arg is unused in TS too — full 3D
/// projection is deliberate).
fn split_midpoint(tree: &CsgNode, points: &mut PointTable, a_id: usize, b_id: usize, root_tol: f64) -> usize {
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
    // Validate: a near-degenerate Newton step explodes — fall back to the chord
    // midpoint (error bounded by chord sag) on drift or residual failure.
    let drift = ((q[0] - mx).powi(2) + (q[1] - my).powi(2) + (q[2] - mz).powi(2)).sqrt();
    if drift > seg_len + root_tol * 8.0 || tree.f(q).abs() > root_tol * 8.0 {
        q = [mx, my, mz];
    }
    let (_, grad) = tree.grad(q);
    points.add(q[0], q[1], q[2], grad[0], grad[1], grad[2])
}

/// Enumerate canonical faces of all leaves and contour each exactly once.
/// Port of `contourAllFaces` (smooth path).
pub fn contour_all_faces(
    oct: &SfccOctree,
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &FaceContourOptions,
) -> FaceContourResult {
    let lat = oct.lat;
    let mut faces: [HashMap<i64, FaceRecord>; 3] = [HashMap::new(), HashMap::new(), HashMap::new()];
    let mut multi_run_faces = 0usize;
    let mut boundary_violations = 0usize;
    let mut key_collisions = 0usize;

    for cell in &oct.leaves {
        let stride = stride_at_level(&lat, cell.level);
        let base = [cell.ix * stride, cell.iy * stride, cell.iz * stride];
        for axis in 0..3usize {
            for side in 0..=1 {
                // Faces are evaluated at the finer of the two incident levels: if
                // the neighbor across this side is subdivided, its finer leaves
                // enumerate the quarter faces instead.
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
                let rec = contour_face(oct, tree, points, axis, g[0], g[1], g[2], stride, opts);
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

    // Global duplicate-segment repair: two faces must never emit the same
    // undirected (a, b) segment — adjacent cells would collapse two distinct
    // surface arcs onto one mesh edge (non-manifold). Split EVERY occurrence with
    // its own face-owned midpoint. Port of the `pairOwners` dedup pass.
    const EDGE_BASE: i64 = 0x8000000;
    let mut pair_owners: HashMap<i64, Vec<(usize, usize, usize)>> = HashMap::new(); // edge key → (axis, key, seg idx)
    for (axis, per_axis) in faces.iter().enumerate() {
        for (&fkey, rec) in per_axis.iter() {
            for (i, s) in rec.segments.iter().enumerate() {
                let (a, b) = (s.a as i64, s.b as i64);
                let k = if a < b { a * EDGE_BASE + b } else { b * EDGE_BASE + a };
                pair_owners.entry(k).or_default().push((axis, fkey as usize, i));
            }
        }
    }
    // Collect entries needing a split. Keys are processed in a deterministic order
    // (sorted) so split-vertex ids are assigned identically run-to-run; within a
    // record split later indices first so stored indices stay valid.
    let mut dup_keys: Vec<i64> = pair_owners.iter().filter(|(_, v)| v.len() >= 2).map(|(&k, _)| k).collect();
    dup_keys.sort_unstable();
    for k in dup_keys {
        let mut list = pair_owners.remove(&k).unwrap();
        // Split later occurrences first so stored indices stay valid per record.
        // TS sorts the whole list by descending idx; with multiple faces sharing
        // a record this keeps per-record indices valid.
        list.sort_by(|x, y| y.2.cmp(&x.2));
        for (axis, fkey, idx) in list {
            let s = faces[axis].get(&(fkey as i64)).unwrap().segments[idx];
            let mid = split_midpoint(tree, points, s.a, s.b, opts.root_tol);
            let rec = faces[axis].get_mut(&(fkey as i64)).unwrap();
            rec.segments[idx] = FaceSegment { a: s.a, b: mid };
            rec.segments.insert(idx + 1, FaceSegment { a: mid, b: s.b });
            rec.consumed_fwd.push(0);
            rec.consumed_rev.push(0);
        }
    }

    FaceContourResult { faces, multi_run_faces, boundary_violations, key_collisions }
}
