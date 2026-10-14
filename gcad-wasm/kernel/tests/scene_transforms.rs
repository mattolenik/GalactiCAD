use gcad_kernel::scene_bridge::{build_csg_tree, BridgeBlendMode, BridgeNode};
use gcad_kernel::sfcc::field_branches::sample_tree;

fn sphere(x: f64, radius: f64) -> BridgeNode {
    BridgeNode::Sphere {
        node_id: 1,
        pos: [x, 0., 0.],
        r: radius,
    }
}

fn scale(arg: BridgeNode, factor: f64) -> BridgeNode {
    BridgeNode::Scale {
        node_id: 2,
        sx: factor,
        sy: factor,
        sz: factor,
        arg: Box::new(arg),
    }
}

fn blend(
    kind: usize,
    mode: BridgeBlendMode,
    radius: f64,
    a: BridgeNode,
    b: BridgeNode,
) -> BridgeNode {
    match kind {
        0 => BridgeNode::Union {
            node_id: 3,
            children: vec![a, b],
            radius,
            mode: Some(mode),
            n: Some(3.),
        },
        1 => BridgeNode::Intersect {
            node_id: 3,
            lh: Box::new(a),
            rh: Box::new(b),
            radius,
            mode: Some(mode),
            n: Some(3.),
        },
        _ => BridgeNode::Subtract {
            node_id: 3,
            lh: Box::new(a),
            rh: Box::new(b),
            radius,
            mode: Some(mode),
            n: Some(3.),
        },
    }
}

fn assert_scale_equivariance(scene: &BridgeNode) {
    let original = build_csg_tree(scene).unwrap();
    for factor in [0.25, 2., 4.] {
        let transformed = build_csg_tree(&scale(scene.clone(), factor)).unwrap();
        for i in -20..=20 {
            let p = [i as f64 * 0.071 + 0.013, 0.37, 0.59];
            let reference = sample_tree(&original, p);
            let actual = sample_tree(&transformed, p.map(|v| v * factor));
            assert!(
                (actual.value - factor * reference.value).abs() < 1e-10,
                "scale={factor}, p={p:?}: {} != {}",
                actual.value,
                factor * reference.value
            );
            for axis in 0..3 {
                assert!(
                    (actual.gradient[axis] - reference.gradient[axis]).abs() < 1e-10,
                    "gradient axis {axis}, scale={factor}, p={p:?}"
                );
            }
        }
    }
}

#[test]
fn uniform_scale_preserves_every_boolean_blend_mode() {
    for mode in [
        BridgeBlendMode::Round,
        BridgeBlendMode::Soft,
        BridgeBlendMode::Chamfer,
        BridgeBlendMode::Stairs,
        BridgeBlendMode::Columns,
    ] {
        for kind in 0..3 {
            assert_scale_equivariance(&blend(
                kind,
                mode,
                0.7,
                sphere(-0.6, 1.5),
                sphere(0.6, 1.25),
            ));
        }
    }
}

#[test]
fn nested_scales_preserve_signed_composite_cutters() {
    let cutter = blend(
        0,
        BridgeBlendMode::Round,
        0.7,
        sphere(-0.6, 1.5),
        sphere(0.6, 1.25),
    );
    let moved = BridgeNode::Translate {
        node_id: 4,
        d: [0.5, -0.25, 0.75],
        arg: Box::new(scale(cutter, 2.)),
    };
    let inner = blend(2, BridgeBlendMode::Soft, 0.4, sphere(0., 3.), moved);
    assert_scale_equivariance(&blend(
        1,
        BridgeBlendMode::Chamfer,
        0.3,
        inner,
        sphere(0.2, 2.5),
    ));
    // Scaling one child must not scale the enclosing operator's radius.
    assert_scale_equivariance(&blend(
        0,
        BridgeBlendMode::Round,
        0.6,
        scale(sphere(-0.4, 1.), 2.),
        sphere(0.7, 1.),
    ));

    // soft(d,d,0.8) = d-0.2: two coincident unit spheres form a radius-1.2
    // cutter. Its inner scale 2 and outer scale 1/4 give a radius-0.6 cavity
    // inside a radius-1.25 sphere, independently of the bridge's lowering.
    let cutter = blend(
        0,
        BridgeBlendMode::Soft,
        0.8,
        sphere(0., 1.),
        sphere(0., 1.),
    );
    let shell = build_csg_tree(&scale(
        blend(
            2,
            BridgeBlendMode::Round,
            0.,
            sphere(0., 5.),
            scale(cutter, 2.),
        ),
        0.25,
    ))
    .unwrap();
    for r in [0.1_f64, 0.5, 0.65, 0.9, 1.3, 2.] {
        assert!((shell.f([r, 0., 0.]) - (r - 1.25).max(0.6 - r)).abs() < 1e-12);
    }
}

#[test]
fn primitive_rotation_wrappers_preserve_the_position_pivot() {
    let profile = vec![[-2., -1.], [2., -1.], [1., 2.], [-1., 1.]];
    let primitives = [
        BridgeNode::Box {
            node_id: 1,
            pos: [0.; 3],
            half: [2., 1., 3.],
        },
        BridgeNode::Cylinder {
            node_id: 1,
            pos: [0.; 3],
            r: 1.25,
            h: 3.,
            fillet_top: 0.,
            fillet_bottom: 0.,
            chamfer_top: 0.,
            chamfer_bottom: 0.,
        },
        BridgeNode::Cone {
            node_id: 1,
            pos: [0.; 3],
            r: 1.5,
            h: 3.,
        },
        BridgeNode::Extrude {
            node_id: 1,
            pos: [0.; 3],
            verts: profile.clone(),
            h: 3.,
            twist_degrees: 17.,
        },
        BridgeNode::Loft {
            node_id: 1,
            pos: [0.; 3],
            profiles: vec![profile.clone(), profile],
            h: 3.,
        },
        BridgeNode::Lathe {
            node_id: 1,
            pos: [0.; 3],
            verts: vec![[0., -1.], [2., -1.], [1., 2.], [0., 2.]],
        },
    ];
    for primitive in primitives {
        let reference = build_csg_tree(&primitive).unwrap();
        let rotated = BridgeNode::Rotate {
            node_id: 2,
            fwd: [0., 1., 0., -1., 0., 0., 0., 0., 1.],
            arg: Box::new(primitive),
        };
        let transformed = build_csg_tree(&BridgeNode::Translate {
            node_id: 3,
            d: [3., -2., 1.],
            arg: Box::new(rotated),
        })
        .unwrap();
        for p in [[0.17, 0.31, 0.53], [1.7, -1.1, 0.4], [-0.7, 1.3, 2.1]] {
            // Independent quarter-turn map: (x,y,z) -> (-y,x,z), then translate.
            let actual = sample_tree(&transformed, [3. - p[1], -2. + p[0], 1. + p[2]]);
            let expected = sample_tree(&reference, p);
            assert!((actual.value - expected.value).abs() < 1e-12);
            for (actual, expected) in actual.gradient.into_iter().zip([
                -expected.gradient[1],
                expected.gradient[0],
                expected.gradient[2],
            ]) {
                assert!((actual - expected).abs() < 1e-12);
            }
        }
    }
}
