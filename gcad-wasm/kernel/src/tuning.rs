//! SFCC tuning knobs. Port of `src/export/sfcc/sfcc-tuning.mts`.
//!
//! M3a: expanded from the M1 tolerance-only stub to add the octree depth bounds
//! and the smooth-refinement certificate knobs (`normal_variation_deg`, the
//! blend-curvature certs, balance enforcement, padding) the octree/refine port
//! reads. Feature-criteria knobs (`tangential_epsilon`, `feature_query_inflate`)
//! are carried too — they're cheap and keep the struct faithful — but the paths
//! that consume them are M4. Meshing/driver knobs (interior-vertex mode, root
//! tol, re-refine rounds, profiling, …) land with M3b/M3c.

/// Finest octree level; lattice resolution is 2^SFCC_MAX_DEPTH cells per axis.
/// span = 16385, span³ ≈ 4.4e12, exact in i64 (and in f64 < 2^53).
pub const SFCC_MAX_DEPTH: u32 = 14;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SfccTuning {
    // --- Octree -----------------------------------------------------------
    /// Minimum octree depth (uniform refinement floor).
    pub depth_min: u32,
    /// Maximum octree depth; cells still failing certificates here are tagged degenerate.
    pub depth_max: u32,
    /// Padding (mm) added to refined scene bounds when sizing the root cube.
    pub bounds_padding_mm: f64,
    /// Enforce 2:1 balance across edge-adjacent (not just face-adjacent) neighbors.
    pub enforce_edge_balance: bool,

    // --- Refinement certificates -----------------------------------------
    /// Max surface-normal variation (deg) across an analytic-stratum cell
    /// before it splits. This — not `depth_max` — drives adaptivity on
    /// stratum-backed geometry; `depth_max` is only the ceiling.
    pub normal_variation_deg: f64,
    /// Refine featureless smooth-blend regions (fillets) by surface curvature.
    pub blend_curvature_refine: bool,
    /// Max surface-normal variation (deg) across a blend cell before it splits.
    pub blend_curvature_deg: f64,
    /// |tangent·faceNormal| below this counts as a tangential crossing → split. (M4 path.)
    pub tangential_epsilon: f64,
    /// Feature query AABB inflation, in fractions of the cell size. (M4 path.)
    pub feature_query_inflate: f64,

    // --- Geometry tolerances ---------------------------------------------
    /// Max |f| at emitted vertices (mm) — the export accuracy anchor.
    pub surface_tol_mm: f64,
    /// Max chord deviation of feature polylines from the analytic curve (mm).
    pub curve_chord_tol_mm: f64,
    /// Flank-probe offset for seam trimming, as a factor of surface_tol.
    pub probe_delta_factor: f64,
    /// Crease gate for boolean seams (degrees).
    pub min_dihedral_deg: f64,
    /// Crease gate for native modeled curves (degrees).
    pub min_tangency_angle_deg: f64,
    /// Corner merge radius, as a fraction of the scene diagonal.
    pub corner_merge_tol_diag_fraction: f64,
    /// Seam seed grid cell size (mm); 0 = auto from each pair's overlap box.
    pub seed_cell_size_mm: f64,
    /// Hard cap on predictor–corrector steps per traced curve.
    pub max_trace_steps: u32,
}

impl Default for SfccTuning {
    /// Mirrors `DEFAULT_SFCC_TUNING` (sfcc-tuning.mts) for the fields ported so far.
    fn default() -> Self {
        SfccTuning {
            depth_min: 5,
            depth_max: 8,
            bounds_padding_mm: 2.0,
            enforce_edge_balance: true,

            normal_variation_deg: 18.0,
            blend_curvature_refine: true,
            blend_curvature_deg: 18.0,
            tangential_epsilon: 0.05,
            feature_query_inflate: 0.25,

            surface_tol_mm: 0.01,
            curve_chord_tol_mm: 0.02,
            probe_delta_factor: 10.0,
            min_dihedral_deg: 15.0,
            min_tangency_angle_deg: 2.0,
            corner_merge_tol_diag_fraction: 1e-6,
            seed_cell_size_mm: 0.0,
            max_trace_steps: 20_000,
        }
    }
}
