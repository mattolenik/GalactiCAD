//! Emitted coordinates, not just indices, must still define triangles.
use gcad_kernel::scene_bridge::{build_csg_tree, BridgeNode};
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::worker::{merge, mesh_partition, prepare};

fn collapsed_triangles(verts: &[f32], tris: &[u32]) -> usize {
    tris.chunks_exact(3)
        .filter(|t| {
            let p: [[f64; 3]; 3] = std::array::from_fn(|i| {
                std::array::from_fn(|j| verts[t[i] as usize * 8 + j] as f64)
            });
            let u: [f64; 3] = std::array::from_fn(|i| p[1][i] - p[0][i]);
            let v: [f64; 3] = std::array::from_fn(|i| p[2][i] - p[0][i]);
            [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]] == [0.; 3]
        })
        .count()
}

#[test]
fn output_rounding_cannot_turn_degenerate_triangles_into_a_successful_export() {
    let tuning = PipelineTuning::default();
    for center in [0., 1000.] {
        let tree = build_csg_tree(&BridgeNode::Sphere { node_id: 0, pos: [center; 3], r: 1. }).unwrap();
        let cube = SfccWorldCube { min_x: center - 1., min_y: center - 1., min_z: center - 1., size: 2. };
        let serial = run_sfcc_pipeline(&tree, &cube, &tuning);
        let collapsed = collapsed_triangles(&serial.verts, &serial.tris);
        assert_eq!(serial.validation.invalid_triangles, collapsed);
        assert!(serial.manifold.ok, "the index topology alone misses output collapse");
        if center == 0. {
            assert_eq!(collapsed, 0);
            assert!(serial.ok, "{:?}", serial.validation);
        } else {
            assert!(collapsed > 0, "control must exercise f32 collapse");
            assert!(!serial.ok, "collapsed output must fail even when all vertex residuals pass");
            assert_eq!(serial.validation.status(), "failed");
        }

        let leaves = prepare(&tree, &cube, &tuning);
        for count in [1, 2, 4, 8] {
            let partials: Vec<_> = (0..count)
                .rev()
                .map(|i| mesh_partition(&tree, &cube, &tuning, &leaves, i, count))
                .collect();
            let merged = merge(&tree, &cube, &tuning, &partials);
            assert!(!merged.serial_recovery, "exercise the actual merge verdict");
            assert_eq!(collapsed_triangles(&merged.verts, &merged.tris), collapsed);
            assert_eq!(merged.validation, serial.validation);
            assert_eq!(merged.ok, serial.ok);
        }
    }
}
