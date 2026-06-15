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
//! vertex pool. DEFERRED: face-contour (M3b), cell-mesh + assemble (M3c),
//! feature classification / curves / corners (M4).

pub mod octree;
pub mod point_table;
pub mod refine_criteria;
