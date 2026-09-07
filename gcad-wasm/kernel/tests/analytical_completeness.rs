//! Independent scalar-derivative controls for the analytical feature audit.
//! Finite differences are used only at smooth points, never as crease normals.
use gcad_kernel::{
    primitives::smin::SminMode,
    sdf::{leaf_at, BlendKind, CsgNode, Shape},
    sfcc::field_branches::sample_tree,
};

fn soft(children: Vec<CsgNode>, r: f64) -> CsgNode {
    CsgNode::Blend {
        kind: BlendKind::Smin,
        mode: SminMode::Soft,
        r,
        n: 4.,
        children,
    }
}

#[test]
fn nested_soft_normal_converges_to_scalar_derivative() {
    let tree = soft(
        vec![
            soft(
                vec![
                    leaf_at(Shape::Sphere { r: 1.2 }, [-0.8, 0., 0.]),
                    leaf_at(Shape::Sphere { r: 1.2 }, [0.8, 0., 0.]),
                ],
                0.8,
            ),
            leaf_at(Shape::Sphere { r: 1.2 }, [0., 1., 0.]),
        ],
        0.7,
    );
    let p = [0.1, 0.4, 1.2651338489240112];
    assert!(tree.f(p).abs() < 1e-14);
    let raw = sample_tree(&tree, p);
    let (value, normal) = tree.grad(p);
    assert!((value - tree.f(p)).abs() < 1e-14);
    let mut previous = f64::INFINITY;
    for h in [1e-2, 1e-3, 1e-4] {
        let derivative: [f64; 3] = std::array::from_fn(|k| {
            let (mut a, mut b) = (p, p);
            a[k] -= h;
            b[k] += h;
            (tree.f(b) - tree.f(a)) / (2. * h)
        });
        let error = (0..3)
            .map(|k| (derivative[k] - raw.gradient[k]).powi(2))
            .sum::<f64>()
            .sqrt();
        assert!(
            error < previous * 0.02,
            "derivative did not converge: {error} after {previous}"
        );
        previous = error;
        let length = derivative.iter().map(|v| v * v).sum::<f64>().sqrt();
        let direction_error = (0..3)
            .map(|k| (normal[k] - derivative[k] / length).powi(2))
            .sum::<f64>()
            .sqrt();
        assert!(
            direction_error < h * h,
            "normal error {direction_error} at step {h}"
        );
    }
    assert_eq!(tree.grad(p), tree.prune_to_box(p, [0.01; 3]).grad(p));
}

#[test]
fn singular_blend_does_not_invent_a_normal() {
    let tree = soft(
        vec![
            leaf_at(Shape::Sphere { r: 1. }, [-1., 0., 0.]),
            leaf_at(Shape::Sphere { r: 1. }, [1., 0., 0.]),
        ],
        0.8,
    );
    assert!(sample_tree(&tree, [0.; 3]).normalized_equation().is_none());
    assert_eq!(tree.grad([0.; 3]).1, [0.; 3]);
    assert_eq!(
        tree.prune_to_box([0.; 3], [0.1; 3]).grad([0.; 3]).1,
        [0.; 3]
    );
}

#[test]
fn inward_displaced_polygon_preserves_medial_branch_creases() {
    use gcad_kernel::{
        sfcc::feature_set::compile_feature_set, tolerances::resolve_tolerances, tuning::SfccTuning,
    };
    // smaxChamfer(d,d,r) has its zero at d=-r/2. The square's
    // inset corners therefore lie at (+/-1.6,+/-1.6), independently
    // of the compiler's candidate list. Their limiting normals are orthogonal.
    let leaf = leaf_at(
        Shape::Extrude {
            verts: vec![-2., -2., 2., -2., 2., 2., -2., 2.],
            wind: -1.,
            h: 2.,
            twist_rad: 0.,
        },
        [0.; 3],
    );
    let tree = CsgNode::Blend {
        kind: BlendKind::Smax,
        mode: SminMode::Chamfer,
        r: 0.8,
        n: 4.,
        children: vec![leaf.clone(), leaf],
    };
    let tol = resolve_tolerances(&SfccTuning::default(), 8.);
    let (features, _) = compile_feature_set(&tree, &tol);
    for sx in [-1., 1.] {
        for sz in [-1., 1.] {
            for i in 0..=10 {
                let p = [sx * 1.6, -1. + i as f64 * 0.2, sz * 1.6];
                assert!(tree.f(p).abs() < 1e-14);
                let gap = features
                    .curves
                    .iter()
                    .map(|c| c.project(p[0], p[1], p[2]).1)
                    .fold(f64::INFINITY, f64::min);
                assert!(
                    gap < 0.002,
                    "missing inset polygon edge at {p:?}, gap={gap}"
                );
            }
        }
    }
}

#[test]
fn lifted_profile_edges_survive_twist_loft_and_winding() {
    use gcad_kernel::{
        sfcc::feature_set::compile_feature_set, tolerances::resolve_tolerances, tuning::SfccTuning,
    };
    let square = vec![-2., -2., 2., -2., 2., 2., -2., 2.];
    let reverse = vec![-2., 2., 2., 2., 2., -2., -2., -2.];
    for (shape, twist) in [
        (
            Shape::Extrude {
                verts: reverse,
                wind: 1.,
                h: 2.,
                twist_rad: 0.7,
            },
            0.7,
        ),
        (
            Shape::Loft {
                profs: vec![square.clone(), square.clone()],
                winds: vec![-1.; 2],
                h: 2.,
            },
            0.,
        ),
    ] {
        for mode in [SminMode::Chamfer, SminMode::Soft, SminMode::Round] {
            let leaf = leaf_at(shape.clone(), [0.; 3]);
            let tree = CsgNode::Blend {
                kind: BlendKind::Smax,
                mode,
                r: 0.8,
                n: 4.,
                children: vec![leaf.clone(), leaf],
            };
            let inset = match mode {
                SminMode::Chamfer => 0.4,
                SminMode::Soft => 0.2,
                _ => 0.8 * (1. - std::f64::consts::FRAC_1_SQRT_2),
            };
            let tol = resolve_tolerances(&SfccTuning::default(), 8.);
            let (features, _) = compile_feature_set(&tree, &tol);
            for i in 0..=8 {
                let y = -0.8 + i as f64 * 0.2;
                let angle = twist * (y + 2.) / 4.;
                let (sn, cs) = angle.sin_cos();
                let q = 2. - inset;
                let p = [q * (cs - sn), y, q * (sn + cs)];
                assert!(tree.f(p).abs() < 1e-12);
                let gap = features
                    .curves
                    .iter()
                    .map(|c| c.project(p[0], p[1], p[2]).1)
                    .fold(f64::INFINITY, f64::min);
                assert!(gap < 0.002, "{mode:?} twist={twist} at {p:?}: {gap}");
            }
        }
    }
}

#[test]
fn outward_polygon_segment_endpoint_join_is_smooth() {
    use gcad_kernel::{
        sfcc::feature_set::compile_feature_set, tolerances::resolve_tolerances, tuning::SfccTuning,
    };
    let leaf = leaf_at(
        Shape::Extrude {
            verts: vec![-2., -2., 2., -2., 2., 2., -2., 2.],
            wind: -1.,
            h: 2.,
            twist_rad: 0.,
        },
        [0.; 3],
    );
    let tree = CsgNode::Blend {
        kind: BlendKind::Smin,
        mode: SminMode::Chamfer,
        r: 0.8,
        n: 4.,
        children: vec![leaf.clone(), leaf],
    };
    let tol = resolve_tolerances(&SfccTuning::default(), 8.);
    let (features, _) = compile_feature_set(&tree, &tol);
    let p = [2.4, 0., 2.];
    assert!(tree.f(p).abs() < 1e-12);
    let gap = features
        .curves
        .iter()
        .map(|c| c.project(p[0], p[1], p[2]).1)
        .fold(f64::INFINITY, f64::min);
    assert!(
        gap > 0.1,
        "smooth segment/endpoint join became a fictitious crease: {gap}"
    );
}

#[test]
fn inward_primitive_branches_have_analytical_rims() {
    use gcad_kernel::{
        primitives::{polygon2d::winding_sign, shapes::lathe_profile_edges},
        sfcc::feature_set::compile_feature_set,
        tolerances::resolve_tolerances,
        tuning::SfccTuning,
    };
    let profile = [[0., -2.], [2., -2.], [2., 2.], [0., 2.]];
    let cone_radius = 2. - 0.4 * (1. + 2f64.sqrt());
    for (name, shape, p) in [
        ("box", Shape::Cuboid { half: [2.; 3] }, [1.6, 0., 1.6]),
        ("cylinder", Shape::Cylinder { r: 2., h: 2. }, [1.6, 1.6, 0.]),
        ("cone", Shape::Cone { r: 2., h: 2. }, [cone_radius, 0.4, 0.]),
        (
            "lathe",
            Shape::Lathe {
                edges: lathe_profile_edges(&profile, winding_sign(&profile)),
            },
            [1.6, 1.6, 0.],
        ),
    ] {
        let leaf = leaf_at(shape, [0.; 3]);
        let tree = CsgNode::Blend {
            kind: BlendKind::Smax,
            mode: SminMode::Chamfer,
            r: 0.8,
            n: 4.,
            children: vec![leaf.clone(), leaf],
        };
        assert!(
            tree.f(p).abs() < 1e-12,
            "{name}: independent inset equation"
        );
        let tol = resolve_tolerances(&SfccTuning::default(), 8.);
        let (features, _) = compile_feature_set(&tree, &tol);
        let gap = features
            .curves
            .iter()
            .map(|c| c.project(p[0], p[1], p[2]).1)
            .fold(f64::INFINITY, f64::min);
        assert!(gap < 0.002, "{name} inset crease missing: {gap}");
    }
}

#[test]
fn represented_small_loop_survives_seed_spacing_and_phase() {
    use gcad_kernel::{
        sfcc::seam_trace::{trace_carrier_pair, SeamTraceDiagnostics},
        strata::{Stratum, StratumIdentity},
        tolerances::resolve_tolerances,
        tuning::SfccTuning,
    };
    let ident = |id| StratumIdentity {
        id,
        owner_node_id: 0,
        leaf_index: id,
        local_index: 0,
        sign: 1.,
    };
    for spacing in [0.25, 0.4, 0.7] {
        for center in [[0.123, 0.217, 0.], [-0.173, 0.131, 0.]] {
            let sphere = Stratum::sphere(ident(0), center[0], center[1], 0., 0.03);
            let plane = Stratum::plane(ident(1), 0., 0., 1., 0.);
            let mut tol = resolve_tolerances(&SfccTuning::default(), 2.);
            tol.seed_cell_size = spacing;
            let mut diagnostics = SeamTraceDiagnostics::default();
            let arcs = trace_carrier_pair(
                &sphere,
                &plane,
                &[-1., -1., -0.1, 1., 1., 0.1],
                &tol,
                &mut diagnostics,
            );
            assert_eq!(
                arcs.len(),
                1,
                "spacing={spacing} center={center:?}: {diagnostics:?}"
            );
            assert!(arcs[0].1, "known circular component must close");
            for p in arcs[0].0.chunks_exact(3) {
                assert!(((p[0] - center[0]).hypot(p[1] - center[1]) - 0.03).abs() < 1e-6);
                assert!(p[2].abs() < 1e-8);
            }
        }
    }
}
