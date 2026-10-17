//! Step 3 candidate B: independent obligations and bounded counterexamples.
//! These are diagnostics, not a replacement coverage certificate.
#![cfg(feature = "serde")]

#[cfg(feature = "sfcc-profile")]
use gcad_kernel::math::grid::cell_aabb;
use gcad_kernel::math::grid::{make_lattice, point_to_world};
use gcad_kernel::scene_bridge::build_csg_tree_from_json;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::refine_criteria::{discovery_guard, make_probe, DiscoveryCheck};
use gcad_kernel::sfcc::worker::{decode_tagged_leaves, prepare};
use serde_json::{json, Value};

fn sheets() -> Value {
    json!({"kind":"union","children":[
        {"kind":"box","pos":[-1.875,0,0],"half":[2.125,4,4]},
        {"kind":"intersect","lh":{"kind":"box","pos":[2.25,0,0],"half":[1.75,4,4]},
         "rh":{"kind":"box","pos":[-1.625,0,0],"half":[2.375,4,4]}}]})
}

fn clipped_box() -> Value {
    json!({"kind":"intersect","lh":{"kind":"box","pos":[0,0,0],"half":[1,1,1]},
        "rh":{"kind":"box","pos":[-1.75,0,0],"half":[2.25,4,4]}})
}

fn cube(min: f64, size: f64) -> SfccWorldCube {
    SfccWorldCube {
        min_x: min,
        min_y: min,
        min_z: min,
        size,
    }
}

fn save(name: &str, value: &Value) {
    if let Ok(dir) = std::env::var("SFCC_COVERAGE_B_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/{name}.json"),
            serde_json::to_string_pretty(value).unwrap() + "\n",
        )
        .unwrap();
    }
}

fn actual_inputs(tree: &gcad_kernel::sdf::CsgNode) -> Vec<Value> {
    use gcad_kernel::sdf::{CsgNode, Shape};
    let mut rows = Vec::new();
    fn visit(tree: &CsgNode, rows: &mut Vec<Value>) {
        match tree {
            CsgNode::Leaf(l) => {
                let dimensions = match l.shape {
                    Shape::Cuboid { half } => half,
                    Shape::Sphere { r } => [r, 0., 0.],
                    _ => unreachable!(),
                };
                rows.push(
                    json!({"matrix":l.sim.r,"scale":l.sim.s,"translation":l.sim.t,
                    "position":l.pos,"sign":l.sign,"dimensions":dimensions}),
                );
            }
            CsgNode::Min(c) | CsgNode::Max(c) => {
                for child in c {
                    visit(child, rows);
                }
            }
            CsgNode::Blend { .. } => unreachable!(),
        }
    }
    visit(tree, &mut rows);
    rows
}

#[test]
fn opposite_endpoint_signs_and_individual_charts_do_not_prove_one_root() {
    let tree = build_csg_tree_from_json(&sheets().to_string()).unwrap();
    let lat = make_lattice(8, 0., 0., 0., 1.);
    let p = make_probe(
        &lat,
        &tree,
        |x, y, z| tree.f(point_to_world(&lat, x, y, z)),
        0,
        0,
        0,
        0,
    );
    assert_eq!(
        discovery_guard(&tree, &p),
        DiscoveryCheck::NeedsSplit
    );
    // All coordinates, parameters and roots here are exact dyadic values.
    for x in [0., 0.25, 0.375, 0.5, 0.625, 0.75, 1.] {
        let expected = (x - 0.25_f64).min((0.5 - x).max(x - 0.75));
        assert_eq!(tree.f([x, 0.5, 0.5]), expected);
    }
    let mut root = [0.; 6];
    gcad_kernel::sfcc::face_contour::canonical_edge_root(
        &tree, 0., 0.5, 0.5, 1., 0.5, 0.5, -0.25, 0.25, 0., &mut root,
    );
    assert!(root[0] == 0.25 || root[0] == 0.5 || root[0] == 0.75);
    save(
        "exact-local-edge",
        &json!({"scene":sheets(),"cell":[0,0,0,1,1,1],
        "actualRoots":[0.25,0.5,0.75],"orientations":[1,-1,1],"guard":"NeedsSplit",
        "singleCanonicalRoot":root,"actualInputs":actual_inputs(&tree)}),
    );
}

#[test]
fn represented_matrix_carrier_is_not_the_declared_field() {
    let a = 1. + 2_f64.powi(-22);
    let scene = json!({"kind":"rotate","fwd":[a,0,0,0,1,0,0,0,1],
        "arg":{"kind":"sphere","pos":[0,0,0],"r":1}});
    let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
    let gcad_kernel::sdf::CsgNode::Leaf(l) = &tree else {
        unreachable!()
    };
    assert_eq!(l.strata.len(), 1);
    assert_eq!(l.strata[0].f(1., 0., 0.), 0.);
    assert_eq!(tree.f([1., 0., 0.]), 2_f64.powi(-22));
    save(
        "carrier-mismatch",
        &json!({"scene":scene,"actualInputs":actual_inputs(&tree),
        "point":[1,0,0],"carrierValue":0,"fieldValue":tree.f([1.,0.,0.])}),
    );
}

#[test]
fn ordinary_two_surface_crease_and_sphere_are_still_successful_controls() {
    for (name, scene, world, leaves, triangles) in [
        ("clipped-box", clipped_box(), cube(-4., 8.), 132, 656),
        (
            "sphere-success",
            json!({"kind":"sphere","pos":[0,0,0],"r":9}),
            cube(-10., 20.),
            2763,
            6776,
        ),
        ("three-sheets-fine", sheets(), cube(-5., 10.), 4372, 11608),
    ] {
        let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
        let r = run_sfcc_pipeline(&tree, &world, &PipelineTuning::default());
        assert!(r.ok, "{name}: {:?}", r.validation);
        assert_eq!(r.validation.unresolved_cells, 0);
        assert_eq!(r.stats.leaves, leaves);
        if name=="clipped-box"||name=="sphere-success" {
            assert_eq!(r.validation.local_coverage.certified_cells,leaves);
            assert!(r.validation.local_coverage.unresolved.is_empty());
        }
        assert_eq!(r.tris.len() / 3, triangles);
        assert_eq!(
            r.manifold.components,
            if name == "three-sheets-fine" { 2 } else { 1 }
        );
        save(
            name,
            &json!({"scene":scene,"leaves":leaves,"triangles":triangles,"ok":r.ok,
            "components":r.manifold.components,"unresolved":r.validation.unresolved_cells}),
        );
    }
}

fn canonical(verts: &[f32], tris: &[u32]) -> Vec<Vec<u32>> {
    let mut out: Vec<_> = tris
        .chunks_exact(3)
        .map(|t| {
            let v: Vec<_> = t
                .iter()
                .map(|&i| {
                    verts[i as usize * 8..i as usize * 8 + 8]
                        .iter()
                        .map(|v| v.to_bits())
                        .collect::<Vec<_>>()
                })
                .collect();
            (0..3)
                .map(|i| {
                    v[i].iter()
                        .chain(&v[(i + 1) % 3])
                        .chain(&v[(i + 2) % 3])
                        .copied()
                        .collect::<Vec<_>>()
                })
                .min()
                .unwrap()
        })
        .collect();
    out.sort();
    out
}

#[test]
fn raw_native_workers_preserve_positive_seam_and_coarse_obstruction() {
    use gcad_kernel::sfcc::worker::{merge, merge_partials, mesh_partition};
    for (name, scene, world, recovery) in [
        ("clipped-box", clipped_box(), cube(-4., 8.), false),
        ("three-sheets-coarse", sheets(), cube(-128., 256.), true),
    ] {
        let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
        let tuning = PipelineTuning::default();
        let serial = run_sfcc_pipeline(&tree, &world, &tuning);
        let bytes = prepare(&tree, &world, &tuning);
        let (lat, _) = decode_tagged_leaves(&bytes);
        let tol = gcad_kernel::tolerances::resolve_tolerances(
            &gcad_kernel::tuning::SfccTuning::default(),
            (3. * world.size * world.size).sqrt(),
        );
        let (features, _) = gcad_kernel::sfcc::feature_set::compile_feature_set(&tree, &tol);
        let expected = canonical(&serial.verts, &serial.tris);
        let mut rows = Vec::new();
        for count in [1, 2, 4, 8] {
            let mut parts: Vec<_> = (0..count)
                .map(|i| mesh_partition(&tree, &world, &tuning, &bytes, i, count))
                .collect();
            for reversed in [false, true] {
                if reversed {
                    parts.reverse();
                }
                let raw = merge_partials(&tree, &features, &lat, &tuning, &parts);
                assert!(
                    !raw.serial_recovery,
                    "raw gate cannot invoke serial recovery"
                );
                assert_eq!(raw.failed_cells, 0);
                assert_eq!(raw.validation, serial.validation);
                assert_eq!(canonical(&raw.verts, &raw.tris), expected);
                let public = merge(&tree, &world, &tuning, &parts);
                assert_eq!(public.serial_recovery, recovery);
                assert_eq!(public.validation, serial.validation);
                assert_eq!(canonical(&public.verts, &public.tris), expected);
                rows.push(json!({"count":count,"reversed":reversed,"rawRecovery":raw.serial_recovery,
                    "publicRecovery":public.serial_recovery,"components":raw.manifold.components,
                    "fallbacks":raw.feature_cell_fallbacks,"unresolved":raw.validation.unresolved_cells}));
            }
        }
        save(&format!("native-workers-{name}"), &json!(rows));
    }
}

#[cfg(feature = "sfcc-profile")]
#[test]
fn locate_every_accepted_three_sheet_cell_in_coarse_full_export() {
    use gcad_kernel::sfcc::diagnosis::{capture, CellId, Event};
    let scene = sheets();
    let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
    let world = cube(-128., 256.);
    let tuning = PipelineTuning::default();
    let (r, trace) = capture("three-sheets-coarse", 100_000, || {
        run_sfcc_pipeline(&tree, &world, &tuning)
    });
    assert_eq!(trace.dropped, 0);
    let bytes = prepare(&tree, &world, &tuning);
    let (lat, cells) = decode_tagged_leaves(&bytes);
    for (level,ix,iy,iz) in [(7,64,63,63),(7,64,63,64),(7,64,64,63),(7,64,64,64),
        (8,128,126,130),(8,128,127,130),(8,128,128,130),(8,128,129,130),(8,128,130,130)] {
        let old=cell_aabb(&lat,level,ix,iy,iz);
        let y=old[1]+(old[4]-old[1])/3.;let z=old[2]+(old[5]-old[2])*0.4;
        assert!(cells.iter().any(|c|{
            let b=cell_aabb(&lat,c.level,c.ix,c.iy,c.iz);
            c.degenerate&&b[0]<0.25&&0.75<b[3]&&b[1]<y&&y<b[4]&&b[2]<z&&z<b[5]
        }),"original responsible cell or its descendants must remain unresolved");
    }
    let mut rows = Vec::new();
    for c in cells {
        let b = cell_aabb(&lat, c.level, c.ix, c.iy, c.iz);
        if !(b[0] < 0.25 && b[3] > 0.75 && b[1] > -3. && b[4] < 3. && b[2] > -3. && b[5] < 3.) {
            continue;
        }
        let cid = CellId::from(&c);
        let decisions: Vec<_> = trace
            .records
            .iter()
            .filter_map(|rec| match rec.event {
                Event::Decision {
                    cell,
                    reason,
                    split,
                    ..
                } if cell == cid => Some(json!({"reason":reason,"split":split,"round":rec.round})),
                _ => None,
            })
            .collect();
        let meshes: Vec<_> = trace.records.iter().filter_map(|rec| match &rec.event {
            Event::Mesh {cell,kind,triangles,fallback} if CellId::from(cell) == cid =>
                Some(json!({"kind":kind,"triangles":triangles,"fallback":fallback,"round":rec.round})),
            _=>None,
        }).collect();
        let unresolved = trace
            .records
            .iter()
            .any(|rec| matches!(&rec.event,Event::Unresolved {cell,..} if CellId::from(cell)==cid));
        rows.push(json!({"cell":[c.level,c.ix as u32,c.iy as u32,c.iz as u32],"bounds":b,
            "degenerate":c.degenerate,"featureCurve":c.feature_curve,"featureCorner":c.feature_corner,
            "decisions":decisions,"unresolved":unresolved,"meshes":meshes}));
    }
    eprintln!(
        "coarse sheets leaves={} components={} unresolved={} targeted={}",
        r.stats.leaves,
        r.manifold.components,
        r.validation.unresolved_cells,
        rows.len()
    );
    assert!(rows.iter().all(|r|r["degenerate"]==true&&r["unresolved"]==true),
        "every responsible final region must be explicitly unresolved");
    assert!(r.validation.unresolved_cells>=rows.len());
    assert!(!r.ok);
    assert!(
        !rows.is_empty(),
        "fixture must include actual production cells containing all three sheets"
    );
    let triangles: Vec<_> = r
        .tris
        .chunks_exact(3)
        .map(|t| {
            t.iter()
                .map(|&i| {
                    [
                        r.verts[i as usize * 8] as f64,
                        r.verts[i as usize * 8 + 1] as f64,
                        r.verts[i as usize * 8 + 2] as f64,
                    ]
                })
                .collect::<Vec<_>>()
        })
        .collect();
    save(
        "coarse-local-ledger",
        &json!({"scene":scene,"cube":[-128,-128,-128,256],
        "lattice":{"origin":[lat.origin_x,lat.origin_y,lat.origin_z],"size":lat.world_size,"step":lat.step},
        "leaves":r.stats.leaves,"triangles":r.tris.len()/3,"components":r.manifold.components,
        "unresolved":r.validation.unresolved_cells,"failed":r.stats.failed_cells,"ok":r.ok,"targetedCells":rows,
        "assembledTriangles":triangles,"actualInputs":actual_inputs(&tree)}),
    );
}

#[cfg(feature = "sfcc-profile")]
#[test]
fn every_three_sheet_cell_reconstructs_all_sheets_or_is_locally_unresolved() {
    use gcad_kernel::sfcc::diagnosis::{capture, CellId, Event};
    let tree = build_csg_tree_from_json(&sheets().to_string()).unwrap();
    let world = cube(-128., 256.);
    let tuning = PipelineTuning::default();
    let (_, trace) = capture("desired-local-coverage", 100_000, || {
        run_sfcc_pipeline(&tree, &world, &tuning)
    });
    assert_eq!(trace.dropped, 0);
    let (lat, cells) = decode_tagged_leaves(&prepare(&tree, &world, &tuning));
    let mut checked = 0;
    for c in cells {
        let b = cell_aabb(&lat, c.level, c.ix, c.iy, c.iz);
        if !(b[0] < 0.25 && b[3] > 0.75 && b[1] > -3. && b[4] < 3. && b[2] > -3. && b[5] < 3.) {
            continue;
        }
        checked += 1;
        let cid = CellId::from(&c);
        if trace
            .records
            .iter()
            .any(|rec| matches!(&rec.event,Event::Unresolved {cell,..} if CellId::from(cell)==cid))
        {
            continue;
        }
        let mut seen = [false; 3];
        for rec in &trace.records {
            if let Event::Mesh {
                cell, triangles, ..
            } = &rec.event
            {
                if CellId::from(cell) != cid {
                    continue;
                }
                for triangle in triangles {
                    for (i, x) in [0.25, 0.5, 0.75].iter().enumerate() {
                        seen[i] |= triangle.iter().all(|p| (p[0] - x).abs() < 0.01);
                    }
                }
            }
        }
        assert!(
            seen.iter().all(|v| *v),
            "{cid:?} accepted despite missing sheets: {seen:?}"
        );
    }
    assert!(checked > 0);
}
