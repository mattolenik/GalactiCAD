//! Thin wasm-bindgen boundary over `gcad_kernel`. Marshaling ONLY — no geometry
//! logic lives here. See `docs/research/gcad-wasm-rust-port.md` §2 for the boundary
//! contract: return owned `Vec<_>` for mesh buffers (zero-copy views are
//! invalidated by any Rust allocation that grows linear memory), and accept that
//! WGSL strings are copied once across the boundary per rebuild.

use gcad_kernel::scene_bridge::build_csg_tree_from_json;
use gcad_kernel::sfcc::pipeline::{run_sfcc_pipeline, PipelineTuning, SfccWorldCube};
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
    let result = run_sfcc_pipeline(&tree, &cube, &tuning.to_pipeline());

    let s = &result.stats;
    let m = &result.manifold;
    let euler: Vec<String> = m.euler_per_component.iter().map(|c| c.to_string()).collect();
    // Compact hand-rolled JSON of the stat fields the TS exporter logs (avoids a
    // serde-Serialize derive on the kernel SfccStats).
    let stats_json = format!(
        "{{\"leaves\":{},\"faces\":{},\"crossPoints\":{},\"tris\":{},\"failedCells\":{},\"degenerateCells\":{},\"featureCurves\":{},\"edgeCells\":{},\"cornerCells\":{},\"featureCellFallbacks\":{},\"reRefineRounds\":{},\"faceAuditFailures\":{},\"boundaryViolations\":{},\"manifoldOk\":{},\"components\":{},\"openEdges\":{},\"nonManifoldEdges\":{},\"misorientedEdges\":{},\"euler\":[{}]}}",
        s.leaves, s.faces, s.cross_points, s.tris, s.failed_cells, s.degenerate_cells, s.feature_curves, s.edge_cells,
        s.corner_cells, s.feature_cell_fallbacks, s.re_refine_rounds, s.face_audit_failures, s.boundary_violations,
        m.ok, m.components, m.open_edges, m.non_manifold_edges, m.misoriented_edges, euler.join(",")
    );

    Ok(SfccExportResult { verts: result.verts, tris: result.tris, ok: result.ok, stats_json })
}
