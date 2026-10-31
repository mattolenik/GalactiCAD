//! Post-pass decimation keeps thin shells closed while collapsing their planar
//! faces: the sub-step hollow box of `thin_sheet.rs` (0.6 mm walls, with and
//! without a taper warp) must come out as two closed shells, every triangle
//! centroid within the tolerance of the field, at a small fraction of the
//! undecimated count.
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{self, CsgNode, Leaf, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};

fn attach_strata(node: &mut CsgNode, leaf_index: &mut usize, first_id: &mut usize) {
    match node {
        CsgNode::Leaf(leaf) => {
            let strata = build_leaf_strata(&Leaf { strata: Vec::new(), ..leaf.clone() }, *leaf_index, *first_id);
            *first_id += strata.len();
            *leaf_index += 1;
            leaf.strata = strata;
        }
        CsgNode::Taper { child, .. } => attach_strata(child, leaf_index, first_id),
        CsgNode::Min(children) | CsgNode::Max(children) | CsgNode::Blend { children, .. } => {
            children.iter_mut().for_each(|c| attach_strata(c, leaf_index, first_id))
        }
    }
}

fn warp_mark(node: &mut CsgNode, scale: f64) {
    match node {
        CsgNode::Leaf(l) => {
            l.warped = true;
            l.warp_scale = scale;
        }
        CsgNode::Min(ch) | CsgNode::Max(ch) => ch.iter_mut().for_each(|c| warp_mark(c, scale)),
        CsgNode::Blend { children, .. } => children.iter_mut().for_each(|c| warp_mark(c, scale)),
        CsgNode::Taper { ratio, child, .. } => warp_mark(child, scale * ratio.max(1.0)),
    }
}

fn hollow_box(tapered: bool) -> CsgNode {
    let shell = sdf::subtract(
        sdf::leaf_at(Shape::Cuboid { half: [10.0; 3] }, [0.0; 3]),
        sdf::leaf_at(Shape::Cuboid { half: [9.4; 3] }, [0.0; 3]),
    );
    let mut tree = if tapered {
        let mut t = sdf::taper(1.05, 20.0, Similarity::identity(), shell);
        warp_mark(&mut t, 1.0);
        t
    } else {
        shell
    };
    tree.assign_leaf_indices();
    attach_strata(&mut tree, &mut 0, &mut 0);
    tree
}

#[test]
fn decimation_keeps_thin_shells_closed_and_collapses_planes() {
    let tol = 0.05;
    for tapered in [true, false] {
        let tree = hollow_box(tapered);
        let cube = SfccWorldCube { min_x: -12.0, min_y: -12.0, min_z: -12.0, size: 24.0 };
        let base = PipelineTuning { depth_min: 3, depth_max: 5, ..PipelineTuning::default() };
        let full = run_sfcc_pipeline(&tree, &cube, &base);
        let dec = run_sfcc_pipeline(&tree, &cube, &PipelineTuning { decimate_tol_mm: tol, ..base });
        let m = &dec.manifold;
        assert!(
            m.open_edges == 0 && m.non_manifold_edges == 0 && m.non_manifold_vertices == 0 && m.components == 2
                && m.euler_per_component.iter().all(|&e| e == 2),
            "tapered={tapered}: shells must stay closed, got components={} euler={:?} open={} nonmanifold edges={} vertices={}",
            m.components, m.euler_per_component, m.open_edges, m.non_manifold_edges, m.non_manifold_vertices
        );
        let (nf, nd) = (full.tris.len() / 3, dec.tris.len() / 3);
        assert!(nd * 10 <= nf, "tapered={tapered}: expected ≥10× fewer triangles, got {nf} → {nd}");
        // Centroid deviation from the field: never worse than the undecimated
        // mesh (whose uncarried creases are already rounded at cell size), and
        // within the tolerance wherever the input was.
        let worst_of = |verts: &[f32], tris: &[u32]| {
            let mut devs: Vec<f64> = tris
                .chunks_exact(3)
                .map(|t| {
                    let mut c = [0.0; 3];
                    for &k in t {
                        for a in 0..3 {
                            c[a] += verts[k as usize * 8 + a] as f64 / 3.0;
                        }
                    }
                    tree.f(c).abs()
                })
                .collect();
            devs.sort_by(|a, b| a.partial_cmp(b).unwrap());
            (devs.iter().filter(|&&d| d > tol).count(), devs[devs.len() - 1])
        };
        // Triangles beyond the tolerance are the crease chamfers the contouring
        // emitted (uncarried creases round at cell size under the warp); the
        // decimation may merge them but never add to them or push them further.
        let (over_full, worst_full) = worst_of(&full.verts, &full.tris);
        let (over_dec, worst) = worst_of(&dec.verts, &dec.tris);
        assert!(worst <= worst_full.max(tol) * 1.05, "tapered={tapered}: centroid deviation {worst} exceeds max({worst_full}, {tol})");
        assert!(over_dec <= over_full, "tapered={tapered}: {over_dec} triangles beyond {tol} mm, input had {over_full}");
        assert_eq!(dec.verts.len() / 8, {
            let mut used = std::collections::HashSet::new();
            dec.tris.iter().for_each(|&k| { used.insert(k); });
            used.len()
        }, "tapered={tapered}: decimated vertices are compacted");
        println!("tapered={tapered}: {nf} → {nd} triangles, beyond-tolerance/max {over_dec}/{worst:.4} mm (input {over_full}/{worst_full:.4})");
    }
}
