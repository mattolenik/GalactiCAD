//! SFCC tuning knobs. Port of `src/export/sfcc/sfcc-tuning.mts`.
//!
//! M1 stub: only the fields consumed by [`crate::tolerances`] are present so far.
//! The full knob set (octree depth bounds, normal-variation certs, blend-band
//! refinement, profiling) lands with the octree/refine port in M2+.

/// Finest octree level; lattice resolution is 2^SFCC_MAX_DEPTH cells per axis.
/// span = 16385, span³ ≈ 4.4e12, exact in i64 (and in f64 < 2^53).
pub const SFCC_MAX_DEPTH: u32 = 14;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SfccTuning {
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
    /// Placeholder defaults — reconcile with `DEFAULT_SFCC_TUNING` (sfcc-tuning.mts)
    /// when the full struct lands in M2.
    fn default() -> Self {
        SfccTuning {
            surface_tol_mm: 0.01,
            curve_chord_tol_mm: 0.01,
            probe_delta_factor: 2.0,
            min_dihedral_deg: 20.0,
            min_tangency_angle_deg: 5.0,
            corner_merge_tol_diag_fraction: 1e-4,
            seed_cell_size_mm: 0.0,
            max_trace_steps: 100_000,
        }
    }
}
