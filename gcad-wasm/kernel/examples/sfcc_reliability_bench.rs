//! Fixed-scene native timing gate. Run with cargo run --release -p gcad-kernel
//! --example sfcc_reliability_bench. Compare medians using the same build/CPU.
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline_profiled, PipelineTuning, SfccWorldCube};
use std::time::Instant;

fn prepared(mut tree: CsgNode) -> CsgNode {
    fn attach(node: &mut CsgNode, first: &mut usize) {
        match node {
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

fn main() {
    let sphere = |r, pos| sdf::leaf_at(Shape::Sphere { r }, pos);
    let box_node = || sdf::leaf_at(Shape::Cuboid { half: [10.; 3] }, [0.; 3]);
    let scenes = [
        ("box", box_node()),
        ("sphere", sphere(4., [0.; 3])),
        ("carved-box", sdf::subtract(box_node(), sphere(6., [5.; 3]))),
        ("hidden-sphere", sphere(0.01, [0.3; 3])),
    ];
    let cube = SfccWorldCube { min_x: -10., min_y: -10., min_z: -10., size: 20. };
    let tuning = PipelineTuning::default();
    for (name, tree) in scenes {
        let tree = prepared(tree);
        let mut times = Vec::new();
        for run in 0..6 {
            let start = Instant::now();
            let r = run_sfcc_pipeline_profiled(&tree, &cube, &tuning, &|| start.elapsed().as_secs_f64() * 1000.);
            let ms = start.elapsed().as_secs_f64() * 1000.;
            if run > 0 {
                times.push(ms);
            }
            if run == 5 {
                times.sort_by(f64::total_cmp);
                println!(
                    "{name}: median_ms={:.3} assemble_ms={:.3} leaves={} tris={} degenerate={}",
                    times[2],
                    r.phase_assemble_ms,
                    r.stats.leaves,
                    r.tris.len() / 3,
                    r.stats.degenerate_cells
                );
            }
        }
    }
}
