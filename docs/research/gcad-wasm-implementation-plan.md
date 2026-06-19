# gcad-wasm: implementation plan

Execution plan for the Rust→WASM port. Companion to the design/rationale doc
[`gcad-wasm-rust-port.md`](./gcad-wasm-rust-port.md) (read that first for the
*why* and the verified toolchain facts). This doc is the *how* and the *in-what-order*.

Branch: `wasm-port`. Scaffold landed (`gcad-wasm/` two-crate workspace, native
test + wasm-pack verified). Status: pre-implementation.

---

## Strategy

**Two epics, sequenced by value.** The motivating win (rayon parallelism of the
~67% `classifyCellFeatures` hot path) needs only the SFCC kernel + its CPU SDF
subset — *not* the WGSL codegen or scene ownership. So:

- **Epic 1 — SFCC kernel in Rust (the perf win).** Port the CPU f64 SDF
  evaluator + SFCC pipeline. The scene arrives as the existing `SerializedNode[]`;
  GPU rendering and codegen stay entirely in TS. Ships the rayon speedup
  independently. *This is the priority.*
- **Epic 2 — Unify primitives + move WGSL codegen + scene ownership (the
  drift-killer).** Define one `trait Primitive { eval_f64; emit_wgsl;
  write_params }`, port all ~36 node types' codegen, move scene ownership to Rust,
  retarget DSL construction. Achieves single-source-of-truth. Optional follow-on;
  larger and riskier.

**Oracle-driven.** The TS SFCC is the correctness oracle at every gate. We already
have the backbone: `mesh-canonical.mts` (order-insensitive compare),
`determinism_test.mts` (double-run guard), and `canonicalEdgeRoot` (the
pure-of-key edge root). Each milestone has a concrete **exit gate** tied to
parity against TS, not "looks done."

**Scope facts that shape the plan** (from the codebase scope map):
- SFCC subset = **7 primitives** (Box, Sphere, Cylinder, Cone, Extrude, Loft,
  Lathe) + booleans (hard + smooth round/soft/chamfer/stairs/columns) + transforms
  (Translate, Rotate, uniform Scale). Everything else → `SfccUnsupportedError`.
- Scene coupling is **two thin spots only**: `compileCpuSdf` walk dispatch and
  `feature-set` native-feature extraction. Everything downstream is pure numeric.
- **No external npm deps** in the SFCC code — only monorepo math/scene imports.
- ~7,400 LOC Rust core; **18 `*_test.mts`** files are the parity corpus.

---

## Epic 0 — done

- `gcad-wasm/` workspace (`kernel` pure-geometry native-testable + `wasm` thin
  cdylib boundary); native test + wasm-pack `.d.ts` generation verified.
- Determinism prep in TS: `mesh-canonical`, double-run guard, `canonicalEdgeRoot`
  (keyed `PointTable` creates are pure-of-key — parallel-safe).
- Design doc + this plan.

---

## Epic 1 — SFCC kernel in Rust

Module groups & rough port sizes (LOC): Math ~510 · SDF eval ~675 · SDF tree +
scene-bridge ~600 · Strata ~400 · Features ~1,645 · Octree+refine+points ~735 ·
Meshing (contour+cell+sliver+manifold) ~1,735 · Assemble ~600.

### M1 — Foundations + the parity harness  *(build this first)*

The harness is infrastructure every later gate depends on; do it before any
geometry.

- **Math layer:** `similarity` (transform-bake), `grid` (lattice), `tolerances`,
  `polygon2d`, `smin` (5 modes + columns interval arithmetic). ~510 LOC, pure f64.
- **Parity harness:**
  - A TS script that runs the TS SFCC over a scene corpus and dumps
    `{verts, tris, stats, manifold}` fixtures (binary or JSON) under
    `gcad-wasm/fixtures/`.
  - A Rust test loader + a Rust port of `mesh-canonical` (`canonicalize_mesh` /
    `meshes_equivalent`) that compares Rust output to the fixtures with `pos_eps`
    (exact for same-impl, ULP-tolerant for cross-impl).
  - The double-run determinism guard, ported to Rust.
  - Render-level parity via the existing `agentcli triangle` / `compare` (SSIM) —
    no change needed, it's already order-insensitive.
- Port the math unit tests (`transform-bake_test`, `lattice_test`) to Rust as the
  first parity proof.
- **Exit gate:** math unit tests pass in Rust; harness can load a TS fixture and
  canonical-compare; `cargo test -p gcad-kernel` green.

### M2 — SDF eval + CSG tree (the subset)

- Per-shape eval/normal as `trait Primitive` impls. Order: **sphere → box →
  cylinder → cone** (simple, exact) then **extrude → loft → lathe** (2D profile,
  twist, local-Lipschitz bounds — the hard ones).
- CSG tree as an `enum` in an index arena (`min`/`max`/`blend`/`leaf`); `f`,
  `grad`, `interval_over_box`, `active_owners_at`, `active_strata_at`. Port the
  smin gradient weights + columns interval enclosure **verbatim** (non-monotone).
- `scene_bridge`: ingest `SerializedNode[]` → extract the 7-primitive geometry
  once; reject the rest with the `SfccUnsupportedError` equivalent.
- **Exit gate:** `cpu-sdf_test` + `cpu-sdf-primitives_test` + `extrude/loft/lathe`
  tests ported and passing; f64 `f`/`grad`/`interval`/`owner` match TS at sampled
  points within ULP tolerance.

### M3 — Octree → contour → mesh, **SMOOTH-ONLY end-to-end**

De-risk the contouring machinery *separately* from feature complexity by running
the whole pipeline on smooth scenes (sphere, smooth union/subtract) with features
disabled.

- Port: `octree`, `refine_criteria` (smooth certs only), `point_table`,
  `face_contour` (the 1,100-LOC module — **highest single-module risk**),
  `cell_mesh`, `sliver_flip`, `manifold_check`, `pipeline`.
- Reuse the `canonicalEdgeRoot` discipline already in TS.
- **Exit gate:** first full mesh out of Rust. Smooth `sfcc-pipeline_test` cases
  pass via canonical compare; manifold χ=2; double-run determinism guard green;
  `octree-adaptive_test` parity.

### M4 — Strata + features → **FULL feature parity** (single-threaded)

- Port `strata` (analytic carriers), then feature compilation: `feature_set`
  (native extraction via `scene_bridge` — the second scene-coupling spot),
  `seam_trace`, `trim`, `feature_curves`, `spatial_index`, `newton`.
- Wire the feature-aware paths: pins + corner-cells + edge-cells in
  refine/contour/mesh.
- **Exit gate:** *all* feature tests pass — `boolean-seams`, `edge-cells`,
  `corner-cells`, `complex-part`, `smooth-boolean`, `extrude/lathe/loft`. This is
  full SFCC parity, single-threaded, native + wasm.

### M5 — WASM integration behind a flag

- Expose `export_sfcc(serialized_nodes, tuning) -> {verts, tris, stats, manifold}`
  from the `wasm` crate. Return **owned `Vec`** (no zero-copy views — they're
  invalidated by allocation; verified). WGSL is untouched (Epic 2).
- Wire into the render worker behind a tuning flag (`exporter: "sfcc-rs"`); TS
  still owns the scene and sends `SerializedNode[]`.
- **Exit gate:** live-app mesh export via the Rust path matches the TS exporter
  (`agentcli triangle` SSIM ≥ 99 across the testcase sweep); single-threaded WASM
  perf baseline recorded vs TS.

### M6 — Rayon (the payoff)

- **Toolchain switch:** pinned nightly + `rust-src` + `build-std =
  ["panic_abort","std"]` + `RUSTFLAGS=-Ctarget-feature=+atomics,+bulk-memory` +
  `--target web`. Add COOP/COEP to Vite dev (`server.headers`) and prod
  (`src/_headers`). `await initThreadPool(navigator.hardwareConcurrency)` once at
  worker start.
- **Smoke-test nested workers first** (rayon pool spawns from inside the render
  worker) — verify on day one of M6.
- Parallelize the per-cell frontier (`classify` + certificates — pure reads over
  the immutable feature set) with `par_iter`; restructure contour/mesh to the
  **two-phase deterministic weld** (local-emit by key → sorted-key id assignment →
  fixed-order merge) so output stays bit-identical.
- **Exit gate:** determinism guard passes (double-run bit-identical);
  full-parity tests still green; measured speedup on the slow twisted cases
  (target ~2–4× on the hot path, per the research; verify, don't assume).

### M7 — Cutover

- Make `sfcc-rs` the default exporter; keep TS SFCC behind a flag as oracle for a
  deprecation window.
- Full regression sweep (`agentcli regress` across all testcases).
- Remove TS SFCC once stable.
- **Exit gate:** clean regression sweep; TS SFCC removed; the SFCC `*_test.mts`
  oracle suite either ported to Rust or retained against the flag.

---

## Epic 2 — unify primitives + WGSL codegen + scene ownership

Only start once Epic 1 is stable. This is the larger surface (all ~36 node types'
codegen) and carries the one genuinely hard tendril (DSL → scene construction).

- **E2-M1 — `trait Primitive::emit_wgsl` for the 7 SFCC shapes.** They already
  have `eval_f64` from Epic 1; add `emit_wgsl` + `write_params` and **byte-diff**
  the generated WGSL against the TS-generated shader. Proves the single-source
  pattern on known-good shapes.
- **E2-M2 — codegen for the remaining ~29 node types.** Operators/modifiers the
  GPU renders but SFCC doesn't eval (shell, twist, elongate, engrave, bend,
  tongue, knurl, offset, morph, groove, pipe, repeat_polar, seam, taper) + extra
  primitives (plane, disc, torus, capsule, blob, hexprism, threaded-rod,
  virtual-cap, polygon2d). `emit_wgsl` + `write_params` only; byte-diff each.
- **E2-M3 — move scene ownership to Rust.** Retarget the CAD transpiler to emit a
  serialized **full-scene** description (extend `SerializedNode[]` round-trip);
  Rust builds the scene and emits WGSL + packed param buffers + serialized nodes
  for UI hit-testing. Editor stays source-driven (no per-edit boundary churn).
  **Exit gate:** full live-app render parity (SSIM across all testcases); editor
  + isolate-view + push/pull still work.
- **E2-M4 — delete the duplication.** Remove TS cpu-sdf, TS WGSL codegen,
  FeatureGraph (dead once non-SFCC exporters are gone), and the non-SFCC
  exporters. Single source of truth achieved.

---

## Cross-cutting

**Parity harness (the spine).** Fixture-based canonical mesh compare (M1) + the
double-run determinism guard + render SSIM (`agentcli triangle`). `pos_eps = 0`
for same-impl determinism; small `pos_eps` for TS↔Rust ULP drift. Every milestone
gates on it.

**Toolchain progression.** Stable 1.96.0 through M5 (kernel is native-testable +
the scalar wasm build works on stable). Switch to pinned nightly + `build-std` at
M6 for rayon. Consider a second `rust-toolchain.toml` under `wasm/` so the kernel
keeps building on stable.

**Determinism.** f64 is bit-reproducible across engines except NaN payloads
(verified) — guard SDF against producing NaNs. Keep all parallel merges
order-independent (the weld rule). `canonicalEdgeRoot` already enforces this for
edge roots.

**Perf measurement.** Port the `tuning.profile → debug.sfcc.perf` bucketing to
Rust for apples-to-apples phase timing; profile WASM in browser devtools. Record
a baseline at M5 (single-thread) so M6's rayon speedup is measurable.

**CI.** Pin the nightly; run native `cargo test` (bulk of correctness) + a wasm
smoke build + the parity-fixture compare. Regenerate fixtures from TS when the
oracle legitimately changes (gated, reviewed).

---

## Risk register

| Risk | Mitigation |
|------|------------|
| `face-contour` (1,100 LOC) is the single most complex module | M3 isolates it on smooth scenes before features pile on; port with the existing edge-root parity test |
| Twisted extrude / loft local-Lipschitz bounds (|∇f|>1) | port the bound formulas verbatim; cover by `extrude`/`loft` tests at M2 |
| smin columns interval arithmetic (non-monotone) | verbatim port; `smooth-boolean_test` parity |
| Nested-worker rayon from inside the render worker | dedicated smoke test at M6 start; fallback = run kernel on main thread of a dedicated worker |
| Cross-engine f64 drift breaking exact fixtures | use ULP-tolerant `pos_eps` for cross-impl; reserve exact compare for same-impl determinism |
| Nightly/`build-std` is a moving target | pin a specific nightly; re-check wasm-bindgen-rayon README before bumps |
| Epic 2 DSL→scene retarget | defer entirely to Epic 2; Epic 1 reuses existing `SerializedNode[]`, no DSL change |

---

## Decision points (resolve as we go)

- **Stop after Epic 1?** Epic 1 delivers the perf win and is independently
  shippable. Epic 2 (drift-killer) is worth it only if codegen drift is hurting —
  decide after Epic 1 lands.
- **Closures vs enum dispatch** for SDF leaves/strata — default to enum + `match`
  (perf, no `dyn`); revisit only if a shape needs open extension.
- **SIMD128** — deferred; revisit only if M6 profiling shows arithmetic-bound
  phases (unlikely — the hot path is branchy classification).
- **Fixture format** (binary vs JSON) — pick at M1; binary if fixtures get large.

---

## Sequencing summary

```
Epic 0  ✔ scaffold + determinism prep + docs
Epic 1   M1 math + parity harness
         M2 SDF eval + CSG tree (subset)
         M3 octree→contour→mesh  (SMOOTH-only end-to-end)   ← first Rust mesh
         M4 strata + features      (FULL parity, 1-thread)   ← SFCC parity
         M5 WASM behind a flag      (live-app SSIM parity)
         M6 rayon                   (the perf payoff)         ← motivating win
         M7 cutover                 (default + remove TS)
Epic 2   E2-M1 trait emit_wgsl (7 SFCC shapes, byte-diff)
         E2-M2 codegen for remaining ~29 node types
         E2-M3 scene ownership → Rust (DSL retarget; render parity)
         E2-M4 delete TS cpu-sdf / codegen / FeatureGraph     ← single source
```
