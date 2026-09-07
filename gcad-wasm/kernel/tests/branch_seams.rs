use gcad_kernel::{
    primitives::smin::SminMode,
    sdf::{leaf_at, BlendKind, CsgNode, Shape},
    sfcc::feature_set::compile_feature_set,
    tolerances::resolve_tolerances,
    tuning::SfccTuning,
};

#[test]
fn displaced_extrusion_has_cap_side_rims() {
    let leaf = leaf_at(
        Shape::Extrude { verts: vec![-2., -2., 2., -2., 2., 2., -2., 2.], wind: -1., h: 2., twist_rad: 0. },
        [0.; 3],
    );
    let tree = CsgNode::Blend {
        kind: BlendKind::Smin,
        mode: SminMode::Chamfer,
        r: 0.8,
        n: 0.,
        children: vec![leaf.clone(), leaf],
    };
    let tol = resolve_tolerances(&SfccTuning::default(), 12.);
    let (fs, _) = compile_feature_set(&tree, &tol);
    for sign in [-1., 1.] {
        for i in 0..=20 {
            let p = [2.4, sign * 2.4, -2. + 4. * i as f64 / 20.];
            assert!(tree.f(p).abs() < 1e-10);
            let gap = fs.curves.iter().map(|c| c.project(p[0], p[1], p[2]).1).fold(f64::INFINITY, f64::min);
            assert!(gap < 0.02, "missing displaced rim at {p:?}: {gap}");
        }
    }
}

fn bracket() -> CsgNode {
    let blend =
        |c| CsgNode::Blend { kind: BlendKind::Smin, mode: SminMode::Chamfer, r: 1.2, n: 4., children: c };
    let body = blend(vec![
        leaf_at(Shape::Cuboid { half: [22., 3., 14.] }, [0.; 3]),
        leaf_at(Shape::Cylinder { r: 6., h: 9. }, [-12., 8., 0.]),
        leaf_at(Shape::Cylinder { r: 6., h: 9. }, [12., 8., 0.]),
    ]);
    let mut rib = leaf_at(
        Shape::Extrude {
            verts: vec![-2.2, -6.5, 2.2, -6.5, 2.2, 6.5, -2.2, 6.5],
            wind: -1.,
            h: 12.,
            twist_rad: 200f64.to_radians(),
        },
        [0.; 3],
    );
    if let CsgNode::Leaf(l) = &mut rib {
        l.sim.r = [0., -1., 0., 1., 0., 0., 0., 0., 1.];
        l.sim.t = [0., 5., 0.];
    }
    let mut tree =
        CsgNode::Max(vec![blend(vec![body, rib]), leaf_at(Shape::Sphere { r: 30. }, [0., -14., 0.])]);
    for (x, z, r, h) in [
        (-12., 0., 3.2, 20.),
        (12., 0., 3.2, 20.),
        (-18., -10., 1.7, 10.),
        (18., -10., 1.7, 10.),
        (-18., 10., 1.7, 10.),
        (18., 10., 1.7, 10.),
    ] {
        let mut cut = leaf_at(Shape::Cylinder { r, h }, [x, 0., z]);
        if let CsgNode::Leaf(l) = &mut cut {
            l.sign = -1.;
        }
        tree = CsgNode::Max(vec![tree, cut]);
    }
    let mut dent = leaf_at(Shape::Sphere { r: 4. }, [0., 11., 0.]);
    if let CsgNode::Leaf(l) = &mut dent {
        l.sign = -1.;
    }
    let mut tree = CsgNode::Max(vec![tree, dent]);
    tree.assign_leaf_indices();
    fn attach(node: &mut CsgNode, first: &mut usize) {
        match node {
            CsgNode::Leaf(l) => {
                l.strata = gcad_kernel::sfcc::feature_set::build_leaf_strata(l, l.index, *first);
                *first += l.strata.len();
            }
            CsgNode::Min(c) | CsgNode::Max(c) | CsgNode::Blend { children: c, .. } => {
                for child in c {
                    attach(child, first)
                }
            }
        }
    }
    attach(&mut tree, &mut 0);
    tree
}

#[test]
fn bracket_preserves_displaced_edges_and_rib_junctions() {
    use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
    let tree = bracket();
    let tol = resolve_tolerances(&SfccTuning::default(), 90.);
    let (fs, _) = compile_feature_set(&tree, &tol);
    for curve in &fs.curves {
        for i in 0..=32 {
            let p = curve.point_at(curve.t_min + (curve.t_max - curve.t_min) * i as f64 / 32.);
            for &id in &curve.adjacent_strata {
                let patch = &fs.strata[id];
                if patch.domain_contains(p, tol.curve_eps * 8.) {
                    assert!(
                        patch.domain_contains(p, tol.surface_tol),
                        "looser tolerance erased patch {id} at {p:?}"
                    );
                }
            }
        }
    }
    let points = [
        [12.34563989286355, 5., 6.8456398928635505],
        [-12.20434801732704, 5., 6.992666769587309],
        [-12.880145836270044, 6., 6.258266529775746],
        [12.8, 8., -6.349803146555017],
        [9.631632963518237, 4.703601671153187, 6.7993262593107895],
        [9.43751334525502, 4.682120384517046, 6.854848834953285],
        [-8.159496869903307, 4.200000000905028, 6.815423684661727],
        [4.894351432635451, 3.7, -2.3683542502653836],
        [-12., 5.8, 6.444199773305718],
    ];
    for p in points {
        assert!(tree.f(p).abs() < 1e-7);
        let gap = fs.curves.iter().map(|c| c.project(p[0], p[1], p[2]).1).fold(f64::INFINITY, f64::min);
        assert!(gap < 0.002, "missing bracket curve at {p:?}: {gap}");
    }
    let mesh = run_sfcc_pipeline(
        &tree,
        &SfccWorldCube { min_x: -26.4, min_y: -21.1, min_z: -26.4, size: 52.8 },
        &PipelineTuning::default(),
    );
    assert!(
        mesh.manifold.ok,
        "open {} nonmanifold {} orientation {} vertices {}",
        mesh.manifold.open_edges,
        mesh.manifold.non_manifold_edges,
        mesh.manifold.misoriented_edges,
        mesh.manifold.non_manifold_vertices
    );
    assert_eq!(mesh.validation.vertex_residuals, gcad_kernel::sfcc::validation::AuditStatus::Passed);
    let pos = |id: u32| -> [f64; 3] { std::array::from_fn(|k| mesh.verts[id as usize * 8 + k] as f64) };
    let samples = points.into_iter().chain(
        fs.curves
            .iter()
            .flat_map(|c| (0..=8).map(move |i| c.point_at(c.t_min + (c.t_max - c.t_min) * i as f64 / 8.))),
    );
    for p in samples {
        let mut best = f64::INFINITY;
        for t in mesh.tris.chunks_exact(3) {
            for k in 0..3 {
                let a = pos(t[k]);
                let b = pos(t[(k + 1) % 3]);
                if (0..3).any(|k| p[k] < a[k].min(b[k]) - best || p[k] > a[k].max(b[k]) + best) {
                    continue;
                }
                let d: [f64; 3] = std::array::from_fn(|j| b[j] - a[j]);
                let l = d.iter().map(|x| x * x).sum::<f64>();
                let u = ((0..3).map(|j| (p[j] - a[j]) * d[j]).sum::<f64>() / l).clamp(0., 1.);
                best = best.min((0..3).map(|j| (p[j] - a[j] - u * d[j]).powi(2)).sum::<f64>().sqrt());
            }
        }
        assert!(best < 0.02, "bracket mesh skips curve at {p:?}: {best}");
    }
    let mut worst = 0f64;
    let mut at = [0.; 3];
    for t in mesh.tris.chunks_exact(3) {
        let ps = [pos(t[0]), pos(t[1]), pos(t[2])];
        for w in [[1. / 3.; 3], [0.5, 0.5, 0.], [0.5, 0., 0.5], [0., 0.5, 0.5]] {
            let p = std::array::from_fn(|k| (0..3).map(|i| ps[i][k] * w[i]).sum());
            let e = tree.f(p).abs();
            if e > worst {
                worst = e;
                at = p;
            }
        }
    }
    assert!(worst < 0.02, "bracket triangle interior residual {worst} at {at:?}");

    // Exercise the same branch graph through separate worker contexts, including
    // corner identities, curve locks, and the shared post-assembly refinement.
    use gcad_kernel::parity::{meshes_equivalent, CanonicalizeOptions};
    use gcad_kernel::sfcc::worker::{merge, mesh_partition, prepare};
    let cube = SfccWorldCube { min_x: -26.4, min_y: -21.1, min_z: -26.4, size: 52.8 };
    let tuning = PipelineTuning::default();
    let leaves = prepare(&tree, &cube, &tuning);
    let partials: Vec<_> =
        (0..2).rev().map(|i| mesh_partition(&tree, &cube, &tuning, &leaves, i, 2)).collect();
    let merged = merge(&tree, &cube, &tuning, &partials);
    assert!(merged.manifold.ok);
    assert_eq!(merged.validation, mesh.validation);
    meshes_equivalent(
        &mesh.verts.iter().map(|&v| v as f64).collect::<Vec<_>>(),
        &mesh.tris,
        &merged.verts.iter().map(|&v| v as f64).collect::<Vec<_>>(),
        &merged.tris,
        &CanonicalizeOptions { pos_eps: 0., compare_normals: true, ..Default::default() },
    )
    .expect("bracket worker merge must match serial geometry and normals");
}

#[test]
fn nearest_pair_switch_on_soft_union_is_a_feature() {
    for reverse in [false, true] {
        let mut children = vec![
            leaf_at(Shape::Sphere { r: 2. }, [0., -1., 0.]),
            leaf_at(Shape::Sphere { r: 2. }, [-2., 0., 0.]),
            leaf_at(Shape::Sphere { r: 2. }, [2., 0., 0.]),
        ];
        if reverse {
            children.reverse();
        }
        let tree = CsgNode::Blend { kind: BlendKind::Smin, mode: SminMode::Soft, r: 0.8, n: 0., children };
        let (mut a, mut b) = (1., 2.);
        for _ in 0..60 {
            let m = (a + b) * 0.5;
            if tree.f([0., m, 0.]) < 0. {
                a = m;
            } else {
                b = m;
            }
        }
        let p = [0., (a + b) * 0.5, 0.];
        let (fs, _) = compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 12.));
        let gap = fs.curves.iter().map(|c| c.project(p[0], p[1], p[2]).1).fold(f64::INFINITY, f64::min);
        assert!(gap < 0.002, "nearest-pair switch missing at {p:?}: {gap}");
    }
}

#[test]
fn displaced_rims_preserve_signed_blends_and_similarity_transforms() {
    for kind in [BlendKind::Smin, BlendKind::Smax] {
        for scale in [0.5, 2.] {
            let mut leaf = leaf_at(
                Shape::Extrude {
                    verts: vec![-2., -2., 2., -2., 2., 2., -2., 2.],
                    wind: -1.,
                    h: 2.,
                    twist_rad: 0.,
                },
                [0.; 3],
            );
            if let CsgNode::Leaf(l) = &mut leaf {
                l.sim.s = scale;
                l.sim.t = [3., -4., 2.];
                l.sim.r = [0., 0., 1., 0., 1., 0., -1., 0., 0.];
            }
            let tree = CsgNode::Blend {
                kind,
                mode: SminMode::Chamfer,
                r: 0.8 * scale,
                n: 0.,
                children: vec![leaf.clone(), leaf],
            };
            let offset = if kind == BlendKind::Smin { 2.4 } else { 1.6 };
            let (fs, _) =
                compile_feature_set(&tree, &resolve_tolerances(&SfccTuning::default(), 20. * scale));
            for sign in [-1., 1.] {
                for z in [-1., 0., 1.] {
                    let p = [3. + scale * z, -4. + scale * sign * offset, 2. - scale * offset];
                    assert!(tree.f(p).abs() < 1e-10);
                    let gap =
                        fs.curves.iter().map(|c| c.project(p[0], p[1], p[2]).1).fold(f64::INFINITY, f64::min);
                    assert!(gap < 0.002, "signed/transformed rim missing at {p:?}: {gap}");
                }
            }
        }
    }
}

// Independent equations for the expected arcs, rather than samples taken from
// whatever curves the feature compiler happened to discover.
fn bracket_transition_arcs(tree: &CsgNode) -> [Vec<[f64; 3]>; 2] {
    std::array::from_fn(|arc| {
        (0..=24)
            .map(|i| {
                let y = if arc == 0 { 3.1 + 1.05 * i as f64 / 24. } else { 5.05 + 1.35 * i as f64 / 24. };
                let point = |z: f64| {
                    let x = if arc == 0 {
                        // plate = (plate + boss - r)/sqrt(2), with boss the
                        // right cylinder's radial field; the outer chamfer supplies z.
                        let radius = 6. + 1.2 + (std::f64::consts::SQRT_2 - 1.) * (y - 3.);
                        12. - (radius * radius - z * z).sqrt()
                    } else {
                        -12.
                    }; // transformed top twist-clamp plane
                    [x, y, z]
                };
                let (mut lo, mut hi) = if arc == 0 { (-4., 0.) } else { (5.8, 7.2) };
                let flo = tree.f(point(lo));
                assert!(flo * tree.f(point(hi)) < 0.);
                for _ in 0..50 {
                    let mid = (lo + hi) * 0.5;
                    if tree.f(point(mid)) * flo > 0. {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                point((lo + hi) * 0.5)
            })
            .collect()
    })
}

#[test]
fn bracket_transition_arcs_survive_ancestors_and_seed_spacing() {
    let root = bracket();
    let arcs = bracket_transition_arcs(&root);
    // Outer rib chamfer, dome, drilled body, and final spherical subtraction.
    let mut stages = vec![&root];
    let mut node = &root;
    for i in 0..8 {
        let CsgNode::Max(c) = node else { panic!("bracket operation order") };
        node = &c[0];
        if i == 0 || i == 6 || i == 7 {
            stages.push(node);
        }
    }
    for (stage, tree) in stages.into_iter().enumerate() {
        for spacing in [0., 2.7] {
            let mut tol = resolve_tolerances(&SfccTuning::default(), 90.);
            tol.seed_cell_size = spacing;
            let (fs, _) = compile_feature_set(tree, &tol);
            let junction = [-13.2, 3., 7.466228379532119];
            assert!(
                fs.corners.iter().any(|c| {
                    (c.x - junction[0]).hypot(c.y - junction[1]).hypot(c.z - junction[2])
                        < tol.corner_merge_tol * 2.
                        && c.curve_ends.len() >= 3
                }),
                "split numerical endpoints instead of one triple junction: stage {stage}, spacing {spacing}"
            );
            for arc in &arcs {
                let mut previous: Vec<usize> = Vec::new();
                for &p in arc {
                    assert!(tree.f(p).abs() < 1e-7);
                    let covering: Vec<_> = fs
                        .curves
                        .iter()
                        .filter(|c| c.project(p[0], p[1], p[2]).1 < 0.002)
                        .map(|c| c.id)
                        .collect();
                    assert!(
                        !covering.is_empty(),
                        "stage {stage}, spacing {spacing}, missing transition {p:?}"
                    );
                    assert!(
                        previous.is_empty()
                            || previous.iter().any(|&a| covering.iter().any(|&b| {
                                a == b
                                    || [fs.curves[a].corner_start, fs.curves[a].corner_end].into_iter().any(
                                        |corner| {
                                            corner >= 0
                                                && [fs.curves[b].corner_start, fs.curves[b].corner_end]
                                                    .contains(&corner)
                                        },
                                    )
                            })),
                        "disconnected transition at {p:?}, stage {stage}, spacing {spacing}"
                    );
                    previous = covering;
                }
            }
        }
    }
}

#[test]
fn nearby_components_of_one_carrier_pair_are_not_consumed() {
    use gcad_kernel::{
        sfcc::{
            field_branches::FieldRef,
            seam_trace::{trace_carrier_pair, SeamTraceDiagnostics},
        },
        strata::{Stratum, StratumIdentity},
    };
    use std::sync::Arc;
    for inner_radius in [0.9, 0.99] {
        let mut inner = leaf_at(Shape::Sphere { r: inner_radius }, [0.; 3]);
        if let CsgNode::Leaf(l) = &mut inner {
            l.sign = -1.;
        }
        let shell = Arc::new(CsgNode::Max(vec![leaf_at(Shape::Sphere { r: 1. }, [0.; 3]), inner]));
        let ident = |id| StratumIdentity { id, owner_node_id: -1, leaf_index: 0, local_index: id, sign: 1. };
        let a = Stratum::field(ident(0), FieldRef::new(shell, vec![]));
        let b = Stratum::plane(ident(1), 0., 0., 1., 0.);
        for extent in [2., 3.] {
            let mut tol = resolve_tolerances(&SfccTuning::default(), 10.);
            tol.seed_cell_size = 0.4;
            let curves = trace_carrier_pair(
                &a,
                &b,
                &[-extent, -extent, -0.1, extent, extent, 0.1],
                &tol,
                &mut SeamTraceDiagnostics::default(),
            );
            assert_eq!(curves.len(), 2, "two concentric components must survive: extent {extent}");
            for radius in [inner_radius, 1.] {
                assert!(curves.iter().any(|(samples, closed)| *closed
                    && samples.chunks_exact(3).all(|p| (p[0].hypot(p[1]) - radius).abs() < 1e-7)));
            }
        }
    }
}
