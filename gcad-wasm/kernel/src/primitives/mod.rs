//! SDF building blocks shared across shapes. M1: the 2D polygon distance field
//! (extrude/loft/lathe profiles) and the smooth-boolean (smin) family.
//! Per-primitive eval/normal and the `Primitive` trait land in M2.

pub mod polygon2d;
pub mod smin;
