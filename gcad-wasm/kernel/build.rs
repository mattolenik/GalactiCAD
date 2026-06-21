//! Build stamp: bakes the repo VERSION (git-derived, `scripts/version`) into the
//! kernel so `version()` reports the SAME string as the rest of the build.
//!
//! The Makefile `export`s VERSION, so every Rust build it drives (`make gcad-wasm`,
//! `gcad-wasm-threads`, `gcad-test`) sees it in the environment and we stamp it
//! here. Outside the Makefile (a bare `cargo build`/`cargo test`, rust-analyzer)
//! VERSION is unset and we fall back to the Cargo.toml package version.
use std::env;

fn main() {
    // Re-run (and recompile the crate) whenever VERSION changes, so the stamp
    // never goes stale across commits even when no .rs source changed.
    println!("cargo:rerun-if-env-changed=VERSION");
    println!("cargo:rerun-if-changed=build.rs");

    let version = env::var("VERSION")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=GCAD_VERSION={version}");
}
