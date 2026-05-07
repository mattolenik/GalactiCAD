# Iso-simplicial exporter — handoff notes

## Agent 1 (this drop)

- **Modules:** `src/export/iso-simplicial/` — `constants.mts`, `cube-tables.mts`, `tet-tables.mts`, `extract-tables.mts`, barrel `index.mts`.
- **`IsoSimplicialConstants`:** frozen defaults aligned with reference `main.cpp` / `iso_common.h` (+ `badqef` ratio from `iso_method_ours.cpp`). See JSDoc on `constants.mts` for symbol mapping.
- **Tables:** byte-for-byte parity with `cube_arrays.cpp`, `tet_arrays.cpp`, and `VisitorExtract` static `faceTable` / `flipTable`. Corner order uses reference `Index` (x + 2y + 4z).
- **Tests:** `iso-simplicial-tables_test.mts` — dimensions and spot-checks vs reference literals.

## Agent 2 (GPU batch sampler)

- **WGSL:** `src/shaders/iso_sample_batch.wgsl` — compute `isoSampleBatch`, `@workgroup_size(256)`. Uniform `sampleCount`; `positionsIn` = tight `f32` triples; `sdfOut[i]` = `vec4(nx, ny, nz, d)`. Bindings `0,1,2,25,27,28,30` aligned with `sample_grid.wgsl` scene bindings.
- **TS:** `iso-sample-batch.mts` — `IsoSampleBatch` mirrors `GridSampler` buffer lifecycle (local cancellation/uniforms/positions/out destroyed after `run`). Export from `index.mts`.
- **Compile:** `ShaderCompiler` replaces `sceneAuxFast`, `sceneAux`, `sceneAuxMid`, `sceneSDF` (no `sceneSDF_mid`). `render-worker-core.mts` imports the WGSL string so esbuild wgsl-loader validates it on `make build`.
- **Test:** `iso-sample-batch_test.mts` — expands includes with `fs`, `await import("webgpu")` **after** `SceneInfo` (static `webgpu` import pollutes `globalThis` and breaks the `sphere` binding). `Object.defineProperty(globalThis, "navigator", …)` for Node. Skips if no adapter. CAD source uses `return sphere.radius(10)` (fluent API). Compares batch vs `GridSampler` 1×1×1; sample points avoid the sphere center where the normal is singular.

## Gaps / next agents

- Agent 3+: QEF solvers consume Hermite samples; iteration order for oversampling must match reference triple loops in `iso_method_ours.h` (x outer, y, z inner with `<= OVERSAMPLE_QEF`).
