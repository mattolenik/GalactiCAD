//! S3b — per-cell meshing. Port of `src/export/sfcc/cell-mesh.mts`.
//!
//! Each leaf cell gathers its boundary face segments (the +axis-side cell
//! consumes a face's segments as stored; the −axis-side cell reverses them),
//! assembles them into closed loops, and triangulates each loop as a disk.
//! Loops come out CCW viewed from OUTSIDE the solid (outward winding) and every
//! interior face segment is consumed exactly twice in opposite directions —
//! recorded into the [`FaceRecord`] counters for the S4 audit.
//!
//! Triangulation: 3-loops emit directly; 4-loops split along the shorter
//! diagonal; larger loops fan from an interior vertex Newton-projected onto the
//! surface (fallback: best-quality boundary-vertex fan).
//!
//! M4c-2 added the FEATURE paths (gated on `opts.features`, inert on smooth
//! scenes): corner-cell wedge fans (`cell.feature_corner`), edge-cell pin routing
//! (`cell.feature_curve`, `mesh_edge_cell`), and analytic-curve polyline sampling.

use crate::math::grid::{cell_aabb, face_axes, pack_point, stride_at_level, SfccLattice};
use crate::sdf::{CsgNode, Pruned, SdfQuery};
use crate::sfcc::octree::LEVER1_MIN_LEAVES;
use crate::sfcc::feature_curves::{CurveKind, FeatureCurve};
use crate::sfcc::feature_set::{SfccCorner, SfccFeatureSet};
use crate::sfcc::face_contour::{FacePin, FaceRecord};
use crate::sfcc::octree::{SfccCell, SfccOctree};
use crate::sfcc::point_table::PointTable;
use crate::strata::Stratum;
use std::collections::HashMap;

/// Interior-vertex placement for disk triangulation. Port of
/// `CellMeshOptions.interiorVertexMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InteriorVertexMode {
    Project,
    Centroid,
    Fan,
}

/// Cell-meshing options. The smooth path uses the first four; the feature path
/// activates when `features` is `Some`.
#[derive(Clone, Copy)]
pub struct CellMeshOptions<'a> {
    pub surface_tol: f64,
    pub interior_vertex_mode: InteriorVertexMode,
    pub project_max_iters: u32,
    /// Max chord deviation (mm) of in-cell feature polylines.
    pub curve_chord_tol: f64,
    pub max_polyline_points_per_cell: usize,
    pub features: Option<&'a SfccFeatureSet>,
}

/// Result of meshing all leaf cells.
pub struct CellMeshResult {
    pub tris: Vec<usize>,
    /// Cells whose segment soup did not assemble into closed loops.
    pub failed_cells: Vec<SfccCell>,
    /// Cells that produced 2+ loops (legal, but certificate-noteworthy).
    pub multi_loop_cells: usize,
    /// Cells meshed with an explicit feature-edge split.
    pub edge_cells: usize,
    /// Cells meshed as wedge fans around an exact corner point.
    pub corner_cells: usize,
    /// Feature cells that fell back to smooth meshing (kept closed; reported).
    pub feature_cell_fallbacks: usize,
    /// The fallback cells themselves — candidates for forced re-refinement.
    pub fallback_cells: Vec<SfccCell>,
}

/// One gathered boundary segment of a cell, carrying provenance so consumption
/// can be tallied back into its [`FaceRecord`].
struct Seg {
    a: usize,
    b: usize,
    /// (axis, face key) of the owning record.
    face: (usize, i64),
    /// Index of this segment within the record.
    idx: usize,
    /// True when the cell consumed the face's segments reversed (−axis side).
    reversed: bool,
}

/// Push one record's segments into `out`, reversing endpoints on the −axis side.
/// Pins are pushed into `pins_out` (feature path only — empty on smooth scenes).
fn push_segments(rec: &FaceRecord, axis: usize, rev: bool, out: &mut Vec<Seg>, pins_out: &mut Vec<FacePin>) {
    for (i, s) in rec.segments.iter().enumerate() {
        if rev {
            out.push(Seg { a: s.b, b: s.a, face: (axis, rec.key), idx: i, reversed: true });
        } else {
            out.push(Seg { a: s.a, b: s.b, face: (axis, rec.key), idx: i, reversed: false });
        }
    }
    pins_out.extend_from_slice(&rec.pins);
}

/// Gather the cell's boundary segments. Each side is either one face at the
/// cell's own level, or — when the neighbor is one level finer (2:1 balance) —
/// up to four quarter faces at level+1, unioned. Port of `gatherSegments`.
fn gather_segments(
    faces: &[HashMap<i64, FaceRecord>; 3],
    lat: &SfccLattice,
    cell: &SfccCell,
    out: &mut Vec<Seg>,
    pins_out: &mut Vec<FacePin>,
) {
    let stride = stride_at_level(lat, cell.level);
    let base = [cell.ix * stride, cell.iy * stride, cell.iz * stride];
    for axis in 0..3usize {
        let [u, v] = face_axes(axis);
        for side in 0..=1 {
            let mut g = base;
            if side == 1 {
                g[axis] += stride;
            }
            let reversed = side == 1;
            let key = pack_point(lat, g[0], g[1], g[2]);
            if let Some(rec) = faces[axis].get(&key) {
                if rec.len == stride {
                    push_segments(rec, axis, reversed, out, pins_out);
                    continue;
                }
            }
            // Neighbor is finer: consume the quarter faces.
            let half = stride / 2;
            if half < 1 {
                continue;
            }
            for a in 0..=1 {
                for b in 0..=1 {
                    let mut q = g;
                    q[u] += a * half;
                    q[v] += b * half;
                    let qkey = pack_point(lat, q[0], q[1], q[2]);
                    if let Some(qrec) = faces[axis].get(&qkey) {
                        if qrec.len == half {
                            push_segments(qrec, axis, reversed, out, pins_out);
                        }
                    }
                }
            }
        }
    }
}

/// Mesh every leaf cell into triangles. Port of `meshAllCells`. Consumption is
/// recorded back into the face records for the S4 face audit.
pub fn mesh_all_cells(
    oct: &SfccOctree,
    faces: &mut [HashMap<i64, FaceRecord>; 3],
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &CellMeshOptions,
) -> CellMeshResult {
    mesh_cells_subset(oct, faces, tree, points, opts, &oct.leaves)
}

/// Spatial-partition (#3 slice 1): contour the cells of N disjoint, contiguous
/// leaf groups into the shared face map (`faces`) + point table (`points`),
/// sequentially, combining their partial results in group order. With contiguous
/// groups the cell processing order equals the serial [`mesh_all_cells`] order, so
/// the triangle buffer is byte-identical (proven by `tests/spatial_partition.rs`).
/// `faces` must already be fully contoured (e.g. via `contour_faces_partitioned`),
/// so every cell — coarse cells at T-junctions included — finds its (sub-)faces.
pub fn mesh_cells_partitioned(
    oct: &SfccOctree,
    faces: &mut [HashMap<i64, FaceRecord>; 3],
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &CellMeshOptions,
    groups: &[std::ops::Range<usize>],
) -> CellMeshResult {
    let mut combined = CellMeshResult {
        tris: Vec::new(),
        failed_cells: Vec::new(),
        multi_loop_cells: 0,
        edge_cells: 0,
        corner_cells: 0,
        feature_cell_fallbacks: 0,
        fallback_cells: Vec::new(),
    };
    for r in groups {
        let part = mesh_cells_subset(oct, faces, tree, points, opts, &oct.leaves[r.clone()]);
        combined.tris.extend(part.tris);
        combined.failed_cells.extend(part.failed_cells);
        combined.multi_loop_cells += part.multi_loop_cells;
        combined.edge_cells += part.edge_cells;
        combined.corner_cells += part.corner_cells;
        combined.feature_cell_fallbacks += part.feature_cell_fallbacks;
        combined.fallback_cells.extend(part.fallback_cells);
    }
    combined
}

/// Mesh one leaf subset, reading the shared `faces` map and appending to the shared
/// `points`. The body is the original `meshAllCells` cell loop; iterating a caller-
/// supplied `leaves` slice is the only change, so passing `&oct.leaves` reproduces
/// the serial result exactly.
pub fn mesh_cells_subset(
    oct: &SfccOctree,
    faces: &mut [HashMap<i64, FaceRecord>; 3],
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &CellMeshOptions,
    leaves: &[SfccCell],
) -> CellMeshResult {
    let lat = oct.lat;
    let mut tris: Vec<usize> = Vec::new();
    let mut failed_cells: Vec<SfccCell> = Vec::new();
    let mut multi_loop_cells = 0usize;
    let mut edge_cells = 0usize;
    let mut corner_cells = 0usize;
    let mut feature_cell_fallbacks = 0usize;
    let mut fallback_cells: Vec<SfccCell> = Vec::new();

    let mut segs: Vec<Seg> = Vec::new();
    let mut pins: Vec<FacePin> = Vec::new();

    // Lever 1: per-cell pruning gate (default OFF; see lever1_should_prune).
    let prune = crate::sdf::lever1_should_prune(tree, LEVER1_MIN_LEAVES);

    for cell in leaves {
        segs.clear();
        pins.clear();
        gather_segments(faces, &lat, cell, &mut segs, &mut pins);
        if segs.is_empty() {
            continue;
        }

        // Loop walk: every point must have exactly one outgoing segment.
        let mut outgoing: HashMap<usize, usize> = HashMap::new();
        let mut degenerate = false;
        for (i, s) in segs.iter().enumerate() {
            if outgoing.contains_key(&s.a) {
                degenerate = true;
                break;
            }
            outgoing.insert(s.a, i);
        }
        if degenerate {
            failed_cells.push(*cell);
            continue;
        }

        let mut visited = vec![false; segs.len()];
        let mut loops: Vec<Vec<usize>> = Vec::new();
        let mut broken = false;
        for start in 0..segs.len() {
            if visited[start] {
                continue;
            }
            let mut loop_pts: Vec<usize> = Vec::new();
            let mut cur = start;
            let mut guard = 0usize;
            loop {
                if visited[cur] {
                    broken = true; // re-entered a consumed segment mid-walk
                    break;
                }
                visited[cur] = true;
                let s = &segs[cur];
                loop_pts.push(s.a);
                let next = match outgoing.get(&s.b) {
                    Some(&n) => n,
                    None => {
                        broken = true; // dangling endpoint
                        break;
                    }
                };
                if next == start {
                    break; // closed
                }
                cur = next;
                guard += 1;
                if guard > segs.len() {
                    broken = true;
                    break;
                }
            }
            if broken {
                break;
            }
            loops.push(loop_pts);
        }
        if broken || loops.is_empty() {
            failed_cells.push(*cell);
            continue;
        }
        if loops.len() > 1 {
            multi_loop_cells += 1;
        }

        // Loops are valid — record consumption for the S4 face audit.
        for s in &segs {
            let rec = faces[s.face.0].get_mut(&s.face.1).unwrap();
            if s.reversed {
                rec.consumed_rev[s.idx] += 1;
            } else {
                rec.consumed_fwd[s.idx] += 1;
            }
        }

        let cbox = cell_aabb(&lat, cell.level, cell.ix, cell.iy, cell.iz);

        // Lever 1: one pruned view per cell, reused across this cell's interior-
        // vertex projection / fan evals. Every `tree.f`/`tree.grad` in the meshers
        // is guarded `in_box(cell_box, ·, margin)` (margin = 0.1·cell_size), so all
        // query points lie within the cell box inflated by that margin — prune over
        // exactly that inflated box so the pruned view stays bit-exact there.
        let pruned: Option<Pruned> = if prune {
            let cs = cbox[3] - cbox[0];
            let half = cs * 0.6; // cell_size/2 + margin(0.1·cell_size), with headroom
            let c = [(cbox[0] + cbox[3]) * 0.5, (cbox[1] + cbox[4]) * 0.5, (cbox[2] + cbox[5]) * 0.5];
            Some(tree.prune_to_box(c, [half, half, half]))
        } else {
            None
        };
        let q: &dyn SdfQuery = match &pruned {
            Some(p) => p,
            None => tree,
        };

        let mut meshed_loops: std::collections::HashSet<usize> = std::collections::HashSet::new();

        if let (true, Some(features)) = (cell.feature_corner >= 0, opts.features) {
            // Corner cells: every loop touching an incident-curve pin is fanned
            // from the EXACT corner point — arbitrary valence. A valence-0 corner
            // (cone apex) fans every loop.
            let corner = &features.corners[cell.feature_corner as usize];
            let incident: std::collections::HashSet<usize> = corner.curve_ends.iter().map(|e| e.0).collect();
            let mut fanned = 0usize;
            for (li, loop_pts) in loops.iter().enumerate() {
                let has_pin = incident.is_empty()
                    || pins.iter().any(|p| incident.contains(&p.curve_id) && loop_pts.contains(&p.point_id));
                if !has_pin {
                    continue;
                }
                let cid = corner_point_id(corner, features, points);
                let m = loop_pts.len();
                for k in 0..m {
                    tris.push(cid);
                    tris.push(loop_pts[k]);
                    tris.push(loop_pts[(k + 1) % m]);
                }
                meshed_loops.insert(li);
                fanned += 1;
            }
            if fanned > 0 {
                corner_cells += 1;
            } else {
                feature_cell_fallbacks += 1;
                fallback_cells.push(*cell);
            }
        } else if let (true, Some(features)) = (cell.feature_curve >= 0, opts.features) {
            // Edge cells: split the loop containing the two pinned feature points
            // and mesh each stratum side against the sampled analytic curve.
            let mut my_pins: Vec<FacePin> = Vec::new();
            for p in &pins {
                if p.curve_id == cell.feature_curve as usize && !my_pins.iter().any(|q| q.point_id == p.point_id) {
                    my_pins.push(*p);
                }
            }
            if my_pins.len() == 2 {
                let idx = loops.iter().position(|l| l.contains(&my_pins[0].point_id) && l.contains(&my_pins[1].point_id));
                if let Some(idx) = idx {
                    let did = mesh_edge_cell(
                        &loops[idx],
                        &my_pins[0],
                        &my_pins[1],
                        cell,
                        &cbox,
                        q,
                        points,
                        opts,
                        features,
                        &mut tris,
                    );
                    if did {
                        meshed_loops.insert(idx);
                    }
                }
            }
            if !meshed_loops.is_empty() {
                edge_cells += 1;
            } else {
                feature_cell_fallbacks += 1;
                fallback_cells.push(*cell);
            }
        }

        for (li, loop_pts) in loops.iter().enumerate() {
            if meshed_loops.contains(&li) {
                continue;
            }
            triangulate_loop(loop_pts, q, points, &cbox, opts, &mut tris);
        }
    }

    CellMeshResult {
        tris,
        failed_cells,
        multi_loop_cells,
        edge_cells,
        corner_cells,
        feature_cell_fallbacks,
        fallback_cells,
    }
}

/// Triangulate one closed loop as a disk. Port of `triangulateLoop`.
fn triangulate_loop<T: SdfQuery + ?Sized>(
    loop_pts: &[usize],
    tree: &T,
    points: &mut PointTable,
    cell_box: &[f64; 6],
    o: &CellMeshOptions,
    out_tris: &mut Vec<usize>,
) {
    let m = loop_pts.len();
    if m < 3 {
        return;
    }
    if m == 3 {
        out_tris.extend_from_slice(&[loop_pts[0], loop_pts[1], loop_pts[2]]);
        return;
    }
    if m == 4 {
        let d02 = dist2(points, loop_pts[0], loop_pts[2]);
        let d13 = dist2(points, loop_pts[1], loop_pts[3]);
        if d02 <= d13 {
            out_tris.extend_from_slice(&[loop_pts[0], loop_pts[1], loop_pts[2], loop_pts[0], loop_pts[2], loop_pts[3]]);
        } else {
            out_tris.extend_from_slice(&[loop_pts[1], loop_pts[2], loop_pts[3], loop_pts[1], loop_pts[3], loop_pts[0]]);
        }
        return;
    }
    if o.interior_vertex_mode == InteriorVertexMode::Fan {
        let k = best_fan_apex(points, loop_pts);
        for i in 1..m - 1 {
            out_tris.extend_from_slice(&[loop_pts[k], loop_pts[(k + i) % m], loop_pts[(k + i + 1) % m]]);
        }
        return;
    }

    // Interior vertex: loop average, optionally Newton-projected onto the surface.
    let mut cx = 0.0;
    let mut cy = 0.0;
    let mut cz = 0.0;
    for &id in loop_pts {
        cx += points.x(id);
        cy += points.y(id);
        cz += points.z(id);
    }
    cx /= m as f64;
    cy /= m as f64;
    cz /= m as f64;
    let mut px = cx;
    let mut py = cy;
    let mut pz = cz;
    if o.interior_vertex_mode == InteriorVertexMode::Project {
        let margin = (cell_box[3] - cell_box[0]) * 0.1;
        for _ in 0..o.project_max_iters {
            let fv = tree.f([px, py, pz]);
            if fv.abs() <= o.surface_tol * 0.25 {
                break;
            }
            let (_, g) = tree.grad([px, py, pz]);
            let g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
            if g2 < 1e-20 {
                break;
            }
            let k = fv / g2;
            px -= k * g[0];
            py -= k * g[1];
            pz -= k * g[2];
            if px < cell_box[0] - margin
                || px > cell_box[3] + margin
                || py < cell_box[1] - margin
                || py > cell_box[4] + margin
                || pz < cell_box[2] - margin
                || pz > cell_box[5] + margin
            {
                break;
            }
        }
        let mut same_sheet = true;
        if tree.f([px, py, pz]).abs() <= o.surface_tol && in_box(cell_box, px, py, pz, margin) {
            let mut ax = 0.0;
            let mut ay = 0.0;
            let mut az = 0.0;
            for &id in loop_pts {
                ax += points.nx(id);
                ay += points.ny(id);
                az += points.nz(id);
            }
            let (_, g) = tree.grad([px, py, pz]);
            same_sheet = ax * g[0] + ay * g[1] + az * g[2] > 0.0;
        }
        if tree.f([px, py, pz]).abs() > o.surface_tol || !in_box(cell_box, px, py, pz, margin) || !same_sheet {
            let k = best_fan_apex(points, loop_pts);
            for i in 1..m - 1 {
                out_tris.extend_from_slice(&[loop_pts[k], loop_pts[(k + i) % m], loop_pts[(k + i + 1) % m]]);
            }
            return;
        }
    }
    let (_, g) = tree.grad([px, py, pz]);
    let c = points.add(px, py, pz, g[0], g[1], g[2]);
    for i in 0..m {
        out_tris.extend_from_slice(&[c, loop_pts[i], loop_pts[(i + 1) % m]]);
    }
}

/// Fan apex choice: the loop vertex maximizing the worst ear quality
/// (2·area/lmax² of each fan triangle). Port of `bestFanApex`.
fn best_fan_apex(pts: &PointTable, loop_pts: &[usize]) -> usize {
    let m = loop_pts.len();
    let quality = |a: usize, b: usize, c: usize| -> f64 {
        let ax = pts.x(a);
        let ay = pts.y(a);
        let az = pts.z(a);
        let ux = pts.x(b) - ax;
        let uy = pts.y(b) - ay;
        let uz = pts.z(b) - az;
        let vx = pts.x(c) - ax;
        let vy = pts.y(c) - ay;
        let vz = pts.z(c) - az;
        let area2 = hypot3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        let e0 = hypot3(ux, uy, uz);
        let e1 = hypot3(vx, vy, vz);
        let e2 = hypot3(pts.x(c) - pts.x(b), pts.y(c) - pts.y(b), pts.z(c) - pts.z(b));
        let lmax = e0.max(e1).max(e2);
        if lmax > 1e-20 {
            area2 / (lmax * lmax)
        } else {
            0.0
        }
    };
    let mut best_k = 0usize;
    let mut best_q = -1.0f64;
    for k in 0..m {
        let mut worst = f64::INFINITY;
        let mut i = 1;
        while i < m - 1 && worst > best_q {
            let q = quality(loop_pts[k], loop_pts[(k + i) % m], loop_pts[(k + i + 1) % m]);
            if q < worst {
                worst = q;
            }
            i += 1;
        }
        if worst > best_q {
            best_q = worst;
            best_k = k;
        }
    }
    best_k
}

fn dist2(pts: &PointTable, a: usize, b: usize) -> f64 {
    let dx = pts.x(a) - pts.x(b);
    let dy = pts.y(a) - pts.y(b);
    let dz = pts.z(a) - pts.z(b);
    dx * dx + dy * dy + dz * dz
}

/// Shared, exact corner mesh vertex (keyed; averaged incident-strata normal).
/// Port of `cornerPointId`.
fn corner_point_id(corner: &SfccCorner, features: &SfccFeatureSet, points: &mut PointTable) -> usize {
    let key = format!("corner:{}", corner.id);
    let (cx, cy, cz) = (corner.x, corner.y, corner.z);
    let strata_ids = corner.strata.clone();
    points.get_or_create_str(&key, || {
        let mut nx = 0.0;
        let mut ny = 0.0;
        let mut nz = 0.0;
        for &sid in &strata_ids {
            let n = features.strata[sid].normal(cx, cy, cz);
            nx += n[0];
            ny += n[1];
            nz += n[2];
        }
        let nl = (nx * nx + ny * ny + nz * nz).sqrt();
        if nl > 1e-12 {
            [cx, cy, cz, nx / nl, ny / nl, nz / nl]
        } else {
            [cx, cy, cz, 0.0, 1.0, 0.0]
        }
    })
}

fn in_box(box6: &[f64; 6], x: f64, y: f64, z: f64, margin: f64) -> bool {
    x >= box6[0] - margin
        && x <= box6[3] + margin
        && y >= box6[1] - margin
        && y <= box6[4] + margin
        && z >= box6[2] - margin
        && z <= box6[5] + margin
}

/// `Math.hypot` for three components.
fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}

/// Mesh an edge cell: split the loop at the curve's two pins into the two
/// stratum chains, sample the analytic curve between the pins, and fan each side
/// from an interior vertex projected onto that side's smooth carrier. Port of
/// `meshEdgeCell`.
#[allow(clippy::too_many_arguments)]
fn mesh_edge_cell<T: SdfQuery + ?Sized>(
    loop_pts: &[usize],
    pin_a: &FacePin,
    pin_b: &FacePin,
    cell: &SfccCell,
    cell_box: &[f64; 6],
    tree: &T,
    points: &mut PointTable,
    opts: &CellMeshOptions,
    features: &SfccFeatureSet,
    out_tris: &mut Vec<usize>,
) -> bool {
    let curve = &features.curves[cell.feature_curve as usize];
    let i = match loop_pts.iter().position(|&x| x == pin_a.point_id) {
        Some(v) => v,
        None => return false,
    };
    let j = match loop_pts.iter().position(|&x| x == pin_b.point_id) {
        Some(v) => v,
        None => return false,
    };
    if i == j {
        return false;
    }
    let m = loop_pts.len();

    // Chains inclusive of both pins, following loop order.
    let mut chain1: Vec<usize> = Vec::new();
    let mut k = i;
    loop {
        chain1.push(loop_pts[k]);
        if k == j {
            break;
        }
        k = (k + 1) % m;
    }
    let mut chain2: Vec<usize> = Vec::new();
    let mut k = j;
    loop {
        chain2.push(loop_pts[k]);
        if k == i {
            break;
        }
        k = (k + 1) % m;
    }
    if chain1.len() < 3 || chain2.len() < 3 {
        return false;
    }

    // Sample the in-cell arc from pin_a.t to pin_b.t (interior points only).
    let interior = match sample_in_cell_arc(curve, pin_a.t, pin_b.t, cell_box, points, features, opts) {
        Some(v) => v,
        None => return false,
    };

    // side1 = chain1 (A→…→B) closed by the polyline B→A (reversed interior);
    // side2 = chain2 (B→…→A) closed by the polyline A→B.
    let mut side1 = chain1.clone();
    side1.extend(interior.iter().rev().copied());
    let mut side2 = chain2.clone();
    side2.extend(interior.iter().copied());

    // Assign strata to sides by aggregate NORMAL-AGREEMENT margin over all non-pin
    // chain vertices. Score both assignments and take the better — never reject.
    let sa = features.strata[curve.adjacent_strata[0]];
    let sb = features.strata[curve.adjacent_strata[1]];
    let agree = |pts: &PointTable, vid: usize, st: &Stratum| -> f64 {
        let x = pts.x(vid);
        let y = pts.y(vid);
        let z = pts.z(vid);
        let n = st.normal(x, y, z);
        let vx = pts.nx(vid);
        let vy = pts.ny(vid);
        let vz = pts.nz(vid);
        let vl = (vx * vx + vy * vy + vz * vz).sqrt();
        if vl < 1e-12 {
            return 0.0;
        }
        ((vx * n[0] + vy * n[1] + vz * n[2]) / vl).abs()
    };
    let mut score = 0.0f64;
    for &vid in &chain1[1..chain1.len() - 1] {
        score += agree(points, vid, &sa) - agree(points, vid, &sb);
    }
    for &vid in &chain2[1..chain2.len() - 1] {
        score += agree(points, vid, &sb) - agree(points, vid, &sa);
    }
    let side1_is_a = score >= 0.0;
    let side2_is_a = !side1_is_a;

    let st1 = if side1_is_a { sa } else { sb };
    let st2 = if side2_is_a { sa } else { sb };
    fan_from_stratum_vertex(&side1, &st1, cell_box, tree, points, opts, out_tris);
    fan_from_stratum_vertex(&side2, &st2, cell_box, tree, points, opts, out_tris);
    true
}

/// Interior polyline points along the curve between two parameters, choosing the
/// in-cell arc for closed curves. Returns point ids (exactly on the analytic
/// curve), or None when no arc stays in the cell. Port of `sampleInCellArc`.
fn sample_in_cell_arc(
    curve: &FeatureCurve,
    t_a: f64,
    t_b: f64,
    cell_box: &[f64; 6],
    points: &mut PointTable,
    features: &SfccFeatureSet,
    opts: &CellMeshOptions,
) -> Option<Vec<usize>> {
    let margin = (cell_box[3] - cell_box[0]) * 0.25;
    let delta: f64;
    if let (true, Some(wrap)) = (curve.closed, curve.param_wrap) {
        let fwd = ((t_b - t_a) % wrap + wrap) % wrap;
        let candidates = [fwd, fwd - wrap]; // the two arcs between the pins
        let mut chosen: Option<f64> = None;
        for d in candidates {
            let p = curve.point_at(t_a + d / 2.0);
            if in_box(cell_box, p[0], p[1], p[2], margin) && (chosen.is_none() || d.abs() < chosen.unwrap().abs()) {
                chosen = Some(d);
            }
        }
        delta = chosen?;
    } else {
        delta = t_b - t_a;
    }
    let arc_len = {
        let pd = curve.param_distance(t_a, t_a + delta);
        if pd != 0.0 {
            pd
        } else {
            delta.abs()
        }
    };
    // Interior-point count from the chord tolerance (straight segments: none).
    let mut n = 1usize;
    match curve.kind() {
        CurveKind::Circle => {
            // chord error of arc dθ at radius r: r(1 − cos(dθ/2)) ≤ tol
            let r = arc_len / if delta != 0.0 { delta.abs() } else { 1.0 };
            let ratio = (1.0 - opts.curve_chord_tol / r.max(1e-9)).clamp(-1.0, 1.0);
            let max_step = 2.0 * ratio.acos();
            n = (delta.abs() / max_step.max(1e-6)).ceil().max(1.0) as usize;
            n = n.min(opts.max_polyline_points_per_cell);
        }
        CurveKind::Traced => {
            n = (delta.abs().ceil().max(1.0) as usize).min(opts.max_polyline_points_per_cell);
            n = n.max(1);
        }
        CurveKind::Segment => {}
    }
    let sa = features.strata[curve.adjacent_strata[0]];
    let sb = features.strata[curve.adjacent_strata[1]];
    let mut ids: Vec<usize> = Vec::new();
    for k in 1..n {
        let t = t_a + (delta * k as f64) / n as f64;
        let p = curve.point_at(t);
        let na = sa.normal(p[0], p[1], p[2]);
        let nb = sb.normal(p[0], p[1], p[2]);
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
        ids.push(points.add(p[0], p[1], p[2], nx, ny, nz));
    }
    Some(ids)
}

/// Fan a disk from an interior vertex projected onto the side's smooth carrier.
/// Port of `fanFromStratumVertex`.
fn fan_from_stratum_vertex<T: SdfQuery + ?Sized>(
    boundary: &[usize],
    stratum: &Stratum,
    cell_box: &[f64; 6],
    tree: &T,
    points: &mut PointTable,
    opts: &CellMeshOptions,
    out_tris: &mut Vec<usize>,
) {
    let m = boundary.len();
    let mut cx = 0.0;
    let mut cy = 0.0;
    let mut cz = 0.0;
    for &id in boundary {
        cx += points.x(id);
        cy += points.y(id);
        cz += points.z(id);
    }
    cx /= m as f64;
    cy /= m as f64;
    cz /= m as f64;
    let proj = stratum.project(cx, cy, cz);
    let margin = (cell_box[3] - cell_box[0]) * 0.1;
    let px = proj[0];
    let py = proj[1];
    let pz = proj[2];
    let mut wrong_patch = false;
    if in_box(cell_box, px, py, pz, margin) {
        let n = stratum.normal(px, py, pz);
        let (_, g) = tree.grad([px, py, pz]);
        let gl = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
        wrong_patch = gl > 1e-12 && (g[0] * n[0] + g[1] * n[1] + g[2] * n[2]).abs() / gl < 0.8;
    }
    if !in_box(cell_box, px, py, pz, margin) || wrong_patch || tree.f([px, py, pz]).abs() > opts.surface_tol {
        let kb = best_fan_apex(points, boundary);
        for k in 1..m - 1 {
            out_tris.extend_from_slice(&[boundary[kb], boundary[(kb + k) % m], boundary[(kb + k + 1) % m]]);
        }
        return;
    }
    let n = stratum.normal(px, py, pz);
    let c = points.add(px, py, pz, n[0], n[1], n[2]);
    for k in 0..m {
        out_tris.extend_from_slice(&[c, boundary[k], boundary[(k + 1) % m]]);
    }
}
