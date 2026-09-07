//! Export validity is more than edge incidence. Report unperformed checks and
//! exhausted numerical/refinement budgets explicitly; none of these checks is a
//! proof of geometric embedding or complete continuous-surface reconstruction.
use crate::sdf::CsgNode;
use crate::sfcc::manifold_check::ManifoldReport;
use std::cell::Cell;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AuditStatus {
    Passed,
    Failed,
    #[default]
    NotChecked,
}
impl AuditStatus {
    pub fn from_passed(passed: bool) -> Self {
        if passed {
            Self::Passed
        } else {
            Self::Failed
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::NotChecked => "notChecked",
        }
    }
}

/// Query failures are local to one export/thread. A guard restores its enclosing
/// scope on return, cancellation, or unwind; nested serial recovery is isolated.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NumericalFailures {
    /// Failed carrier-pair queries or triple-point endpoint refinements.
    pub curve_projection: usize,
    pub face_projection: usize,
    pub chord_budget: usize,
}
impl NumericalFailures {
    pub fn total(self) -> usize {
        self.curve_projection + self.face_projection + self.chord_budget
    }
}
thread_local! { static FAILURES: Cell<NumericalFailures> = Cell::new(NumericalFailures::default()); }
pub struct NumericalGuard(NumericalFailures);
impl NumericalGuard {
    pub fn new() -> Self {
        Self(FAILURES.replace(NumericalFailures::default()))
    }
}
impl Drop for NumericalGuard {
    fn drop(&mut self) {
        FAILURES.set(self.0);
    }
}
pub fn numerical_failures() -> NumericalFailures {
    FAILURES.get()
}
pub fn restore_numerical_failures(value: NumericalFailures) {
    FAILURES.set(value);
}
pub fn curve_projection_failed() {
    let mut d = FAILURES.get();
    d.curve_projection += 1;
    FAILURES.set(d);
}
pub fn face_projection_failed() {
    let mut d = FAILURES.get();
    d.face_projection += 1;
    FAILURES.set(d);
}
pub fn chord_budget_exhausted() {
    let mut d = FAILURES.get();
    d.chord_budget += 1;
    FAILURES.set(d);
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SfccValidation {
    /// Raw candidate tracing outcomes, including hidden carrier extensions.
    /// These counters alone do not establish exposed feature completeness.
    pub feature_trace: crate::sfcc::seam_trace::SeamTraceDiagnostics,
    pub edge_incidence: AuditStatus,
    pub vertex_links: AuditStatus,
    pub face_segments: AuditStatus,
    pub vertex_residuals: AuditStatus,
    pub unresolved_cells: usize,
    pub feature_fallback_cells: usize,
    pub numerical: NumericalFailures,
    pub off_surface_vertices: usize,
    pub max_vertex_residual: f64,
}
impl SfccValidation {
    pub fn with_topology(m: &ManifoldReport, check_vertex_links: bool) -> Self {
        Self {
            edge_incidence: AuditStatus::from_passed(
                m.open_edges == 0 && m.non_manifold_edges == 0 && m.misoriented_edges == 0,
            ),
            vertex_links: if check_vertex_links {
                AuditStatus::from_passed(m.non_manifold_vertices == 0)
            } else {
                AuditStatus::NotChecked
            },
            ..Self::default()
        }
    }
    /// Test the values actually shipped, after f32 conversion. This bounds the
    /// vertex field residual only, not triangle interiors or Hausdorff distance.
    pub fn check_vertices(&mut self, tree: &CsgNode, verts: &[f32], tolerance: f64) {
        self.off_surface_vertices = 0;
        self.max_vertex_residual = 0.0;
        for v in verts.chunks_exact(8) {
            let f = tree.f([v[0] as f64, v[1] as f64, v[2] as f64]).abs();
            if !f.is_finite() || f > tolerance {
                self.off_surface_vertices += 1;
            }
            if f.is_finite() {
                self.max_vertex_residual = self.max_vertex_residual.max(f);
            }
        }
        self.vertex_residuals = AuditStatus::from_passed(self.off_surface_vertices == 0);
    }
    pub fn status(&self) -> &'static str {
        let checks = [self.edge_incidence, self.vertex_links, self.face_segments, self.vertex_residuals];
        if checks.contains(&AuditStatus::Failed) {
            "failed"
        } else if checks.contains(&AuditStatus::NotChecked)
            || self.unresolved_cells > 0
            || self.feature_fallback_cells > 0
            || self.numerical.total() > 0
        {
            "incomplete"
        } else {
            "passed"
        }
    }
    pub fn ok(&self) -> bool {
        self.status() == "passed"
    }
    /// One shared schema for serial, worker, and native boundary tests.
    pub fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"status\":\"{}\",\"edgeIncidence\":\"{}\",\"vertexLinks\":\"{}\",",
                "\"faceSegments\":\"{}\",\"vertexResiduals\":\"{}\",\"unresolvedCells\":{},",
                "\"featureFallbackCells\":{},\"curveProjectionFailures\":{},\"faceProjectionFailures\":{},",
                "\"chordBudgetFailures\":{},\"offSurfaceVertices\":{},\"maxVertexResidual\":{},",
                "\"featureTrace\":{{\"pairsConsidered\":{},\"seedsFound\":{},\"curvesTraced\":{},",
                "\"tangencyBails\":{},\"tangentReversals\":{},\"correctionBails\":{},\"stepCapHits\":{}}}}}"
            ),
            self.status(),
            self.edge_incidence.as_str(),
            self.vertex_links.as_str(),
            self.face_segments.as_str(),
            self.vertex_residuals.as_str(),
            self.unresolved_cells,
            self.feature_fallback_cells,
            self.numerical.curve_projection,
            self.numerical.face_projection,
            self.numerical.chord_budget,
            self.off_surface_vertices,
            self.max_vertex_residual,
            self.feature_trace.pairs_considered,
            self.feature_trace.seeds_found,
            self.feature_trace.curves_traced,
            self.feature_trace.tangency_bails,
            self.feature_trace.tangent_reversals,
            self.feature_trace.correction_bails,
            self.feature_trace.step_cap_hits
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sdf::{leaf_at, Shape};
    fn passed() -> SfccValidation {
        SfccValidation {
            edge_incidence: AuditStatus::Passed,
            vertex_links: AuditStatus::Passed,
            face_segments: AuditStatus::Passed,
            vertex_residuals: AuditStatus::Passed,
            ..Default::default()
        }
    }
    #[test]
    fn skipped_checks_and_exhausted_budgets_are_not_success() {
        assert!(passed().ok());
        let mut v = passed();
        v.vertex_links = AuditStatus::NotChecked;
        assert_eq!(v.status(), "incomplete");
        v = passed();
        v.unresolved_cells = 1;
        assert!(!v.ok());
        v = passed();
        v.feature_fallback_cells = 1;
        assert!(!v.ok());
        v = passed();
        v.numerical.chord_budget = 1;
        assert!(!v.ok());
        v.edge_incidence = AuditStatus::Failed;
        assert_eq!(v.status(), "failed");
    }
    #[test]
    fn failures_are_isolated_across_nested_exports() {
        let _scope = NumericalGuard::new();
        curve_projection_failed();
        {
            let _nested = NumericalGuard::new();
            assert_eq!(numerical_failures().total(), 0);
            face_projection_failed();
        }
        assert_eq!(numerical_failures(), NumericalFailures { curve_projection: 1, ..Default::default() });
    }
    #[test]
    fn residual_audit_checks_final_float32_positions_and_nonfinite_values() {
        let tree = leaf_at(Shape::Sphere { r: 1.00000004 }, [0.; 3]);
        let mut v = passed();
        let mut verts = [1.00000004_f64 as f32, 0., 0., 0., 1., 0., 0., 0.];
        v.check_vertices(&tree, &verts, 1e-9);
        assert_eq!(v.off_surface_vertices, 1);
        assert_eq!(v.status(), "failed");
        v.check_vertices(&tree, &verts, 1e-6);
        assert!(v.ok());
        verts[0] = f32::NAN;
        v.check_vertices(&tree, &verts, 1e-6);
        assert!(!v.ok());
        assert!(!v.to_json().contains("NaN"));
    }
}
