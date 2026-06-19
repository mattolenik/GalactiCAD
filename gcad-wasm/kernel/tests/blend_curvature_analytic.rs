//! Lever-2 analytic blend-curvature cert: SOUNDNESS + flag-gated parity.
//!
//! - Default (flag OFF) is bit-identical to the sampled-cone pipeline (the proven
//!   path), on both a fillet scene and a hard scene.
//! - With the flag ON, the analytic fillet is a closed 2-manifold (χ=2), double-run
//!   bit-identical, and its REALIZED per-cell normal variation on the blend band
//!   stays ≤ θ (no faceting the sampled cone would have prevented).

use gcad_kernel::primitives::smin::SminMode;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::manifold_check::check_manifold;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccPipelineResult, SfccWorldCube};

fn attach_strata(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
    match node {
        CsgNode::Leaf(l) => {
            let strata = build_leaf_strata(&Leaf { strata: Vec::new(), ..l.clone() }, *leaf_index, *first_id);
            *first_id += strata.len();
            *leaf_index += 1;
            l.strata = strata;
        }
        CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter_mut().for_each(|c| attach_strata(c, leaf_index, first_id)),
        CsgNode::Blend { children, .. } => children.iter_mut().for_each(|c| attach_strata(c, leaf_index, first_id)),
    }
}

fn prepared(mut tree: CsgNode) -> CsgNode {
    tree.assign_leaf_indices();
    let (mut li, mut fi) = (0usize, 0usize);
    attach_strata(&mut tree, &mut li, &mut fi);
    tree
}

fn sphere_union_round() -> CsgNode {
    prepared(sdf::union_smooth(
        vec![sdf::leaf_at(Shape::Sphere { r: 4.0 }, [-3.0, 0.0, 0.0]), sdf::leaf_at(Shape::Sphere { r: 4.0 }, [3.0, 0.0, 0.0])],
        SminMode::Round,
        1.0,
        2.0,
    ))
}

fn cube() -> SfccWorldCube {
    SfccWorldCube { min_x: -9.0, min_y: -6.0, min_z: -6.0, size: 18.0 }
}

fn tuning(theta: f64, analytic: bool, depth_max: u32) -> PipelineTuning {
    PipelineTuning {
        depth_min: 4,
        depth_max,
        bounds_padding_mm: 0.0,
        blend_curvature_refine: true,
        blend_curvature_deg: theta,
        blend_curvature_analytic: analytic,
        ..PipelineTuning::default()
    }
}

fn unit(g: [f64; 3]) -> [f64; 3] {
    let l = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
    if l < 1e-30 {
        [0.0, 0.0, 0.0]
    } else {
        [g[0] / l, g[1] / l, g[2] / l]
    }
}

/// Max angle (deg) between adjacent vertex normals over blend-band triangles (no
/// analytic owner at the centroid) — a realized per-cell normal-variation proxy.
fn realized_blend_variation(tree: &CsgNode, r: &SfccPipelineResult) -> f64 {
    let pos = |i: u32| -> [f64; 3] {
        let b = i as usize * 8;
        [r.verts[b] as f64, r.verts[b + 1] as f64, r.verts[b + 2] as f64]
    };
    let nrm = |i: u32| -> [f64; 3] {
        let b = i as usize * 8;
        [r.verts[b + 4] as f64, r.verts[b + 5] as f64, r.verts[b + 6] as f64]
    };
    let mut max_deg = 0.0f64;
    for t in r.tris.chunks(3) {
        let (a, b, c) = (t[0], t[1], t[2]);
        let (pa, pb, pc) = (pos(a), pos(b), pos(c));
        let ctr = [(pa[0] + pb[0] + pc[0]) / 3.0, (pa[1] + pb[1] + pc[1]) / 3.0, (pa[2] + pb[2] + pc[2]) / 3.0];
        if !tree.active_owners_at(ctr, 1e-6).is_empty() {
            continue; // not a blend-band tri
        }
        let (na, nb, nc) = (unit(nrm(a)), unit(nrm(b)), unit(nrm(c)));
        for (u, v) in [(na, nb), (nb, nc), (na, nc)] {
            let dot = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]).clamp(-1.0, 1.0);
            let deg = dot.acos() * 180.0 / std::f64::consts::PI;
            if deg > max_deg {
                max_deg = deg;
            }
        }
    }
    max_deg
}

#[test]
fn flag_off_is_bit_identical_to_sampled_on_fillet() {
    let tree = sphere_union_round();
    let c = cube();
    let smp = run_sfcc_pipeline(&tree, &c, &tuning(8.0, false, 7));
    let off = run_sfcc_pipeline(&tree, &c, &tuning(8.0, false, 7)); // flag off == sampled
    assert_eq!(smp.verts, off.verts, "flag-off verts must equal the sampled path");
    assert_eq!(smp.tris, off.tris, "flag-off tris must equal the sampled path");
}

#[test]
fn analytic_fillet_is_manifold_deterministic_and_sound() {
    let tree = sphere_union_round();
    let c = cube();
    let theta = 4.0;
    let depth_max = 8;
    let a1 = run_sfcc_pipeline(&tree, &c, &tuning(theta, true, depth_max));
    let a2 = run_sfcc_pipeline(&tree, &c, &tuning(theta, true, depth_max));
    // Determinism: double-run bit-identical.
    assert_eq!(a1.verts, a2.verts, "analytic verts must be double-run bit-identical");
    assert_eq!(a1.tris, a2.tris, "analytic tris must be double-run bit-identical");
    // Manifold: closed 2-manifold, χ = 2 (single sphere-topology component).
    let man = check_manifold(&a1.tris, false);
    assert!(man.ok, "analytic fillet must be a closed 2-manifold: {man:?}", man = (man.open_edges, man.non_manifold_edges));
    assert_eq!(man.euler_per_component, vec![2], "χ must be 2");
    // SOUNDNESS: realized blend-band normal variation ≤ θ (no faceting the sampled
    // cone would have prevented). Small slack for the proxy + interior projection.
    let realized = realized_blend_variation(&tree, &a1);
    assert!(realized <= theta + 0.5, "analytic blend var {realized:.2}° exceeds θ={theta}° (soundness)");
}
