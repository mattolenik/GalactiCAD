//! Known reconstruction failures retained for later algorithm milestones.
//! The normal suite reports these tests as ignored; each asserts the intended
//! behavior, not the current failure. Run them explicitly with:
//! `cargo test --offline --release -p gcad-kernel --test known_reconstruction_failures -- --ignored`
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::primitives::smin::SminMode;
use gcad_kernel::scene_bridge::{build_csg_tree, BridgeNode};
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::feature_curves::make_circle_curve;
use gcad_kernel::sfcc::feature_set::{compile_feature_set, SfccFeatureSet};
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::point_table::PointTable;
use gcad_kernel::sfcc::sliver_flip::flip_sliver_triangles;
use gcad_kernel::sfcc::spatial_index::SfccSpatialIndex;
use gcad_kernel::tolerances::resolve_tolerances;
use gcad_kernel::tuning::SfccTuning;

fn features(tree: &CsgNode, cube_size: f64) -> SfccFeatureSet {
    let tolerances = resolve_tolerances(&SfccTuning::default(), cube_size * 3.0_f64.sqrt());
    compile_feature_set(tree, &tolerances).0
}

fn clipped_cube(center_y: f64) -> CsgNode {
    build_csg_tree(&BridgeNode::Intersect {
        node_id: 0,
        lh: Box::new(BridgeNode::Box {
            node_id: 0,
            pos: [0.; 3],
            half: [2., 5000., 2.],
        }),
        rh: Box::new(BridgeNode::Box {
            node_id: 0,
            pos: [0., center_y, 0.],
            half: [20., 2., 20.],
        }),
        radius: 0.,
        mode: None,
        n: None,
    })
    .unwrap()
}

#[test]
#[ignore = "Known: fixed carrier-trim samples can miss the surviving interval of a long box edge"]
fn long_carrier_trimming_preserves_all_twelve_edges_of_a_four_mm_cube() {
    for center_y in [0., 2.44140625] {
        let tree = clipped_cube(center_y);
        let compiled = features(&tree, 4.);
        for axis in 0..3 {
            for a in [-2., 2.] {
                for b in [-2., 2.] {
                    for along in [-1., 0., 1.] {
                        let mut p = [0.; 3];
                        p[axis] = along;
                        p[(axis + 1) % 3] = a;
                        p[(axis + 2) % 3] = b;
                        p[1] += center_y;
                        assert!(
                            compiled
                                .curves
                                .iter()
                                .any(|curve| curve.project(p[0], p[1], p[2]).1 < 1e-6),
                            "cube center y={center_y}: no compiled edge at {p:?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
#[ignore = "Known: missing trimmed cube edges let emitted triangles bridge sharp corners"]
fn hard_intersection_cube_triangles_follow_the_exact_cuboid_boundary() {
    for center_y in [0., 2.44140625] {
        let tree = clipped_cube(center_y);
        let result = run_sfcc_pipeline(
            &tree,
            &SfccWorldCube {
                min_x: -2.,
                min_y: center_y - 2.,
                min_z: -2.,
                size: 4.,
            },
            &PipelineTuning::default(),
        );
        let mut worst = 0.0_f64;
        for tri in result.tris.chunks_exact(3) {
            let mut p = [0.; 3];
            for &id in tri {
                for k in 0..3 {
                    p[k] += result.verts[id as usize * 8 + k] as f64 / 3.;
                }
            }
            p[1] -= center_y;
            // Exact cuboid distance, independent of the CSG evaluator and its carriers.
            let q = p.map(|v| v.abs() - 2.);
            let outside = q[0].max(0.).hypot(q[1].max(0.)).hypot(q[2].max(0.));
            let inside = q[0].max(q[1]).max(q[2]).min(0.);
            worst = worst.max((outside + inside).abs());
        }
        assert!(!result.tris.is_empty());
        assert!(
            worst <= 0.01,
            "cube center y={center_y}: centroid-to-boundary error {worst} mm"
        );
    }
}

#[test]
#[ignore = "Known: a sign-changing box cell can hide a separate sphere without recording unresolved discovery"]
fn separate_sphere_is_reconstructed_or_reported_as_unresolved() {
    let center = [0.04125955406450752, 1.53, 1.53];
    let radius = 0.01650382162580301;
    let sphere = BridgeNode::Sphere {
        node_id: 0,
        pos: center,
        r: radius,
    };
    let cube = SfccWorldCube {
        min_x: -100.,
        min_y: -100.,
        min_z: -100.,
        size: 200.,
    };
    let tuning = PipelineTuning::default();
    let alone = run_sfcc_pipeline(&build_csg_tree(&sphere).unwrap(), &cube, &tuning);
    assert!(
        alone.validation.unresolved_cells > 0,
        "the standalone sphere control must diagnose its insufficient depth budget"
    );
    let tree = build_csg_tree(&BridgeNode::Union {
        node_id: 0,
        children: vec![
            BridgeNode::Box {
                node_id: 0,
                pos: [-50., 0., 0.],
                half: [50., 100., 100.],
            },
            sphere,
        ],
        radius: 0.,
        mode: None,
        n: None,
    })
    .unwrap();
    let result = run_sfcc_pipeline(&tree, &cube, &tuning);
    let covered = result.manifold.components == 2
        && result.verts.chunks_exact(8).any(|v| {
            (v[0] as f64 - center[0])
                .hypot(v[1] as f64 - center[1])
                .hypot(v[2] as f64 - center[2])
                < 2. * radius
        });
    assert!(
        covered || result.validation.unresolved_cells > 0,
        "separate sphere lost: {} components, {} unresolved cells",
        result.manifold.components,
        result.validation.unresolved_cells
    );
}

#[test]
#[ignore = "Known: aspect-ratio-only sliver flips can reverse a planar triangle's orientation"]
fn sliver_flip_preserves_the_oriented_planar_patch() {
    let mut points = PointTable::new();
    let p = points.add(-1., 0., 0., 0., 0., 1.);
    let q = points.add(1., 0., 0., 0., 0., 1.);
    let r = points.add(0., 0.01, 0., 0., 0., 1.);
    let d = points.add(4., -0.001, 0., 0., 0., 1.);
    let tris = [p, q, r, q, p, d];
    let area2 = |t: &[usize]| {
        (points.x(t[1]) - points.x(t[0])) * (points.y(t[2]) - points.y(t[0]))
            - (points.y(t[1]) - points.y(t[0])) * (points.x(t[2]) - points.x(t[0]))
    };
    assert!(tris.chunks_exact(3).all(|t| area2(t) > 0.));
    let (out, _) = flip_sliver_triangles(&points, &tris, 4);
    for tri in out.chunks_exact(3) {
        assert!(
            area2(tri) > 0.,
            "flip reversed an originally positive patch: area2={}",
            area2(tri)
        );
    }
}

#[test]
#[ignore = "Known: the default dihedral gate discards a real shallow sphere/plane intersection circle"]
fn shallow_spherical_cut_retains_its_boundary_circle() {
    let angle = 10.0_f64.to_radians();
    let z = 10. * angle.cos();
    let radius = 10. * angle.sin();
    let tree = build_csg_tree(&BridgeNode::Intersect {
        node_id: 0,
        lh: Box::new(BridgeNode::Sphere {
            node_id: 0,
            pos: [0.; 3],
            r: 10.,
        }),
        rh: Box::new(BridgeNode::Box {
            node_id: 0,
            pos: [0., 0., z - 20.],
            half: [20.; 3],
        }),
        radius: 0.,
        mode: None,
        n: None,
    })
    .unwrap();
    let compiled = features(&tree, 20.);
    for i in 0..12 {
        let t = i as f64 * std::f64::consts::TAU / 12.;
        let p = [radius * t.cos(), radius * t.sin(), z];
        assert!(
            compiled
                .curves
                .iter()
                .any(|curve| curve.project(p[0], p[1], p[2]).1 < 1e-5),
            "the true sphere/cap crease has no compiled curve at {p:?}"
        );
    }
}

#[test]
#[ignore = "Known: identical-profile loft compilation duplicates and overlaps the twelve cuboid edges"]
fn identical_profile_loft_has_no_duplicate_feature_length() {
    let square = vec![[-2., -2.], [2., -2.], [2., 2.], [-2., 2.]];
    let tree = build_csg_tree(&BridgeNode::Loft {
        node_id: 0,
        pos: [0.; 3],
        profiles: vec![square.clone(), square],
        h: 2.,
    })
    .unwrap();
    let compiled = features(&tree, 4.);
    // This is exactly a 4 mm cube: the unique sharp-edge length is 12 * 4 mm.
    // Summing lengths permits harmless subdivision but detects duplicate coverage.
    let length: f64 = compiled
        .curves
        .iter()
        .map(|curve| {
            curve
                .index_polyline
                .windows(6)
                .step_by(3)
                .map(|v| (v[3] - v[0]).hypot(v[4] - v[1]).hypot(v[5] - v[2]))
                .sum::<f64>()
        })
        .sum();
    assert!(
        (length - 48.).abs() < 1e-5,
        "feature graph length {length} mm, expected 48 mm"
    );
}

#[test]
#[ignore = "Known: chord-only spatial-index boxes can omit an actual analytic circle extremum"]
fn spatial_index_encloses_the_curve_between_its_index_samples() {
    let w = 1. / 3.0_f64.sqrt();
    let cy = 1. - (2.0_f64 / 3.).sqrt() + 0.0002;
    let curve = make_circle_curve(7, 0, [0, 1], 0., cy, 0., w, w, w, 1., None);
    let p = curve.point_at(2. * std::f64::consts::PI / 3.);
    let mut index = SfccSpatialIndex::new(1.);
    index.insert_curve_polyline(7, &curve.index_polyline);
    let candidates = index.curves_in_box(p.map(|v| v - 1e-8), p.map(|v| v + 1e-8));
    assert!(
        candidates.contains(&7),
        "index omitted a point on its circle: {p:?}"
    );
}

#[test]
#[ignore = "Known: the optional 1/r round-blend curvature estimate is unsafe for oblique carriers"]
fn round_blend_curvature_bound_covers_oblique_planar_carriers() {
    let c = -0.5_f64;
    let s = (1. - c * c).sqrt();
    let a = sdf::leaf_at(Shape::Cuboid { half: [1000.; 3] }, [-1000., 0., 0.]);
    let b = sdf::leaf(
        Shape::Cuboid { half: [1000.; 3] },
        Similarity {
            r: [c, -s, 0., s, c, 0., 0., 0., 1.],
            t: [-1000. * c, -1000. * s, 0.],
            s: 1.,
        },
        [0.; 3],
    );
    let tree = sdf::union_smooth(vec![a, b], SminMode::Round, 1., 2.);
    // At a=b=1-1/sqrt(2), the physical normal curvature is
    // (1-c)/(r*sqrt(1+c)); the operand-coordinate circle is not a world-space circle.
    let exact_curvature = (1. - c) / (1. + c).sqrt();
    // Returning None is also safe: the caller then uses sampled refinement.
    if let Some(bound) = tree.blend_curvature_bound() {
        assert!(
            bound >= exact_curvature,
            "reported bound {bound}, true curvature {exact_curvature}"
        );
    }
}
