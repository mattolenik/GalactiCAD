//! Analytic geometry controls for primitive-local scaling, including real axis edges.
use gcad_kernel::scene_bridge::{build_csg_tree, BridgeNode};
use gcad_kernel::sfcc::field_branches::sample_tree;

#[test]
fn lathe_distance_and_raw_derivatives_match_scaled_cylinders_and_annuli() {
    let k = 1. / 5.0_f64.sqrt();
    for inner in [0., 0.5] {
        for local_scale in [1., 1e-7, 1e-12] {
            let profile = [[inner, -2.], [2., -2.], [2., -2.], [2., 2.], [inner, 2.]];
            let tree = build_csg_tree(&BridgeNode::Scale {
                node_id: 0,
                sx: 1. / local_scale,
                sy: 1. / local_scale,
                sz: 1. / local_scale,
                arg: Box::new(BridgeNode::Lathe {
                    node_id: 0,
                    pos: [0.; 3],
                    verts: profile.map(|p| p.map(|v| v * local_scale)).to_vec(),
                }),
            })
            .unwrap();
            let mut controls = vec![([2.2, 2.4, 0.], 0.2 / k, [k, 2. * k, 0.])];
            controls.extend(if inner == 0. {
                vec![
                    ([0., 0.3, 0.], -1.7, [0., 1., 0.]),
                    ([0., 2.2, 0.], 0.2, [0., 1., 0.]),
                    ([0., 2., 0.], 0., [0., 1., 0.]),
                    ([0.1, 0., 0.], -1.9, [1., 0., 0.]),
                ]
            } else {
                vec![
                    ([0.49, 0., 0.], 0.01, [-1., 0., 0.]),
                    ([0.51, 0., 0.], -0.01, [-1., 0., 0.]),
                    ([0., 0., 0.51], -0.01, [0., 0., -1.]),
                    ([0.5, 0., 0.], 0., [-1., 0., 0.]),
                ]
            });
            for (p, distance, gradient) in controls {
                let sample = sample_tree(&tree, p);
                assert!(
                    (tree.f(p) - distance).abs() < 1e-10,
                    "scale={local_scale}, p={p:?}"
                );
                assert!((sample.value - distance).abs() < 1e-10);
                for k in 0..3 {
                    assert!(
                        (sample.gradient[k] - gradient[k]).abs() < 1e-10,
                        "scale={local_scale}, p={p:?}: {:?} != {gradient:?}",
                        sample.gradient
                    );
                }
            }
        }
    }
}

#[test]
fn negative_lathe_radii_are_not_treated_as_axis_roundoff() {
    let result = build_csg_tree(&BridgeNode::Lathe {
        node_id: 0,
        pos: [0.; 3],
        verts: vec![[-1e-9, -1.], [1., -1.], [1., 1.], [-1e-9, 1.]],
    });
    assert!(
        result.is_err(),
        "the signed meridian contract requires nonnegative profile radii"
    );
}
