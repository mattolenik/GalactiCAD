//! WGSL shader codegen.
//!
//! Port target: the `Node.compile*()` methods spread across `src/scene/`. Walks
//! the scene and emits the raymarcher WGSL as a string (copied once across the
//! boundary per rebuild — acceptable). Lives next to the SDF eval so both come
//! from a single `Primitive` definition (see `sdf`).
//!
//! TODO: port; byte-diff the emitted WGSL against the TS-generated shader.
