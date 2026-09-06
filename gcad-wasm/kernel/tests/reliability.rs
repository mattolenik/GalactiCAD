//! Regression tests for surface discovery and export-result validity. No external fixtures.
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::manifold_check::check_manifold;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};

fn prepared(mut tree: CsgNode) -> CsgNode {
    fn attach(n: &mut CsgNode, first: &mut usize) {
        match n {
            CsgNode::Leaf(l) => {
                l.strata = build_leaf_strata(l, l.index, *first);
                *first += l.strata.len();
            }
            CsgNode::Min(ch) | CsgNode::Max(ch) | CsgNode::Blend { children: ch, .. } => {
                for c in ch {
                    attach(c, first);
                }
            }
        }
    }
    tree.assign_leaf_indices();
    attach(&mut tree, &mut 0);
    tree
}
fn sphere(r: f64, p: [f64; 3]) -> CsgNode {
    sdf::leaf_at(Shape::Sphere { r }, p)
}
fn cube() -> SfccWorldCube {
    SfccWorldCube { min_x: -10., min_y: -10., min_z: -10., size: 20. }
}

#[test]
fn unresolved_surface_cannot_report_success() {
    let tree = prepared(sphere(0.01, [0.3; 3]));
    let r = run_sfcc_pipeline(&tree, &cube(), &PipelineTuning::default());
    assert!(!r.ok, "a surface below the lattice resolution must be reported unresolved");
    assert!(r.stats.degenerate_cells > 0);
}

#[test]
fn sufficient_depth_discovers_a_surface_between_coarse_samples() {
    let tree = prepared(sphere(0.01, [0.3; 3]));
    let tuning = PipelineTuning { depth_max: 13, ..PipelineTuning::default() };
    let r = run_sfcc_pipeline(&tree, &cube(), &tuning);
    assert!(!r.tris.is_empty());
    assert!(r.manifold.ok);
    assert_eq!(r.manifold.components, 1);
}

#[test]
fn refinement_ceiling_is_not_a_successful_export() {
    let tree = prepared(sphere(4., [0.; 3]));
    let tuning = PipelineTuning { depth_min: 3, depth_max: 3, normal_variation_deg: 0., ..PipelineTuning::default() };
    let r = run_sfcc_pipeline(&tree, &cube(), &tuning);
    assert!(r.stats.degenerate_cells > 0);
    assert!(!r.ok);
    assert!(r.manifold.ok, "unresolved refinement and topology are separate results");
}

#[test]
fn normal_exports_check_vertex_links() {
    assert!(PipelineTuning::default().check_vertex_links);
    let tetra = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    assert!(check_manifold(&tetra, true).ok);
    let bowtie = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3, 0, 5, 4, 0, 4, 6, 0, 6, 5, 4, 5, 6];
    let m = check_manifold(&bowtie, PipelineTuning::default().check_vertex_links);
    assert!(!m.ok);
    assert_eq!(m.non_manifold_vertices, 1);
}

#[test]
fn small_real_component_survives_discovery_and_cleanup() {
    for offset in [0., 0.13, 0.31] {
        let tree = prepared(sdf::union(vec![sphere(3., [-4., 0., 0.]), sphere(0.12, [3. + offset, 0.3, 0.3])]));
        let tuning = PipelineTuning { depth_min: 3, depth_max: 9, ..PipelineTuning::default() };
        let r = run_sfcc_pipeline(&tree, &cube(), &tuning);
        assert_eq!(r.manifold.components, 2, "small component lost at offset {offset}");
        assert!(r.manifold.ok);
    }
}

#[test]
fn bounded_empty_intersection_is_a_valid_empty_export() {
    let tree = prepared(sdf::intersect(vec![sphere(1., [-4., 0., 0.]), sphere(1., [4., 0., 0.])]));
    let r = run_sfcc_pipeline(&tree, &cube(), &PipelineTuning::default());
    assert!(r.tris.is_empty());
    assert!(r.ok);
}

#[test]
fn small_enclosed_cavity_is_preserved() {
    let tree = prepared(sdf::subtract(sphere(4., [0.; 3]), sphere(0.12, [0.3; 3])));
    let t = PipelineTuning { depth_max: 9, ..Default::default() };
    let r = run_sfcc_pipeline(&tree, &cube(), &t);
    assert_eq!(r.manifold.components, 2, "outer shell and cavity must both survive");
    assert!(r.manifold.ok);
    assert_eq!(r.validation.off_surface_vertices, 0);
}

#[test]
fn small_sphere_discovery_scales_with_the_domain() {
    for scale in [0.1, 1., 10.] {
        let tree = prepared(sphere(0.03 * scale, [0.37 * scale; 3]));
        let c = SfccWorldCube { min_x: -10. * scale, min_y: -10. * scale, min_z: -10. * scale, size: 20. * scale };
        let t = PipelineTuning { depth_max: 12, surface_tol_mm: 0.001 * scale, ..Default::default() };
        let r = run_sfcc_pipeline(&tree, &c, &t);
        assert!(!r.tris.is_empty(), "scale {scale}");
        assert!(r.manifold.ok, "scale {scale}");
        assert_eq!(r.validation.off_surface_vertices, 0, "scale {scale}");
    }
}

#[test]
fn transformed_box_bounds_enclose_dense_samples() {
    use gcad_kernel::math::similarity::Similarity;
    let angle = 0.73_f64;
    let sim = Similarity {
        r: [angle.cos(), -angle.sin(), 0., angle.sin(), angle.cos(), 0., 0., 0., 1.],
        t: [12., -3., 8.],
        s: 2.3,
    };
    for shape in [Shape::Sphere { r: 1.1 }, Shape::Cuboid { half: [1., 2., 3.] }, Shape::Cylinder { r: 1., h: 2. }] {
        let positive = sdf::leaf_with_strata(shape, sim, [0.3, -0.2, 0.1], vec![]);
        for tree in [positive.clone(), sdf::subtract(sphere(50., [0.; 3]), positive)] {
            for c in [[12., -3., 8.], [14., 0., 9.], [8., -4., 6.]] {
                let half = [0.3, 0.7, 0.5];
                let (lo, hi) = tree.interval_over_box(c, half);
                for i in 0..=4 {
                    for j in 0..=4 {
                        for k in 0..=4 {
                            let p = [
                                c[0] + half[0] * (i as f64 / 2. - 1.),
                                c[1] + half[1] * (j as f64 / 2. - 1.),
                                c[2] + half[2] * (k as f64 / 2. - 1.),
                            ];
                            let f = tree.f(p);
                            assert!(lo <= f && f <= hi, "{lo} <= {f} <= {hi}, p={p:?}");
                        }
                    }
                }
            }
        }
    }
}
