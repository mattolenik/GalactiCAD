//! Analytic per-stratum smoothCrit cert (opt-in `normal_variation_analytic`):
//! closed-2-manifold, verts-on-surface, and double-run bit-identical. Soundness
//! (κ upper-bounds the true carrier curvature ⇒ realized normal variation ≤ θ) is
//! by construction; here we gate that the analytic refinement still yields a valid,
//! deterministic surface mesh on each analytic carrier kind (sphere/cylinder/cone).

use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccPipelineResult, SfccWorldCube};

fn prepared(mut tree: CsgNode) -> CsgNode {
    tree.assign_leaf_indices();
    fn walk(node: &mut CsgNode, li: &mut usize, fi: &mut usize) {
        match node {
            CsgNode::Leaf(l) => {
                let s = build_leaf_strata(&Leaf { strata: Vec::new(), ..l.clone() }, *li, *fi);
                *fi += s.len();
                *li += 1;
                l.strata = s;
            }
            CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter_mut().for_each(|c| walk(c, li, fi)),
            CsgNode::Blend { children, .. } => children.iter_mut().for_each(|c| walk(c, li, fi)),
        }
    }
    let (mut li, mut fi) = (0usize, 0usize);
    walk(&mut tree, &mut li, &mut fi);
    tree
}

fn mesh_analytic(tree: &CsgNode, cube: &SfccWorldCube) -> SfccPipelineResult {
    let tuning = PipelineTuning {
        depth_min: 4,
        depth_max: 7,
        blend_curvature_refine: false,
        normal_variation_deg: 3.0,
        normal_variation_analytic: true,
        ..PipelineTuning::default()
    };
    run_sfcc_pipeline(tree, cube, &tuning)
}

fn assert_valid_closed(name: &str, tree: &CsgNode, r: &SfccPipelineResult, components: usize) {
    assert!(!r.tris.is_empty(), "{name}: produced triangles");
    assert!(
        r.manifold.ok,
        "{name}: manifold (open={} nonmani={} misori={})",
        r.manifold.open_edges, r.manifold.non_manifold_edges, r.manifold.misoriented_edges
    );
    assert_eq!(r.manifold.components, components, "{name}: component count");
    assert_eq!(r.manifold.euler_per_component, vec![2i64; components], "{name}: χ per component must be 2");
    // Verts on the surface — the analytic refinement changes only depth, never the
    // contoured vertex positions, so every vertex stays on the analytic surface.
    let mut i = 0;
    while i < r.verts.len() {
        let f = tree.f([r.verts[i] as f64, r.verts[i + 1] as f64, r.verts[i + 2] as f64]).abs();
        assert!(f <= 0.05, "{name}: vertex off-surface |f|={f}");
        i += 8;
    }
}

#[test]
fn sphere_analytic_manifold_and_deterministic() {
    let tree = prepared(sdf::leaf_at(Shape::Sphere { r: 6.0 }, [0.13, -0.21, 0.07]));
    let cube = SfccWorldCube { min_x: -9.0, min_y: -9.0, min_z: -9.0, size: 18.0 };
    let a = mesh_analytic(&tree, &cube);
    assert_valid_closed("sphere", &tree, &a, 1);
    // Double-run bit-identical (determinism under the analytic cert).
    let b = mesh_analytic(&tree, &cube);
    assert_eq!(a.verts, b.verts, "sphere: verts not deterministic");
    assert_eq!(a.tris, b.tris, "sphere: tris not deterministic");
}

#[test]
fn cylinder_and_cone_analytic_are_closed() {
    let cyl = prepared(sdf::leaf_at(Shape::Cylinder { r: 5.0, h: 10.0 }, [0.0, 0.0, 0.0]));
    let cone = prepared(sdf::leaf_at(Shape::Cone { r: 5.0, h: 10.0 }, [0.0, 0.0, 0.0]));
    let cube = SfccWorldCube { min_x: -10.0, min_y: -10.0, min_z: -10.0, size: 20.0 };
    assert_valid_closed("cylinder", &cyl, &mesh_analytic(&cyl, &cube), 1);
    assert_valid_closed("cone", &cone, &mesh_analytic(&cone, &cube), 1);
}
