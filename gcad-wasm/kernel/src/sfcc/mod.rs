//! SFCC mesh exporter pipeline.
//!
//! Port target: `src/export/sfcc/` (octree refinement, per-cell feature
//! classification, primal contouring, manifold audits). The weld merges are kept
//! order-independent (sorted-key id assignment, fixed-order reductions) so results
//! are deterministic (validated against the TS oracle via the order-insensitive
//! canonical mesh compare, `mesh-canonical.mts` → Rust).
//!
//! M3a landed: the certified adaptive [`octree`] driver, the smooth-surface
//! [`refine_criteria`] (empty cull + per-stratum normal-variation / edge-crossing
//! certificates + blend-band curvature), and the integer-keyed [`point_table`]
//! vertex pool. M3b: [`face_contour`]. M3c: [`cell_mesh`], [`sliver_flip`],
//! [`manifold_check`], and the smooth-only [`pipeline`] driver — the first full
//! Rust mesh. DEFERRED: feature classification / curves / corners and the
//! feature-aware refine/contour/cell-mesh paths (M4).

pub mod cancel;
pub mod cell_mesh;
pub mod face_contour;
pub mod feature_curves;
pub mod feature_chain;
pub(crate) mod provenance;
pub mod feature_set;
pub mod field_branches;
pub mod manifold_check;
pub mod newton;
pub mod octree;
pub mod pipeline;
pub mod point_table;
pub(crate) mod predicates;
pub(crate) mod patch_triangulate;
pub(crate) mod triangle_quality;
pub(crate) mod surface_patch;
pub(crate) mod mesh_edit;
pub(crate) mod quality_remesh;
pub(crate) mod adaptive_refine;
pub(crate) mod assembly;
pub mod refine_criteria;
pub mod sdf_simd;
pub mod seam_trace;
pub mod sliver_flip;
pub mod spatial_index;
pub mod tree;
pub mod trim;
pub mod worker;

pub mod validation;

mod blend_surfaces;

pub(crate) mod branch_surfaces;
pub(crate) mod surface_refine;

pub mod perf;
