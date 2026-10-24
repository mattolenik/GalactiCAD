//! S3b — per-cell meshing. Port of `src/export/sfcc/cell-mesh.mts`.
//!
//! Each leaf cell gathers its boundary face segments (the +axis-side cell
//! consumes a face's segments as stored; the −axis-side cell reverses them),
//! assembles them into closed loops, and triangulates each loop as a disk.
//! Loops come out CCW viewed from OUTSIDE the solid (outward winding) and every
//! interior face segment is consumed exactly twice in opposite directions —
//! recorded into the [`FaceRecord`] counters for the S4 audit.
//!
//! Triangulation: 3-loops emit directly; 4-loops prefer a valid projected diagonal
//! before comparing length; larger loops fan from an interior vertex projected
//! onto the surface (fallback: best-quality boundary-vertex fan).
//!
//! M4c-2 added the FEATURE paths (gated on `opts.features`, inert on smooth
//! scenes): corner-cell wedge fans (`cell.feature_corner`), edge-cell pin routing
//! (`cell.feature_curve`, `mesh_edge_cell`), and analytic-curve polyline sampling.

use crate::math::grid::{cell_aabb, face_axes, pack_point, stride_at_level, SfccLattice};
use crate::sdf::{CsgNode, Pruned, SdfQuery};
use crate::sfcc::face_contour::{FacePin, FaceRecord};
use crate::sfcc::feature_curves::{CurveKind, FeatureCurve};
use crate::sfcc::feature_set::{SfccCorner, SfccFeatureSet};
use crate::sfcc::octree::LEVER1_MIN_LEAVES;
use crate::sfcc::octree::{SfccCell, SfccOctree};
use crate::sfcc::point_table::{CurveInterval, PointTable};
use crate::sfcc::triangle_quality as q;
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
    pub quality_triangulation: bool,
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
    /// Fallback retry candidates; retained report-only fillings are counted
    /// above but do not add a new forced-refinement reason.
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
    let leaf_groups: Vec<&[SfccCell]> = groups.iter().map(|r| &oct.leaves[r.clone()]).collect();
    mesh_cells_for(oct, faces, tree, points, opts, &leaf_groups)
}

/// Mesh N caller-supplied leaf groups (each an arbitrary cell slice — contiguous
/// index ranges OR Morton/Z-order chunks, #3 slice 2) into the shared `faces` map +
/// `points`, sequentially, combining their partials in group order. The triangle
/// buffer order follows the group order; with contiguous groups it equals the serial
/// order (byte-identical), with Morton groups it reorders (canonically equal).
pub(crate) fn mesh_cells_for(
    oct: &SfccOctree,
    faces: &mut [HashMap<i64, FaceRecord>; 3],
    tree: &CsgNode,
    points: &mut PointTable,
    opts: &CellMeshOptions,
    groups: &[&[SfccCell]],
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
    for &group in groups {
        let part = mesh_cells_subset(oct, faces, tree, points, opts, group);
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
    let coverage_scope=super::local_coverage::Scope::new(tree);
    let atomic_box_guard=super::local_coverage::AtomicBoxGuard::new(tree);

    // Quality triangulation performs enough queries to amortize a pruned view
    // on larger trees. Its box includes the entire candidate projection budget.
    // Baseline pruning retains the existing experiment gate.
    let prune = if opts.quality_triangulation { tree.leaf_count() >= 8 }
        else { crate::sdf::lever1_should_prune(tree, LEVER1_MIN_LEAVES) };

    for cell in leaves {
        if let Some(kind)=atomic_box_guard.as_ref().and_then(|g|g.inspect(oct,cell)) {
            points.coverage_edge_failures.push(super::local_coverage::EdgeFailure {cell:*cell,kind});
        }
        let coverage_start=tris.len();
        #[cfg(feature = "sfcc-profile")]
        let diagnostic_start = tris.len();
        segs.clear();
        pins.clear();
        gather_segments(faces, &lat, cell, &mut segs, &mut pins);
        if segs.is_empty() {
            let missing_corner = opts.features.is_some_and(|features| {
                if cell.feature_corner < 0 { return false; }
                let corner = &features.corners[cell.feature_corner as usize];
                tree.f([corner.x, corner.y, corner.z]).abs() <= opts.curve_chord_tol
            });
            if super::local_coverage::record(&coverage_scope,oct,cell,faces,points,&[],opts.features) || missing_corner {failed_cells.push(*cell);}
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
            super::local_coverage::record(&coverage_scope,oct,cell,faces,points,&tris[coverage_start..],opts.features);
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
            super::local_coverage::record(&coverage_scope,oct,cell,faces,points,&tris[coverage_start..],opts.features);
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
        // vertex projection / fan evals. Baseline queries are guarded by the
        // centroid margin. Quality queries additionally include the maximum
        // coarse-candidate displacement and f32 rounding of the cell boundary.
        let pruned: Option<Pruned> = if prune {
            let cs = cbox[3] - cbox[0];
            let quality_reach = if opts.quality_triangulation {
                let rounding = (cbox.iter().map(|x| x.abs()).fold(0., f64::max) * f32::EPSILON as f64)
                    .max(f32::from_bits(1) as f64);
                8. * opts.curve_chord_tol + rounding
            } else { 0. };
            let half = cs * 0.6 + quality_reach;
            let c = [(cbox[0] + cbox[3]) * 0.5, (cbox[1] + cbox[4]) * 0.5, (cbox[2] + cbox[5]) * 0.5];
            Some(tree.prune_to_box(c, [half, half, half]))
        } else {
            None
        };
        let q: &dyn SdfQuery = match &pruned {
            Some(p) => p,
            None => tree,
        };

        if opts.quality_triangulation && loops.len() > 1 && pins.is_empty() {
            let mut candidate = None;
            if let Some(features) = opts.features {
                for carrier in &features.strata {
                    if let Ok(mesh) = super::surface_patch::planar_domains(points, &loops, q, carrier, opts.curve_chord_tol) {
                        candidate = Some((mesh, carrier.id));
                        break;
                    }
                }
            }
            if let Some((mesh, owner)) = candidate {
                for t in mesh.chunks_exact(3) { points.set_patch([t[0], t[1], t[2]], owner); }
                tris.extend(mesh);
                if super::local_coverage::record(&coverage_scope,oct,cell,faces,points,&tris[coverage_start..],opts.features) {failed_cells.push(*cell);}
                #[cfg(feature = "sfcc-profile")]
                super::diagnosis::mesh(cell, points, &tris[diagnostic_start..], "planar-domains", false);
                continue;
            }
        }

        let mut meshed_loops: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut feature_graph_failed = false;
        let mut retained_unresolved = false;

        // The depth ceiling can leave several modeled junctions in one cell.
        // Such a cell cannot be represented by a fan from whichever corner the
        // classifier encountered last. Build the local feature graph instead.
        if let Some(features) = opts.features {
            let corners: Vec<_> = features
                .index
                .corners_in_box([cbox[0], cbox[1], cbox[2]], [cbox[3], cbox[4], cbox[5]])
                .into_iter()
                .filter(|&id| {
                    let c = &features.corners[id];
                    !c.curve_ends.is_empty() && in_box(&cbox, c.x, c.y, c.z, 0.)
                })
                .collect();
            let distinct_curves: std::collections::HashSet<_> = pins.iter().map(|p| p.curve_id).collect();
            // Straight native corner fans already preserve their exact edges.
            // Curved incident arcs require explicit sampling even when there
            // is only one corner; multiple junctions require the full graph.
            let curved_corner = corners.iter().any(|&id| {
                features.corners[id]
                    .curve_ends
                    .iter()
                    .any(|&(curve, _)| features.curves[curve].kind() != CurveKind::Segment)
            });
            if corners.len() > 1 || ((cell.degenerate || loops.len() > 1) && distinct_curves.len() > 1) || curved_corner {
                if mesh_feature_graph(&loops, &pins, &corners, &cbox, q, points, opts, features, &mut tris, &mut retained_unresolved) {
                    if retained_unresolved {
                        failed_cells.push(*cell);
                        feature_cell_fallbacks+=1;
                        super::local_coverage::record_unresolved_filling(cell,points,&tris[coverage_start..]);
                    } else if super::local_coverage::record(&coverage_scope,oct,cell,faces,points,&tris[coverage_start..],opts.features) {failed_cells.push(*cell);}
                    if corners.is_empty() {
                        edge_cells += 1;
                    } else {
                        corner_cells += 1;
                    }
                    #[cfg(feature = "sfcc-profile")]
                    super::diagnosis::mesh(cell, points, &tris[diagnostic_start..], "feature-graph", retained_unresolved);
                    continue;
                }
                feature_graph_failed = true;
            }
        }

        // Independent caps turn a newly discovered interior contour into a
        // detached bubble. Its incident modeled paths must construct the patch.
        if feature_graph_failed && loops.len() > 1
            && segs.iter().any(|s| faces[s.face.0][&s.face.1].interior_cycle) {
            failed_cells.push(*cell);
            continue;
        }

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
                for pin in &pins {
                    if incident.contains(&pin.curve_id) && loop_pts.contains(&pin.point_id) {
                        let curve = &features.curves[pin.curve_id];
                        for &(id, end) in &corner.curve_ends {
                            if id == pin.curve_id {
                                points.protect_curve_edge(
                                    cid,
                                    pin.point_id,
                                    CurveInterval {
                                        curve_id: id,
                                        start: if end == 0 { curve.t_min } else { curve.t_max },
                                        end: pin.t,
                                    },
                                );
                            }
                        }
                    }
                }
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
                feature_graph_failed = false;
            }
        } else if let (true, Some(features)) = (cell.feature_curve >= 0, opts.features) {
            // Edge cells: split the loop containing the two pinned feature points
            // and mesh each stratum side against the sampled analytic curve.
            let mut my_pins: Vec<FacePin> = Vec::new();
            for p in &pins {
                if p.curve_id == cell.feature_curve as usize
                    && !my_pins.iter().any(|q| q.point_id == p.point_id)
                {
                    my_pins.push(*p);
                }
            }
            if my_pins.len() == 2 {
                let idx = loops
                    .iter()
                    .position(|l| l.contains(&my_pins[0].point_id) && l.contains(&my_pins[1].point_id));
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
                        &mut retained_unresolved,
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
                feature_graph_failed = false;
            }
        }

        // A successful single-corner fan is not a successful multi-curve graph.
        // Retain the unresolved constraint report even when it yields a disk.
        if feature_graph_failed {
            feature_cell_fallbacks += 1;
            fallback_cells.push(*cell);
        } else if retained_unresolved {
            feature_cell_fallbacks += 1;
        }

        for (li, loop_pts) in loops.iter().enumerate() {
            if meshed_loops.contains(&li) {
                continue;
            }
            triangulate_loop(loop_pts, q, points, &cbox, opts, &mut tris);
        }
        #[cfg(feature = "sfcc-profile")]
        super::diagnosis::mesh(cell, points, &tris[diagnostic_start..], "cell-loops", retained_unresolved || fallback_cells.last().is_some_and(|c| c.level == cell.level && c.key == cell.key));
        if retained_unresolved {
            failed_cells.push(*cell);
            super::local_coverage::record_unresolved_filling(cell,points,&tris[coverage_start..]);
        } else if super::local_coverage::record(&coverage_scope,oct,cell,faces,points,&tris[coverage_start..],opts.features) {failed_cells.push(*cell);}
    }

    for failure in &points.coverage_edge_failures {
        let c=failure.cell;
        if !c.degenerate&&leaves.iter().any(|v|v.level==c.level&&v.key==c.key)
            && !failed_cells.iter().any(|v|v.level==c.level&&v.key==c.key) {failed_cells.push(c);}
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
    if o.quality_triangulation && m >= 3 {
        // Only accept known carriers here. Unknown field charts retain the
        // baseline route until connected branch ownership can be established.
        if let Some(features) = o.features {
            for carrier in &features.strata {
                if !super::surface_patch::supports_local_edits(carrier) { continue; }
                if !loop_pts.iter().all(|&i| {
                    let p = super::triangle_quality::pos(points, i);
                    // Reject distant equations before their (possibly
                    // iterative) carrier projection. This is only a candidate
                    // screen; acceptance still uses displacement and exposure.
                    let sample = carrier.raw_field(p[0], p[1], p[2]);
                    let gradient = super::triangle_quality::norm(sample.gradient);
                    if !sample.value.is_finite() || !gradient.is_finite() || gradient == 0.
                        || sample.value.abs() > gradient * o.surface_tol * 0.1 { return false; }
                    let q = carrier.project(p[0], p[1], p[2]);
                    super::triangle_quality::norm(super::triangle_quality::sub(p, q)) <= o.surface_tol * 0.1
                        && carrier.domain_contains(q, o.surface_tol * 0.01)
                }) { continue; }
                let candidate = super::surface_patch::disk_strict_or_coarse(points, loop_pts, tree, Some(carrier), o.curve_chord_tol);
                if let Ok(candidate) = candidate {
                    for t in candidate.chunks_exact(3) { points.set_patch([t[0], t[1], t[2]], carrier.id); }
                    out_tris.extend(candidate);
                    return;
                }
            }
        }
    }
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
        let valid = super::surface_patch::Chart::from_boundary(points, loop_pts)
            .map(|chart| {
                let p: [q::P3; 4] = std::array::from_fn(|i| q::pos(points, loop_pts[i]));
                [[0, 1, 2, 0, 2, 3], [1, 2, 3, 1, 3, 0]].map(|indices| {
                    [p, p.map(q::rounded)].into_iter().all(|p| {
                        p.iter().flatten().all(|x| x.is_finite())
                            && indices.chunks_exact(3).all(|t| {
                                super::predicates::orient2d(
                                    chart.map(p[t[0]]), chart.map(p[t[1]]), chart.map(p[t[2]]),
                                ) > 0
                            })
                    })
                })
            })
            .unwrap_or([false; 2]);
        // Prefer a valid projected disk before length. An unavailable chart is
        // not proof of invalid 3D geometry; retain the existing fallback there.
        let use_02 = if valid[0] != valid[1] { valid[0] } else { d02 <= d13 };
        if use_02 {
            out_tris.extend_from_slice(&[
                loop_pts[0],
                loop_pts[1],
                loop_pts[2],
                loop_pts[0],
                loop_pts[2],
                loop_pts[3],
            ]);
        } else {
            out_tris.extend_from_slice(&[
                loop_pts[1],
                loop_pts[2],
                loop_pts[3],
                loop_pts[1],
                loop_pts[3],
                loop_pts[0],
            ]);
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
            let sample = tree.field_sample([px, py, pz]);
            let fv = sample.value;
            if !fv.is_finite() {
                break;
            }
            if fv.abs() <= o.surface_tol * 0.25 {
                break;
            }
            let g = sample.gradient;
            let g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
            if !g2.is_finite() || g2 < 1e-20 {
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
        if in_box(cell_box, px, py, pz, margin) && tree.f([px, py, pz]).abs() <= o.surface_tol {
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
        if !in_box(cell_box, px, py, pz, margin) || tree.f([px, py, pz]).abs() > o.surface_tol || !same_sheet
        {
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

/// Split the boundary disk by every in-cell feature path, then mesh each patch
/// separately. The rotation order around each vertex supplies the local surface
/// embedding; boundary orientation and edge incidence are checked before commit.
#[allow(clippy::too_many_arguments)]
fn mesh_feature_graph<T: SdfQuery + ?Sized>(
    loops: &[Vec<usize>],
    pins: &[FacePin],
    corners: &[usize],
    cell_box: &[f64; 6],
    tree: &T,
    points: &mut PointTable,
    opts: &CellMeshOptions,
    features: &SfccFeatureSet,
    out: &mut Vec<usize>,
    retained_unresolved: &mut bool,
) -> bool {
    use std::collections::{BTreeMap, BTreeSet};
    if loops.is_empty() {
        return false;
    }
    let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };
    let mut edges: BTreeMap<(usize, usize), Option<BTreeSet<usize>>> = BTreeMap::new();
    let mut shared_arcs: Vec<SharedArc> = Vec::new();
    let mut memberships = Vec::new();
    let mut boundary_forward = BTreeSet::new();
    for boundary in loops {
        for i in 0..boundary.len() {
            let (a, b) = (boundary[i], boundary[(i + 1) % boundary.len()]);
            edges.insert(key(a, b), None);
            boundary_forward.insert((a, b));
        }
    }
    let mut paths: BTreeMap<usize, Vec<(f64, usize)>> = BTreeMap::new();
    // New patches obey the surface displacement budget as well as the feature
    // chord budget; the existing per-cell point cap remains unchanged.
    let arc_opts = CellMeshOptions { curve_chord_tol: if loops.len() > 1 {
        opts.curve_chord_tol.min(opts.surface_tol)
    } else { opts.curve_chord_tol }, ..*opts };
    for pin in pins {
        if loops.iter().any(|boundary| boundary.contains(&pin.point_id)) {
            paths.entry(pin.curve_id).or_default().push((pin.t, pin.point_id));
        }
    }
    for &id in corners {
        let corner = &features.corners[id];
        let point = corner_point_id(corner, features, points);
        for &(curve, end) in &corner.curve_ends {
            let c = &features.curves[curve];
            paths.entry(curve).or_default().push((if end == 0 { c.t_min } else { c.t_max }, point));
        }
    }
    for (id, mut nodes) in paths {
        let curve = &features.curves[id];
        nodes.sort_by(|a, b| a.0.total_cmp(&b.0));
        nodes.dedup_by(|a, b| a.1 == b.1);
        if nodes.len() < 2 {
            return false; // an incident arc cannot silently disappear
        }
        if curve.closed {
            let (t, p) = nodes[0];
            nodes.push((t + curve.param_wrap.unwrap(), p));
        }
        for pair in nodes.windows(2) {
            let ((ta, a), (tb, b)) = (pair[0], pair[1]);
            if a == b {
                continue;
            }
            let Some(mid) = curve.point_at_checked((ta + tb) * 0.5) else {
                return false;
            };
            if !in_box(cell_box, mid[0], mid[1], mid[2], 1e-9) {
                continue;
            }
            let Some(interior) = sample_in_cell_arc(curve, ta, tb, cell_box, points, features, &arc_opts) else {
                return false;
            };
            let own_nodes: Vec<_> = std::iter::once(a).chain(interior.points.iter().copied()).chain(std::iter::once(b)).collect();
            let mut shared = None;
            for arc in &shared_arcs {
                if let Some(mapped) = transport_shared_arc(arc, id, &own_nodes, &interior.parameters, points, features, opts.curve_chord_tol) {
                    shared = Some(mapped);break;
                }
            }
            if let Some((nodes,parameters)) = shared {
                for (edge,span) in nodes.windows(2).zip(parameters.windows(2)) {
                    edges.get_mut(&key(edge[0],edge[1])).unwrap().get_or_insert_with(BTreeSet::new).extend(curve.adjacent_strata);
                    memberships.push((edge[0],edge[1],CurveInterval{curve_id:id,start:span[0],end:span[1]}));
                }
                continue;
            }
            shared_arcs.push(SharedArc{curve:id,nodes:own_nodes,parameters:interior.parameters.clone()});
            let mut previous = a;
            for (span, next) in
                interior.parameters.windows(2).zip(interior.points.iter().copied().chain(std::iter::once(b)))
            {
                let k = key(previous, next);
                if let Some(existing) = edges.get_mut(&k) {
                    let midpoint=curve.point_at_checked((span[0]+span[1])*0.5);
                    let supported=midpoint.is_some_and(|p| {
                        let pad=opts.curve_chord_tol*0.001;
                        super::loft_seam::certify(features,id,id,p.map(|x|x-pad),p.map(|x|x+pad)).is_some()
                    });
                    if existing.is_some() || !supported {return false;}
                    *existing=Some(curve.adjacent_strata.into_iter().collect());
                } else {
                    edges.insert(k, Some(curve.adjacent_strata.into_iter().collect()));
                }
                memberships.push((
                    previous,
                    next,
                    CurveInterval { curve_id: id, start: span[0], end: span[1] },
                ));
                previous = next;
            }
        }
    }
    let mut around: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for &(a, b) in edges.keys() {
        around.entry(a).or_default().push(b);
        around.entry(b).or_default().push(a);
    }
    for (&id, neighbors) in &mut around {
        if neighbors.len() < 2 {
            return false;
        }
        let p = [points.x(id), points.y(id), points.z(id)];
        let mut n = [points.nx(id), points.ny(id), points.nz(id)];
        let len = n[0].hypot(n[1]).hypot(n[2]);
        if !len.is_finite() || len < 1e-12 {
            return false;
        }
        n = n.map(|v| v / len);
        let axis = if n[0].abs() < 0.8 { [1., 0., 0.] } else { [0., 1., 0.] };
        let u = [
            n[1] * axis[2] - n[2] * axis[1],
            n[2] * axis[0] - n[0] * axis[2],
            n[0] * axis[1] - n[1] * axis[0],
        ];
        let v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        let angle = |other: usize| {
            let d = [points.x(other) - p[0], points.y(other) - p[1], points.z(other) - p[2]];
            let dot = |a: [f64; 3]| (0..3).map(|k| d[k] * a[k]).sum::<f64>();
            dot(v).atan2(dot(u))
        };
        neighbors.sort_by(|&a, &b| angle(a).total_cmp(&angle(b)).then(a.cmp(&b)));
    }
    let mut visited = BTreeSet::new();
    let mut patches = Vec::new();
    let mut used_boundary = BTreeSet::new();
    let mut used_features: BTreeMap<(usize, usize), usize> = BTreeMap::new();
    for &(a, b) in edges.keys() {
        for first in [(a, b), (b, a)] {
            if visited.contains(&first) {
                continue;
            }
            let mut edge = first;
            let mut polygon = Vec::new();
            let mut backward = false;
            let mut forward = false;
            let mut candidates: Option<BTreeSet<usize>> = None;
            loop {
                if !visited.insert(edge) {
                    return false;
                }
                polygon.push(edge.0);
                forward |= boundary_forward.contains(&edge);
                backward |= boundary_forward.contains(&(edge.1, edge.0));
                if let Some(ids) = &edges[&key(edge.0, edge.1)] {
                    let ids = ids.clone();
                    candidates = Some(match candidates {
                        None => ids,
                        // Lifted and native carriers can describe the same patch with
                        // different ids. Select by geometric agreement below.
                        Some(old) => old.union(&ids).copied().collect(),
                    });
                }
                let ns = &around[&edge.1];
                let i = ns.iter().position(|&p| p == edge.0).unwrap();
                edge = (edge.1, ns[(i + ns.len() - 1) % ns.len()]);
                if edge == first {
                    break;
                }
                if polygon.len() > edges.len() * 2 {
                    return false;
                }
            }
            if backward {
                if forward {
                    return false;
                }
                continue;
            }
            if polygon.len() < 3 {
                return false;
            }
            let Some(candidates) = candidates else {
                return false;
            };
            if candidates.is_empty() {
                return false;
            }
            let score = |id: usize| {
                polygon
                    .iter()
                    .map(|&p| features.strata[id].f(points.x(p), points.y(p), points.z(p)).abs())
                    .sum::<f64>()
            };
            let stratum = *candidates.iter().min_by(|&&a, &&b| score(a).total_cmp(&score(b))).unwrap();
            for i in 0..polygon.len() {
                let e = (polygon[i], polygon[(i + 1) % polygon.len()]);
                if boundary_forward.contains(&e) {
                    used_boundary.insert(e);
                } else {
                    *used_features.entry(key(e.0, e.1)).or_default() += 1;
                }
            }
            patches.push((stratum, polygon));
        }
    }
    if used_boundary != boundary_forward
        || edges.iter().any(|(edge, ids)| ids.is_some()
            && !boundary_forward.contains(edge) && !boundary_forward.contains(&(edge.1,edge.0))
            && used_features.get(edge) != Some(&2))
    {
        return false;
    }
    let mut triangles = Vec::new();
    let mut unresolved=false;
    for (id, polygon) in patches {
        let start = triangles.len();
        if !fan_from_stratum_vertex(&polygon, &features.strata[id], cell_box, tree, points, opts, &mut triangles) {unresolved=true;}
        if loops.len() > 1 {
            for tri in triangles[start..].chunks_exact(3) {
                let p = [tri[0], tri[1], tri[2]].map(|i| q::pos(points, i));
                let center = q::bary(p, [1. / 3.; 3]);
                let normal = features.strata[id].normal(center[0], center[1], center[2]);
                let reference = |weights: [f64;3], sample: [f64;3]| {
                    for (opposite, &weight) in weights.iter().enumerate() {
                        if weight != 0. { continue; }
                        let (a,b) = ((opposite + 1) % 3, (opposite + 2) % 3);
                        if let Some(&(start,end,interval)) = memberships.iter().find(|(x,y,_)| key(*x,*y) == key(tri[a],tri[b])) {
                            let fraction = if start == tri[a] && end == tri[b] { weights[b] } else { weights[a] };
                            let curve = &features.curves[interval.curve_id];
                            let point = curve.point_at_checked(interval.start + fraction * (interval.end - interval.start))?;
                            if features.strata[id].f(point[0], point[1], point[2]).abs() > opts.surface_tol * 0.001 { return None; }
                            if curve.adjacent_strata.iter().any(|&sid| {
                                let carrier = &features.strata[sid];
                                !carrier.domain_contains(point, opts.surface_tol * 0.001)
                                    || carrier.f(point[0], point[1], point[2]).abs() > opts.surface_tol * 0.001
                            }) { return None; }
                            return Some(point);
                        }
                    }
                    Some(features.strata[id].project(sample[0], sample[1], sample[2]))
                };
                if super::quality_remesh::validate_with_samples(tree, &features.strata[id], p, normal, opts.surface_tol, reference).is_err() {
                    return false;
                }
            }
        }
    }
    if loops.len() > 1 {
        let mut index = super::mesh_edit::GrowingIndex::new();
        for tri in triangles.chunks_exact(3) {
            let ids = [tri[0], tri[1], tri[2]];
            let p = ids.map(|i| q::pos(points, i));
            if index.conflicts(ids, p) { return false; }
            index.extend([(ids, p)]);
        }
    }
    for (a, b, interval) in memberships {
        points.protect_curve_edge(a, b, interval);
    }
    out.extend(triangles);
    *retained_unresolved|=unresolved;
    true
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
    retained_unresolved: &mut bool,
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

    let mut previous = pin_a.point_id;
    for (span, &id) in
        interior.parameters.windows(2).zip(interior.points.iter().chain(std::iter::once(&pin_b.point_id)))
    {
        points.protect_curve_edge(
            previous,
            id,
            CurveInterval { curve_id: curve.id, start: span[0], end: span[1] },
        );
        previous = id;
    }

    // side1 = chain1 (A→…→B) closed by the polyline B→A (reversed interior);
    // side2 = chain2 (B→…→A) closed by the polyline A→B.
    let mut side1 = chain1.clone();
    side1.extend(interior.points.iter().rev().copied());
    let mut side2 = chain2.clone();
    side2.extend(interior.points.iter().copied());

    // Assign strata to sides by aggregate NORMAL-AGREEMENT margin over all non-pin
    // chain vertices. Score both assignments and take the better — never reject.
    let sa = &features.strata[curve.adjacent_strata[0]];
    let sb = &features.strata[curve.adjacent_strata[1]];
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
    // Keep modeled edge constraints in unsupported best-effort output. The
    // caller marks this cell failed and requests bounded refinement; replacing
    // these fans with an unconstrained loop would silently flatten the crease.
    let first=fan_from_stratum_vertex(&side1, &st1, cell_box, tree, points, opts, out_tris);
    let second=fan_from_stratum_vertex(&side2, &st2, cell_box, tree, points, opts, out_tris);
    *retained_unresolved|=!first||!second;
    true
}

struct SharedArc { curve:usize,nodes:Vec<usize>,parameters:Vec<f64> }

/// Keep one physical sampling of a supported seam, with each original chart's
/// ordered parameters. Chord fidelity remains a sampled obligation, as for the
/// existing traced-arc sampler; the source restriction checks are independent.
fn transport_shared_arc(
    source: &SharedArc,
    target: usize,
    target_nodes: &[usize],
    target_parameters: &[f64],
    points: &PointTable,
    features: &SfccFeatureSet,
    tolerance: f64,
) -> Option<(Vec<usize>, Vec<f64>)> {
    let a = &features.curves[source.curve];
    let b = &features.curves[target];
    if !super::feature_overlap::same_traced_endpoints(a, b) {
        return None;
    }
    let mut nodes = source.nodes.clone();
    if nodes.first() == target_nodes.last() && nodes.last() == target_nodes.first() {
        nodes.reverse();
    }
    if nodes.first() != target_nodes.first() || nodes.last() != target_nodes.last() {
        return None;
    }
    let (_, _, ar) = a.traced_carriers()?;
    let (_, _, br) = b.traced_carriers()?;
    let numerical = 8. * ar.curve_eps.max(br.curve_eps);
    if !numerical.is_finite() || numerical <= 0. || numerical > tolerance * 0.01 {
        return None;
    }
    let t0 = *target_parameters.first()?;
    let t1 = *target_parameters.last()?;
    let match_point = |curve: &FeatureCurve, p: [f64; 3], range: [f64; 2]| -> Option<f64> {
        let (t, d) = curve.project(p[0], p[1], p[2]);
        if !t.is_finite()
            || !d.is_finite()
            || d > numerical
            || t < range[0].min(range[1])
            || t > range[0].max(range[1])
        {
            return None;
        }
        let q = curve.point_at_checked(t)?;
        let lo = std::array::from_fn(|k| p[k].min(q[k]) - numerical);
        let hi = std::array::from_fn(|k| p[k].max(q[k]) + numerical);
        super::loft_seam::certify(features, source.curve, target, lo, hi)?;
        if curve
            .adjacent_strata
            .iter()
            .any(|&id| !features.strata[id].domain_contains(p, numerical))
        {
            return None;
        }
        Some(t)
    };
    let mut parameters = vec![t0];
    for &node in nodes.iter().skip(1).take(nodes.len() - 2) {
        parameters.push(match_point(b, q::pos(points, node), [t0, t1])?);
    }
    parameters.push(t1);
    if parameters
        .windows(2)
        .any(|p| (p[1] - p[0]) * (t1 - t0) <= 0.)
    {
        return None;
    }
    let distance = |p: [f64; 3]| {
        nodes
            .windows(2)
            .map(|v| {
                let a = q::pos(points, v[0]);
                let d = q::sub(q::pos(points, v[1]), a);
                let len = q::dot(d, d);
                let u = if len > 0. {
                    (q::dot(q::sub(p, a), d) / len).clamp(0., 1.)
                } else {
                    0.
                };
                q::norm(q::sub(p, std::array::from_fn(|k| a[k] + u * d[k])))
            })
            .fold(f64::INFINITY, f64::min)
    };
    let range = [source.parameters[0], *source.parameters.last()?];
    for span in target_parameters.windows(2) {
        for u in [0.25, 0.5, 0.75] {
            let p = b.point_at_checked(span[0] + u * (span[1] - span[0]))?;
            match_point(a, p, range)?;
            if distance(p) > tolerance * 0.5 {
                return None;
            }
        }
    }
    for &node in target_nodes.iter().skip(1).take(target_nodes.len() - 2) {
        let p = q::pos(points, node);
        match_point(a, p, range)?;
        if distance(p) > tolerance * 0.5 {
            return None;
        }
    }
    Some((nodes, parameters))
}

struct SampledArc {
    points: Vec<usize>,
    /// Includes both endpoints and retains the chosen unwrapped arc.
    parameters: Vec<f64>,
}

/// Remove only redundant interior samples of one ordered curve. Both endpoint
/// parameters remain fixed; an entirely unrepresentable open span is rejected.
fn coalesce_arc_samples(samples: &mut Vec<(f64, [f64; 3])>) -> bool {
    let mut i = 1;
    while i + 1 < samples.len() {
        if q::rounded(samples[i].1) == q::rounded(samples[i - 1].1)
            || q::rounded(samples[i].1) == q::rounded(samples[i + 1].1)
        {
            samples.remove(i);
        } else {
            i += 1;
        }
    }
    samples.len() > 2 || q::rounded(samples[0].1) != q::rounded(samples[1].1)
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
) -> Option<SampledArc> {
    let live = |p: [f64; 3]| {
        curve.adjacent_strata.iter().all(|&id| features.strata[id].domain_contains(p, opts.surface_tol))
    };
    let margin = (cell_box[3] - cell_box[0]) * 0.25;
    let delta: f64;
    if let (true, Some(wrap)) = (curve.closed, curve.param_wrap) {
        let fwd = ((t_b - t_a) % wrap + wrap) % wrap;
        let candidates = [fwd, fwd - wrap]; // the two arcs between the pins
        let mut chosen: Option<f64> = None;
        for d in candidates {
            let p = curve.point_at(t_a + d / 2.0);
            if in_box(cell_box, p[0], p[1], p[2], margin)
                && (chosen.is_none() || d.abs() < chosen.unwrap().abs())
            {
                chosen = Some(d);
            }
        }
        delta = chosen?;
    } else {
        delta = t_b - t_a;
    }
    // Reused endpoint vertices already carry the canonical pin/corner parameter.
    // An open arc must not replace t_b with the rounded cancellation t_a+(t_b-t_a).
    let end = if curve.closed && curve.param_wrap.is_some() {t_a+delta}else{t_b};
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
            if n > opts.max_polyline_points_per_cell {
                crate::sfcc::validation::chord_budget_exhausted();
                return None;
            }
        }
        CurveKind::Traced => {
            n = delta.abs().ceil().max(1.0) as usize;
            if n > opts.max_polyline_points_per_cell {
                crate::sfcc::validation::chord_budget_exhausted();
                return None;
            }
        }
        CurveKind::Segment => {}
    }
    // Traced curves have no analytic curvature bound. Subdivide until projected
    // midpoints meet the requested chord tolerance, or explicitly exhaust the cap.
    // This is a sampled check, not a bound on the continuous curve between samples.
    let params: Vec<f64> = if curve.kind() == CurveKind::Traced {
        // Integer parameters are the original adaptive trace knots. Uniform
        // resampling can straddle and erase a localized turn or inflection.
        let mut params = vec![t_a];
        params
            .extend(((t_a.min(end).floor() as i64 + 1)..=(t_a.max(end).ceil() as i64 - 1)).map(|k| k as f64));
        params.push(end);
        params.sort_by(|a, b| if delta >= 0. { a.total_cmp(b) } else { b.total_cmp(a) });
        params
    } else {
        (0..=n).map(|k| if k==0 {t_a}else if k==n {end}else{t_a + delta * k as f64 / n as f64}).collect()
    };
    if params.len() - 1 > opts.max_polyline_points_per_cell {
        crate::sfcc::validation::chord_budget_exhausted();
        return None;
    }
    let mut samples = Vec::with_capacity(params.len());
    for t in params {
        let p = match curve.point_at_checked(t) {
            Some(p) if in_box(cell_box, p[0], p[1], p[2], margin) && live(p) => p,
            _ => {
                crate::sfcc::validation::curve_projection_failed();
                return None;
            }
        };
        samples.push((t, p));
    }
    if curve.kind() == CurveKind::Traced {
        let mut i = 0;
        while i + 1 < samples.len() {
            let (ta, a) = samples[i];
            let (tb, b) = samples[i + 1];
            // A midpoint alone misses S-shaped spans. Check both quarters
            // as well, inserting the worst offending sample before retrying.
            let mut error = 0f64;
            let mut tm = ta;
            let mut m = a;
            for u in [0.25, 0.5, 0.75] {
                let t = ta + (tb - ta) * u;
                let p = match curve.point_at_checked(t) {
                    Some(p) if in_box(cell_box, p[0], p[1], p[2], margin) && live(p) => p,
                    _ => {
                        crate::sfcc::validation::curve_projection_failed();
                        return None;
                    }
                };
                let e = (0..3).map(|k| (p[k] - (a[k] * (1. - u) + b[k] * u)).powi(2)).sum::<f64>().sqrt();
                if e > error {
                    error = e;
                    tm = t;
                    m = p;
                }
            }
            // Sampled errors are estimates, unlike the circle's exact sagitta.
            // Reserve half the budget for extrema between these probes and
            // the small endpoint adjustments made when wiring junctions.
            if error > opts.curve_chord_tol * 0.5 {
                if samples.len() - 1 >= opts.max_polyline_points_per_cell || tm == ta || tm == tb {
                    crate::sfcc::validation::chord_budget_exhausted();
                    return None;
                }
                samples.insert(i + 1, (tm, m));
            } else {
                i += 1;
            }
        }
    }
    let original_samples = samples.len();
    if !coalesce_arc_samples(&mut samples) { return None; }
    if samples.len() != original_samples {
        // Recheck the combined traced intervals at the original chord budget.
        // A circle would need a new analytic sagitta allocation, so reject that
        // unsupported quantization case instead of borrowing a larger tolerance.
        if curve.kind() != CurveKind::Traced { return None; }
        for pair in samples.windows(2) {
            let [(ta,a),(tb,b)] = [pair[0],pair[1]];
            for u in [0.25,0.5,0.75] {
                let Some(p)=curve.point_at_checked(ta+u*(tb-ta)) else {
                    crate::sfcc::validation::curve_projection_failed();return None;
                };
                let chord=std::array::from_fn(|k|a[k]*(1.-u)+b[k]*u);
                if !live(p) || !in_box(cell_box,p[0],p[1],p[2],margin)
                    || q::norm(q::sub(p,chord)) > opts.curve_chord_tol*0.5 { return None; }
            }
        }
    }
    let sa = &features.strata[curve.adjacent_strata[0]];
    let sb = &features.strata[curve.adjacent_strata[1]];
    let mut ids: Vec<usize> = Vec::new();
    for &(_, p) in samples.iter().skip(1).take(samples.len() - 2) {
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
    Some(SampledArc { points: ids, parameters: samples.iter().map(|s| s.0).collect() })
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
) -> bool {
    if opts.quality_triangulation && super::surface_patch::supports_local_edits(stratum) {
        let candidate = super::surface_patch::disk_strict_or_coarse(
            points,
            boundary,
            tree,
            Some(stratum),
            opts.curve_chord_tol,
        );
        if let Ok(candidate) = candidate {
            for t in candidate.chunks_exact(3) {
                points.set_patch([t[0], t[1], t[2]], stratum.id);
            }
            out_tris.extend(candidate);
            return true;
        }
    }
    let start = out_tris.len();
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
    if !in_box(cell_box, px, py, pz, margin)
        || wrong_patch
        || tree.f([px, py, pz]).abs() > opts.surface_tol
    {
        let kb = best_fan_apex(points, boundary);
        for k in 1..m - 1 {
            out_tris.extend_from_slice(&[
                boundary[kb],
                boundary[(kb + k) % m],
                boundary[(kb + k + 1) % m],
            ]);
        }
        return repair_planar_fan(
            points,
            boundary,
            tree,
            stratum,
            opts.surface_tol,
            out_tris,
            start,
        );
    }
    let n = stratum.normal(px, py, pz);
    let c = points.add(px, py, pz, n[0], n[1], n[2]);
    for k in 0..m {
        out_tris.extend_from_slice(&[c, boundary[k], boundary[(k + 1) % m]]);
    }
    repair_planar_fan(
        points,
        boundary,
        tree,
        stratum,
        opts.surface_tol,
        out_tris,
        start,
    )
}

/// A projected average need not see every edge of a concave planar disk.
/// Only the free interior fan point is discarded; all model corners and feature
/// segments are immutable polygon boundary constraints of the strict fallback.
fn repair_planar_fan<T: SdfQuery + ?Sized>(
    points: &mut PointTable,
    boundary: &[usize],
    tree: &T,
    stratum: &Stratum,
    tolerance: f64,
    out: &mut Vec<usize>,
    start: usize,
) -> bool {
    if stratum.certificate_plane().is_none() {
        return true;
    }
    let embedded = |triangles: &[usize], points: &PointTable| {
        let mut index = super::mesh_edit::GrowingIndex::new();
        for t in triangles.chunks_exact(3) {
            let ids = [t[0], t[1], t[2]];
            let p = ids.map(|i| q::pos(points, i));
            if index.conflicts(ids, p) {
                return false;
            }
            index.extend([(ids, p)]);
        }
        true
    };
    // Boundary winding comes from shared face consumption. The selected
    // carrier can have the opposite supporting orientation at a CSG tie.
    let Ok(chart) = super::surface_patch::Chart::from_boundary(points, boundary) else {
        return false;
    };
    let normal = chart.normal;
    if out[start..]
        .chunks_exact(3)
        .all(|t| q::valid_orientation([t[0], t[1], t[2]].map(|i| q::pos(points, i)), normal))
        && embedded(&out[start..], points)
    {
        return true;
    }
    let Ok(candidate)=super::surface_patch::planar_boundary_disk(points, boundary, tree, stratum, tolerance) else {return false;};
    let key = |a: usize, b: usize| (a.min(b), a.max(b));
    let edges: std::collections::BTreeSet<_> = candidate
        .chunks_exact(3)
        .flat_map(|t| (0..3).map(move |k| key(t[k], t[(k + 1) % 3])))
        .collect();
    if !(0..boundary.len())
        .all(|k| edges.contains(&key(boundary[k], boundary[(k + 1) % boundary.len()])))
        || !embedded(&candidate, points)
    {
        return false;
    }
    out.truncate(start);
    // Curved trim chords need not lie in the exposed planar domain. The
    // displacement checks accept geometry, but do not assign carrier ownership.
    out.extend(candidate);
    true
}

#[cfg(test)]
mod reliability_tests {
    use super::*;
    use crate::sfcc::feature_curves::{make_circle_curve, make_traced_curve, TracedRefine};
    fn planar_fixture(polygon: &[[f64; 2]]) -> (CsgNode, Stratum, PointTable, Vec<usize>) {
        let tree = crate::sdf::leaf_at(
            crate::sdf::Shape::Extrude {
                verts: polygon.iter().flatten().copied().collect(),
                wind: crate::primitives::polygon2d::winding_sign(polygon),
                h: 1.,
                twist_rad: 0.,
            },
            [0.; 3],
        );
        let carrier = Stratum::plane(
            crate::strata::StratumIdentity {
                id: 0,
                owner_node_id: 0,
                leaf_index: 0,
                local_index: 0,
                sign: 1.,
            },
            0.,
            1.,
            0.,
            -1.,
        );
        let mut points = PointTable::new();
        for (i, &[x, z]) in polygon.iter().enumerate() {
            points.get_or_create_str(&format!("corner:{i}"), || [x, 1., z, 0., 1., 0.]);
        }
        let boundary: Vec<_> = (0..polygon.len()).collect();
        for i in 0..polygon.len() {
            points.protect_curve_edge(
                i,
                (i + 1) % polygon.len(),
                CurveInterval {
                    curve_id: i,
                    start: 0.,
                    end: 1.,
                },
            );
        }
        (tree, carrier, points, boundary)
    }
    fn assert_planar_constraints(points: &PointTable, boundary: &[usize], triangles: &[usize]) {
        let ids: Vec<_> = triangles
            .chunks_exact(3)
            .map(|t| [t[0], t[1], t[2]])
            .collect();
        for (i, &t) in ids.iter().enumerate() {
            let p = t.map(|v| q::pos(points, v));
            assert!(q::valid_orientation(p, [0., 1., 0.]));
            for &other in &ids[..i] {
                assert!(!super::super::mesh_edit::intersects_both(
                    p,
                    other.map(|v| q::pos(points, v)),
                    t,
                    other
                ));
            }
        }
        let edges: std::collections::BTreeSet<_> = ids
            .iter()
            .flat_map(|t| (0..3).map(move |k| (t[k].min(t[(k + 1) % 3]), t[k].max(t[(k + 1) % 3]))))
            .collect();
        for (i, &a) in boundary.iter().enumerate() {
            let b = boundary[(i + 1) % boundary.len()];
            assert!(edges.contains(&(a.min(b), a.max(b))));
            assert_eq!(
                points.curve_intervals(a, b),
                vec![CurveInterval {
                    curve_id: i,
                    start: 0.,
                    end: 1.
                }]
            );
        }
    }
    #[test]
    fn concave_planar_projection_fan_keeps_every_corner_and_boundary_segment() {
        let polygon = [
            [0., 0.],
            [0., 3.],
            [1., 3.],
            [1., 1.],
            [3., 1.],
            [3., 0.],
            [2.5, 0.],
            [2., 0.],
            [1.5, 0.],
            [1., 0.],
        ];
        let (tree, carrier, mut points, boundary) = planar_fixture(&polygon);
        let opts = CellMeshOptions {
            surface_tol: 0.01,
            interior_vertex_mode: InteriorVertexMode::Project,
            quality_triangulation: false,
            project_max_iters: 16,
            curve_chord_tol: 0.02,
            max_polyline_points_per_cell: 64,
            features: None,
        };
        let mut triangles = vec![];
        assert!(fan_from_stratum_vertex(
            &boundary,
            &carrier,
            &[-1., -1., -1., 4., 4., 4.],
            &tree,
            &mut points,
            &opts,
            &mut triangles
        ));
        assert_eq!(triangles.len() / 3, boundary.len() - 2);
        assert_planar_constraints(&points, &boundary, &triangles);
    }
    #[test]
    fn planar_collinear_fan_is_retriangulated_without_erasing_its_feature_vertex() {
        let (tree, carrier, mut points, boundary) =
            planar_fixture(&[[0., 0.], [0., 1.], [0., 2.], [2., 2.], [2., 0.]]);
        let mut triangles = vec![0, 1, 2, 0, 2, 3, 0, 3, 4];
        assert!(repair_planar_fan(
            &mut points,
            &boundary,
            &tree,
            &carrier,
            0.01,
            &mut triangles,
            0
        ));
        assert_planar_constraints(&points, &boundary, &triangles);
        let original = vec![0, 1, 2];
        let mut unsupported = original.clone();
        assert!(!repair_planar_fan(
            &mut points,
            &[0, 1, 2],
            &tree,
            &carrier,
            0.01,
            &mut unsupported,
            0
        ));
        assert_eq!(unsupported, original);
    }

    #[test]
    fn quantized_arc_keeps_end_parameters_and_tiny_representable_turns() {
        let mut samples = vec![
            (0., [1., 0., 0.]),
            (1., [1. + f64::EPSILON, 0., 0.]),
            (2., [2., 0., 0.]),
        ];
        assert!(coalesce_arc_samples(&mut samples));
        assert_eq!(samples, vec![(0., [1., 0., 0.]), (2., [2., 0., 0.])]);
        let mut tiny = vec![
            (0., [1., 0., 0.]),
            (1., [1., f32::from_bits(1) as f64, 0.]),
            (2., [2., 0., 0.]),
        ];
        assert!(coalesce_arc_samples(&mut tiny));
        assert_eq!(tiny.len(), 3);
        let mut collapsed = vec![(0., [1., 0., 0.]), (1., [1. + f64::EPSILON, 0., 0.])];
        assert!(!coalesce_arc_samples(&mut collapsed));
        assert_eq!(collapsed.len(), 2);
    }


    #[test]
    fn interior_face_cycle_is_shared_oppositely_across_coarse_fine_cells() {
        let lat = crate::math::grid::make_lattice(2, 0., 0., 0., 4.);
        let key = pack_point(&lat, 0, 2, 0);
        let record = FaceRecord { axis: 1, key, len: 1,
            segments: vec![super::super::face_contour::FaceSegment { a: 0, b: 1 },
                super::super::face_contour::FaceSegment { a: 1, b: 2 },
                super::super::face_contour::FaceSegment { a: 2, b: 0 }],
            pins: vec![], interior_cycle: true, consumed_fwd: vec![0;3], consumed_rev: vec![0;3] };
        let mut faces: [HashMap<i64,FaceRecord>;3] = std::array::from_fn(|_| HashMap::new());
        faces[1].insert(key,record);
        let coarse = SfccCell { level: 1, ix: 0, iy: 0, iz: 0, key: 0, degenerate: false, feature_curve: -1, feature_corner: -1 };
        let fine = SfccCell { level: 2, ix: 0, iy: 2, iz: 0, key, ..coarse };
        let (mut a, mut b) = (Vec::new(), Vec::new());
        gather_segments(&faces, &lat, &coarse, &mut a, &mut Vec::new());
        gather_segments(&faces, &lat, &fine, &mut b, &mut Vec::new());
        assert_eq!(a.len(),3); assert_eq!(b.len(),3);
        for (a,b) in a.iter().zip(&b) {
            assert_eq!((a.a,a.b),(b.b,b.a));
            assert_eq!(a.face,b.face);
            assert_ne!(a.reversed,b.reversed);
        }
    }

    #[test]
    fn visible_tagged_corner_without_contours_requests_refinement() {
        let tree = crate::sdf::leaf_at(crate::sdf::Shape::Cuboid { half: [0.25; 3] }, [0.; 3]);
        let features = crate::sfcc::feature_set::compile_native_features(&tree);
        let lat = crate::math::grid::make_lattice(1, -1., -1., -1., 2.);
        let cell = SfccCell { level: 0, ix: 0, iy: 0, iz: 0, key: 0, degenerate: false,
            feature_curve: -1, feature_corner: 0 };
        let oct = crate::sfcc::octree::rebuild_octree_from_leaves(&tree, &lat, vec![cell]);
        let opts = CellMeshOptions { surface_tol: 0.01, interior_vertex_mode: InteriorVertexMode::Project,
            quality_triangulation: false, project_max_iters: 16, curve_chord_tol: 0.02,
            max_polyline_points_per_cell: 16, features: Some(&features) };
        let result = mesh_cells_subset(&oct, &mut std::array::from_fn(|_| HashMap::new()), &tree,
            &mut PointTable::new(), &opts, &[cell]);
        assert_eq!(result.failed_cells.len(), 1);
        assert!(result.tris.is_empty());
    }

    #[test]
    fn unsupported_constrained_fan_retains_crease_and_propagates_unresolved_cell() {
        use super::super::face_contour::FaceSegment;
        let tree = crate::sdf::leaf_at(crate::sdf::Shape::Cuboid { half: [1.; 3] }, [0.; 3]);
        let features = crate::sfcc::feature_set::compile_native_features(&tree);
        let curve = features
            .curves
            .iter()
            .find(|c| {
                c.axis_plane_crossings(0, -0.5)
                    .iter()
                    .any(|p| p.y == 1. && p.z == 1.)
            })
            .unwrap();
        let lat = crate::math::grid::make_lattice(1, -0.5, 0.5, 0.5, 2.);
        let cell = SfccCell {
            level: 1,
            ix: 0,
            iy: 0,
            iz: 0,
            key: 0,
            degenerate: false,
            feature_curve: curve.id as i64,
            feature_corner: -1,
        };
        let oct = crate::sfcc::octree::rebuild_octree_from_leaves(&tree, &lat, vec![cell]);
        let mut points = PointTable::new();
        // Two distinct shared-face pin identities round to the same position.
        // The old constrained fan is malformed; dropping its real box edge is
        // not an acceptable substitute for reporting that unresolved filling.
        for (p, n) in [
            ([-0.5, 1., 1.], [0., 1., 1.]),
            ([-0.5, 1., 1.], [0., 1., 1.]),
            ([-0.5, 1., 0.5], [0., 1., 0.]),
            ([0.5, 1., 0.5], [0., 1., 0.]),
            ([0.5, 1., 1.], [0., 1., 1.]),
            ([0.5, 0.5, 1.], [0., 0., 1.]),
            ([-0.5, 0.5, 1.], [0., 0., 1.]),
        ] {
            points.add(p[0], p[1], p[2], n[0], n[1], n[2]);
        }
        let mut faces: [HashMap<i64, FaceRecord>; 3] = std::array::from_fn(|_| HashMap::new());
        for (axis, g, edges, pin) in [
            (0, [0, 0, 0], vec![(0, 1), (1, 2), (6, 0)], Some(0)),
            (0, [1, 0, 0], vec![(4, 3), (5, 4)], Some(4)),
            (2, [0, 0, 0], vec![(2, 3)], None),
            (1, [0, 0, 0], vec![(5, 6)], None),
        ] {
            let key = pack_point(&lat, g[0], g[1], g[2]);
            let count = edges.len();
            let pins = pin
                .map(|id| {
                    let p = q::pos(&points, id);
                    let (t, _) = curve.project(p[0], p[1], p[2]);
                    FacePin {
                        point_id: id,
                        curve_id: curve.id,
                        t,
                    }
                })
                .into_iter()
                .collect();
            faces[axis].insert(
                key,
                FaceRecord {
                    axis,
                    key,
                    len: 1,
                    segments: edges
                        .into_iter()
                        .map(|(a, b)| FaceSegment { a, b })
                        .collect(),
                    pins,
                    interior_cycle: false,
                    consumed_fwd: vec![0; count],
                    consumed_rev: vec![0; count],
                },
            );
        }
        let opts = CellMeshOptions {
            surface_tol: 0.01,
            interior_vertex_mode: InteriorVertexMode::Project,
            quality_triangulation: false,
            project_max_iters: 16,
            curve_chord_tol: 0.02,
            max_polyline_points_per_cell: 16,
            features: Some(&features),
        };
        let result = mesh_cells_subset(&oct, &mut faces, &tree, &mut points, &opts, &[cell]);
        assert!(!result.tris.is_empty());
        assert_eq!(result.failed_cells.len(), 1);
        assert!(result.fallback_cells.is_empty());
        assert_eq!(result.feature_cell_fallbacks, 1);
        assert!(points.edge_is_protected(0, 4));
        assert!(result
            .tris
            .chunks_exact(3)
            .any(|t| t.contains(&0) && t.contains(&4)));
        let report = super::super::local_coverage::report(&tree, &points);
        assert_eq!(report.certified_cells, 0);
        assert!(report
            .unresolved
            .iter()
            .any(|(_, reason)| reason == "constrained_fan_unresolved"));
    }

    #[test]
    fn modeled_feature_paths_connect_two_boundary_loops_without_caps() {
        let polygon = [[-0.4, -0.3], [0.4, -0.3], [0., 0.4]];
        let tree = crate::sdf::leaf_at(crate::sdf::Shape::Extrude {
            verts: polygon.into_iter().flatten().collect(),
            wind: crate::primitives::polygon2d::winding_sign(&polygon), h: 2., twist_rad: 0.,
        }, [0.; 3]);
        let features = crate::sfcc::feature_set::compile_native_features(&tree);
        let mut points = PointTable::new();
        let mut pins = Vec::new();
        for y in [-0.5, 0.5] {
            for [x, z] in polygon {
                let (curve_id, t) = features.curves.iter().find_map(|c|
                    c.axis_plane_crossings(1, y).iter().find(|p| (p.x-x).hypot(p.z-z) < 1e-10).map(|p| (c.id,p.t))).unwrap();
                let [a,b] = features.curves[curve_id].adjacent_strata.map(|s| features.strata[s].normal(x,y,z));
                let n: [f64;3] = std::array::from_fn(|k| a[k]+b[k]);
                let id = points.add(x, y, z, n[0], n[1], n[2]);
                pins.push(FacePin { point_id: id, curve_id, t });
            }
        }
        let loops = vec![vec![2, 1, 0], vec![3, 4, 5]];
        let opts = CellMeshOptions { surface_tol: 0.01, interior_vertex_mode: InteriorVertexMode::Project,
            quality_triangulation: false, project_max_iters: 16, curve_chord_tol: 0.02,
            max_polyline_points_per_cell: 16, features: Some(&features) };
        let mut triangles = Vec::new();
        assert!(mesh_feature_graph(&loops, &pins, &[], &[-1., -0.5, -1., 1., 0.5, 1.],
            &tree, &mut points, &opts, &features, &mut triangles, &mut false));
        assert!(!triangles.is_empty());
        for tri in triangles.chunks_exact(3) {
            // A cap would contain only one Y coordinate and lie inside the solid.
            assert!(tri.iter().any(|&i| points.y(i) != points.y(tri[0])));
        }
        let mut disconnected_pins = pins.clone();
        disconnected_pins.retain(|p| p.point_id < 3);
        assert!(!mesh_feature_graph(&loops, &disconnected_pins, &[], &[-1., -0.5, -1., 1., 0.5, 1.],
            &tree, &mut points, &opts, &features, &mut Vec::new(), &mut false));
    }
    use crate::sfcc::spatial_index::SfccSpatialIndex;
    use crate::sfcc::validation::{numerical_failures, NumericalGuard};
    use crate::strata::StratumIdentity;
    fn ident(id: usize) -> StratumIdentity {
        StratumIdentity { id, owner_node_id: -1, leaf_index: 0, local_index: id, sign: 1. }
    }
    #[test]
    fn quad_prefers_a_valid_diagonal_without_requiring_every_patch_to_be_a_chart() {
        let tree = crate::sdf::leaf_at(crate::sdf::Shape::Sphere { r: 1. }, [0.; 3]);
        let opts = CellMeshOptions {
            surface_tol: 0.01,
            interior_vertex_mode: InteriorVertexMode::Project,
            quality_triangulation: false,
            project_max_iters: 16,
            curve_chord_tol: 0.01,
            max_polyline_points_per_cell: 16,
            features: None,
        };
        for (positions, normal) in [
            // The shorter 1-3 diagonal cuts off an inward +X cap on the X face.
            ([[0., 0., 0.], [0., 1./8., -1.], [1., 0., -1.], [0., -1./64., 1./4.]], [-1., -1., -1.]),
            // Two valid orthogonal faces have no disk in the chosen axis chart.
            // Keeping the shorter 0-2 diagonal is correct for this 3D patch.
            ([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]], [1., 0., 1.]),
        ] {
            let mut points = PointTable::new();
            for [x, y, z] in positions {
                points.add(x, y, z, 0., 0., 1.);
            }
            let mut tris = Vec::new();
            triangulate_loop(&[0, 1, 2, 3], &tree, &mut points, &[-2., -2., -2., 2., 2., 2.], &opts, &mut tris);
            assert_eq!(tris.len(), 6);
            for t in tris.chunks_exact(3) {
                let p = [t[0], t[1], t[2]].map(|i| q::pos(&points, i));
                assert!(q::dot(q::normal(p), normal) > 0., "inward cap: {p:?}");
            }
        }
    }
    #[test]
    fn open_arc_retains_the_canonical_endpoint_parameter() {
        let a=Stratum::plane(ident(0),0.,1.,0.,0.);
        let b=Stratum::plane(ident(1),0.,0.,1.,0.);
        let features=SfccFeatureSet {unresolved_branch_paths:Vec::new(),trace_diagnostics:Default::default(),
            strata:vec![a,b],curves:Vec::new(),corners:Vec::new(),index:SfccSpatialIndex::new(1.),run_id:0};
        let opts=CellMeshOptions {surface_tol:0.01,interior_vertex_mode:InteriorVertexMode::Project,quality_triangulation:false,
            project_max_iters:8,curve_chord_tol:0.02,max_polyline_points_per_cell:16,features:Some(&features)};
        let curve=super::super::feature_curves::make_segment_curve(0,-1,[0,1],0.,0.,0.,1.,0.,0.);
        let end=2_f64.powi(-54);assert_ne!(1.+(end-1.),end);
        let arc=sample_in_cell_arc(&curve,1.,end,&[-2.,-2.,-2.,2.,2.,2.],&mut PointTable::new(),&features,&opts).unwrap();
        assert_eq!(arc.parameters.last().unwrap().to_bits(),end.to_bits());
    }
    #[test]
    fn circle_cap_and_traced_midpoint_error_are_enforced() {
        let _scope = NumericalGuard::new();
        let sphere = Stratum::sphere(ident(0), 0., 0., 0., 1.);
        let plane = Stratum::plane(ident(1), 0., 0., 1., 0.);
        let features = SfccFeatureSet {
            unresolved_branch_paths: Vec::new(),
            trace_diagnostics: Default::default(),
            strata: vec![sphere.clone(), plane.clone()],
            curves: vec![],
            corners: vec![],
            index: SfccSpatialIndex::new(1.),
            run_id: 0,
        };
        let mut opts = CellMeshOptions {
            surface_tol: 0.01,
            interior_vertex_mode: InteriorVertexMode::Project,
            quality_triangulation: false,
            project_max_iters: 16,
            curve_chord_tol: 0.01,
            max_polyline_points_per_cell: 1,
            features: Some(&features),
        };
        let circle = make_circle_curve(
            0,
            -1,
            [0, 1],
            0.,
            0.,
            0.,
            0.,
            0.,
            1.,
            1.,
            Some((0., std::f64::consts::FRAC_PI_2)),
        );
        let bounds = [-2., -2., -2., 2., 2., 2.];
        let mut points = PointTable::new();
        assert!(sample_in_cell_arc(
            &circle,
            0.,
            std::f64::consts::FRAC_PI_2,
            &bounds,
            &mut points,
            &features,
            &opts
        )
        .is_none());
        assert_eq!(numerical_failures().chord_budget, 1);
        let traced = make_traced_curve(
            0,
            [0, 1],
            vec![1., 0., 0., 0., 1., 0.],
            false,
            sphere.clone(),
            plane,
            TracedRefine { curve_eps: 1e-12, min_cross: 1e-3, max_displacement: 1. },
            -1,
        );
        opts.max_polyline_points_per_cell = 64;
        let ids = sample_in_cell_arc(&traced, 0., 1., &bounds, &mut points, &features, &opts).unwrap();
        assert!(ids.points.len() > 1, "two tracer samples alone do not meet the chord tolerance");
        let mut poly = vec![[1., 0., 0.]];
        poly.extend(ids.points.iter().map(|&id| [points.x(id), points.y(id), points.z(id)]));
        poly.push([0., 1., 0.]);
        for edge in poly.windows(2) {
            let m = [(edge[0][0] + edge[1][0]) * 0.5, (edge[0][1] + edge[1][1]) * 0.5, 0.];
            assert!(sphere.f(m[0], m[1], m[2]).abs() <= opts.curve_chord_tol);
        }
        assert_eq!(numerical_failures().curve_projection, 0);
    }
}
