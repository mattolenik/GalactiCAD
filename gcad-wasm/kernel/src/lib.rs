//! gcad geometry kernel — pure, native-testable geometry: the scene/node graph,
//! the f64 SDF evaluator, WGSL shader codegen, and the SFCC mesh exporter.
//!
//! This crate has NO wasm-bindgen dependency and builds + tests natively
//! (`cargo test -p gcad-kernel`) so the TypeScript SFCC implementation can serve
//! as a correctness oracle during the port. The thin `gcad-wasm` crate wraps this
//! for the browser. Design: `docs/research/gcad-wasm-rust-port.md`.

pub mod codegen;
pub mod math;
pub mod parity;
pub mod primitives;
pub mod scene;
pub mod scene_bridge;
pub mod sdf;
pub mod sfcc;
pub mod strata;
pub mod tolerances;
pub mod tuning;

/// Crate version, surfaced across the WASM boundary as a build smoke test.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_reported() {
        assert!(!version().is_empty());
    }
}
