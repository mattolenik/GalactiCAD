# Agent 2 to-do implementation
_Exported on 5/7/2026 at 15:55:07 PDT from Cursor (3.2.16)_

---

**User**

Implement the following to-dos from the plan (the plan is attached for your reference). Do NOT edit the plan file itself.

You have been assigned the following 1 to-do(s) with IDs: agent-2

1. [agent-2] Agent 2: iso_sample_batch.wgsl + GridSampler-style TS + parity test

These to-dos have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the assigned to-dos.

---

**Cursor**

Implementing Agent 2: iso-simplicial GPU batch sampler (WGSL + TS + parity test). Exploring reference patterns and marking the todo in progress.



Implementing the WGSL shader and TS wrapper. Checking how `faceSelection` is initialized in the worker and verifying `vec3` array stride concerns:



Creating the shader, TS module, wiring it into the render worker for build-time WGSL validation, and adding a parity test that loads WGSL via `fs` (tsx can't import `.wgsl`).



Moving the validation block: statements can't appear between import declarations.



Reordering the test: `Object.assign(globalThis, globals)` from `webgpu` overwrites globals like `sphere` before `SceneInfo` runs.



Deferring the `webgpu` import: importing `webgpu` at module load runs native init that pollutes `globalThis` (including replacing `sphere`) before `SceneInfo` runs.



Here is what was implemented for **Agent 2**.

### WGSL: `src/shaders/iso_sample_batch.wgsl`
- Compute entry point `isoSampleBatch`, `@workgroup_size(256)`.
- **Uniform (binding 0):** `sampleCount` (+ padding to 16 bytes).
- **Input (binding 1):** `array<f32>` — tight `[x,y,z, …]` triples (avoids `array<vec3f>` 16-byte stride).
- **Output (binding 2):** `array<vec4f>` — `xyz` = `sceneSDF(p).n`, `w` = `sceneSDF(p).d`.
- **Scene bindings** aligned with `sample_grid.wgsl` / `mdc.wgsl`: `25` cancellation, `27` `polygonVertices`, `28` `faceSelection`, `30` `mdcSceneParams`, plus `hg_sdf`, `mdc_scene_params_read`, and `//:) insert` for `sceneAuxFast` / `sceneAux` / `sceneAuxMid` / `sceneSDF`.

### TypeScript: `src/export/iso-simplicial/iso-sample-batch.mts`
- **`IsoSampleBatch`** — same buffer roles as `GridSampler` (shared polygon / face / MDC params; local uniforms, positions, output, cancellation; destroyed in `finally`).
- **`ISO_SAMPLE_BATCH_UNIFORM_BYTES`** = 16.
- **`IsoSampleBatchResult`:** `sdf` (`vec4` per sample) and `sampleCount`.
- Optional **`AbortError`** if `signal` is already aborted before/after GPU work.
- Debug log uses existing **`ShrecExport`** module (same family as grid sampling).

### Barrel & build wiring
- Re-export from `src/export/iso-simplicial/index.mts`.
- `render-worker-core.mts` imports the WGSL string and asserts it contains `fn isoSampleBatch` so esbuild’s wgsl-loader keeps validating it.

### Parity test: `src/export/iso-simplicial/iso-sample-batch_test.mts`
- Expands `//:) include` with `fs` (tsx cannot import `.wgsl`).
- **`await import("webgpu")` after `SceneInfo`** — a top-level `webgpu` import assigns `globalThis` and clobbered the `sphere` helper used by `SceneInfo`.
- Node: `Object.defineProperty(globalThis, "navigator", { value: { gpu: create([]) }, … })`.
- Scene: `transpileCadSource("return sphere.radius(10)")` (fluent `sphere`, explicit `return`).
- Compares **`IsoSampleBatch`** vs **`GridSampler`** on a 1×1×1 grid at the same world points; first point is `(2,0,0)` so the normal is not singular at the sphere center.
- Skips if `GPUHelper.create()` returns undefined (no adapter).

`make build` and `make test` both pass. `iso-simplicial-handoff.md` is updated with Agent 2 API/layout notes and test caveats.

