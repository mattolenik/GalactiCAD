//! Step 1: actual first branches, followed by explicitly counterfactual replay.
#![cfg(all(feature = "sfcc-profile", feature = "serde"))]
#[path = "support/discovery.rs"]
mod support;
use gcad_kernel::math::grid::{cell_aabb, point_to_world, CELL_EDGES};
use gcad_kernel::scene_bridge::build_csg_tree_from_json;
use gcad_kernel::sfcc::diagnosis::{capture, triangle_exactly_degenerate, CellId, Event, Trace};
use gcad_kernel::sfcc::pipeline::{
    run_sfcc_pipeline, PipelineTuning, SfccPipelineResult, SfccWorldCube,
};
use gcad_kernel::sfcc::refine_criteria::*;
use gcad_kernel::sfcc::worker::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use support::*;

fn save(name: &str, value: &Value) {
    if let Ok(dir) = std::env::var("SFCC_DIAG_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/{name}.json"),
            serde_json::to_string_pretty(value).unwrap() + "\n",
        )
        .unwrap();
    }
}
fn id(c: CellId) -> Value {
    json!([c.0, c.1, c.2, c.3])
}
fn stats(r: &SfccPipelineResult) -> Value {
    json!({"leaves":r.stats.leaves,"components":r.manifold.components,"unresolved":r.validation.unresolved_cells,
        "failed":r.stats.failed_cells,"degenerate":r.stats.degenerate_cells,"rounds":r.stats.re_refine_rounds,
        "featureCurves":r.stats.feature_curves,"featureEdges":r.feature_edges.len(),"featureFallbacks":r.stats.feature_cell_fallbacks,"ok":r.ok,
        "triangles":r.tris.len()/3,"validation":format!("{:?}",r.validation)})
}
fn same(a: &SfccPipelineResult, b: &SfccPipelineResult) {
    assert_eq!(a.verts, b.verts);
    assert_eq!(a.tris, b.tris);
    assert_eq!(a.feature_edges, b.feature_edges);
    assert_eq!(a.validation, b.validation);
    assert_eq!(stats(a), stats(b));
}
// Persistent predicate workspaces must be equally warm for allocation counters.
fn observed_run(
    name: &str,
    tree: &gcad_kernel::sdf::CsgNode,
    cube: &SfccWorldCube,
    tuning: &PipelineTuning,
) -> (SfccPipelineResult, Trace) {
    let _ = run_sfcc_pipeline(tree, cube, tuning);
    gcad_kernel::sfcc::perf::reset();
    let baseline = run_sfcc_pipeline(tree, cube, tuning);
    let work = gcad_kernel::sfcc::perf::snapshot();
    gcad_kernel::sfcc::perf::reset();
    let (result, trace) = capture(name, 250_000, || run_sfcc_pipeline(tree, cube, tuning));
    assert_eq!(
        gcad_kernel::sfcc::perf::snapshot(),
        work,
        "observer changed production counters"
    );
    same(&baseline, &result);
    reconcile(&trace, &result);
    (result, trace)
}
fn first_reason_counts(trace: &Trace) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::new();
    for rec in &trace.records {
        if let Event::Unresolved { cell, .. } = &rec.event {
            let reason = trace
                .records
                .iter()
                .rev()
                .find_map(|d| match d.event {
                    Event::Decision {
                        cell: id,
                        reason,
                        split: true,
                        ..
                    } if d.export == rec.export
                        && d.round == rec.round
                        && id == CellId::from(cell) =>
                    {
                        Some(reason)
                    }
                    _ => None,
                })
                .expect("every unresolved fixture cell must have an executed first rejection");
            *counts.entry(reason).or_insert(0) += 1;
        }
    }
    counts
}
fn reconcile(trace: &Trace, r: &SfccPipelineResult) {
    assert_eq!(trace.dropped, 0, "truncated evidence is incomplete");
    let mut rounds = BTreeMap::new();
    let mut cells: BTreeMap<(usize, u32), BTreeSet<CellId>> = BTreeMap::new();
    for rec in &trace.records {
        match &rec.event {
            Event::Round {
                degenerate,
                failed,
                failed_degenerate,
                final_round,
                ..
            } => {
                rounds.insert(
                    (rec.export, rec.round),
                    (*degenerate + *failed - *failed_degenerate, *final_round),
                );
            }
            Event::Unresolved { cell, .. } => {
                assert!(cells
                    .entry((rec.export, rec.round))
                    .or_default()
                    .insert(cell.into()));
            }
            _ => {}
        }
    }
    for (key, (count, final_round)) in rounds {
        assert_eq!(cells.get(&key).map_or(0, BTreeSet::len), count);
        if final_round {
            assert_eq!(r.validation.unresolved_cells, count);
        }
    }
}

// Independent analytic sphere witnesses; not the runtime sphere interval formula.
// Squared distance extrema over axis-aligned rectangles give exact real conditions;
// these f64 calculations are fixture evidence with comfortable margins, not a numeric proof.
fn sphere_range(lo: [f64; 3], hi: [f64; 3]) -> (f64, f64) {
    let mut low = 0.;
    let mut high = 0.;
    for a in 0..3 {
        let x = lo[a] - CENTER[a];
        let y = hi[a] - CENTER[a];
        let near = if x <= 0. && y >= 0. {
            0.
        } else {
            x.abs().min(y.abs())
        };
        low += near * near;
        high += (x * x).max(y * y);
    }
    (low - RADIUS * RADIUS, high - RADIUS * RADIUS)
}

#[test]
fn fine_hidden_all_actual_cells_are_attributed_and_replayed() {
    let (tree, cube) = hidden();
    let tuning = PipelineTuning {
        depth_max: 14,
        surface_tol_mm: 1e-5,
        ..Default::default()
    };
    let (observed, trace) = observed_run("hidden-fine", &tree, &cube, &tuning);
    reconcile(&trace, &observed);
    assert_eq!(observed.validation.unresolved_cells, 36);
    let last = trace
        .records
        .iter()
        .find(|r| {
            matches!(
                &r.event,
                Event::Round {
                    final_round: true,
                    ..
                }
            )
        })
        .unwrap();
    let Event::Round { lattice: lat, .. } = &last.event else {
        unreachable!()
    };
    let mut counts = BTreeMap::new();
    let mut rows = Vec::new();
    let mut secondary_edge_failures = 0;
    for rec in trace
        .records
        .iter()
        .filter(|r| r.export == last.export && r.round == last.round)
    {
        let Event::Unresolved { cell, failed } = &rec.event else {
            continue;
        };
        let cid = CellId::from(cell);
        let decisions: Vec<_> = trace
            .records
            .iter()
            .filter(|r| r.export == rec.export && r.round == rec.round)
            .filter_map(|r| {
                if let Event::Decision {
                    cell,
                    reason,
                    split,
                    curve,
                    corner,
                    ..
                } = r.event
                {
                    (cell == cid).then_some((reason, split, curve, corner))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(decisions.len(), 1);
        let (first, split, curve, corner) = decisions[0];
        assert!(split);
        assert!(!failed);
        assert_eq!((curve, corner), (cell.feature_curve, cell.feature_corner));
        *counts.entry(first).or_insert(0) += 1;
        let p = make_probe(
            lat,
            &tree,
            |x, y, z| tree.f(point_to_world(lat, x, y, z)),
            cell.level,
            cell.ix,
            cell.iy,
            cell.iz,
        );
        let bounds = cell_aabb(lat, cell.level, cell.ix, cell.iy, cell.iz);
        let point = |i: usize| [p.pts[3 * i], p.pts[3 * i + 1], p.pts[3 * i + 2]];
        let signs: Vec<_> = (0..8)
            .map(|i| sphere_range(point(i), point(i)).0 < 0.)
            .collect();
        let mut hidden_edges = Vec::new();
        let mut hidden_faces = Vec::new();
        for (i, [a, b]) in CELL_EDGES.iter().copied().enumerate() {
            if signs[a] == signs[b] {
                let (lo, hi) = sphere_range(point(a), point(b));
                if lo <= 0. && hi >= 0. {
                    hidden_edges
                        .push(json!({"edge":i,"minSquaredResidual":lo,"maxSquaredResidual":hi}));
                }
            }
        }
        for axis in 0..3 {
            for side in 0..2 {
                let first = side << axis;
                let last = first | (7 ^ (1 << axis));
                if (0..8)
                    .filter(|i| (i >> axis) & 1 == side)
                    .all(|i| signs[i] == signs[first])
                {
                    let (lo, hi) = sphere_range(point(first), point(last));
                    if lo <= 0. && hi >= 0. {
                        hidden_faces.push(json!({"axis":axis,"side":side,"minSquaredResidual":lo,"maxSquaredResidual":hi}));
                    }
                }
            }
        }
        assert_eq!(first, "stratum_normal_variation");
        assert!(trace.records.iter().any(
            |r| matches!(r.event, Event::Decision { cell, owner: Some(1), .. } if cell == cid)
        ));
        assert_eq!(
            discovery_guard(&tree, &p),
            DiscoveryCheck::NoDiscoveryRejection { opaque: false }
        );
        assert!(has_corner_sign_change(&p));
        assert!(hidden_edges.is_empty() && hidden_faces.is_empty());
        let strata = active_strata(&tree, &p, tree.grad_bound());
        assert_eq!(strata.len(), 1);
        assert_eq!(strata[0].id, 6);
        assert!(!stratum_normal_variation_ok(
            strata[0],
            &p,
            tuning.normal_variation_deg.to_radians().cos()
        ));
        let mut min_cos = 1.;
        let mut witness = (0, 0);
        for i in 0..9 {
            for j in i + 1..9 {
                let a: [f64; 3] = std::array::from_fn(|k| point(i)[k] - CENTER[k]);
                let b: [f64; 3] = std::array::from_fn(|k| point(j)[k] - CENTER[k]);
                let cosine = (0..3).map(|k| a[k] * b[k]).sum::<f64>()
                    / (a[0].hypot(a[1]).hypot(a[2]) * b[0].hypot(b[1]).hypot(b[2]));
                if cosine < min_cos {
                    min_cos = cosine;
                    witness = (i, j);
                }
            }
        }
        assert!(min_cos < tuning.normal_variation_deg.to_radians().cos());
        secondary_edge_failures += usize::from(!stratum_edge_crossings_ok(strata[0], &p));
        let replay:Vec<_>=strata.iter().map(|s|json!({"stratum":s.id,
            "normalPasses":stratum_normal_variation_ok(s,&p,tuning.normal_variation_deg.to_radians().cos()),
            "edgeDerivativePasses":stratum_edge_crossings_ok(s,&p)})).collect();
        let mut ancestry = Vec::new();
        let mut parent = cid.parent();
        while let Some(pid) = parent {
            let events: Vec<_> = trace
                .records
                .iter()
                .filter(|r| r.export == rec.export && r.round == rec.round)
                .filter_map(|r| match &r.event {
                    Event::Octree {
                        cell,
                        kind: "initial_descent",
                    } if *cell == pid => Some("initial-descent"),
                    Event::Split { cell, balance } if *cell == pid => Some(if *balance {
                        "balance-split"
                    } else {
                        "decision-split"
                    }),
                    _ => None,
                })
                .collect();
            assert_eq!(events.len(), 1, "missing actual parent subdivision {pid:?}");
            ancestry.push(json!({"cell":id(pid),"split":events[0]}));
            parent = pid.parent();
        }
        rows.push(json!({"export":rec.export,"round":rec.round,"cell":id(cid),"bounds":bounds,
            "firstExecutedReason":first,"replayIsSecondary":true,
            "analyticNormalWitness":{"pair":[witness.0,witness.1],"minCos":min_cos,"angleDegrees":min_cos.clamp(-1.,1.).acos().to_degrees()},"featureTags":[curve,corner],"originalSpherePath":[1],
            "discoveryReplay":format!("{:?}",discovery_guard(&tree,&p)),"rootCornerSignChange":has_corner_sign_change(&p),
            "sphereNegativeCorners":signs.iter().filter(|&&s|s).count(),"analyticSameSignEdges":hidden_edges,
            "analyticSameSignFaces":hidden_faces,"smoothReplay":replay,"ancestry":ancestry}));
    }
    assert_eq!(rows.len(), 36);
    assert_eq!(secondary_edge_failures, 21);
    eprintln!("hidden first branches: {counts:?}");
    save(
        "hidden-fine-ledger",
        &json!({"settings":format!("{tuning:?}"),"cube":format!("{cube:?}"),
        "lattice":{"origin":[lat.origin_x,lat.origin_y,lat.origin_z],"step":lat.step,"maxDepth":lat.max_depth},"stats":stats(&observed),"firstReasonCounts":counts,"dropped":trace.dropped,"cells":rows}),
    );
}

#[test]
fn depth_tolerance_and_quality_controls_are_separate_outcomes() {
    let (tree, cube) = hidden();
    let mut cases = Vec::new();
    let mut default_tol_mesh = None;
    for (name, t) in [
        ("default", PipelineTuning::default()),
        (
            "depth12-fine",
            PipelineTuning {
                depth_max: 12,
                surface_tol_mm: 1e-5,
                ..Default::default()
            },
        ),
        (
            "depth14-default-tolerance",
            PipelineTuning {
                depth_max: 14,
                ..Default::default()
            },
        ),
        (
            "depth14-fine",
            PipelineTuning {
                depth_max: 14,
                surface_tol_mm: 1e-5,
                ..Default::default()
            },
        ),
        (
            "depth14-no-normal",
            PipelineTuning {
                depth_max: 14,
                surface_tol_mm: 1e-5,
                normal_variation_deg: 180.,
                ..Default::default()
            },
        ),
        (
            "depth14-quality",
            PipelineTuning {
                depth_max: 14,
                surface_tol_mm: 1e-5,
                quality_triangulation: true,
                ..Default::default()
            },
        ),
    ] {
        let (r, tr) = observed_run(name, &tree, &cube, &t);
        reconcile(&tr, &r);
        if name == "depth14-default-tolerance" {
            default_tol_mesh = Some((r.verts.clone(), r.tris.clone()));
        }
        if name == "depth14-fine" {
            let (verts, tris) = default_tol_mesh.as_ref().unwrap();
            assert_ne!(&r.verts, verts);
            assert_ne!(&r.tris, tris);
        }
        if name == "depth14-no-normal" {
            assert_eq!(r.validation.unresolved_cells, 21);
        }
        if name == "default" {
            assert_eq!(r.validation.unresolved_cells, 4);
            assert_eq!(r.manifold.components, 1);
        }
        let final_round = tr
            .records
            .iter()
            .filter_map(|rec| match rec.event {
                Event::Round {
                    final_round: true, ..
                } => Some(rec.round),
                _ => None,
            })
            .max()
            .unwrap();
        let final_cells: Vec<_> = tr
            .records
            .iter()
            .filter(|rec| rec.round == final_round)
            .filter_map(|rec| match rec.event {
                Event::Unresolved { cell, .. } => Some(id((&cell).into())),
                _ => None,
            })
            .collect();
        let lattice = tr
            .records
            .iter()
            .find_map(|r| match r.event {
                Event::Round { lattice, .. } => Some(lattice),
                _ => None,
            })
            .unwrap();
        let data = json!({"name":name,"settings":format!("{t:?}"),"lattice":format!("{lattice:?}"),"stats":stats(&r),"firstReasonCounts":first_reason_counts(&tr),"finalCells":final_cells,
            "interpretation":"Whole-pipeline control; changed earlier leaf selection means counts are not predicted by fixed-cell replay."});
        eprintln!("control {data}");
        cases.push(data);
    }
    save("hidden-controls", &json!(cases));
}

fn components(r: &SfccPipelineResult) -> Vec<[f64; 6]> {
    fn root(parent: &mut [usize], i: usize) -> usize {
        if parent[i] != i {
            parent[i] = root(parent, parent[i]);
        }
        parent[i]
    }
    let mut parent: Vec<_> = (0..r.verts.len() / 8).collect();
    for tri in r.tris.chunks_exact(3) {
        let a = root(&mut parent, tri[0] as usize);
        for &v in &tri[1..] {
            let b = root(&mut parent, v as usize);
            parent[b] = a;
        }
    }
    let mut groups = BTreeMap::new();
    for &v in &r.tris {
        let v = v as usize;
        let k = root(&mut parent, v);
        let b = groups.entry(k).or_insert([
            f64::INFINITY,
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ]);
        for a in 0..3 {
            b[a] = b[a].min(r.verts[v * 8 + a] as f64);
            b[a + 3] = b[a + 3].max(r.verts[v * 8 + a] as f64);
        }
    }
    groups.into_values().collect()
}
fn lens_scene(r: f64, translation: [f64; 3], scale: f64, cavity: bool) -> String {
    let pos = |p: [f64; 3]| std::array::from_fn::<_, 3, _>(|a| translation[a] + p[a] * scale);
    let lens = json!({"kind":"intersect","lh":
        {"kind":"sphere","pos":pos([10.,0.,0.]),"r":r*scale},"rh":
        {"kind":"sphere","pos":pos([-10.,0.,0.]),"r":r*scale}});
    if cavity {
        json!({"kind":"subtract","lh":{"kind":"box","pos":pos([0.;3]),"half":([3.*scale;3])},"rh":lens}).to_string()
    } else {
        json!({"kind":"union","children":[{"kind":"box","pos":pos([-1.75,0.,0.]),"half":[1.25*scale,3.*scale,3.*scale]},lens]}).to_string()
    }
}

#[test]
fn bridge_lens_has_an_independent_production_outcome() {
    let mut results = Vec::new();
    for (name, r, translation, scale, phase, depth, cavity) in [
        ("lens", 10.01, [0.; 3], 1., [0.; 3], 8, false),
        ("lens-depth6", 10.01, [0.; 3], 1., [0.; 3], 6, false),
        ("lens-depth10", 10.01, [0.; 3], 1., [0.; 3], 10, false),
        (
            "lens-phase",
            10.01,
            [0.; 3],
            1.,
            [0.03, -0.02, 0.01],
            8,
            false,
        ),
        (
            "lens-translated",
            10.01,
            [7., -9., 11.],
            1.,
            [0.; 3],
            8,
            false,
        ),
        ("lens-scaled", 10.01, [0.; 3], 10., [0.; 3], 8, false),
        ("lens-near-tangent", 10.0001, [0.; 3], 1., [0.; 3], 8, false),
        ("lens-cavity", 10.01, [0.; 3], 1., [0.; 3], 8, true),
    ] {
        let scene = lens_scene(r, translation, scale, cavity);
        let tree = build_csg_tree_from_json(&scene).unwrap();
        let cube = SfccWorldCube {
            min_x: translation[0] + (-4. + phase[0]) * scale,
            min_y: translation[1] + (-4. + phase[1]) * scale,
            min_z: translation[2] + (-4. + phase[2]) * scale,
            size: 8. * scale,
        };
        let t = PipelineTuning {
            depth_max: depth,
            bounds_padding_mm: 2. * scale,
            surface_tol_mm: 0.01 * scale,
            curve_chord_tol_mm: 0.02 * scale,
            ..Default::default()
        };
        let (out, tr) = observed_run(name, &tree, &cube, &t);
        reconcile(&tr, &out);

        let b = components(&out);
        assert_eq!(b.len(), out.manifold.components);
        let lattice = tr
            .records
            .iter()
            .find_map(|r| match r.event {
                Event::Round { lattice, .. } => Some(lattice),
                _ => None,
            })
            .unwrap();
        let radial = (r * r - 100.).sqrt();
        let lens_aabb = [
            translation[0] - (r - 10.) * scale,
            translation[1] - radial * scale,
            translation[2] - radial * scale,
            translation[0] + (r - 10.) * scale,
            translation[1] + radial * scale,
            translation[2] + radial * scale,
        ];
        let local_unresolved = tr
            .records
            .iter()
            .filter(|rec| match rec.event {
                Event::Unresolved { cell, .. } => {
                    let b = cell_aabb(&lattice, cell.level, cell.ix, cell.iy, cell.iz);
                    (0..3).all(|a| b[a] <= lens_aabb[a + 3] && b[a + 3] >= lens_aabb[a])
                }
                _ => false,
            })
            .count();
        let lens_bounds: Vec<_> = b
            .iter()
            .filter(|b| b[0] > translation[0] - 0.1 * scale && b[3] < translation[0] + 0.1 * scale)
            .collect();
        // Classification is reported, not silently promoted into a success certificate.
        if name == "lens" {
            let stages: Vec<_> = tr
                .records
                .iter()
                .filter_map(|r| match &r.event {
                    Event::Features {
                        stage,
                        strata,
                        adjacent_strata,
                    } => Some((*stage, *strata, adjacent_strata.len())),
                    _ => None,
                })
                .collect();
            assert_eq!(
                stages,
                vec![("raw_before_trim", 8, 19), ("after_trim", 8, 13)]
            );
            assert_eq!(out.validation.unresolved_cells, 267);
            assert!(!out.ok);
            assert_eq!(b.len(), 2);
            assert_eq!(lens_bounds.len(), 1);
            assert_eq!(out.stats.feature_curves, 13);
            let mut degrees = BTreeMap::new();
            let mut neighbors: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
            let mut edge_count = 0;
            for edge in out
                .feature_edges
                .iter()
                .filter(|e| e.interval.curve_id == 12)
            {
                edge_count += 1;
                let [a, b] = edge.vertices;
                neighbors.entry(a).or_default().push(b);
                neighbors.entry(b).or_default().push(a);
                for &v in &edge.vertices {
                    *degrees.entry(v).or_insert(0) += 1;
                    let p = &out.verts[v as usize * 8..v as usize * 8 + 3];
                    assert!((p[0] as f64).abs() < 1e-5);
                    assert!(((p[1] as f64).hypot(p[2] as f64) - radial).abs() < 0.01);
                }
            }
            assert!(edge_count > 3);
            assert!(degrees.values().all(|&d| d == 2));
            let mut pending = vec![*neighbors.keys().next().unwrap()];
            let mut visited = BTreeSet::new();
            while let Some(v) = pending.pop() {
                if visited.insert(v) {
                    pending.extend(&neighbors[&v]);
                }
            }
            assert_eq!(visited.len(), neighbors.len(), "one connected seam cycle");
            assert!(lens_bounds[0][0] - b.iter().find(|b| b[3] < -0.1).unwrap()[3] > 0.48);
        }
        if name == "lens-near-tangent" {
            assert_eq!(out.validation.feature_trace.unresolved_discovery, 1);
            let stages: Vec<_> = tr
                .records
                .iter()
                .filter_map(|rec| match &rec.event {
                    Event::Features {
                        stage,
                        adjacent_strata,
                        ..
                    } => Some((*stage, adjacent_strata.len())),
                    _ => None,
                })
                .collect();
            assert_eq!(stages, vec![("raw_before_trim", 17), ("after_trim", 12)]);
            // Box strata occupy 0..6; the two sphere strata are 6 and 7.
            assert!(tr
                .records
                .iter()
                .filter_map(|rec| match &rec.event {
                    Event::Features {
                        adjacent_strata, ..
                    } => Some(adjacent_strata),
                    _ => None,
                })
                .flatten()
                .all(|p| *p != [6, 7] && *p != [7, 6]));
            assert_eq!(out.stats.feature_curves, 12);
            assert_eq!(b.len(), 1);
            let rank = 20. * radial / (r * r);
            assert!(rank < 2_f64.to_radians().sin());
        }
        if lens_bounds.is_empty() {
            assert!(
                local_unresolved > 0,
                "missing lens must be localized as unresolved"
            );
        }
        for b in &lens_bounds {
            assert!(b[0] >= translation[0] - (r - 10.) * scale - 0.011 * scale);
            assert!(b[3] <= translation[0] + (r - 10.) * scale + 0.011 * scale);
        }
        let v = json!({"name":name,"scene":serde_json::from_str::<Value>(&scene).unwrap(),"cube":format!("{cube:?}"),"settings":format!("{t:?}"),"stats":stats(&out),"firstReasonCounts":first_reason_counts(&tr),"componentBounds":b,"lensComponents":lens_bounds.len(),"lensAabb":lens_aabb,"localUnresolved":local_unresolved});
        eprintln!("lens {v}");
        results.push(v);
    }
    save("lens-matrix", &json!(results));
}

#[test]
fn bounded_trace_and_nested_capture_restore_state() {
    let (tree, cube) = hidden();
    let t = PipelineTuning::default();
    let (r, tr) = capture("limited", 1, || run_sfcc_pipeline(&tree, &cube, &t));
    assert_eq!(tr.records.len(), 1);
    assert!(tr.dropped > 0);
    let ((a, b), outer) = capture("outer", 100_000, || {
        let a = run_sfcc_pipeline(&tree, &cube, &t);
        let (_, inner) = capture("inner", 1, || run_sfcc_pipeline(&tree, &cube, &t));
        assert!(inner.dropped > 0);
        let caught = std::panic::catch_unwind(|| {
            capture("panic", 1, || panic!("intentional capture unwind"))
        });
        assert!(caught.is_err());
        let b = run_sfcc_pipeline(&tree, &cube, &t);
        (a, b)
    });
    same(&r, &a);
    same(&a, &b);
    reconcile(&outer, &b);
    assert_eq!(
        outer
            .records
            .iter()
            .map(|r| r.export)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([1, 2])
    );
}

#[test]
fn finest_cell_aligned_lens_is_retained_by_real_features_despite_passing_guard() {
    let cube = SfccWorldCube {
        min_x: -128.,
        min_y: -128.,
        min_z: -128.,
        size: 256.,
    };
    let t = PipelineTuning::default();
    let empty = prepared(box_node());
    let (lat, _) = decode_tagged_leaves(&prepare(&empty, &cube, &t));
    let center = [
        lat.origin_x + 128.5 * lat.step,
        lat.origin_y + 128.5 * lat.step,
        lat.origin_z + 128.5 * lat.step,
    ];
    let scene = lens_scene(10.01, center, 1., false);
    let tree = build_csg_tree_from_json(&scene).unwrap();
    let leaves = prepare(&tree, &cube, &t);
    let (lat, leaves) = decode_tagged_leaves(&leaves);
    let cell = leaves
        .iter()
        .find(|c| c.level == 8 && c.ix == 128 && c.iy == 128 && c.iz == 128)
        .unwrap();
    let probe = make_probe(
        &lat,
        &tree,
        |x, y, z| tree.f(point_to_world(&lat, x, y, z)),
        cell.level,
        cell.ix,
        cell.iy,
        cell.iz,
    );
    assert_eq!(
        discovery_guard(&tree, &probe),
        DiscoveryCheck::NoDiscoveryRejection { opaque: false }
    );
    assert!(has_corner_sign_change(&probe));
    assert!(cell.degenerate);
    let (r, tr) = observed_run("aligned-lens", &tree, &cube, &t);
    reconcile(&tr, &r);
    let cid = CellId::from(cell);
    let first = tr
        .records
        .iter()
        .find_map(|r| match r.event {
            Event::Decision { cell, reason, .. } if cell == cid => Some(reason),
            _ => None,
        })
        .unwrap();
    assert_eq!(first, "feature_contained_loop_or_segment");
    let data = json!({"scene":serde_json::from_str::<Value>(&scene).unwrap(),"cube":format!("{cube:?}"),
        "lattice":format!("{lat:?}"),"cell":id(cid),"bounds":cell_aabb(&lat,8,128,128,128),"lensCenter":center,
        "firstExecutedReason":first,"replayedGuardPasses":true,"stats":stats(&r),"componentBounds":components(&r)});
    eprintln!("aligned lens {data}");
    save("aligned-lens", &data);
    assert_eq!(r.manifold.components, 1);
    assert_eq!(r.validation.unresolved_cells, 1);
    assert_eq!(r.stats.feature_cell_fallbacks, 1);
    let tol = gcad_kernel::tolerances::resolve_tolerances(
        &gcad_kernel::tuning::SfccTuning::default(),
        (3. * cube.size * cube.size).sqrt(),
    );
    let (features, _) = gcad_kernel::sfcc::feature_set::compile_feature_set(&tree, &tol);
    let bytes = prepare(&tree, &cube, &t);
    for n in [1, 2, 4, 8] {
        let parts: Vec<_> = (0..n)
            .map(|i| mesh_partition(&tree, &cube, &t, &bytes, i, n))
            .collect();
        for parts in [parts.clone(), parts.into_iter().rev().collect()] {
            let raw = merge_partials(&tree, &features, &lat, &t, &parts);
            assert!(!raw.serial_recovery);
            assert_eq!(raw.failed_cells, 0);
            assert_eq!(raw.feature_cell_fallbacks, 1);
            assert_eq!(raw.validation, r.validation);
            assert_eq!(
                canonical(&raw.verts, &raw.tris),
                canonical(&r.verts, &r.tris)
            );
            let recovered = merge(&tree, &cube, &t, &parts);
            assert!(recovered.serial_recovery);
            assert_eq!(recovered.validation, r.validation);
        }
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
fn fine_workers_preserve_actual_first_decisions_raw_geometry_and_tags() {
    let (tree, cube) = hidden();
    let t = PipelineTuning {
        depth_max: 14,
        surface_tol_mm: 1e-5,
        ..Default::default()
    };
    let serial = run_sfcc_pipeline(&tree, &cube, &t);
    let (bytes, trace) = capture("prepare-fine", 100_000, || prepare(&tree, &cube, &t));
    assert_eq!(trace.dropped, 0);
    assert_eq!(prepare(&tree, &cube, &t), bytes);
    assert_eq!(build_octree_resumable_inprocess(&tree, &cube, &t), bytes);
    let (_, leaves) = decode_tagged_leaves(&bytes);
    let degenerate: Vec<_> = leaves
        .iter()
        .filter(|c| c.degenerate)
        .map(CellId::from)
        .collect();
    assert_eq!(degenerate.len(), 36);
    let (whole, whole_trace) = capture("direct-fine", 100_000, || {
        decide_partition_bytes(&tree, &cube, &t, &bytes, 0, leaves.len())
    });
    let firsts = |trace: &Trace| {
        let mut out: BTreeMap<_, _> = BTreeMap::new();
        for r in &trace.records {
            if let Event::Decision {
                cell,
                reason,
                split,
                curve,
                corner,
                ..
            } = r.event
            {
                if degenerate.contains(&cell) {
                    out.insert(cell, (reason, split, curve, corner));
                }
            }
        }
        out
    };
    assert_eq!(firsts(&trace), firsts(&whole_trace));
    let expected = canonical(&serial.verts, &serial.tris);
    for n in [1, 2, 4, 8] {
        let mut decisions = Vec::new();
        let mut reasons = BTreeMap::new();
        for i in (0..n).rev() {
            let (data, tr) = capture("partition-fine", 100_000, || {
                decide_partition_bytes(
                    &tree,
                    &cube,
                    &t,
                    &bytes,
                    i * leaves.len() / n,
                    (i + 1) * leaves.len() / n,
                )
            });
            reasons.extend(firsts(&tr));
            decisions.push((i, decode_decisions(&data)));
        }
        decisions.sort_by_key(|x| x.0);
        assert_eq!(
            encode_decisions(&decisions.into_iter().flat_map(|x| x.1).collect::<Vec<_>>()),
            whole
        );
        assert_eq!(reasons, firsts(&whole_trace));
        let parts: Vec<_> = (0..n)
            .map(|i| mesh_partition(&tree, &cube, &t, &bytes, i, n))
            .collect();
        for reverse in [false, true] {
            let mut parts = parts.clone();
            if reverse {
                parts.reverse();
            }
            let merged = merge(&tree, &cube, &t, &parts);
            assert!(!merged.serial_recovery);
            assert_eq!(merged.failed_cells, 0);
            assert_eq!(merged.degenerate_cells, 36);
            assert_eq!(merged.validation, serial.validation);
            assert_eq!(canonical(&merged.verts, &merged.tris), expected);
        }
    }
}

#[test]
fn recovery_round_counts_do_not_leak_into_the_next_export() {
    // The existing twisted-extrude fixture genuinely executes re-refinement;
    // the hidden-plus-cylinder fixture enters serial recovery but has zero rounds.
    let scene=json!({"kind":"union","children":[
        {"kind":"extrude","pos":[0.,0.,0.],"verts":[[-3.,-3.],[3.,-3.],[3.,0.],[0.,0.],[0.,3.],[-3.,3.]],"h":5.,"twist_degrees":90.},
        {"kind":"sphere","pos":[4.8,0.3,0.3],"r":0.01}]}).to_string();
    let tree = build_csg_tree_from_json(&scene).unwrap();
    let cube = SfccWorldCube {
        min_x: -6.,
        min_y: -6.,
        min_z: -6.,
        size: 12.,
    };
    let t = PipelineTuning {
        depth_min: 4,
        depth_max: 7,
        max_polyline_points_per_cell: 1,
        curve_chord_tol_mm: 1e-8,
        ..Default::default()
    };
    let (serial, _) = observed_run("forced-recovery-serial", &tree, &cube, &t);
    let bytes = prepare(&tree, &cube, &t);
    let mut rounds = Vec::new();
    for n in [1, 2, 4, 8] {
        let parts: Vec<_> = (0..n)
            .rev()
            .map(|i| mesh_partition(&tree, &cube, &t, &bytes, i, n))
            .collect();
        for (reversed, parts) in [
            (false, parts.clone()),
            (true, parts.into_iter().rev().collect()),
        ] {
            let (merged, trace) = capture("recovery", 250_000, || merge(&tree, &cube, &t, &parts));
            let scopes: Vec<_> = trace
                .records
                .iter()
                .filter_map(|r| match r.event {
                    Event::Export { parent } => Some((r.export, parent)),
                    _ => None,
                })
                .collect();
            assert_eq!(scopes, vec![(1, 0), (2, 1), (3, 1)]);
            let final_counts: Vec<_> = trace
                .records
                .iter()
                .filter_map(|r| match r.event {
                    Event::Round { degenerate, .. } => Some((r.round, degenerate)),
                    _ => None,
                })
                .collect();
            assert_eq!(final_counts, vec![(0, 5824), (1, 6162)]);
            assert!(merged.serial_recovery);
            assert!(merged.re_refine_rounds > 0);
            assert_eq!(merged.verts, serial.verts);
            assert_eq!(merged.tris, serial.tris);
            assert_eq!(merged.validation, serial.validation);
            reconcile(&trace, &serial);
            for rec in &trace.records {
                if let Event::Round {
                    leaves,
                    degenerate,
                    failed,
                    failed_degenerate,
                    fallbacks,
                    final_round,
                    ..
                } = rec.event
                {
                    rounds.push(json!({"workers":n,"reversed":reversed,"export":rec.export,"round":rec.round,"leaves":leaves,
                "degenerate":degenerate,"failed":failed,"failedDegenerate":failed_degenerate,"fallbacks":fallbacks,"final":final_round}));
                }
            }
        }
    }
    save("recovery-rounds", &json!(rounds));
    let (plain, cube) = support::hidden();
    let r = run_sfcc_pipeline(&plain, &cube, &PipelineTuning::default());
    assert_eq!(r.validation.unresolved_cells, 4);
}

#[test]
fn clipped_cap_and_successful_primitive_controls() {
    let cap = json!({"kind":"union","children":[
        {"kind":"box","pos":[-1.75,0.,0.],"half":[1.25,3.,3.]},
        {"kind":"intersect","lh":{"kind":"sphere","pos":[0.,0.,0.],"r":1.},
         "rh":{"kind":"box","pos":[1.5,0.,0.],"half":[0.51,2.,2.]}}]})
    .to_string();
    let cube = SfccWorldCube {
        min_x: -4.,
        min_y: -4.,
        min_z: -4.,
        size: 8.,
    };
    let mut cases = Vec::new();
    for (name, scene) in [
        ("clipped-cap", cap),
        (
            "sphere",
            json!({"kind":"sphere","pos":[0.,0.,0.],"r":1.}).to_string(),
        ),
        (
            "box",
            json!({"kind":"box","pos":[0.,0.,0.],"half":[1.,1.,1.]}).to_string(),
        ),
    ] {
        let tree = build_csg_tree_from_json(&scene).unwrap();
        let (r, tr) = observed_run(name, &tree, &cube, &PipelineTuning::default());
        reconcile(&tr, &r);
        if name == "clipped-cap" {
            assert_eq!(r.manifold.components, 2);
            assert!(components(&r)
                .iter()
                .any(|b| b[0] >= 0.989 && b[3] <= 1.001));
        } else if name == "box" {
            assert!(r.ok);
            assert_eq!(r.manifold.components, 1);
        } else {
            // A new exploratory assertion of r.ok failed on the unchanged sphere
            // baseline. Preserve that discovered limitation, not a false success.
            eprintln!("ordinary sphere baseline {}", stats(&r));
            assert!(r.manifold.ok);
            assert_eq!(r.manifold.components, 1);
            assert!(!r.ok);
            assert_eq!(r.validation.unresolved_cells, 8);
        }
        cases.push(json!({"name":name,"scene":serde_json::from_str::<Value>(&scene).unwrap(),"stats":stats(&r),"components":components(&r)}));
    }
    save("cap-and-positive-controls", &json!(cases));
}

#[test]
fn depth10_lens_fragments_have_cell_mesh_provenance() {
    let scene = lens_scene(10.01, [0.; 3], 1., false);
    let tree = build_csg_tree_from_json(&scene).unwrap();
    let cube = SfccWorldCube {
        min_x: -4.,
        min_y: -4.,
        min_z: -4.,
        size: 8.,
    };
    let tuning = PipelineTuning {
        depth_max: 10,
        ..Default::default()
    };
    let (r, tr) = observed_run("lens-depth10-origins", &tree, &cube, &tuning);
    reconcile(&tr, &r);
    let key = |p: [[f64; 3]; 3]| {
        let mut p = p.map(|p| p.map(|x| (x as f32).to_bits()));
        p.sort();
        p
    };
    let invalid = triangle_exactly_degenerate;
    let mut origin: BTreeMap<_, Vec<Value>> = BTreeMap::new();
    let mut raw_triangles = 0;
    let mut raw_collapsed = 0;
    for rec in &tr.records {
        if let Event::Mesh {
            cell,
            kind,
            fallback,
            triangles,
        } = &rec.event
        {
            let first = tr.records.iter().find_map(|d| match d.event {
                Event::Decision {
                    cell: cid,
                    reason,
                    split,
                    ..
                } if d.export == rec.export
                    && d.round == rec.round
                    && cid == CellId::from(cell) =>
                {
                    Some((reason, split))
                }
                _ => None,
            });
            for &p in triangles {
                raw_triangles += 1;
                raw_collapsed += usize::from(invalid(p));
                origin.entry(key(p)).or_default().push(json!({"cell":id(cell.into()),"round":rec.round,"firstDecision":first,
                "degenerate":cell.degenerate,"fallback":fallback,"mesher":kind,"preF32Degenerate":invalid(p),"rawPositions":p}));
            }
        }
    }
    fn root(parent: &mut [usize], i: usize) -> usize {
        if parent[i] != i {
            parent[i] = root(parent, parent[i]);
        }
        parent[i]
    }
    let mut parent: Vec<_> = (0..r.verts.len() / 8).collect();
    for t in r.tris.chunks_exact(3) {
        let a = root(&mut parent, t[0] as usize);
        for &v in &t[1..] {
            let b = root(&mut parent, v as usize);
            parent[b] = a;
        }
    }
    let groups: Vec<_> = r
        .tris
        .chunks_exact(3)
        .map(|t| root(&mut parent, t[0] as usize))
        .collect();
    let mut group_sizes = BTreeMap::new();
    for &g in &groups {
        *group_sizes.entry(g).or_insert(0) += 1;
    }
    let mut rows = Vec::new();
    let mut fragments = Vec::new();
    let mut missing = 0;
    for (i, t) in r.tris.chunks_exact(3).enumerate() {
        let p: [[f64; 3]; 3] =
            std::array::from_fn(|i| std::array::from_fn(|a| r.verts[t[i] as usize * 8 + a] as f64));
        let origins = origin.get(&key(p));
        if group_sizes[&groups[i]] <= 32 || invalid(p) {
            let candidates =
                origins.expect("every invalid/fragment triangle needs positional provenance");
            assert!(candidates.iter().all(|o| o["degenerate"] == true));
            if invalid(p) {
                assert!(candidates.iter().all(|o| o["preF32Degenerate"] == true));
            }
        }
        if group_sizes[&groups[i]] <= 32 {
            fragments.push(json!({"triangle":i,"component":groups[i],"componentTriangles":group_sizes[&groups[i]],
                "positions":p,"origins":origins,"invalid":invalid(p)}));
        }
        if !invalid(p) {
            continue;
        }
        if origins.is_none() {
            missing += 1;
        }
        rows.push(json!({"triangle":i,"positions":p,"origins":origins}));
    }
    assert_eq!(raw_triangles, 8534);
    assert_eq!(raw_collapsed, 68);
    assert_eq!(rows.len(), 12);
    assert_eq!(missing, 0);
    assert_eq!(r.tris.len() / 3, 8478);
    assert_eq!(rows.len(), r.validation.invalid_triangles);
    assert_eq!(
        fragments.len(),
        46,
        "both detached components must be inventoried"
    );
    eprintln!(
        "depth10 invalid origins: {} triangles, {} not directly matched",
        rows.len(),
        missing
    );
    save(
        "lens-depth10-invalid-origins",
        &json!({"scene":serde_json::from_str::<Value>(&scene).unwrap(),"stats":stats(&r),"rawTriangles":raw_triangles,"rawCollapsed":raw_collapsed,"unmatched":missing,"invalidTriangles":rows,"smallComponentTriangles":fragments,"componentTriangleCounts":group_sizes}),
    );
}

#[test]
fn reduced_lens_only_preserves_the_unresolved_construction_failure() {
    let scene: Value = serde_json::from_str(&lens_scene(10.01, [0.; 3], 1., false)).unwrap();
    let lens = scene["children"][1].clone();
    let tree = build_csg_tree_from_json(&lens.to_string()).unwrap();
    let cube = SfccWorldCube {
        min_x: -4.,
        min_y: -4.,
        min_z: -4.,
        size: 8.,
    };
    let t = PipelineTuning {
        depth_max: 10,
        ..Default::default()
    };
    let (r, tr) = observed_run("lens-only-depth10", &tree, &cube, &t);
    assert_eq!(r.validation.unresolved_cells, 1017);
    assert_eq!(r.manifold.components, 3); // Analytic lens target has one component.
    assert_eq!(r.validation.invalid_triangles, 12);
    let raw_collapses: usize = tr
        .records
        .iter()
        .filter_map(|rec| match &rec.event {
            Event::Mesh {
                cell, triangles, ..
            } => Some(
                triangles
                    .iter()
                    .filter(|p| {
                        let flat = triangle_exactly_degenerate(**p);
                        if flat {
                            assert!(cell.degenerate);
                        }
                        flat
                    })
                    .count(),
            ),
            _ => None,
        })
        .sum();
    assert_eq!(raw_collapses, 68);
    save(
        "lens-only-depth10",
        &json!({"scene":lens,"cube":[-4.,-4.,-4.,8.],"settings":format!("{t:?}"),"stats":stats(&r),"rawCollapsed":raw_collapses}),
    );
}

#[test]
fn exact_rotation_keeps_the_lens_and_box_separate() {
    let scene = json!({"kind":"rotate","fwd":[0.,1.,0.,-1.,0.,0.,0.,0.,1.],"arg":serde_json::from_str::<Value>(&lens_scene(10.01,[0.;3],1.,false)).unwrap()});
    let tree = build_csg_tree_from_json(&scene.to_string()).unwrap();
    let cube = SfccWorldCube {
        min_x: -4.,
        min_y: -4.,
        min_z: -4.,
        size: 8.,
    };
    let (r, _) = observed_run("lens-rotate", &tree, &cube, &PipelineTuning::default());
    let b = components(&r);
    assert_eq!(b.len(), 2);
    assert_eq!(b.iter().filter(|b| b[4] <= -0.49).count(), 1);
    assert_eq!(
        b.iter().filter(|b| b[1] >= -0.02 && b[4] <= 0.02).count(),
        1
    );
    save(
        "lens-rotate",
        &json!({"scene":scene,"cube":[-4.,-4.,-4.,8.],"stats":stats(&r),"componentBounds":b}),
    );
}
