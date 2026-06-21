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

### WASM build

Needs the wasm target plus `wasm-pack`; the pinned stable toolchain is enough.
Build via `make gcad-wasm`, or directly:

```sh
rustup target add wasm32-unknown-unknown
RUSTFLAGS='-C target-feature=+simd128' wasm-pack build gcad-wasm/wasm --target web
```

This emits the JS glue + `.d.ts` into `gcad-wasm/wasm/pkg/` (consumed by esbuild + tsc).
