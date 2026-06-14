//! Thin wasm-bindgen boundary over `gcad_kernel`. Marshaling ONLY — no geometry
//! logic lives here. See `docs/research/gcad-wasm-rust-port.md` §2 for the boundary
//! contract: return owned `Vec<_>` for mesh buffers (zero-copy views are
//! invalidated by any Rust allocation that grows linear memory), and accept that
//! WGSL strings are copied once across the boundary per rebuild.

use wasm_bindgen::prelude::*;

/// Build smoke test: returns the kernel crate version across the boundary.
#[wasm_bindgen]
pub fn version() -> String {
    gcad_kernel::version().to_string()
}
