//! Step 4 consensus common baseline/candidate harness. Optional evidence is not timing.
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
    let sheets = sdf::union(vec![
        box_at([2.125, 4., 4.], [-1.875, 0., 0.]),
        sdf::intersect(vec![box_at([1.75, 4., 4.], [2.25, 0., 0.]), box_at([2.375, 4., 4.], [-1.625, 0., 0.])]),
    ]);
    let mut rotated = box_at([3., 2., 1.], [0.25, -0.5, 0.75]);
    if let CsgNode::Leaf(leaf) = &mut rotated {
        let (s, c) = 0.37_f64.sin_cos();
        leaf.sim.r = [c, -s, 0., s, c, 0., 0., 0., 1.];
        leaf.sim.s = 1.25;
        leaf.sim.t = [0.125, -0.25, 0.5];
    }
    let opaque = sdf::union(vec![sphere(9., [0.; 3]),
        sdf::union_smooth(vec![sphere(1., [0.; 3]), sphere(1., [0.25, 0., 0.])],
            gcad_kernel::primitives::smin::SminMode::Round, 0.1, 2.), sphere(9., [0.; 3])]);
    let scenes = [
        ("represented-rotation", rotated, cube, PipelineTuning::default()),
        ("opaque-separated-repeats", opaque, cube, PipelineTuning::default()),
        ("default-box-flips", box_at([3.; 3], [0.; 3]), cube, PipelineTuning::default()),
        ("clipped-box", sdf::intersect(vec![box_at([1.; 3], [0.; 3]), box_at([2.25, 4., 4.], [-1.75, 0., 0.])]),
            SfccWorldCube { min_x: -4., min_y: -4., min_z: -4., size: 8. }, PipelineTuning::default()),
        ("three-sheets-coarse", sheets.clone(), SfccWorldCube { min_x: -128., min_y: -128., min_z: -128., size: 256. }, PipelineTuning::default()),
        ("three-sheets-fine", sheets, SfccWorldCube { min_x: -5., min_y: -5., min_z: -5., size: 10. }, PipelineTuning::default()),
        ("nonadjacent-duplicates", sdf::union((0..16).map(|i| sphere(9., [if i % 2 == 0 {0.} else {0.125}, 0., 0.])).collect()), cube, PipelineTuning::default()),
        ("unique-16", sdf::union((0..16).map(|i| sphere(9., [i as f64 / 128., 0., 0.])).collect()), cube, PipelineTuning::default()),

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
            let (r, trace) = gcad_kernel::sfcc::diagnosis::capture(name, 500_000, || run_sfcc_pipeline_profiled(&tree, &cube, &tuning, &|| {
                start.elapsed().as_secs_f64() * 1000.
            }));
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
            let phases = [r.phase_feature_ms, r.phase_octree_ms, r.phase_contour_ms, r.phase_cellmesh_ms, r.phase_assemble_ms, r.phase_octree_decide_ms, r.phase_octree_apply_ms];
            println!("{{\"scene\":\"{name}\",\"sample\":{sample},\"{kind}\":{elapsed:.6},\"leaves\":{},\"triangles\":{},\"components\":{},\"degenerate\":{},\"failed\":{},\"unresolved\":{},\"ok\":{},\"decided\":{decided},\"counters\":{counters:?},\"phase_ms\":{phases:?}}}", r.stats.leaves, r.tris.len()/3, r.manifold.components, r.stats.degenerate_cells, r.stats.failed_cells, r.validation.unresolved_cells, r.ok);
            if let Ok(directory) = std::env::var("SFCC_COST_EVIDENCE") {
                let dir = std::path::Path::new(&directory).join(name);
                std::fs::create_dir_all(&dir).unwrap();
                let mut geometry = Vec::new();
                geometry.extend_from_slice(&(r.verts.len() as u64).to_le_bytes());
                for value in &r.verts { geometry.extend_from_slice(&value.to_bits().to_le_bytes()); }
                geometry.extend_from_slice(&(r.tris.len() as u64).to_le_bytes());
                for value in &r.tris { geometry.extend_from_slice(&value.to_le_bytes()); }
                std::fs::write(dir.join("geometry.bin"), geometry).unwrap();
                let mut features = Vec::new();
                for edge in &r.feature_edges {
                    for v in edge.vertices { features.extend_from_slice(&v.to_le_bytes()); }
                    features.extend_from_slice(&(edge.interval.curve_id as u64).to_le_bytes());
                    features.extend_from_slice(&edge.interval.start.to_bits().to_le_bytes());
                    features.extend_from_slice(&edge.interval.end.to_bits().to_le_bytes());
                }
                std::fs::write(dir.join("features.bin"), features).unwrap();
                std::fs::write(dir.join("validation.txt"), format!("{:?}\n", r.validation)).unwrap();
                if std::env::var_os("SFCC_COST_MESH_ONLY").is_none() {
                let leaves = gcad_kernel::sfcc::worker::prepare(&tree, &cube, &tuning);
                let n = gcad_kernel::sfcc::worker::decode_tagged_leaves(&leaves).1.len();
                let decisions = gcad_kernel::sfcc::worker::decide_partition_bytes(&tree, &cube, &tuning, &leaves, 0, n);
                std::fs::write(dir.join("leaves.bin"), leaves).unwrap();
                std::fs::write(dir.join("decisions.bin"), decisions).unwrap();
                }
                #[cfg(feature = "sfcc-profile")]
                {
                    assert_eq!(trace.dropped, 0);
                    let events = trace.records.iter().filter(|r| !matches!(r.event, gcad_kernel::sfcc::diagnosis::Event::Mesh { .. })).map(|r| format!("{:?}\n", r)).collect::<String>();
                    std::fs::write(dir.join("trace.txt"), events).unwrap();
                }
            }
            std::hint::black_box(r);
        }
    }
}
