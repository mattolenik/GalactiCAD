#![cfg(feature = "serde")]
use gcad_kernel::{
    scene_bridge::build_csg_tree_from_json,
    sfcc::{
        pipeline::{
            run_sfcc_pipeline, run_sfcc_pipeline_separate_partitioned_morton, PipelineTuning,
            SfccWorldCube,
        },
        worker::{build_octree_resumable_inprocess, merge, mesh_partition, prepare},
    },
};
use serde_json::{json, Value};
fn box_at(pos: [f64; 3], half: [f64; 3]) -> Value {
    json!({"kind":"box","pos":pos,"half":half})
}
fn sheets() -> Value {
    json!({"kind":"union","children":[box_at([-1.875,0.,0.],[2.125,4.,4.]),{"kind":"intersect","lh":box_at([2.25,0.,0.],[1.75,4.,4.]),"rh":box_at([-1.625,0.,0.],[2.375,4.,4.])}]})
}
fn cube() -> SfccWorldCube {
    SfccWorldCube {
        min_x: -128.,
        min_y: -128.,
        min_z: -128.,
        size: 256.,
    }
}
fn canonical(v: &[f32], t: &[u32]) -> Vec<Vec<u32>> {
    let mut out = Vec::new();
    for t in t.chunks_exact(3) {
        let vv: Vec<Vec<_>> = t
            .iter()
            .map(|&i| {
                v[i as usize * 8..i as usize * 8 + 8]
                    .iter()
                    .map(|v| v.to_bits())
                    .collect()
            })
            .collect();
        let t = (0..3)
            .map(|i| {
                vv[i]
                    .iter()
                    .chain(&vv[(i + 1) % 3])
                    .chain(&vv[(i + 2) % 3])
                    .copied()
                    .collect::<Vec<_>>()
            })
            .min()
            .unwrap();
        out.push(t);
    }
    out.sort();
    out
}
#[test]
fn coarse_three_sheets_are_complete_in_serial_resumable_and_raw_workers() {
    let tree = build_csg_tree_from_json(&sheets().to_string()).unwrap();
    let t = PipelineTuning::default();
    let c = cube();
    let r = run_sfcc_pipeline(&tree, &c, &t);
    assert!(r.ok, "{:?}", r.validation);
    assert_eq!(r.manifold.components, 2);
    assert_eq!(r.stats.leaves, 106);
    assert_eq!(r.validation.local_coverage.scope, "signedBoxArrangement");
    assert_eq!(r.validation.local_coverage.certified_cells, 106);
    let expected = canonical(&r.verts, &r.tris);
    let prepared = prepare(&tree, &c, &t);
    assert_eq!(prepared, build_octree_resumable_inprocess(&tree, &c, &t));
    for n in [1, 2, 4, 8] {
        let parts: Vec<_> = (0..n)
            .map(|i| mesh_partition(&tree, &c, &t, &prepared, i, n))
            .collect();
        for (order, mut p) in [parts.clone(), parts].into_iter().enumerate() {
            if order == 1 {
                p.reverse();
            }
            let m = merge(&tree, &c, &t, &p);
            assert!(!m.serial_recovery);
            assert!(m.ok, "{:?}", m.validation);
            assert_eq!(canonical(&m.verts, &m.tris), expected);
            assert_eq!(m.validation, r.validation);
        }
        let s = run_sfcc_pipeline_separate_partitioned_morton(&tree, &c, &t, n);
        assert_eq!(canonical(&s.verts, &s.tris), expected);
    }
    std::fs::write(
        "/tmp/sfcc-arrangement-b-integrated-coarse.json",
        serde_json::to_string(
            &json!({"verts":r.verts,"tris":r.tris,"validation":r.validation.to_json()}),
        )
        .unwrap(),
    )
    .unwrap();
}
#[test]
fn complete_internal_components_cavities_and_thin_walls() {
    let outer = box_at([0.; 3], [1.; 3]);
    let inner = box_at([0.; 3], [0.75; 3]);
    let cases = [
        ("enclosed", outer.clone(), 1),
        (
            "two_enclosed",
            json!({"kind":"union","children":[box_at([-0.375,0.,0.],[0.125;3]),box_at([0.375,0.,0.],[0.125;3])]}),
            2,
        ),
        (
            "cavity",
            json!({"kind":"subtract","lh":outer.clone(),"rh":inner}),
            2,
        ),
        (
            "through_hole",
            json!({"kind":"subtract","lh":outer.clone(),"rh":box_at([0.;3],[0.25,0.25,2.])}),
            1,
        ),
        ("thin_wall", box_at([0.; 3], [0.015625, 0.5, 0.5]), 1),
    ];
    for (name, scene, components) in cases {
        let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
        let r = run_sfcc_pipeline(&tree, &cube(), &PipelineTuning::default());
        assert!(r.ok, "{name}: {:?}", r.validation);
        assert_eq!(r.manifold.components, components, "{name}");
        if name == "through_hole" {
            assert_eq!(r.manifold.euler_per_component, vec![0]);
        }
        println!(
            "{name}:{} triangles {} certificates {:?}",
            r.tris.len() / 3,
            r.validation.local_coverage.certified_cells,
            r.validation.local_coverage.scope
        );
    }
}
#[test]
fn receiver_rejects_mutation_and_duplicate_partition() {
    let tree = build_csg_tree_from_json(&sheets().to_string()).unwrap();
    let t = PipelineTuning::default();
    let c = cube();
    let prepared = prepare(&tree, &c, &t);
    let mut corrupt_prepared = prepared.clone();
    corrupt_prepared[48..56].copy_from_slice(&u64::MAX.to_le_bytes());
    assert!(
        std::panic::catch_unwind(|| gcad_kernel::sfcc::worker::decode_tagged_leaves(
            &corrupt_prepared
        ))
        .is_err()
    );
    for (offset, bytes) in [
        (56, u32::MAX.to_le_bytes().to_vec()),
        (64, i64::MAX.to_le_bytes().to_vec()),
        (72, (-1_i64).to_le_bytes().to_vec()),
    ] {
        let mut corrupt = prepared.clone();
        corrupt[offset..offset + bytes.len()].copy_from_slice(&bytes);
        assert!(
            std::panic::catch_unwind(|| gcad_kernel::sfcc::worker::decode_tagged_leaves(&corrupt))
                .is_err()
        );
    }
    let a = mesh_partition(&tree, &c, &t, &prepared, 0, 2);
    let b = mesh_partition(&tree, &c, &t, &prepared, 1, 2);
    let mut wrong = b.clone();
    let i = wrong.len() - 1;
    wrong[i] ^= 1;
    assert!(std::panic::catch_unwind(|| merge(&tree, &c, &t, &[a.clone(), wrong])).is_err());
    assert!(std::panic::catch_unwind(|| merge(&tree, &c, &t, &[a.clone(), a.clone()])).is_err());
}
#[test]
fn singular_zero_sets_are_explicit_in_serial_and_workers() {
    let b = box_at([0.; 3], [1.; 3]);
    let scene = json!({"kind":"subtract","lh":b.clone(),"rh":b});
    let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
    let c = cube();
    let tuning = PipelineTuning::default();
    let r = run_sfcc_pipeline(&tree, &c, &tuning);
    assert!(!r.ok);
    assert!(r
        .validation
        .local_coverage
        .unresolved
        .iter()
        .any(|(_, r)| r == "arrangement_zero_only_face"));
    let prepared = prepare(&tree, &c, &tuning);
    let p = mesh_partition(&tree, &c, &tuning, &prepared, 0, 1);
    let r = merge(&tree, &c, &tuning, &[p]);
    assert!(!r.ok);
    assert!(r
        .validation
        .local_coverage
        .unresolved
        .iter()
        .any(|(_, r)| r == "arrangement_zero_only_face"));
}
#[test]
fn quality_stages_still_execute_and_unproved_edits_withdraw() {
    let tree = build_csg_tree_from_json(&sheets().to_string()).unwrap();
    let tuning = PipelineTuning {
        quality_triangulation: true,
        quality_refinement: true,
        quality_remeshing: true,
        quality_audit: true,
        ..Default::default()
    };
    let r = run_sfcc_pipeline(&tree, &cube(), &tuning);
    let q = r
        .validation
        .quality
        .as_ref()
        .expect("quality stages remain enabled");
    assert_eq!(q.before_triangles, 848);
    assert!(!q.cancelled);
    assert_eq!(q.geometry_failures, 0);
    assert_eq!(q.intersections, 0);
    if q.flips + q.inserted + q.collapses + q.relocations > 0 {
        assert!(!r.validation.local_coverage.unresolved.is_empty());
        assert!(!r.ok);
    }
    println!("quality={q:?}");
}
#[test]
fn ordering_duplicate_ids_and_grid_phase_preserve_complete_targets() {
    let a = box_at([-1.875, 0., 0.], [2.125, 4., 4.]);
    let b = box_at([2.25, 0., 0.], [1.75, 4., 4.]);
    let c = box_at([-1.625, 0., 0.], [2.375, 4., 4.]);
    let variants = [
        sheets(),
        json!({"kind":"union","children":[{"kind":"intersect","lh":c.clone(),"rh":b.clone()},a.clone()]}),
        json!({"kind":"union","children":[a.clone(),a,{"kind":"intersect","lh":b,"rh":c}]}),
    ];
    for (i, scene) in variants.into_iter().enumerate() {
        let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
        for (phase, shift) in [0., 0.125, -0.25].into_iter().enumerate() {
            let world = SfccWorldCube {
                min_x: -128. + shift,
                min_y: -128. + shift,
                min_z: -128. + shift,
                size: 256.,
            };
            let r = run_sfcc_pipeline(&tree, &world, &PipelineTuning::default());
            assert!(r.ok, "variant{i}, phase{phase}: {:?}", r.validation);
            assert_eq!(r.manifold.components, 2);
            assert_eq!(r.validation.local_coverage.scope, "signedBoxArrangement");
            std::fs::write(
                format!("/tmp/sfcc-arrangement-b-variant-{i}-{phase}.json"),
                serde_json::to_string(&json!({"verts":r.verts,"tris":r.tris})).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn whole_components_can_be_inside_one_actual_production_cell() {
    for (scene, components, triangles) in [
        (box_at([-0.5; 3], [0.0625; 3]), 1, 12),
        (
            json!({"kind":"union","children":[box_at([-0.625,-0.5,-0.5],[0.0625;3]),box_at([-0.375,-0.5,-0.5],[0.0625;3])]}),
            2,
            24,
        ),
    ] {
        let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
        let r = run_sfcc_pipeline(&tree, &cube(), &PipelineTuning::default());
        assert!(r.ok, "{:?}", r.validation);
        assert_eq!(r.stats.leaves, 1);
        assert_eq!(r.manifold.components, components);
        assert_eq!(r.tris.len() / 3, triangles);
        assert_eq!(r.validation.local_coverage.certified_cells, 1);
    }
}
