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
