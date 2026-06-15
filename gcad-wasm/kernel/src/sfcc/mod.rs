//! SFCC mesh exporter pipeline.
//!
//! Port target: `src/export/sfcc/` (octree refinement, per-cell feature
//! classification, primal contouring, manifold audits). The per-cell frontier
//! (`classifyCellFeatures` + certificates — ~67% of slow exports) is the
//! parallelism target: rayon `par_iter` over the immutable feature set. Keep the
//! weld merges order-independent (sorted-key id assignment, fixed-order
//! reductions) so results stay deterministic under threads.
//!
//! TODO: port single-threaded first; validate against the TS oracle via the
//! order-insensitive canonical mesh compare (`mesh-canonical.mts` → Rust), then
//! add rayon and re-check the double-run determinism guard.
//!
//! M3a landed: the certified adaptive [`octree`] driver, the smooth-surface
//! [`refine_criteria`] (empty cull + per-stratum normal-variation / edge-crossing
//! certificates + blend-band curvature), and the integer-keyed [`point_table`]
//! vertex pool. M3b: [`face_contour`]. M3c: [`cell_mesh`], [`sliver_flip`],
//! [`manifold_check`], and the smooth-only [`pipeline`] driver — the first full
//! Rust mesh. DEFERRED: feature classification / curves / corners and the
//! feature-aware refine/contour/cell-mesh paths (M4).

pub mod cell_mesh;
pub mod face_contour;
pub mod feature_curves;
pub mod feature_set;
pub mod manifold_check;
pub mod newton;
pub mod octree;
pub mod pipeline;
pub mod point_table;
pub mod refine_criteria;
pub mod seam_trace;
pub mod sliver_flip;
pub mod spatial_index;
pub mod tree;
pub mod trim;
