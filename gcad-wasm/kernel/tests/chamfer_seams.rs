use gcad_kernel::primitives::smin::SminMode;
use gcad_kernel::sdf::{self, BlendKind, CsgNode, Shape};
use gcad_kernel::sfcc::feature_set::compile_feature_set;
use gcad_kernel::tolerances::resolve_tolerances;
use gcad_kernel::tuning::SfccTuning;

#[test]
fn holes_through_loft_chamfer_preserve_both_flange_faces() {
    let mut barrel = sdf::leaf_at(Shape::Cylinder { r: 8., h: 19. }, [0.; 3]);
    if let CsgNode::Leaf(l) = &mut barrel {
        l.sim.r = [1., 0., 0., 0., 0., -1., 0., 1., 0.];
    }
    let square = vec![-10., -10., 10., -10., 10., 10., -10., 10.];
    let ring = vec![
        8.8, 0., 7.62, 4.4, 4.4, 7.62, 0., 8.8, -4.4, 7.62, -7.62, 4.4, -8.8, 0., -7.62, -4.4, -4.4, -7.62, 0., -8.8,
        4.4, -7.62, 7.62, -4.4,
    ];
    let mut flange = sdf::leaf_at(Shape::Loft { profs: vec![square, ring], winds: vec![-1., -1.], h: 3. }, [0.; 3]);
    if let CsgNode::Leaf(l) = &mut flange {
        l.sim.r = [1., 0., 0., 0., 0., 1., 0., -1., 0.];
        l.sim.t = [0., 0., 16.];
    }
    let body = CsgNode::Blend {
        kind: BlendKind::Smin,
        mode: SminMode::Chamfer,
        r: 1.5,
        n: 0.,
        children: vec![barrel, flange],
    };
    let mut children = vec![body.clone()];
    for x in [-7.5, 7.5] {
        for cy in [-7.5, 7.5] {
            let mut hole = sdf::leaf_at(Shape::Cylinder { r: 1.4, h: 4. }, [0.; 3]);
            if let CsgNode::Leaf(l) = &mut hole {
                l.sim.r = [1., 0., 0., 0., 0., -1., 0., 1., 0.];
                l.sim.t = [x, cy, 16.];
                l.sign = -1.;
            }
            children.push(hole);
        }
    }
    children.push(sdf::leaf_at(Shape::Cuboid { half: [30.; 3] }, [0., 22.6, 0.]));
    let tree = CsgNode::Max(children);
    let tol = resolve_tolerances(&SfccTuning::default(), 70.);
    let (features, _) = compile_feature_set(&tree, &tol);
    let mut failures = Vec::new();
    for curve in &features.curves {
        if !curve.adjacent_strata.iter().any(|&id| features.strata[id].leaf_index == usize::MAX) {
            continue;
        }
        for i in 0..=16 {
            let p = curve.point_at(curve.t_min + (curve.t_max - curve.t_min) * i as f64 / 16.);
            assert!(
                body.f(p).abs() <= tol.surface_tol,
                "the cutter must not mask an inactive blend branch: curve {}, point {p:?}, body residual {}",
                curve.id,
                body.f(p)
            );
        }
    }
    for cx in [-7.5, 7.5] {
        for cy in [-7.5, 7.5] {
            for i in 0..96 {
                let angle = i as f64 * std::f64::consts::TAU / 96.;
                let x = cx + 1.4 * angle.cos();
                let y = cy + 1.4 * angle.sin();
                if y < -7.4 {
                    continue;
                }
                for outside in [8., 21.] {
                    let (mut a, mut b) = (outside, 18.9);
                    assert!(body.f([x, y, a]) > 0. && body.f([x, y, b]) < 0.);
                    for _ in 0..60 {
                        let m = (a + b) * 0.5;
                        if body.f([x, y, m]) > 0. {
                            a = m;
                        } else {
                            b = m;
                        }
                    }
                    let z = (a + b) * 0.5;
                    assert!(tree.f([x, y, z]).abs() < 1e-10);
                    let gap = features.curves.iter().map(|c| c.project(x, y, z).1).fold(f64::INFINITY, f64::min);
                    if gap > tol.max_chord_error {
                        failures.push(format!(
                            "hole {cx}, sample {i}, side {outside}: missing seam at {:?}, gap {gap}",
                            [x, y, z]
                        ));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));

    // At the default depth ceiling some cells contain the hole/loft/blend
    // junction AND the base-clip junction. All of their curves must constrain
    // the triangles, even though refinement cannot separate the corners.
    use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
    let mesh = run_sfcc_pipeline(
        &tree,
        &SfccWorldCube { min_x: -23.5, min_y: 10.300000190734863 - 23.5, min_z: -23.5, size: 47. },
        &PipelineTuning::default(),
    );
    assert!(mesh.manifold.ok);
    assert_eq!(mesh.validation.vertex_residuals, gcad_kernel::sfcc::validation::AuditStatus::Passed);
    let mut samples = 0;
    let mut worst = 0.0_f64;
    for triangle in mesh.tris.chunks_exact(3) {
        let p: Vec<[f64; 3]> =
            triangle.iter().map(|&id| std::array::from_fn(|k| mesh.verts[id as usize * 8 + k] as f64)).collect();
        if !p.iter().all(|p| {
            p[2] > 12.
                && p[2] < 20.
                && [-7.5, 7.5].iter().any(|&x| [-7.5, 7.5].iter().any(|&y| (p[0] - x).hypot(p[1] - y) < 1.6))
        }) {
            continue;
        }
        for weights in [[1. / 3.; 3], [0.5, 0.5, 0.], [0., 0.5, 0.5], [0.5, 0., 0.5]] {
            let q = std::array::from_fn(|k| (0..3).map(|i| weights[i] * p[i][k]).sum());
            let error = tree.f(q).abs();
            worst = worst.max(error);
            samples += 1;
        }
    }
    assert!(samples > 1000);
    assert!(worst <= tol.max_chord_error, "hole junction triangle residual {worst}");
}

#[test]
fn crossed_cylinder_chamfer_has_both_transition_seams() {
    let a = sdf::leaf_at(Shape::Cylinder { r: 8., h: 19. }, [0.; 3]);
    let mut b = sdf::leaf_at(Shape::Cylinder { r: 6.5, h: 12. }, [0.; 3]);
    if let CsgNode::Leaf(l) = &mut b {
        l.sim.r = [1., 0., 0., 0., 0., -1., 0., 1., 0.];
    }
    let tree = CsgNode::Blend { kind: BlendKind::Smin, mode: SminMode::Chamfer, r: 1.5, n: 0., children: vec![a, b] };
    let tol = resolve_tolerances(&SfccTuning::default(), 70.);
    let (features, _) = compile_feature_set(&tree, &tol);
    // Along x=0, the two transition curves pass through (0,8,8)
    // (first cylinder side) and (0,6.5,9.5) (second cylinder side).
    let mut points = vec![[0., 8., 8.], [0., 6.5, 9.5]];
    // All four arms approach each tangent X crossing. Their dihedral falls
    // below 15 degrees here but the modeled chamfer boundary still exists.
    for offset in [0.6_f64, 1.2, 2.0] {
        for sx in [-1., 1.] {
            for sy in [-1., 1.] {
                for sz in [-1., 1.] {
                    points.push([sx * (64. - offset * offset).sqrt(), sy * offset, sz * offset]);
                }
            }
        }
    }
    for p in points {
        assert!(tree.f(p).abs() < 1e-10);
        assert!(
            features.curves.iter().any(|c| c.project(p[0], p[1], p[2]).1 < 0.01),
            "missing chamfer transition at {p:?}"
        );
    }
}

#[test]
fn holes_through_chamfer_union_follow_cylinder_rim_distance() {
    let mut barrel = sdf::leaf_at(Shape::Cylinder { r: 8., h: 19. }, [0.; 3]);
    if let CsgNode::Leaf(l) = &mut barrel {
        l.sim.r = [1., 0., 0., 0., 0., -1., 0., 1., 0.];
    }
    let flange = sdf::leaf_at(Shape::Cuboid { half: [10., 10., 3.] }, [0., 0., 16.]);
    let body = CsgNode::Blend {
        kind: BlendKind::Smin,
        mode: SminMode::Chamfer,
        r: 1.5,
        n: 0.,
        children: vec![barrel, flange],
    };
    let mut children = vec![body];
    for x in [-7.5, 7.5] {
        for y in [-7.5, 7.5] {
            let mut hole = sdf::leaf_at(Shape::Cylinder { r: 1.4, h: 4. }, [0.; 3]);
            if let CsgNode::Leaf(l) = &mut hole {
                l.sim.r = [1., 0., 0., 0., 0., -1., 0., 1., 0.];
                l.sim.t = [x, y, 16.];
                l.sign = -1.;
            }
            children.push(hole);
        }
    }
    let tree = CsgNode::Max(children);
    let (features, _) = compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 70.));
    for cx in [-7.5, 7.5] {
        for cy in [-7.5, 7.5] {
            for i in 0..48 {
                let angle = i as f64 * std::f64::consts::TAU / 48.;
                let x = cx + 1.4 * angle.cos();
                let y = cy + 1.4 * angle.sin();
                let radial = x.hypot(y) - 8.;
                // Outside the barrel cap AND mantle, its field is
                // hypot(radial,z-19). The flange field is z-19, so their
                // chamfer zero set solves hypot(radial,z-19)+(z-19)=1.5.
                let z = 19. + ((2.25 - radial * radial) / 3.).max(0.);
                let p = [x, y, z];
                assert!(tree.f(p).abs() < 1e-10, "reference point {p:?}");
                let gap = features.curves.iter().map(|c| c.project(x, y, z).1).fold(f64::INFINITY, f64::min);
                let limit = if radial < 1.4 { 0.01 } else { 0.04 }; // trim/corner neighborhood
                assert!(gap < limit, "missing hole/union boundary at {p:?}: gap {gap}");
            }
        }
    }
}
