//! A wall thinner than the lattice step must still export closed. Corner
//! sampling alone misses such a sheet wherever it threads between lattice
//! planes (holes) or crosses an edge with both endpoints outside (the two
//! sides get joined into a slit); the octree's interior-sign witness lets those
//! ceiling cells refine past `depth_max` (octree.rs `SHEET_EXTRA_DEPTH`).
//! Pinned on a hollow box with 0.6 mm walls on a 0.875 mm step, with and
//! without a taper warp (the warp drops the analytic carriers, which is the
//! bowl sample's regime).
use gcad_kernel::math::similarity::Similarity;
use gcad_kernel::sdf::{self, CsgNode, Leaf, SdfQuery, Shape};
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

/// Mark every leaf warped the way the scene bridge does under a taper.
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
fn sub_step_walls_export_closed() {
    // Also with blend-curvature refinement off: a warped region has no carriers,
    // so that switch must not leave it without any smoothness criterion.
    let tunings = [
        PipelineTuning { depth_min: 3, depth_max: 5, ..PipelineTuning::default() },
        PipelineTuning { depth_min: 3, depth_max: 5, blend_curvature_refine: false, ..PipelineTuning::default() },
        PipelineTuning { depth_min: 3, depth_max: 5, multi_sheet_cells: true, ..PipelineTuning::default() },
    ];
    for tapered in [true, false] {
        let (mut counts, mut off_normal) = (Vec::new(), Vec::new());
        for (i, tuning) in tunings.iter().enumerate() {
            let tree = hollow_box(tapered);
            // 24 mm cube + 2·2 mm padding over 2^5 cells: 0.875 mm step vs 0.6 mm walls.
            let cube = SfccWorldCube { min_x: -12.0, min_y: -12.0, min_z: -12.0, size: 24.0 };
            let r = run_sfcc_pipeline(&tree, &cube, tuning);
            let m = &r.manifold;
            assert!(
                m.open_edges == 0 && m.components == 2 && m.euler_per_component.iter().all(|&e| e == 2),
                "tapered={tapered} tuning#{i}: outer + cavity shells must both be closed spheres, got components={} euler={:?} open={} tris={}",
                m.components,
                m.euler_per_component,
                m.open_edges,
                r.tris.len() / 3
            );
            counts.push(r.tris.len() / 3);
            // Every face is planar: a triangle off its face's normal bridges an
            // edge (untagged creases under the warp, docs/feat/sfcc/multi-sheet-cells.md).
            let (mut area, mut off) = (0.0, 0.0);
            for t in r.tris.chunks_exact(3) {
                let p = [t[0], t[1], t[2]].map(|i| [0, 1, 2].map(|k| r.verts[i as usize * 8 + k] as f64));
                let (u, v) = ([0, 1, 2].map(|k| p[1][k] - p[0][k]), [0, 1, 2].map(|k| p[2][k] - p[0][k]));
                let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
                let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                let (_, g) = tree.grad([0, 1, 2].map(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.0));
                let lg = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
                area += l / 2.0;
                if l > 0.0 && (n[0] * g[0] + n[1] * g[1] + n[2] * g[2]) < l * lg * 1f64.to_radians().cos() {
                    off += l / 2.0;
                }
            }
            off_normal.push(off / area);
        }
        // Multi-sheet cells keep the warped walls in coarse cells, and their
        // crease points keep the box edges sharp (7% of the area off-normal
        // before). The unwarped box goes through the certified box-discovery
        // path, which splits first.
        if tapered {
            assert!(counts[2] * 3 < counts[0] * 2, "multi-sheet cells must cut the tapered box by a third: {counts:?}");
            assert!(off_normal[2] < 0.005, "multi-sheet cells must keep the box faces planar: {off_normal:?}");
        }
    }
}
