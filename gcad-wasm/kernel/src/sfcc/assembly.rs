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
    let mut ordered = points.ordered_triangles(tris);
    super::feature_overlap::complete(points, &mut ordered, features);
    let arrangement_metadata = super::box_arrangement::MetadataSnapshot::capture(points, &ordered);
    let deduped = drop_coincident_triangle_pairs(&ordered);
    let filtered = drop_debris_components(points, &deduped, step * 4., features, step * 2., 600);
    let mut tris = drop_coincident_triangle_pairs(&filtered);
    if !tuning.quality_triangulation
        && !tuning.quality_refinement
        && !tuning.quality_remeshing
        && !tuning.quality_audit
    {
        let (flipped, _, transport) = super::local_coverage::flip_with_transport(points, &tris, 4);
        let (tris, unresolved) = super::surface_refine::refine_surface(
            tree,
            features,
            points,
            &flipped,
            tuning.surface_tol_mm,
            tuning.curve_chord_tol_mm,
        );
        super::local_coverage::finish_with_transport(points, &ordered, &tris, transport.as_ref());
        if let Some(snapshot) = arrangement_metadata {
            snapshot.verify(points, &tris);
        }
        #[cfg(feature="sfcc-profile")]
        super::diagnosis::assembled(points,&tris);
        return (tris, unresolved, None);
    }
    let mut audit = QualityAudit::default();
    let mut flip_transport = None;
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
        let (out, n, transport) = super::local_coverage::flip_with_transport(points, &tris, 4);
        flip_transport = transport;
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
        tuning.surface_tol_mm,
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
            if j < i && super::mesh_edit::intersects_both(p, geo[j], ids[i], ids[j]) {
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
    super::local_coverage::finish_with_transport(points, &ordered, &tris, flip_transport.as_ref());
    if let Some(snapshot) = arrangement_metadata {
        snapshot.verify(points, &tris);
    }
    #[cfg(feature="sfcc-profile")]
    super::diagnosis::assembled(points,&tris);
    (tris, unresolved, Some(audit))
}

#[cfg(all(test, feature = "serde"))]
mod surface_budget_tests {
    use super::*;
    use crate::scene_bridge::build_csg_tree_from_json;
    use crate::sfcc::feature_set::compile_native_features;
    use std::collections::BTreeMap;

    fn housing_patch() -> (CsgNode, SfccFeatureSet, PointTable, Vec<usize>) {
        // The complete transformed Manim housing remains the field context.
        // Only the selected triangle pair is reduced for this construction test.
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/housing-main-bore-gpu.json"
        )).unwrap();
        let tree = build_csg_tree_from_json(fixture["sceneJson"].as_str().unwrap()).unwrap();
        let features = compile_native_features(&tree);
        let mut points = PointTable::new();
        for value in fixture["patchPositions"].as_array().unwrap() {
            let p = std::array::from_fn(|k| value[k].as_f64().unwrap());
            let (_, n) = tree.grad(p);
            points.add(p[0], p[1], p[2], n[0], n[1], n[2]);
        }
        let tris = fixture["patchTriangles"].as_array().unwrap().iter()
            .flat_map(|t| t.as_array().unwrap().iter().map(|i| i.as_u64().unwrap() as usize)).collect();
        (tree, features, points, tris)
    }

    fn worst_sampled_field(tree: &CsgNode, points: &PointTable, tris: &[usize]) -> f64 {
        tris.chunks_exact(3).flat_map(|t| {
            let p = std::array::from_fn(|k| q::pos(points, t[k]));
            [p, p.map(q::rounded)].into_iter().flat_map(|p| q::SAMPLES.map(|w| tree.f(q::bary(p, w)).abs()))
        }).fold(0., f64::max)
    }

    #[test]
    fn housing_bore_assembly_uses_surface_budget_not_looser_feature_budget() {
        for quality_audit in [false, true] {
            let (tree, features, mut points, tris) = housing_patch();
            let before = worst_sampled_field(&tree, &points, &tris);
            assert!(before > 0.01 && before < 0.02 * 0.75, "counterexample misses surface budget but escapes old trigger: {before}");
            let tuning = PipelineTuning { quality_audit, ..Default::default() };
            let (after, unresolved, audit) = finish(&tree, &features, &mut points, &tris, 0.191015625, &tuning, None);
            assert_eq!(unresolved, 0);
            assert_eq!(audit.is_some(), quality_audit);
            assert!(after.len() > tris.len());
            assert!(worst_sampled_field(&tree, &points, &after) <= tuning.surface_tol_mm);
            let mut incidence = BTreeMap::new();
            let mut vertices = std::collections::BTreeSet::new();
            for t in after.chunks_exact(3) {
                let p = std::array::from_fn(|k| q::pos(&points, t[k]));
                assert!(q::valid_orientation(p, tree.grad(q::bary(p, [1. / 3.; 3])).1), "refinement must preserve outward orientation and f32 validity");
                for k in 0..3 {
                    vertices.insert(t[k]);
                    *incidence.entry((t[k].min(t[(k + 1) % 3]), t[k].max(t[(k + 1) % 3]))).or_insert(0) += 1;
                }
            }
            assert!(incidence.values().all(|&n| n == 1 || n == 2));
            assert_eq!(vertices.len() + after.len() / 3, incidence.len() + 1, "the reduced patch remains a conforming disk");
        }
    }

    #[test]
    fn unidentified_protected_housing_edges_remain_unresolved_without_inventing_a_curve() {
        let (tree, features, mut points, input) = housing_patch();
        for t in input.chunks_exact(3) {
            for k in 0..3 { points.protect_edge(t[k], t[(k + 1) % 3]); }
        }
        let (tris, unresolved) = super::super::surface_refine::refine_surface(
            &tree, &features, &mut points, &input, 0.01, 0.02,
        );
        assert_eq!(tris, input, "refinement cannot invent an unidentified protected edge's curve");
        assert_eq!(points.count(), 4);
        assert_eq!(unresolved, 2, "both existing surface-budget failures remain explicit");
    }

    #[test]
    fn tighter_feature_setting_is_not_weakened_by_separate_surface_budget() {
        let (tree, features, mut points, tris) = housing_patch();
        let tuning = PipelineTuning { surface_tol_mm: 0.01, curve_chord_tol_mm: 0.005, ..Default::default() };
        let (after, unresolved, _) = finish(&tree, &features, &mut points, &tris, 0.191015625, &tuning, None);
        assert_eq!(unresolved, 0);
        assert!(worst_sampled_field(&tree, &points, &after) <= tuning.curve_chord_tol_mm);
    }

    #[test]
    fn equal_surface_and_feature_budgets_preserve_the_old_refinement_choice() {
        let (tree, features, mut points, tris) = housing_patch();
        let tuning = PipelineTuning { surface_tol_mm: 0.02, curve_chord_tol_mm: 0.02, ..Default::default() };
        let (after, unresolved, _) = finish(&tree, &features, &mut points, &tris, 0.191015625, &tuning, None);
        assert_eq!(unresolved, 0);
        assert_eq!(after.len(), tris.len(), "this control remains below the unchanged 0.015 trigger");
    }

    #[test]
    fn captured_housing_penetration_is_not_shared_vertex_contact() {
        let a = [
            [-5.252085208892822, -7.385986328125, 12.596956253051758],
            [-5.223132610321045, -7.399999618530273, 12.55765438079834],
            [-5.231285095214844, -7.399999618530273, 12.562357902526855],
        ];
        let b = [
            [-5.250438690185547, -7.387378215789795, 12.57392692565918],
            [-5.224705219268799, -7.393144607543945, 12.552962303161621],
            [-5.22788667678833, -7.399999618530273, 12.580302238464355],
        ];
        assert!(q::valid_orientation(a, q::normal(a)));
        assert!(q::valid_orientation(b, q::normal(b)));
        assert!(super::super::mesh_edit::intersects_both(a, b, [0, 1, 2], [3, 4, 5]));
    }

    #[test]
    fn full_housing_negative_base_region_preserves_embedding() {
        use crate::sfcc::pipeline::{run_sfcc_pipeline, SfccWorldCube};
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/housing-main-bore-gpu.json"
        )).unwrap();
        let tree = build_csg_tree_from_json(fixture["sceneJson"].as_str().unwrap()).unwrap();
        let min: [f64; 3] = std::array::from_fn(|k| fixture["cube"]["min"][k].as_f64().unwrap());
        let max_x = fixture["cube"]["max"][0].as_f64().unwrap();
        let result = run_sfcc_pipeline(&tree, &SfccWorldCube {
            min_x: min[0], min_y: min[1], min_z: min[2], size: max_x - min[0],
        }, &PipelineTuning::default());
        assert_eq!(result.validation.invalid_triangles, 0);
        let ids: Vec<[usize; 3]> = result.tris.chunks_exact(3)
            .map(|t| [t[0] as usize, t[1] as usize, t[2] as usize]).collect();
        let geometry: Vec<[[f64; 3]; 3]> = ids.iter().map(|t| t.map(|i|
            std::array::from_fn(|k| result.verts[i * 8 + k] as f64))).collect();
        let index = super::super::mesh_edit::TriangleIndex::new(&geometry);
        let lo = [-5.3, -7.45, 12.4];
        let hi = [-5.0, -7.3, 12.7];
        let mut selected = 0;
        let mut pairs = std::collections::BTreeSet::new();
        for (i, &p) in geometry.iter().enumerate() {
            if !(0..3).all(|axis| p.iter().any(|v| v[axis] <= hi[axis])
                && p.iter().any(|v| v[axis] >= lo[axis])) { continue; }
            selected += 1;
            for j in index.query(p) {
                if j != i && super::super::mesh_edit::intersects(p, geometry[j], ids[i], ids[j]) {
                    pairs.insert((i.min(j), i.max(j)));
                }
            }
        }
        assert!(selected > 0, "the complete housing must exercise this region");
        assert!(pairs.is_empty(), "new negative-side base intersections in full housing: {pairs:?}");
    }
}
