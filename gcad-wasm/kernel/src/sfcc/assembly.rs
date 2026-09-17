//! The only post-assembly sequence, shared by serial and worker merges. The
//! face-segment audit describes input assembly; quality.audit checks final
//! triangles independently after global connectivity edits.
use super::{
    feature_set::SfccFeatureSet,
    pipeline::{drop_coincident_triangle_pairs, drop_debris_components, PipelineTuning},
    point_table::PointTable,
    triangle_quality as q,
    validation::QualityAudit,
};
use crate::sdf::CsgNode;
pub(crate) fn finish(
    tree: &CsgNode,
    features: &SfccFeatureSet,
    points: &mut PointTable,
    tris: &[usize],
    step: f64,
    tuning: &PipelineTuning,
    progress: Option<&dyn Fn(&str)>,
) -> (Vec<usize>, usize, Option<QualityAudit>) {
    let emit = |label: &str| {
        if let Some(progress) = progress {
            progress(label);
        }
    };
    let ordered = points.ordered_triangles(tris);
    let deduped = drop_coincident_triangle_pairs(&ordered);
    let filtered = drop_debris_components(points, &deduped, step * 4., features, step * 2., 600);
    let mut tris = drop_coincident_triangle_pairs(&filtered);
    if !tuning.quality_triangulation
        && !tuning.quality_refinement
        && !tuning.quality_remeshing
        && !tuning.quality_audit
    {
        let (flipped, _) = super::sliver_flip::flip_sliver_triangles(points, &tris, 4);
        let (tris, unresolved) = super::surface_refine::refine_surface(
            tree,
            features,
            points,
            &flipped,
            tuning.curve_chord_tol_mm,
        );
        return (tris, unresolved, None);
    }
    let mut audit = QualityAudit::default();
    let before = q::measure(points, &tris);
    audit.before_triangles = before.triangles;
    audit.before_slivers = before.slivers;
    audit.before_p5_angle = before.p5_angle;
    if tuning.quality_triangulation {
        emit("Optimizing patch diagonals");
        let (out, r) = super::quality_remesh::flips(
            tree,
            features,
            points,
            &tris,
            tuning.curve_chord_tol_mm,
            4,
        );
        tris = out;
        audit.flips += r.flips;
        audit.rejected += r.rejected;
        audit.cancelled |= r.cancelled;
    }
    if tuning.quality_audit
        && !tuning.quality_triangulation
        && !tuning.quality_refinement
        && !tuning.quality_remeshing
    {
        let (out, n) = super::sliver_flip::flip_sliver_triangles(points, &tris, 4);
        tris = out;
        audit.flips = n;
    }
    // Retain the established blend fallback for triangles whose general field
    // ownership is not yet supported by analytical edits. Recorded patch IDs
    // survive these conforming splits as well.
    let (out, legacy_unresolved) = super::surface_refine::refine_surface(
        tree,
        features,
        points,
        &tris,
        tuning.curve_chord_tol_mm,
    );
    tris = out;
    let unresolved;
    if tuning.quality_triangulation || tuning.quality_refinement || tuning.quality_remeshing {
        emit("Refining analytical patches");
        let budget = (tris.len() / 3).clamp(10_000, 100_000);
        let (out, r) = super::adaptive_refine::refine(
            tree,
            features,
            points,
            &tris,
            tuning.curve_chord_tol_mm,
            budget,
        );
        tris = out;
        audit.inserted = r.inserted;
        audit.edge_splits = r.edge_splits;
        audit.interior_splits = r.interior_splits;
        audit.rejected += r.rejected;
        audit.cancelled |= r.cancelled;
        unresolved = legacy_unresolved.max(r.unresolved);
    } else {
        unresolved = legacy_unresolved;
    }
    if tuning.quality_remeshing {
        emit("Remeshing analytical patches");
        let (out, r) = super::quality_remesh::remesh(
            tree,
            features,
            points,
            &tris,
            tuning.curve_chord_tol_mm,
            tuning.quality_max_edit_trials,
        );
        tris = out;
        audit.flips += r.flips;
        audit.collapses = r.collapses;
        audit.relocations = r.relocations;
        audit.work_budget_exhausted = r.work_budget_exhausted;
        audit.rejected += r.rejected;
        audit.cancelled |= r.cancelled;
    }
    emit("Auditing final triangle geometry");
    let after = q::measure(points, &tris);
    audit.after_triangles = after.triangles;
    audit.after_slivers = after.slivers;
    audit.after_p5_angle = after.p5_angle;
    // Full final connectivity and embedding are separate from the historic
    // input face-consumption record. Inspect f64 and exported f32 geometry.
    let ids: Vec<[usize; 3]> = tris.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
    let geo: Vec<_> = ids.iter().map(|t| t.map(|i| q::pos(points, i))).collect();
    let index = super::mesh_edit::TriangleIndex::new(&geo);
    for (i, &p) in geo.iter().enumerate() {
        if i % 128 == 0 && super::cancel::is_cancelled() {
            audit.cancelled = true;
            break;
        }
        if points.patch(ids[i]).is_none() {
            audit.unknown_triangles += 1;
        }
        if !q::valid_orientation(p, q::normal(p))
            || q::deviation(tree, p.map(q::rounded), tuning.curve_chord_tol_mm).is_err()
        {
            audit.geometry_failures += 1;
        }
        for j in index.query(p) {
            if j < i
                && super::mesh_edit::intersects_both(p, geo[j], ids[i], ids[j])
            {
                audit.intersections += 1;
            }
        }
    }
    let unresolved =
        if tuning.quality_triangulation || tuning.quality_refinement || tuning.quality_remeshing {
            audit.geometry_failures
        } else {
            unresolved
        };
    (tris, unresolved, Some(audit))
}
