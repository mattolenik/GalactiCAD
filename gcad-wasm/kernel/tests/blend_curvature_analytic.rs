//! The legacy analytic-blend option must fall back to sampled refinement.
//! Mesh equality here checks the fallback, not a continuous curvature certificate.
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::primitives::smin::SminMode;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};

fn prepared(mut tree: CsgNode) -> CsgNode {
    fn attach(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
        match node {
            CsgNode::Leaf(leaf) => {
                let strata = build_leaf_strata(
                    &Leaf {
                        strata: Vec::new(),
                        ..leaf.clone()
                    },
                    *leaf_index,
                    *first_id,
                );
                *first_id += strata.len();
                *leaf_index += 1;
                leaf.strata = strata;
            }
            CsgNode::Min(children) | CsgNode::Max(children) | CsgNode::Blend { children, .. } => {
                children
                    .iter_mut()
                    .for_each(|child| attach(child, leaf_index, first_id));
            }
        }
    }
    tree.assign_leaf_indices();
    attach(&mut tree, &mut 0, &mut 0);
    tree
}

fn sphere_union() -> CsgNode {
    sdf::union_smooth(
        vec![
            sdf::leaf_at(Shape::Sphere { r: 4. }, [-3., 0., 0.]),
            sdf::leaf_at(Shape::Sphere { r: 4. }, [3., 0., 0.]),
        ],
        SminMode::Round,
        1.,
        2.,
    )
}

fn oblique_boxes() -> CsgNode {
    let c = -0.5_f64;
    let s = (1. - c * c).sqrt();
    sdf::union_smooth(
        vec![
            sdf::leaf_at(Shape::Cuboid { half: [5.; 3] }, [-5., 0., 0.]),
            sdf::leaf(
                Shape::Cuboid { half: [5.; 3] },
                Similarity {
                    r: [c, -s, 0., s, c, 0., 0., 0., 1.],
                    t: [-5. * c, -5. * s, 0.],
                    s: 1.,
                },
                [0.; 3],
            ),
        ],
        SminMode::Round,
        1.,
        2.,
    )
}

#[test]
fn oblique_plane_blend_exceeds_the_old_inverse_radius_estimate() {
    let tree = oblique_boxes();
    let c = -0.5_f64;
    let s = (1. - c * c).sqrt();
    let v = 1. - std::f64::consts::FRAC_1_SQRT_2;
    let p = [v, (v - c * v) / s, 0.];
    let tangent = [
        (1. - c) / (2. * (1. - c)).sqrt(),
        -s / (2. * (1. - c)).sqrt(),
        0.,
    ];
    let h = 1e-3;
    let plus = std::array::from_fn(|k| p[k] + h * tangent[k]);
    let minus = std::array::from_fn(|k| p[k] - h * tangent[k]);
    // At the symmetric point, |gradient|=sqrt(1+c) and the normal curvature is
    // (1-c)/(r*sqrt(1+c)). The operand-space circle is not a world-space circle.
    let exact = (1. - c) / (1. + c).sqrt();
    let measured =
        (tree.f(plus) - 2. * tree.f(p) + tree.f(minus)).abs() / (h * h * (1. + c).sqrt());
    assert!(tree.f(p).abs() < 1e-12);
    assert!((measured - exact).abs() < 1e-4 && measured > 2.);
    assert_eq!(
        tree.blend_curvature_bound(),
        None,
        "unproved curvature must not select the shortcut"
    );
}

#[test]
fn analytic_blend_request_uses_the_same_sampled_refinement() {
    let scenes = [
        prepared(sphere_union()),
        prepared(oblique_boxes()),
        prepared(sdf::subtract_smooth(
            sdf::leaf_at(Shape::Sphere { r: 8. }, [0.; 3]),
            sphere_union(),
            SminMode::Round,
            0.7,
            2.,
        )),
        // No attached strata: the empty-owner route must also retain its normal
        // sampling when the tree has no blend and the old advisory was Some(0).
        sdf::leaf_at(Shape::Sphere { r: 4. }, [0.; 3]),
    ];
    let cube = SfccWorldCube {
        min_x: -12.,
        min_y: -12.,
        min_z: -12.,
        size: 24.,
    };
    for (case, tree) in scenes.iter().enumerate() {
        let tuning = PipelineTuning {
            depth_min: 3,
            depth_max: 6,
            blend_curvature_deg: 8.,
            ..PipelineTuning::default()
        };
        let sampled = run_sfcc_pipeline(tree, &cube, &tuning);
        let requested = run_sfcc_pipeline(
            tree,
            &cube,
            &PipelineTuning {
                blend_curvature_analytic: true,
                ..tuning
            },
        );
        assert!(
            !sampled.tris.is_empty(),
            "case {case} produced no control mesh"
        );
        assert_eq!(requested.verts, sampled.verts, "case {case}: vertices");
        assert_eq!(requested.tris, sampled.tris, "case {case}: triangles");
        assert_eq!(
            requested.stats.leaves, sampled.stats.leaves,
            "case {case}: refinement"
        );
        assert_eq!(
            requested.validation.to_json(),
            sampled.validation.to_json(),
            "case {case}: validation"
        );
    }
}
