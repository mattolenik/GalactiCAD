# gcad-wasm: Rust→WASM port of the CPU geometry kernel

Design doc for porting galacticad's CPU-side geometry kernel — the scene/node
graph, WGSL shader codegen, the f64 SDF evaluator, and the SFCC mesh exporter —
from TypeScript to a single Rust crate compiled to WebAssembly. The WebGPU
raymarcher, editor UI, and CAD transpiler stay in TypeScript.

**Status:** exploration / not greenlit. Motivation: rayon data-parallelism of the
per-cell SFCC hot loop (`classifyCellFeatures` ≈ 67% of slow exports) plus a single
source of truth for each primitive (CPU eval + WGSL emit + param packing).

Companion: `sfcc-algorithm-design.md`. Determinism prep already landed in TS
(`src/export/sfcc/mesh-canonical.mts`, `determinism_test.mts`,
`edge-root-determinism_test.mts`, and `canonicalEdgeRoot` in `face-contour.mts`).

Confidence key: **[V]** verified against a primary source · **[J]** engineering
judgement (deep-research run did not settle it) · **[us]** established in our own
codebase work.

---

## 0. Reality check

A focused deep-research pass **refuted (0-3)** the idea that porting a pure f64
kernel to wasm32 is "largely a no-op." **[V]** This is a genuine rewrite (~17k LOC
of dense, tested TS: scene ~9.4k + SFCC ~5k + cpu-sdf ~2.2k). The redeeming factor
is that the cut is clean: the editor is **source-driven** (rewrites CAD text, never
mutates `Node` instances), `Node` is stateless geometry, FeatureGraph becomes dead
code once non-SFCC exporters are dropped, and the render-worker boundary already has
the right shape. **[us]**

The single hard tendril: today the scene is built by `new Function(body)()`
executing transpiled CAD code that calls `Node` constructors
(`render-worker-core.mts:612`). Retarget that to emit a **serialized scene
description** that Rust ingests; leave the CAD transpiler itself in TS.

---

## 1. Project structure & toolchain  [J]

(The deep-research run returned **no verified claims** here; this is judgement.)

Two-crate Cargo workspace at `gcad-wasm/`, sibling to `src/`:

```
gcad-wasm/
  Cargo.toml            # [workspace] members = ["kernel", "wasm"]
  rust-toolchain.toml   # pinned nightly + components = ["rust-src"]
  kernel/               # pure geometry: scene enum, sdf, sfcc, wgsl codegen
                        #   no wasm-bindgen — compiles & tests NATIVELY
  wasm/                 # thin cdylib: #[wasm_bindgen] exports, marshaling only
```

The split is the key to testing: `cargo test -p kernel` runs **natively** (fast,
full proptest/insta, no browser) with the TS reference as the oracle; the `wasm`
crate does boundary marshaling only.

- **Build tool:** `wasm-pack --target web`, or drive `wasm-bindgen-cli` directly
  from a build script. Lean toward the CLI because rayon forces explicit flags
  anyway (`-Ctarget-feature=+atomics,+bulk-memory`, `-Zbuild-std`) **[V]** and
  wasm-pack has historically fought that combination. **Not trunk** — trunk targets
  Rust-only apps; we have a TS/Vite host.
- **TypeScript types:** wasm-bindgen **auto-generates `.d.ts`** **[V]** that drops
  into the existing import graph.
- **Vite:** `vite-plugin-wasm` (or a prebuild step) + import the generated ESM. Set
  COOP/COEP headers in dev (`server.headers`) and prod (`src/_headers` already
  exists — that is where the prod headers go).
- **CI:** pin a *specific* nightly — the wasm-bindgen-rayon pinned nightly is a
  moving target (README 2025-11-15 vs docs.rs 2024-08-02) **[V]**. Run native
  `cargo test` (bulk of correctness) plus a wasm smoke build.

---

## 2. The TS↔WASM boundary  [V on the pitfalls]

Run the kernel **inside the existing render worker**; pay thread-pool init once at
worker start. The boundary is coarse (a few calls per rebuild/export), so use
**wasm-bindgen, not a hand-rolled ABI** — it marshals rich types (structs, strings,
slices, `Result`, classes) **[V]**; hand-rolled ABIs only pay off for
high-frequency DOM traffic, which we do not have.

Three verified traps:

1. **Zero-copy typed-array views are a footgun.** `Float64Array`/`Uint32Array`
   views into linear memory are **invalidated by any Rust allocation that grows
   memory** — `WebAssembly.Memory.grow()` detaches the old buffer and the stale
   view *silently reads zero*. **[V]** → For the once-per-export mesh, return
   `Vec<f32>`/`Vec<u32>` and let wasm-bindgen copy; the copy is negligible vs
   meshing compute. Reserve zero-copy views for hot per-frame data (none here).
2. **Rust→JS strings are always copied** via TextDecoder/TextEncoder (UTF-8↔UTF-16).
   `js_sys::JsString` does **not** help for a WGSL string *generated in Rust* (it
   already lives in linear memory). **[V]** → Accept the one WGSL copy per rebuild.
3. **Scene input:** construction is once-per-rebuild (not hot) → pass the whole
   scene as **one serialized blob** (extend the round-trippable `SerializedNode[]`)
   rather than per-node boundary calls.

---

## 3. Performant CPU SDF evaluator  [J] + [V on f64/SIMD facts]

- **Scene/SDF tree → Rust `enum` + `match`** in an index-based arena (`Vec<Node>`,
  children as indices). Build-once/read-many ⇒ **no `Rc`/`RefCell`**, no
  borrow-checker friction. **[J]**
- **Drift-killer:** one `trait Primitive { eval_f64(); emit_wgsl(); write_params(); }`
  per shape — define each primitive once and get CPU eval + GPU codegen + param
  packing that cannot drift (today they are maintained twice). **[us][J]** This is
  the architectural payoff that justifies moving codegen and SDF together.
- **SIMD128 — do not lead with it.** It is a **compile-time, all-or-nothing**
  decision (no in-binary runtime dispatch; multiversioning = ship two binaries and
  select in JS). **[V]** For branchy symbolic eval (min/max trees, per-leaf type
  dispatch) SIMD helps little — the work is divergent control flow, not wide
  arithmetic, which matches our profile (`classifyCellFeatures`-bound, not
  arithmetic-bound) **[us]**. Where it *could* pay: batching a primitive over a
  cell's 8 corners / along an edge. Get scalar f64 + rayon working and **measure
  first**. **[J]**
- **f64 is bit-reproducible across engines except NaN payload bits.** **[V]** →
  guard against producing NaNs (sqrt of negatives, 0/0); the existing
  double-run determinism guard catches payload nondeterminism within an engine.
- **Bounds checks:** prefer iterators (elide checks) in hot loops; `get_unchecked`
  only in audited spots, after measuring. **[J]**

---

## 4. Parallelism (rayon) — payoff and setup tax  [V]

Setup (all verified): **nightly** + `rust-src` + `build-std = ["panic_abort","std"]`
+ `RUSTFLAGS=-Ctarget-feature=+atomics,+bulk-memory` + `--target web` +
**COOP/COEP cross-origin isolation** (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`) + `await
initThreadPool(navigator.hardwareConcurrency)` once before any rayon call. Default
wasm32 `std::thread::spawn` **panics** with no override. **[V]**
`wasm-bindgen-rayon` (the **RReverser fork** — GoogleChromeLabs archived
2024-07-17) is the documented path: Web Workers sharing one module+memory via
SharedArrayBuffer. **[V]**

Maps directly onto the plan: parallelize the **per-cell frontier**
(`classifyCellFeatures` + certificates — independent reads over the immutable
feature set) with `par_iter`. **[us]**

**Determinism**, independently corroborated: rayon `reduce`/`sum` apply the op in
**unspecified order**, so non-associative FP is run-to-run-variable **[V]** — exactly
the hazard the two-phase weld (sorted-key id assignment, fixed-order merge) avoids
**[us]**. A **deterministic** reduction costs ≈nothing vs the non-deterministic one
(within 0.2% in the cited study) **[V]**, so there is no performance excuse for
arrival-order-dependent merges. `canonicalEdgeRoot` is this discipline applied to
the edge iso-crossing.

**Smoke-test early** (research did not cover): the rayon pool spawns sub-workers
from *inside* the render worker (nested workers). Modern browsers allow it; verify
on day one.

---

## 5. Correctness & performance methodology  [J] + [us]

(No verified claims surfaced here, but the underlying sources are sound.)

- **TS SFCC = the oracle.** Port the existing `mesh-canonical.mts` order-insensitive
  compare to Rust and cross-check Rust↔TS with the `posEps` tolerance path; reuse
  the double-run determinism guard.
- **Native `cargo test`:** `proptest` for invariants (χ, manifold, watertight,
  vertices-on-surface), `insta` for snapshotting canonical mesh signatures.
- **Profiling:** browser devtools shows wasm frames; port the existing
  `tuning.profile → debug.sfcc.perf` bucketing to Rust for apples-to-apples phase
  timing.
- **Contouring references** (authoritative, unverified by this run): QEF stability
  via clamped SVD/pseudo-inverse, Manifold Dual Contouring, dualsimp. Caveat: SFCC
  is primal/feature-conforming with its own manifold audit, not classic DC — treat
  these as reference, not prescription; `manifold-check.mts` + χ asserts already
  encode the guarantees.

---

## 6. Build order

1. Scaffold the workspace; native `cargo test` + wasm-pack build green; COOP/COEP in
   Vite dev + `src/_headers`; nested-worker rayon smoke test.
2. Port primitives as `trait Primitive` — validate WGSL byte-diff + f64 eval vs TS,
   one shape at a time.
3. Port scene enum + WGSL codegen; one scene end-to-end through the worker; render
   matches via SSIM.
4. Port SFCC **single-threaded**; validate mesh vs TS oracle (canonical compare).
5. Add rayon on the frontier; validate the determinism guard; measure.
6. SIMD128 batching only if step-5 profiling justifies it.

---

## 7. Open questions (spike rather than trust)

The deep-research run left these unsettled — treat §1/§3/§5 recommendations as
judgement:

- Exact wasm-pack-vs-CLI + Vite/`.d.ts` wiring and the dev-loop (watch/HMR).
- SoA vs enum-tree micro-decisions and concrete bounds-check elimination.
- Whether SIMD128 actually pays for *our* branchy eval.
- The proptest/insta/ULP-diff oracle harness in practice.
- Nested-worker rayon behavior from inside the render worker.

---

## Sources

Primary (verified 3-0 unless noted):
- wasm-bindgen guide — https://rustwasm.github.io/docs/wasm-bindgen/print.html
- wasm-bindgen str type — https://rustwasm.github.io/docs/wasm-bindgen/reference/types/str.html
- js-sys (view invalidation) — https://docs.rs/js-sys
- core::arch::wasm32 (SIMD/atomics) — https://doc.rust-lang.org/core/arch/wasm32/index.html
- WebAssembly Nondeterminism — https://github.com/WebAssembly/design/blob/main/Nondeterminism.md
- WebAssembly numerics spec — https://webassembly.github.io/spec/core/exec/numerics.html
- rayon ParallelIterator — https://docs.rs/rayon/latest/rayon/iter/trait.ParallelIterator.html
- wasm-bindgen-rayon (RReverser) — https://github.com/RReverser/wasm-bindgen-rayon
- deterministic parallel reduction (arXiv 2408.05148, SC'24) — https://arxiv.org/pdf/2408.05148
- SharedArrayBuffer / COOP-COEP (MDN) — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer

Secondary / blog / academic (unverified, for the open-question areas):
- Vite + Rust/WASM — https://github.com/shadanan/vite-rust-wasm
- SIMD-enhanced WASM library — https://nickb.dev/blog/authoring-a-simd-enhanced-wasm-library-with-rust/
- Arenas in Rust — https://manishearth.github.io/blog/2021/03/15/arenas-in-rust/
- QEF — https://www.mattkeeter.com/projects/qef/
- Manifold Dual Contouring — https://onlinelibrary.wiley.com/doi/full/10.1111/cgf.13933
- Dual contouring tutorial — https://www.boristhebrave.com/2018/04/15/dual-contouring-tutorial/
- dualsimp — https://www.cs.wustl.edu/~taoju/research/dualsimp_tvcg.pdf
