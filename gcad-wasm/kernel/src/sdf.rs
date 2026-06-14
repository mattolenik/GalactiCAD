//! CPU-side f64 signed-distance evaluator.
//!
//! Port target: `src/export/sfcc/cpu-sdf*.mts`. Design: each primitive is defined
//! ONCE via a `Primitive` trait that yields CPU eval + WGSL emit + GPU param
//! packing, so the GPU and CPU representations cannot drift (today they are
//! maintained twice).
//!
//! f64 arithmetic is bit-reproducible across conforming engines except for NaN
//! payload bits — guard against producing NaNs (sqrt of negatives, 0/0).
//!
//! TODO: define `trait Primitive { eval_f64; emit_wgsl; write_params; aabb }` and
//! port shapes one at a time (box, cylinder, twisted extrude first).

/// 3-component f64 vector (placeholder until the math layer is ported).
pub type Vec3 = [f64; 3];
