//! S3b — per-cell meshing (SMOOTH path). Port of the featureless paths of
//! `src/export/sfcc/cell-mesh.mts`.
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
//! DEFERRED to M4 (the feature paths — inert on smooth scenes, so omitted here):
//! corner-cell wedge fans (`cell.featureCorner`), edge-cell pin routing
//! (`cell.featureCurve`, `meshEdgeCell`), and the analytic-curve polyline
//! sampling. On a smooth scene `feature_curve`/`feature_corner` stay −1 so every
//! loop takes the smooth disk path.

use crate::math::grid::{cell_aabb, face_axes, pack_point, stride_at_level, SfccLattice};
use crate::sdf::CsgNode;
use crate::sfcc::face_contour::FaceRecord;
use crate::sfcc::octree::{SfccCell, SfccOctree};
use crate::sfcc::point_table::PointTable;
use std::collections::HashMap;

/// Interior-vertex placement for disk triangulation. Port of
/// `CellMeshOptions.interiorVertexMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InteriorVertexMode {
    Project,
    Centroid,
    Fan,
}

/// Smooth-path cell-meshing options (the feature/curve knobs are M4-only and
/// inert here, so omitted).
#[derive(Clone, Copy)]
pub struct CellMeshOptions {
    pub surface_tol: f64,
    pub interior_vertex_mode: InteriorVertexMode,
    pub project_max_iters: u32,
}

/// Result of meshing all leaf cells.
pub struct CellMeshResult {
    pub tris: Vec<usize>,
    /// Cells whose segment soup did not assemble into closed loops.
    pub failed_cells: Vec<SfccCell>,
    /// Cells that produced 2+ loops (legal, but certificate-noteworthy).
    pub multi_loop_cells: usize,
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
fn push_segments(rec: &FaceRecord, axis: usize, rev: bool, out: &mut Vec<Seg>) {
    for (i, s) in rec.segments.iter().enumerate() {
        if rev {
            out.push(Seg { a: s.b, b: s.a, face: (axis, rec.key), idx: i, reversed: true });
        } else {
            out.push(Seg { a: s.a, b: s.b, face: (axis, rec.key), idx: i, reversed: false });
        }
    }
}

/// Gather the cell's boundary segments. Each side is either one face at the
/// cell's own level, or — when the neighbor is one level finer (2:1 balance) —
/// up to four quarter faces at level+1, unioned (segments reference global point
/// ids). Port of `gatherSegments` (smooth path; `pins` are M4 → not gathered).
fn gather_segments(
    faces: &[HashMap<i64, FaceRecord>; 3],
    lat: &SfccLattice,
    cell: &SfccCell,
    out: &mut Vec<Seg>,
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
            // side == 0: face is the cell's min-axis side ⇒ cell is on the
            // face's +axis side ⇒ consume as stored. side == 1: reversed.
            let reversed = side == 1;
            let key = pack_point(lat, g[0], g[1], g[2]);
            // Face keys are min-corner lattice points which COLLIDE across
            // levels, so every lookup validates the record's size.
            if let Some(rec) = faces[axis].get(&key) {
                if rec.len == stride {
                    push_segments(rec, axis, reversed, out);
                    continue;
                }
            }
            // Neighbor is finer: consume the quarter faces (absent quarters
            // border certified-empty regions and carry no segments).
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
                            push_segments(qrec, axis, reversed, out);
                        }
                    }
                }
            }
        }
    }
}

/// Mesh every leaf cell into triangles (smooth path). Port of `meshAllCells`.
/// Consumption is recorded back into the face records for the S4 face audit.
pub fn mesh_all_cells(
    oct: &SfccOctree,
    faces: &mut [HashMap<i64, FaceRecord>; 3],
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &CellMeshOptions,
) -> CellMeshResult {
    let lat = oct.lat;
    let mut tris: Vec<usize> = Vec::new();
    let mut failed_cells: Vec<SfccCell> = Vec::new();
    let mut multi_loop_cells = 0usize;

    let mut segs: Vec<Seg> = Vec::new();

    for cell in &oct.leaves {
        segs.clear();
        gather_segments(faces, &lat, cell, &mut segs);
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

        // SMOOTH path: corner-cell / edge-cell feature meshing (cell.featureCorner
        // / cell.featureCurve >= 0) is M4 — on a smooth scene both stay −1, so
        // every loop takes the disk path below.
        for loop_pts in &loops {
            triangulate_loop(loop_pts, tree, points, &cbox, opts, &mut tris);
        }
    }

    CellMeshResult { tris, failed_cells, multi_loop_cells }
}

/// Triangulate one closed loop as a disk. Port of `triangulateLoop`.
fn triangulate_loop(
    loop_pts: &[usize],
    tree: &CsgNode,
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
        // Accept only a vertex that (1) reached the surface, (2) stayed in the
        // cell, and (3) lies on the SAME sheet as the loop (gradient roughly
        // along the loop's average normal — the far side of a slab faces away,
        // dot ≈ −1).
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
            // Projection failed: fan from the best worst-ear boundary vertex —
            // every loop vertex IS on the surface, so the max-|f| guarantee holds.
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

fn in_box(box6: &[f64; 6], x: f64, y: f64, z: f64, margin: f64) -> bool {
    x >= box6[0] - margin
        && x <= box6[3] + margin
        && y >= box6[1] - margin
        && y <= box6[4] + margin
        && z >= box6[2] - margin
        && z <= box6[5] + margin
}

/// `Math.hypot` for three components — matches TS `Math.hypot(x, y, z)` ordering.
fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    (x * x + y * y + z * z).sqrt()
}
