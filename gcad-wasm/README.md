# gcad-wasm

Rust→WASM port of galacticad's CPU geometry kernel (scene graph, WGSL codegen,
f64 SDF evaluator, SFCC mesh exporter). Design + rationale:
[`../docs/research/gcad-wasm-rust-port.md`](../docs/research/gcad-wasm-rust-port.md).

**Status:** scaffold only — the kernel modules are stubs to be ported incrementally.

## Layout
- `kernel/` — pure geometry, no wasm-bindgen. Builds + tests **natively**.
- `wasm/`   — thin `#[wasm_bindgen]` boundary (cdylib). Marshaling only.

## Build / test

Native (the correctness path — the TS SFCC implementation is the oracle):

```sh
cargo test -p gcad-kernel
```

Toolchain is pinned in `rust-toolchain.toml` (stable 1.96.0); the native kernel
needs no extra setup.

### WASM build (later)

Needs the wasm target, and — for the rayon parallel path — a nightly toolchain
with `rust-src` + `-Zbuild-std` and `-Ctarget-feature=+atomics,+bulk-memory`, plus
COOP/COEP headers on the host (`src/_headers` for prod, Vite `server.headers` for
dev). See the design doc §1/§4. Sketch:

```sh
rustup target add wasm32-unknown-unknown
# scalar (stable) build:
cargo build -p gcad-wasm --target wasm32-unknown-unknown --release
# then wasm-bindgen-cli emits the JS glue + .d.ts; the threaded build switches
# to the pinned nightly with build-std.
```
