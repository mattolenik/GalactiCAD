//! Thin wasm-bindgen boundary over `gcad_kernel`. Marshaling ONLY — no geometry
//! logic lives here. See `docs/research/gcad-wasm-rust-port.md` §2 for the boundary
//! contract: return owned `Vec<_>` for mesh buffers (zero-copy views are
//! invalidated by any Rust allocation that grows linear memory), and accept that
//! WGSL strings are copied once across the boundary per rebuild.

use gcad_kernel::scene_bridge::build_csg_tree_from_json;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline_profiled, PipelineTuning, SfccWorldCube};
use gcad_kernel::sfcc::worker;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Build smoke test: returns the kernel crate version across the boundary.
#[wasm_bindgen]
pub fn version() -> String {
    gcad_kernel::version().to_string()
}

/// The SFCC tuning subset the pipeline consumes, deserialized from the TS
/// `SfccTuning` JSON. Field names are camelCase (the TS object), defaults mirror
/// `DEFAULT_SFCC_TUNING`; unknown TS-only knobs (jitterRetries, failurePolicy,
/// creaseAngleDeg, debugOutput, profile, ambiguityResolution, faceSnapEpsFraction)
/// are ignored. Missing fields fall back to the pipeline defaults.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BridgeTuning {
    depth_min: u32,
    depth_max: u32,
    bounds_padding_mm: f64,
    enforce_edge_balance: bool,
    normal_variation_deg: f64,
    blend_curvature_refine: bool,
    blend_curvature_deg: f64,
    blend_curvature_analytic: bool,
    normal_variation_analytic: bool,
    tangential_epsilon: f64,
    feature_query_inflate: f64,
    surface_tol_mm: f64,
    curve_chord_tol_mm: f64,
    probe_delta_factor: f64,
    min_dihedral_deg: f64,
    min_tangency_angle_deg: f64,
    corner_merge_tol_diag_fraction: f64,
    seed_cell_size_mm: f64,
    max_trace_steps: u32,
    edge_root_tol_fraction: f64,
    max_polyline_points_per_cell: usize,
    interior_vertex_mode: String,
    project_max_iters: u32,
    recovery_cull: bool,
    re_refine_max_rounds: u32,
    check_vertex_links: bool,
}

impl Default for BridgeTuning {
    fn default() -> Self {
        let d = PipelineTuning::default();
        BridgeTuning {
            depth_min: d.depth_min,
            depth_max: d.depth_max,
            bounds_padding_mm: d.bounds_padding_mm,
            enforce_edge_balance: d.enforce_edge_balance,
            normal_variation_deg: d.normal_variation_deg,
            blend_curvature_refine: d.blend_curvature_refine,
            blend_curvature_deg: d.blend_curvature_deg,
            blend_curvature_analytic: d.blend_curvature_analytic,
            normal_variation_analytic: d.normal_variation_analytic,
            tangential_epsilon: d.tangential_epsilon,
            feature_query_inflate: d.feature_query_inflate,
            surface_tol_mm: d.surface_tol_mm,
            curve_chord_tol_mm: d.curve_chord_tol_mm,
            probe_delta_factor: d.probe_delta_factor,
            min_dihedral_deg: d.min_dihedral_deg,
            min_tangency_angle_deg: d.min_tangency_angle_deg,
            corner_merge_tol_diag_fraction: d.corner_merge_tol_diag_fraction,
            seed_cell_size_mm: d.seed_cell_size_mm,
            max_trace_steps: d.max_trace_steps,
            edge_root_tol_fraction: d.edge_root_tol_fraction,
            max_polyline_points_per_cell: d.max_polyline_points_per_cell,
            interior_vertex_mode: "project".to_string(),
            project_max_iters: d.project_max_iters,
            recovery_cull: d.recovery_cull,
            re_refine_max_rounds: d.re_refine_max_rounds,
            check_vertex_links: d.check_vertex_links,
        }
    }
}

impl BridgeTuning {
    fn to_pipeline(&self) -> PipelineTuning {
        use gcad_kernel::sfcc::cell_mesh::InteriorVertexMode;
        let interior_vertex_mode = match self.interior_vertex_mode.as_str() {
            "centroid" => InteriorVertexMode::Centroid,
            "fan" => InteriorVertexMode::Fan,
            _ => InteriorVertexMode::Project,
        };
        PipelineTuning {
            depth_min: self.depth_min,
            depth_max: self.depth_max,
            bounds_padding_mm: self.bounds_padding_mm,
            enforce_edge_balance: self.enforce_edge_balance,
            normal_variation_deg: self.normal_variation_deg,
            blend_curvature_refine: self.blend_curvature_refine,
            blend_curvature_deg: self.blend_curvature_deg,
            blend_curvature_analytic: self.blend_curvature_analytic,
            normal_variation_analytic: self.normal_variation_analytic,
            surface_tol_mm: self.surface_tol_mm,
            edge_root_tol_fraction: self.edge_root_tol_fraction,
            interior_vertex_mode,
            project_max_iters: self.project_max_iters,
            re_refine_max_rounds: self.re_refine_max_rounds,
            check_vertex_links: self.check_vertex_links,
            tangential_epsilon: self.tangential_epsilon,
            feature_query_inflate: self.feature_query_inflate,
            curve_chord_tol_mm: self.curve_chord_tol_mm,
            max_polyline_points_per_cell: self.max_polyline_points_per_cell,
            recovery_cull: self.recovery_cull,
            probe_delta_factor: self.probe_delta_factor,
            min_dihedral_deg: self.min_dihedral_deg,
            min_tangency_angle_deg: self.min_tangency_angle_deg,
            corner_merge_tol_diag_fraction: self.corner_merge_tol_diag_fraction,
            seed_cell_size_mm: self.seed_cell_size_mm,
            max_trace_steps: self.max_trace_steps,
        }
    }
}

/// The OWNED mesh export result handed back across the boundary. wasm-bindgen
/// copies `verts`/`tris` into fresh JS typed arrays on access (no stale linear-
/// memory views). Stats are exposed individually as a small JSON string.
#[wasm_bindgen]
pub struct SfccExportResult {
    verts: Vec<f32>,
    tris: Vec<u32>,
    ok: bool,
    stats_json: String,
}

#[wasm_bindgen]
impl SfccExportResult {
    /// Stride-8 vertex buffer (pos, pad, normal, pad), f32. Copied into JS.
    #[wasm_bindgen(getter)]
    pub fn verts(&self) -> Vec<f32> {
        self.verts.clone()
    }
    /// Triangle index buffer (3 indices per triangle), u32. Copied into JS.
    #[wasm_bindgen(getter)]
    pub fn tris(&self) -> Vec<u32> {
        self.tris.clone()
    }
    /// Whether the pipeline certified the mesh (manifold + audits clean).
    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool {
        self.ok
    }
    /// Pipeline stats + manifold report, as a JSON string (parsed on the TS side).
    #[wasm_bindgen(getter)]
    pub fn stats_json(&self) -> String {
        self.stats_json.clone()
    }
}

/// Build a mesh from a SERIALIZED SFCC scene. `scene_json` is the `BridgeNode`
/// tree (see `scene_bridge`); `tuning_json` is the TS `SfccTuning` object (a
/// partial is fine — missing knobs use defaults); the world cube comes from the
/// caller's `worldBoundsCube()` (`min_*` + `size`). Returns an owned result, or a
/// JS error (the scene_bridge rejection message) on an unsupported scene.
#[wasm_bindgen]
pub fn export_sfcc(
    scene_json: &str,
    tuning_json: &str,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    size: f64,
) -> Result<SfccExportResult, JsError> {
    let tree = build_csg_tree_from_json(scene_json).map_err(|e| JsError::new(&e))?;
    let tuning: BridgeTuning = if tuning_json.trim().is_empty() {
        BridgeTuning::default()
    } else {
        serde_json::from_str(tuning_json).map_err(|e| JsError::new(&format!("tuning JSON parse error: {e}")))?
    };
    let cube = SfccWorldCube { min_x, min_y, min_z, size };
    // Phase-timed run: `js_sys::Date::now()` is the injected clock (the dep-free kernel
    // has no time source). Date.now has ~1ms resolution — ample for the 10s–1000s-of-ms
    // phases; the mesh output is identical to the un-profiled `run_sfcc_pipeline`. The
    // phase split measures the #3 spatial-partition Amdahl ceiling (parallelizable
    // contour+cellmesh vs serial feature/octree/assemble).
    let now = || js_sys::Date::now();
    let result = run_sfcc_pipeline_profiled(&tree, &cube, &tuning.to_pipeline(), &now);

    let s = &result.stats;
    let m = &result.manifold;
    let euler: Vec<String> = m.euler_per_component.iter().map(|c| c.to_string()).collect();
    // Per-round octree split as a compact `[frontier, decideMs(1dp), applyMs(1dp)]` array
    // — the measurement input for "is parallelizing the per-cell decide worth it?".
    let octree_rounds: Vec<String> = result
        .octree_rounds
        .iter()
        .map(|(n, d, a)| format!("[{},{:.1},{:.1}]", n, d, a))
        .collect();
    // Compact hand-rolled JSON of the stat fields the TS exporter logs (avoids a
    // serde-Serialize derive on the kernel SfccStats). The phase* ms are appended for
    // the spatial-partition (#3) ceiling measurement.
    let stats_json = format!(
        "{{\"leaves\":{},\"faces\":{},\"crossPoints\":{},\"tris\":{},\"failedCells\":{},\"degenerateCells\":{},\"featureCurves\":{},\"edgeCells\":{},\"cornerCells\":{},\"featureCellFallbacks\":{},\"reRefineRounds\":{},\"faceAuditFailures\":{},\"boundaryViolations\":{},\"manifoldOk\":{},\"components\":{},\"openEdges\":{},\"nonManifoldEdges\":{},\"misorientedEdges\":{},\"euler\":[{}],\"phaseFeatureMs\":{},\"phaseOctreeMs\":{},\"phaseContourMs\":{},\"phaseCellmeshMs\":{},\"phaseAssembleMs\":{},\"phaseOctreeDecideMs\":{},\"phaseOctreeApplyMs\":{},\"octreeRounds\":[{}]}}",
        s.leaves, s.faces, s.cross_points, s.tris, s.failed_cells, s.degenerate_cells, s.feature_curves, s.edge_cells,
        s.corner_cells, s.feature_cell_fallbacks, s.re_refine_rounds, s.face_audit_failures, s.boundary_violations,
        m.ok, m.components, m.open_edges, m.non_manifold_edges, m.misoriented_edges, euler.join(","),
        result.phase_feature_ms.round() as i64, result.phase_octree_ms.round() as i64,
        result.phase_contour_ms.round() as i64, result.phase_cellmesh_ms.round() as i64,
        result.phase_assemble_ms.round() as i64,
        result.phase_octree_decide_ms.round() as i64, result.phase_octree_apply_ms.round() as i64,
        octree_rounds.join(",")
    );

    Ok(SfccExportResult { verts: result.verts, tris: result.tris, ok: result.ok, stats_json })
}

// --- slice 5 / Stage A: cross-instance worker meshing (prepare / mesh / merge) ---
// The three serializable phases that let SFCC meshing run across SEPARATE wasm
// instances (later: Web Workers). The expensive per-cell DECISION (classify +
// smoothCrit, the serial ~60%) runs ONCE in `prepare`; workers receive the tagged
// leaves and only mesh their Morton group; `merge` dedups + runs the S4 tail. The
// in-process equivalence to serial is proven by kernel tests/worker_partition.rs.
//
// What each worker RECOMPUTES vs RECEIVES:
//   RECEIVES — the tagged leaf set + lattice params (the DECISION result), as the
//     `prepare` byte buffer. No worker re-runs classify/smoothCrit or the refine loop.
//   RECOMPUTES — the CsgNode (from scene_json) + the feature set (compile_feature_set,
//     the cheap ~6% feature phase). Recomputed per worker for now; a later slice could
//     serialize the curve/corner/strata graph to avoid even that.

fn parse_tuning(tuning_json: &str) -> Result<BridgeTuning, JsError> {
    if tuning_json.trim().is_empty() {
        Ok(BridgeTuning::default())
    } else {
        serde_json::from_str(tuning_json).map_err(|e| JsError::new(&format!("tuning JSON parse error: {e}")))
    }
}

/// Phase 1 — `prepare`: compile the feature set + build the tagged octree (the serial
/// ~60%), then serialize the tagged leaves + lattice to a byte buffer. Run ONCE on the
/// main thread; the returned `Uint8Array` is broadcast to every worker. Copied into JS.
#[wasm_bindgen]
pub fn sfcc_worker_prepare(
    scene_json: &str,
    tuning_json: &str,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    size: f64,
) -> Result<Vec<u8>, JsError> {
    let tree = build_csg_tree_from_json(scene_json).map_err(|e| JsError::new(&e))?;
    let tuning = parse_tuning(tuning_json)?;
    let cube = SfccWorldCube { min_x, min_y, min_z, size };
    Ok(worker::prepare(&tree, &cube, &tuning.to_pipeline()))
}

/// Octree-DECISION worker primitive: decide cells `[start, end)` of a serialized
/// frontier (the gate-measured ~50%-of-export parallelizable half). The main thread
/// ships a round's frontier; each worker decides its contiguous slice independently
/// (pure per-cell certs); the main thread concatenates + applies split+ripple. Returns
/// the encoded decisions, copied into JS. Recomputes the CsgNode + feature set locally.
#[wasm_bindgen]
pub fn sfcc_decide_partition(
    scene_json: &str,
    tuning_json: &str,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    size: f64,
    frontier_bytes: &[u8],
    start: usize,
    end: usize,
) -> Result<Vec<u8>, JsError> {
    let tree = build_csg_tree_from_json(scene_json).map_err(|e| JsError::new(&e))?;
    let tuning = parse_tuning(tuning_json)?;
    let cube = SfccWorldCube { min_x, min_y, min_z, size };
    Ok(worker::decide_partition_bytes(&tree, &cube, &tuning.to_pipeline(), frontier_bytes, start, end))
}

// --- Octree-decision SESSION (slice 5b stage B2a) -------------------------------
// The wasm-holdable resumable build: the main thread keeps a borrow-free octree
// build across JS worker round-trips. The per-round BSP loop (stage B2b) drives:
//   sfcc_octree_begin → loop { sfcc_octree_current_frontier → scatter to workers
//   (sfcc_decide_partition) → sfcc_octree_apply_decisions until `done` } →
//   sfcc_octree_finish → leaves (then mesh). Single session at a time (one slot).

/// Begin a resumable octree-decision session: build the tagged-octree machinery
/// (features + lattice + round-0 frontier) and hold it on the main wasm instance.
/// Call `sfcc_octree_current_frontier` next.
#[wasm_bindgen]
pub fn sfcc_octree_begin(
    scene_json: &str,
    tuning_json: &str,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    size: f64,
) -> Result<(), JsError> {
    let tree = build_csg_tree_from_json(scene_json).map_err(|e| JsError::new(&e))?;
    let tuning = parse_tuning(tuning_json)?;
    let cube = SfccWorldCube { min_x, min_y, min_z, size };
    worker::octree_session_begin(tree, &cube, &tuning.to_pipeline());
    Ok(())
}

/// The current round's frontier to DECIDE (the `encode_tagged_leaves` wire format,
/// fed to `sfcc_decide_partition`). An empty leaf set means the build is done.
#[wasm_bindgen]
pub fn sfcc_octree_current_frontier() -> Vec<u8> {
    worker::octree_session_current_frontier()
}

/// Apply the current round's decisions (concatenated worker outputs, the
/// `encode_decisions` wire format) on the main thread: split + 2:1 ripple, advance a
/// round. Returns `true` when the build is complete (→ `sfcc_octree_finish`).
#[wasm_bindgen]
pub fn sfcc_octree_apply_decisions(decisions_bytes: &[u8]) -> bool {
    worker::octree_session_apply_decisions(decisions_bytes)
}

/// Finish the session → the tagged leaves (same `encode_tagged_leaves` format as
/// `sfcc_worker_prepare`, fed to the mesh phase). Consumes the session.
#[wasm_bindgen]
pub fn sfcc_octree_finish() -> Vec<u8> {
    worker::octree_session_finish()
}

/// Phase 2 — `mesh_partition`: one worker's share. Reconstruct the octree from
/// `leaves_bytes` (the `sfcc_worker_prepare` output), Morton-partition the surface
/// leaves into `group_count` groups, and mesh ONLY `group_index` into its own table.
/// Returns the partial mesh byte buffer (verts + global keys + tris + counters),
/// copied into JS. Recomputes the CsgNode + feature set locally (see module note).
#[wasm_bindgen]
pub fn sfcc_worker_mesh_partition(
    scene_json: &str,
    tuning_json: &str,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    size: f64,
    leaves_bytes: &[u8],
    group_index: usize,
    group_count: usize,
) -> Result<Vec<u8>, JsError> {
    let tree = build_csg_tree_from_json(scene_json).map_err(|e| JsError::new(&e))?;
    let tuning = parse_tuning(tuning_json)?;
    let cube = SfccWorldCube { min_x, min_y, min_z, size };
    Ok(worker::mesh_partition(&tree, &cube, &tuning.to_pipeline(), leaves_bytes, group_index, group_count))
}

/// Phase 3 — `merge`: dedup the worker partials by global point key, concat the
/// remapped tris, and run the same S4 tail as `export_sfcc`. `partials` is a JS array
/// of the `sfcc_worker_mesh_partition` `Uint8Array` buffers. Returns the same shape as
/// `export_sfcc` (`SfccExportResult`). The feature set + lattice are rebuilt from the
/// same scene_json/tuning/cube the prepare step used.
#[wasm_bindgen]
pub fn sfcc_worker_merge(
    scene_json: &str,
    tuning_json: &str,
    min_x: f64,
    min_y: f64,
    min_z: f64,
    size: f64,
    partials: js_sys::Array,
) -> Result<SfccExportResult, JsError> {
    let tree = build_csg_tree_from_json(scene_json).map_err(|e| JsError::new(&e))?;
    let tuning = parse_tuning(tuning_json)?;
    let cube = SfccWorldCube { min_x, min_y, min_z, size };

    // Marshal the JS array of Uint8Array partials into owned Vec<u8>s.
    let bufs: Vec<Vec<u8>> = partials
        .iter()
        .map(|v| js_sys::Uint8Array::new(&v).to_vec())
        .collect();

    let merged = worker::merge(&tree, &cube, &tuning.to_pipeline(), &bufs);

    let m = &merged.manifold;
    let euler: Vec<String> = m.euler_per_component.iter().map(|c| c.to_string()).collect();
    // Same stat shape as export_sfcc minus the octree-side fields prepare owns
    // (leaves / degenerateCells / reRefineRounds / faceAuditFailures: the worker
    // path has no shared face map, so faceAuditFailures is 0) and the phase timings.
    let stats_json = format!(
        "{{\"crossPoints\":{},\"tris\":{},\"failedCells\":{},\"featureCurves\":{},\"edgeCells\":{},\"cornerCells\":{},\"featureCellFallbacks\":{},\"multiLoopCells\":{},\"multiRunFaces\":{},\"boundaryViolations\":{},\"faceAuditFailures\":0,\"manifoldOk\":{},\"components\":{},\"openEdges\":{},\"nonManifoldEdges\":{},\"misorientedEdges\":{},\"euler\":[{}]}}",
        merged.cross_points, merged.tris.len() / 3, merged.failed_cells, merged.feature_curves, merged.edge_cells,
        merged.corner_cells, merged.feature_cell_fallbacks, merged.multi_loop_cells, merged.multi_run_faces,
        merged.boundary_violations, m.ok, m.components, m.open_edges, m.non_manifold_edges, m.misoriented_edges,
        euler.join(",")
    );

    Ok(SfccExportResult { verts: merged.verts, tris: merged.tris, ok: merged.ok, stats_json })
}

// --- M6 threading smoke (opt-in `threads` feature) ---------------------------
// Feasibility probe for rayon-in-wasm (Web Workers + SharedArrayBuffer + atomics).
// `init_thread_pool` is the wasm-bindgen-rayon entry the JS side awaits ONCE at
// worker startup; `par_smoke` exercises a rayon par_iter so we can confirm the
// pool actually parallelizes from inside the render worker BEFORE parallelizing
// the real classifyCellFeatures frontier. Built only with `--features threads`
// (nightly + -Zbuild-std + +atomics,+bulk-memory); the default build is unaffected.
#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

#[cfg(feature = "threads")]
#[wasm_bindgen]
pub fn par_smoke(n: u32) -> u64 {
    use rayon::prelude::*;
    (0..n as u64).into_par_iter().map(|i| i * i).sum()
}
