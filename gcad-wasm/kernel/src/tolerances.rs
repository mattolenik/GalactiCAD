//! Resolved SFCC tolerances. Port of `src/export/sfcc/tolerances.mts`.
//!
//! Turns the tuning knobs (mm / factors) into the absolute world-space values the
//! pipeline consumes, with scene-diagonal-relative defaults applied. Resolved
//! once per export run.

use crate::tuning::SfccTuning;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedTolerances {
    /// Max |f| at emitted vertices (mm) — the export accuracy anchor.
    pub surface_tol: f64,
    /// Max chord deviation of feature polylines from the analytic curve (mm).
    pub max_chord_error: f64,
    /// Newton on-curve residual (mm).
    pub curve_eps: f64,
    /// Flank-probe offset for seam trimming (mm).
    pub probe_delta: f64,
    /// cos(min_dihedral_deg): boolean-seam crease gate.
    pub min_dihedral_cos: f64,
    /// cos(min_tangency_angle_deg): native-curve crease gate.
    pub native_crease_cos: f64,
    /// sin(min_tangency_angle_deg): tracer tangency floor.
    pub min_tangency_sin: f64,
    /// Corner merge radius (mm).
    pub corner_merge_tol: f64,
    /// Seam seed grid cell size (mm); 0 = auto.
    pub seed_cell_size: f64,
    /// Hard cap on predictor–corrector steps per traced curve.
    pub max_trace_steps: u32,
}

pub fn resolve_tolerances(t: &SfccTuning, scene_diag: f64) -> ResolvedTolerances {
    let deg = std::f64::consts::PI / 180.0;
    ResolvedTolerances {
        surface_tol: t.surface_tol_mm,
        max_chord_error: t.curve_chord_tol_mm,
        curve_eps: (1e-9 * scene_diag).max(1e-12),
        probe_delta: t.probe_delta_factor * t.surface_tol_mm,
        min_dihedral_cos: (t.min_dihedral_deg * deg).cos(),
        native_crease_cos: (t.min_tangency_angle_deg * deg).cos(),
        min_tangency_sin: (t.min_tangency_angle_deg * deg).sin(),
        corner_merge_tol: t.corner_merge_tol_diag_fraction * scene_diag,
        seed_cell_size: t.seed_cell_size_mm,
        max_trace_steps: t.max_trace_steps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_and_passthrough_fields() {
        let t = SfccTuning {
            surface_tol_mm: 0.02,
            curve_chord_tol_mm: 0.05,
            probe_delta_factor: 3.0,
            min_dihedral_deg: 60.0,
            min_tangency_angle_deg: 30.0,
            corner_merge_tol_diag_fraction: 1e-3,
            seed_cell_size_mm: 0.0,
            max_trace_steps: 5000,
        };
        let r = resolve_tolerances(&t, 200.0);
        assert_eq!(r.surface_tol, 0.02);
        assert_eq!(r.max_chord_error, 0.05);
        assert!((r.probe_delta - 0.06).abs() < 1e-15);
        assert!((r.curve_eps - (1e-9 * 200.0)).abs() < 1e-18);
        assert!((r.min_dihedral_cos - 0.5).abs() < 1e-12); // cos 60°
        assert!((r.min_tangency_sin - 0.5).abs() < 1e-12); // sin 30°
        assert!((r.corner_merge_tol - 0.2).abs() < 1e-15);
        assert_eq!(r.max_trace_steps, 5000);
    }

    #[test]
    fn curve_eps_has_a_floor() {
        let r = resolve_tolerances(&SfccTuning::default(), 1e-6);
        assert_eq!(r.curve_eps, 1e-12); // floor wins over 1e-9 * 1e-6 = 1e-15
    }
}
