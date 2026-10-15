//! Release costs against the pre-discovery source using identical geometry and tuning.
//! Usage: [fast | all | scene-name] [samples=5] [warmups=1]. Output is JSON Lines.
//! `existing-48-blob 1 0` takes about 110 seconds; it is excluded from `fast`.
//! Build separately with `sfcc-profile` for one structural sample, never timing evidence.
use gcad_kernel::sdf::{self, CsgNode, Shape};
use gcad_kernel::sfcc::feature_set::build_leaf_strata;
#[cfg(feature = "sfcc-profile")]
use gcad_kernel::sfcc::pipeline::run_sfcc_pipeline_profiled;
#[cfg(not(feature = "sfcc-profile"))]
use gcad_kernel::sfcc::pipeline::run_sfcc_pipeline;
use gcad_kernel::sfcc::pipeline::{PipelineTuning, SfccWorldCube};
use std::time::Instant;
fn sphere(r: f64, p: [f64; 3]) -> CsgNode {
    sdf::leaf_at(Shape::Sphere { r }, p)
}
fn box_at(half: [f64; 3], pos: [f64; 3]) -> CsgNode {
    sdf::leaf_at(Shape::Cuboid { half }, pos)
}
fn prepared(mut t: CsgNode) -> CsgNode {
    fn attach(t: &mut CsgNode, first: &mut usize) {
        match t {
            CsgNode::Leaf(l) => {
                l.strata = build_leaf_strata(l, l.index, *first);
                *first += l.strata.len();
            }
            CsgNode::Min(ch) | CsgNode::Max(ch) | CsgNode::Blend { children: ch, .. } => {
                for c in ch {
                    attach(c, first)
                }
            }
        }
    }
    t.assign_leaf_indices();
    attach(&mut t, &mut 0);
    t
}
fn main() {
    let cube = SfccWorldCube {
        min_x: -10.,
        min_y: -10.,
        min_z: -10.,
        size: 20.,
    };
    let large = SfccWorldCube {
        min_x: -100.,
        min_y: -100.,
        min_z: -100.,
        size: 200.,
    };
    let mut buried = vec![box_at([10.; 3], [0.; 3])];
    for i in 0..14 {
        buried.push(sphere(0.1, [i as f64 * 0.1, 0., 0.]));
    }
    let hidden = || {
        vec![
            box_at([50., 100., 100.], [-50., 0., 0.]),
            sphere(0.01650382162580301, [0.04125955406450752, 1.53, 1.53]),
        ]
    };
    let mut many_hidden = hidden();
    for i in 0..14 {
        many_hidden.push(sphere(0.1, [-50., i as f64, 0.]));
    }
    let mut blob = Vec::new();
    for i in 0..4 {
        for j in 0..4 {
            for k in 0..3 {
                blob.push(sphere(
                    1.6,
                    [
                        (i as f64 - 1.5) * 2.6,
                        (j as f64 - 1.5) * 2.6,
                        (k as f64 - 1.) * 2.6,
                    ],
                ));
            }
        }
    }
    let scenes = [
        (
            "box",
            box_at([10.; 3], [0.; 3]),
            cube,
            PipelineTuning::default(),
        ),
        (
            "sphere",
            sphere(9., [0.; 3]),
            cube,
            PipelineTuning::default(),
        ),
        (
            "ordinary-seam",
            sdf::subtract(box_at([10.; 3], [0.; 3]), sphere(6., [5.; 3])),
            cube,
            PipelineTuning::default(),
        ),
        (
            "hidden-box-sphere",
            sdf::union(hidden()),
            large,
            PipelineTuning::default(),
        ),
        (
            "duplicates-4",
            sdf::union(vec![sphere(9., [0.; 3]); 4]),
            cube,
            PipelineTuning::default(),
        ),
        (
            "duplicates-16",
            sdf::union(vec![sphere(9., [0.; 3]); 16]),
            cube,
            PipelineTuning::default(),
        ),
        (
            "small-seam",
            sdf::subtract(box_at([3.; 3], [0.; 3]), sphere(2., [2.; 3])),
            cube,
            PipelineTuning::default(),
        ),
        (
            "buried-15",
            sdf::union(buried),
            cube,
            PipelineTuning::default(),
        ),
        (
            "existing-48-blob",
            sdf::union_smooth(
                blob,
                gcad_kernel::primitives::smin::SminMode::Round,
                0.9,
                2.,
            ),
            SfccWorldCube {
                min_x: -8.,
                min_y: -8.,
                min_z: -6.,
                size: 16.,
            },
            PipelineTuning {
                depth_min: 4,
                depth_max: 7,
                ..Default::default()
            },
        ),
        (
            "many-hard-hidden-16",
            sdf::union(many_hidden),
            large,
            PipelineTuning::default(),
        ),
    ];

    let mut args = std::env::args().skip(1);
    let filter = args.next().unwrap_or_else(|| "fast".into());
    let samples = args
        .next()
        .map(|s| s.parse::<usize>().expect("sample count"))
        .unwrap_or(5);
    let warmups = args
        .next()
        .map(|s| s.parse::<usize>().expect("warmup count"))
        .unwrap_or(1);
    assert!(samples > 0);
    assert!(
        filter == "fast" || filter == "all" || scenes.iter().any(|s| s.0 == filter),
        "unknown scene"
    );
    for (name, tree, cube, tuning) in scenes {
        if !(filter == name || filter == "all" || filter == "fast" && name != "existing-48-blob") {
            continue;
        }
        let tree = prepared(tree);
        #[cfg(not(feature = "sfcc-profile"))]
        for _ in 0..warmups {
            std::hint::black_box(run_sfcc_pipeline(&tree, &cube, &tuning));
        }
        #[cfg(feature = "sfcc-profile")]
        let (samples, _) = (1, warmups); // Exactly one structural run, never a timing sample.
        for sample in 0..samples {
            #[cfg(feature = "sfcc-profile")]
            gcad_kernel::sfcc::perf::reset();
            let start = Instant::now();
            #[cfg(not(feature = "sfcc-profile"))]
            let r = run_sfcc_pipeline(&tree, &cube, &tuning);
            #[cfg(feature = "sfcc-profile")]
            let r = run_sfcc_pipeline_profiled(&tree, &cube, &tuning, &|| {
                start.elapsed().as_secs_f64() * 1000.
            });
            let elapsed = start.elapsed().as_secs_f64() * 1000.;
            #[cfg(not(feature = "sfcc-profile"))]
            let (kind, decided, counters): (&str, String, Vec<usize>) =
                ("elapsed_ms", "null".into(), Vec::new());
            #[cfg(feature = "sfcc-profile")]
            let (kind, decided, counters) = (
                "diagnostic_ms",
                r.octree_rounds
                    .iter()
                    .map(|r| r.0)
                    .sum::<usize>()
                    .to_string(),
                gcad_kernel::sfcc::perf::snapshot().to_vec(),
            );
            println!("{{\"scene\":\"{name}\",\"sample\":{sample},\"{kind}\":{elapsed:.6},\"leaves\":{},\"triangles\":{},\"components\":{},\"degenerate\":{},\"failed\":{},\"unresolved\":{},\"ok\":{},\"decided\":{decided},\"counters\":{counters:?}}}", r.stats.leaves, r.tris.len()/3, r.manifold.components, r.stats.degenerate_cells, r.stats.failed_cells, r.validation.unresolved_cells, r.ok);
            std::hint::black_box(r);
        }
    }
}
