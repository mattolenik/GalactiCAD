//! Read-only replay of a saved acceptance case using the existing native kernel.
//! cargo run --release --features serde,sfcc-profile --example sfcc_failure_diagnosis -- CASE_DIR OUT_DIR [PROBE_POINTS_JSON]
#[cfg(all(feature = "serde", feature = "sfcc-profile"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use gcad_kernel::scene_bridge::build_csg_tree_from_json;
    use gcad_kernel::sfcc::{diagnosis::{capture, triangle_exactly_degenerate, CellId, Event}, pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube}};
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 && args.len() != 4 { return Err("expected CASE_DIR OUT_DIR [PROBE_POINTS_JSON]".into()); }
    let input = PathBuf::from(&args[1]); let output = PathBuf::from(&args[2]);
    std::fs::create_dir_all(&output)?;
    let config: Value = serde_json::from_slice(&std::fs::read(input.join("effective-config.json"))?)?;
    let stats: Value = serde_json::from_slice(&std::fs::read(input.join("stats.json"))?)?;
    let tree = build_csg_tree_from_json(config["sceneJson"].as_str().ok_or("missing serialized scene")?)?;
    let t = PipelineTuning::default();
    let defaults = json!({"depthMin":t.depth_min,"depthMax":t.depth_max,"boundsPaddingMm":t.bounds_padding_mm,
        "enforceEdgeBalance":t.enforce_edge_balance,"normalVariationDeg":t.normal_variation_deg,
        "blendCurvatureRefine":t.blend_curvature_refine,"blendCurvatureDeg":t.blend_curvature_deg,
        "normalVariationAnalytic":t.normal_variation_analytic,"surfaceTolMm":t.surface_tol_mm,"multiSheetCells":t.multi_sheet_cells,"decimateTolMm":t.decimate_tol_mm,"edgeRootTolFraction":t.edge_root_tol_fraction,
        "interiorVertexMode":"project","qualityTriangulation":t.quality_triangulation,"qualityAudit":t.quality_audit,
        "qualityRefinement":t.quality_refinement,"qualityRemeshing":t.quality_remeshing,"qualityMaxEditTrials":t.quality_max_edit_trials,
        "projectMaxIters":t.project_max_iters,"reRefineMaxRounds":t.re_refine_max_rounds,"checkVertexLinks":t.check_vertex_links,
        "tangentialEpsilon":t.tangential_epsilon,"featureQueryInflate":t.feature_query_inflate,"curveChordTolMm":t.curve_chord_tol_mm,
        "maxPolylinePointsPerCell":t.max_polyline_points_per_cell,"recoveryCull":t.recovery_cull,
        "probeDeltaFactor":t.probe_delta_factor,"minTangencyAngleDeg":t.min_tangency_angle_deg,
        "cornerMergeTolDiagFraction":t.corner_merge_tol_diag_fraction,"seedCellSizeMm":t.seed_cell_size_mm,"maxTraceSteps":t.max_trace_steps});
    for (key, expected) in defaults.as_object().ok_or("defaults object")? {
        // Older captures predate these options; omission used native off defaults.
        let actual = if matches!(key.as_str(), "multiSheetCells" | "decimateTolMm") {
            config["tuning"].get(key).unwrap_or(expected)
        } else {
            &config["tuning"][key]
        };
        if actual != expected && !(actual.is_number() && expected.is_number() && actual.as_f64() == expected.as_f64()) {
            return Err(format!("diagnostic supports checked defaults only: {key}: {actual} != {expected}").into());
        }
    }
    let number = |path: &Value| path.as_f64().ok_or("missing cube coordinate");
    let cube = SfccWorldCube { min_x:number(&config["cube"]["min"][0])?,min_y:number(&config["cube"]["min"][1])?,min_z:number(&config["cube"]["min"][2])?,
        size:number(&config["cube"]["max"][0])?-number(&config["cube"]["min"][0])? };
    let source_v: Vec<_> = std::fs::read(input.join("mesh.verts.bin"))?.chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().expect("four bytes"))).collect();
    let source_t: Vec<_> = std::fs::read(input.join("mesh.tris.bin"))?.chunks_exact(4).map(|b|u32::from_le_bytes(b.try_into().expect("four bytes"))).collect();
    let position = |v:&[f32], id:u32| [v[id as usize*8]as f64,v[id as usize*8+1]as f64,v[id as usize*8+2]as f64];
    let key = |p:[[f64;3];3]| { let mut k=p.map(|p|p.map(|x|if x==0.{0}else{(x as f32).to_bits()})); k.sort(); k };
    let mut targets=BTreeSet::new();
    for tri in source_t.chunks_exact(3) { let p=[position(&source_v,tri[0]),position(&source_v,tri[1]),position(&source_v,tri[2])]; if triangle_exactly_degenerate(p){targets.insert(key(p));} }
    eprintln!("Running one native diagnostic export; {} saved degenerate geometric faces",targets.len());
    let (result, trace)=capture("saved-acceptance-case",2_000_000,||run_sfcc_pipeline(&tree,&cube,&t));
    let native_targets: BTreeSet<_>=result.tris.chunks_exact(3).filter_map(|tri|{
        let p=[position(&result.verts,tri[0]),position(&result.verts,tri[1]),position(&result.verts,tri[2])];
        triangle_exactly_degenerate(p).then(||key(p))
    }).collect();
    let final_round=trace.records.iter().rev().find(|r|matches!(r.event,Event::Round{final_round:true,..})).map(|r|(r.export,r.round)).ok_or("no final round")?;
    let mut decisions=BTreeMap::new();
    for r in &trace.records { if let Event::Decision{cell,reason,split,..}=r.event {decisions.insert((r.export,r.round,cell),(reason,split));} }
    let mut reason_counts=BTreeMap::<String,usize>::new();
    let mut matches=Vec::new(); let mut native_matches=Vec::new(); let mut raw64=0; let mut raw32=0;
    let mut cells=BTreeMap::<CellId,Value>::new();
    let mut lattice=Value::Null;
    for r in &trace.records {
        if (r.export,r.round)!=final_round {continue;}
        if let Event::Round{lattice:lat,..}=&r.event {lattice=json!({"maxDepth":lat.max_depth,"origin":[lat.origin_x,lat.origin_y,lat.origin_z],"worldSize":lat.world_size,"step":lat.step});}
        if let Event::Mesh{cell,..}|Event::Unresolved{cell,..}=&r.event {
            let id=CellId::from(cell);
            let entry=cells.entry(id).or_insert_with(||json!({"cell":[cell.level as i64,cell.ix,cell.iy,cell.iz],"degenerate":cell.degenerate,"featureCurve":cell.feature_curve,"featureCorner":cell.feature_corner,
                "firstReason":decisions.get(&(r.export,r.round,id)).map(|v|v.0)}));
            if let Event::Mesh{kind,fallback,triangles,..}=&r.event {entry["construction"]=json!(kind);entry["fallback"]=json!(fallback);entry["triangles"]=json!(triangles.len());}
        }
        match &r.event {
            Event::Unresolved{cell,..} => {
                let reason=decisions.get(&(r.export,r.round,CellId::from(cell))).map(|v|v.0).unwrap_or("no_executed_decision_record");
                *reason_counts.entry(reason.to_owned()).or_default()+=1;
            },
            Event::Mesh{cell,kind,fallback,triangles} => for p in triangles {
                let f64_bad=triangle_exactly_degenerate(*p);
                let f32_bad=triangle_exactly_degenerate(p.map(|p|p.map(|x|x as f32 as f64)));
                raw64+=usize::from(f64_bad);raw32+=usize::from(f32_bad);
                if targets.contains(&key(*p)) || native_targets.contains(&key(*p)) {
                    let entry=json!({"f32Key":key(*p),"cell":[cell.level as i64,cell.ix,cell.iy,cell.iz],"construction":kind,"fallback":fallback,
                        "degenerateCell":cell.degenerate,"f64Degenerate":f64_bad,"f32Degenerate":f32_bad,"workingPositions":p,
                        "decision":decisions.get(&(r.export,r.round,CellId::from(cell))).map(|v|v.0)});
                    if targets.contains(&key(*p)) {matches.push(entry.clone());}
                    if native_targets.contains(&key(*p)) {native_matches.push(entry);}
                }
            },
            _=>{},
        }
    }
    if let Some(record)=trace.records.iter().rev().find(|r|(r.export,r.round)==final_round&&matches!(r.event,Event::Assembled{..})) {
        if let Event::Assembled{positions,triangles}=&record.event {
            std::fs::write(output.join("native.working.verts.bin"),positions.iter().flatten().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>())?;
            std::fs::write(output.join("native.working.tris.bin"),triangles.iter().flatten().flat_map(|&i|(u32::try_from(i).expect("u32 point")).to_le_bytes()).collect::<Vec<_>>())?;
        }
    }
    let geometric_bag=|v:&[f32],tris:&[u32]| {let mut b=BTreeMap::new();for tri in tris.chunks_exact(3){let k=key([position(v,tri[0]),position(v,tri[1]),position(v,tri[2])]);*b.entry(k).or_insert(0usize)+=1;}b};
    let same_geometry=geometric_bag(&source_v,&source_t)==geometric_bag(&result.verts,&result.tris);
    std::fs::write(output.join("native.verts.bin"),result.verts.iter().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>())?;
    std::fs::write(output.join("native.tris.bin"),result.tris.iter().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>())?;
    std::fs::write(output.join("native.feature-edges.bin"),result.feature_edges.iter().flat_map(|e|[e.vertices[0] as f64,e.vertices[1] as f64,e.interval.curve_id as f64,e.interval.start,e.interval.end]).flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>())?;
    let summary=json!({"backend":"native Rust diagnostic; never relabeled as the original WASM run","geometryMatchesSavedUnorientedF32TriangleMultiset":same_geometry,
        "traceRecords":trace.records.len(),"dropped":trace.dropped,"finalExportRound":final_round,"leaves":result.stats.leaves,"triangles":result.tris.len()/3,"components":result.manifold.components,"euler":result.manifold.euler_per_component,
        "validation":serde_json::from_str::<Value>(&result.validation.to_json())?,"finalUnresolvedFirstReasons":reason_counts,
        "finalPreassemblyF64Degenerate":raw64,"finalPreassemblyF32Degenerate":raw32,"savedBadTriangleSourceCandidates":matches,"nativeBadTriangleSourceCandidates":native_matches});
    std::fs::write(output.join("native-diagnosis.json"),serde_json::to_string_pretty(&summary)?)?;
    std::fs::write(output.join("native-cells.json"),serde_json::to_vec(&json!({"backend":"native diagnostic replay","lattice":lattice,"cells":cells.values().collect::<Vec<_>>()}))?)?;
    eprintln!("native matches saved geometry: {same_geometry}; dropped={}; invalid={}",trace.dropped,result.validation.invalid_triangles);
    // Recompile only to inspect the existing feature representation; no alternate evaluator.
    let diag=(cube.size*cube.size+cube.size*cube.size+cube.size*cube.size).sqrt();
    let (features, _)=gcad_kernel::sfcc::feature_set::compile_feature_set(&tree,&gcad_kernel::tolerances::resolve_tolerances(&gcad_kernel::tuning::SfccTuning::default(),diag));
    let mut failed_obligations=Vec::new();
    for r in &trace.records {
        if let Event::Unresolved { cell, failed: true } = &r.event {
            let corner=usize::try_from(cell.feature_corner).ok().and_then(|id|features.corners.get(id));
            let center=corner.map(|c|[c.x,c.y,c.z]);
            let constructed:Vec<_>=trace.records.iter().filter_map(|event|{
                if (event.export,event.round)!=(r.export,r.round){return None;}
                match &event.event { Event::Mesh{cell:owner,kind,fallback,triangles} if CellId::from(owner)==CellId::from(cell)=>Some(json!({"kind":kind,"fallback":fallback,"triangles":triangles.len()})),_=>None }
            }).collect();
            let h=lattice["worldSize"].as_f64().ok_or("lattice size")?/2_f64.powi(cell.level as i32);
            let lo=[cell.ix,cell.iy,cell.iz].map(|v|v as f64*h);
            let lo:[f64;3]=std::array::from_fn(|k|lo[k]+lattice["origin"][k].as_f64().expect("recorded lattice origin"));
            failed_obligations.push(json!({"export":r.export,"round":r.round,"finalRound":(r.export,r.round)==final_round,
                "cell":[cell.level as i64,cell.ix,cell.iy,cell.iz],"degenerate":cell.degenerate,"featureCorner":cell.feature_corner,"featureCurve":cell.feature_curve,
                "boxMin":lo,"boxMax":lo.map(|v|v+h),"cornerPosition":center,"cornerField":center.map(|p|tree.f(p)),
                "strictInterior":center.map(|p|(0..3).all(|k|p[k]>lo[k]&&p[k]<lo[k]+h)),
                "minimumFaceDistance":center.map(|p|(0..3).map(|k|(p[k]-lo[k]).min(lo[k]+h-p[k])).fold(f64::INFINITY,f64::min)),
                "cornerCurveEnds":corner.map(|c|&c.curve_ends),"cornerStrata":corner.map(|c|&c.strata),"construction":constructed,
                "firstReason":decisions.get(&(r.export,r.round,CellId::from(cell))).map(|v|v.0)}));
        }
    }
    std::fs::write(output.join("failed-obligations.json"),serde_json::to_vec_pretty(&json!({"backend":"native diagnostic replay","dropped":trace.dropped,"cells":failed_obligations}))?)?;
    let mut issues=Vec::new();
    for issue in stats["validation"]["featureChains"]["issues"].as_array().ok_or("saved feature issues missing")? {
        let id=issue["curveId"].as_u64().ok_or("curve ID")? as usize;
        let curve=features.curves.get(id).ok_or("native feature ID missing")?;
        let lo=issue["range"][0].as_f64().ok_or("range")?; let hi=issue["range"][1].as_f64().ok_or("range")?;
        let mut parameters=vec![lo,hi];
        for i in 1..16 {parameters.push(lo+(hi-lo)*i as f64/16.);}
        if curve.kind()==gcad_kernel::sfcc::feature_curves::CurveKind::Traced {parameters.extend(((lo.floor()as i64+1)..=(hi.ceil()as i64-1)).map(|i|i as f64));}
        parameters.sort_by(f64::total_cmp);parameters.dedup();
        let samples:Vec<_>=parameters.iter().map(|&t|json!({"t":t,"p":curve.point_at_checked(t)})).collect();
        issues.push(json!({"issue":issue,"kind":format!("{:?}",curve.kind()),"native":curve.native,"closed":curve.closed,"domain":[curve.t_min,curve.t_max],
            "adjacentStrata":curve.adjacent_strata,"ownerNodeId":curve.owner_node_id,"samples":samples}));
    }
    let mut endpoint_checks=Vec::new();
    let edges:Vec<_>=std::fs::read(input.join("mesh.features.bin"))?.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().expect("eight bytes"))).collect();
    for edge in edges.chunks_exact(5) {
        let id=edge[2]as usize;
        if let Some(c)=features.curves.get(id) {for (v,t) in [(edge[0]as u32,edge[3]),(edge[1]as u32,edge[4])] {
            let p=position(&source_v,v);
            let q=c.point_at_checked(t);
            endpoint_checks.push(json!({"curveId":id,"t":t,"meshPosition":p,"curvePosition":q,"distance":q.map(|q|(0..3).map(|i|(q[i]-p[i]).powi(2)).sum::<f64>().sqrt())}));
        }}
    }
    std::fs::write(output.join("feature-samples.json"),serde_json::to_string_pretty(&json!({"backend":"native feature compilation; verify agreement before joining to saved WASM IDs",
        "nativeCurveCount":features.curves.len(),"savedCurveCount":stats["featureCurves"],"fingerprint":features.fingerprint().to_string(),"issues":issues,"endpointChecks":endpoint_checks}))?)?;
    if let Some(file)=args.get(3) {
        let probes:Vec<[f64;3]>=serde_json::from_slice(&std::fs::read(file)?)?;
        if probes.len()>100 || probes.iter().flatten().any(|x|!x.is_finite()) {return Err("expected at most 100 finite probe points".into());}
        let lat=trace.records.iter().rev().find_map(|r|match r.event {Event::Round{lattice,..}=>Some(lattice),_=>None}).ok_or("lattice")?;
        let contains=|p:[f64;3],c:CellId| {
            let b=gcad_kernel::math::grid::cell_aabb(&lat,c.0,c.1,c.2,c.3);
            (0..3).all(|k|b[k]<=p[k]&&p[k]<=b[k+3])
        };
        let mut output_probes=Vec::new();
        for p in probes {
            let mut events=Vec::new();
            for r in &trace.records {
                match &r.event {
                    Event::Decision{cell,reason,split,curve,corner,..} if contains(p,*cell)=>events.push(json!({"round":r.round,"stage":"decision","cell":[cell.0 as i64,cell.1,cell.2,cell.3],"reason":reason,"split":split,"curve":curve,"corner":corner})),
                    Event::Split{cell,balance} if contains(p,*cell)=>events.push(json!({"round":r.round,"stage":"split","cell":[cell.0 as i64,cell.1,cell.2,cell.3],"balance":balance})),
                    Event::Mesh{cell,kind,fallback,triangles} if contains(p,CellId::from(cell))=>events.push(json!({"round":r.round,"stage":"mesh","cell":[cell.level as i64,cell.ix,cell.iy,cell.iz],"kind":kind,"fallback":fallback,"triangles":triangles.len(),"workingTriangles":triangles})),
                    Event::Unresolved{cell,failed} if contains(p,CellId::from(cell))=>events.push(json!({"round":r.round,"stage":"unresolved","cell":[cell.level as i64,cell.ix,cell.iy,cell.iz],"failed":failed})),
                    _=>{},
                }
            }
            let corners:Vec<_>=features.corners.iter().filter_map(|c| {
                let q=[c.x,c.y,c.z];let distance=(0..3).map(|k|(p[k]-q[k]).powi(2)).sum::<f64>().sqrt();
                (distance<=t.curve_chord_tol_mm).then(||json!({"id":c.id,"position":q,"distance":distance,"curveEnds":c.curve_ends}))
            }).collect();
            output_probes.push(json!({"point":p,"nearbyCompiledCorners":corners,"events":events}));
        }
        std::fs::write(output.join("probe-paths.json"),serde_json::to_string_pretty(&output_probes)?)?;
    }
    Ok(())
}

#[cfg(not(all(feature = "serde", feature = "sfcc-profile")))]
fn main() { eprintln!("enable --features serde,sfcc-profile"); std::process::exit(2); }
