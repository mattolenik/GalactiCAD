This is an in-browser CAD application that uses SDFs (signed distance functions) for representing geometry instead of
polygons. It uses WebGPU and the WGSL shading language for rendering SDFs. It is a CAD-as-code design, similar in
concept to OpenSCAD.

The CAD models are defined by JavaScript code that the user edits in-app using the Monaco code
editor. The code should be an expression or block that eventually returns a Node object, which is a scene object such
as a Sphere, Cube, Union, or other construct. This source will be loaded into a Function object and executed, giving a
scene tree. The scene tree that results will be walked and evaluated and the result is a string that contains the WGSL
code for rendering the SDF scene, which will then be injected into the shader code at runtime.

## Notes on Rendering

Rendering is done with ray marching in preview.wgsl and related files. Keep in mind all rendering is done manually with
this fragment shader, so no traditional rendering techniques with polygons will work, we must handle it all.

### Scene parameter buffers (pass split)

Scene parameters are **not** packed into one shared buffer for every pass. The preview and beam paths share read-only **uniform** bindings (`previewParamsF32`, `previewParamsVec2`, `previewParamsVec3`, `previewParamsMat3`) filled from `SceneInfo.packPreviewParams()`; TS codegen emits direct indexed reads (fixed `vec4` swizzles for scalars and vec2, `.xyz` for vec3, `array<mat3x3f>` for preview rotation matrices). Union BVH AABB center/half are packed into **`previewParamsVec3`** (two logical vec3 slots per BVH-eligible node). A separate **`previewCapParamDrag` uniform** bank (same `vec4`-packed layout as `previewParamsF32`) holds live cap push/pull values; cap height/offset are read from this bank in preview WGSL. It is a uniform buffer so the fragment stage stays within the **10 storage buffers / stage** limit (edge buffers and other storage bindings already consume that budget). Preview/beam **do not** bind `boundsSceneParams`. Bounds (`bounds.wgsl`) and mesh export (`mdc.wgsl`) use **storage** buffers (`boundsSceneParams`, `mdcSceneParams`) with flat `f32` layout and `sp_*` codegen (including BVH data in `packSceneParams()`). Parity across passes is not required; the worker uploads both packed layouts on build.

### Preview param updates (param-only build and push/pull)

- **`paramOffset` vs preview-only keys:** `SerializedNode.paramOffset` is the start index (in `f32`) into the **bounds/MDC** packed layout (`packSceneParams()`). It is **not** the address of preview uniform data. Cap push/pull must use **`sceneCapParamsByteOffset`**: the byte offset into the worker’s **`previewCapParamDrag` uniform** CPU shadow (same `vec4`-packed layout as `previewParamsF32`), i.e. `previewF32Slot * 4` from the scene graph. Do not derive preview patch addresses from `paramOffset`; the preview f32 allocator and scene-param allocator are independent pools.

- **Param-only scene build** (`structuralFingerprint()` unchanged, worker `#doBuild`): The worker re-uploads `boundsSceneParams` and `mdcSceneParams` from `packSceneParams()`, and the used prefix of each preview bank from `packPreviewParams()` via `#uploadBuildBuffers` (CPU shadow sync + partial `writeBuffer` per bank; skips unchanged packed bytes vs last upload). Polygon vertex data is written when the scene has polygons. No WGSL recompilation; existing preview/beam bind groups are reused (buffers are updated in place).

- **Cap push/pull (extrude / loft / threaded rod):** The main thread sends `writeBuffers.previewParamsF32Patch` with `{ byteOffset, data }` where `byteOffset` is `sceneCapParamsByteOffset` and `data` is two `f32` (`h`, `posYDelta`). The worker patches the shared **`#previewF32Shadow`** at those indices and **`writeBuffer`s the full `previewCapParamDrag` uniform** from the shadow (uniform sub-ranges require 256-byte alignment; full-bank upload avoids that). The main `previewParamsF32` uniform is **not** re-uploaded during drag. On each build/param-only build, `#uploadBuildBuffers` mirrors the packed preview `f32` bank into both `previewParamsF32` and `previewCapParamDrag`. Bounds and MDC storage buffers are **not** updated during the drag; they refresh on the next build (or param-only build when source changes).

- **Polygon edge push/pull:** Uses `writeBuffers.polygonVertices` with byte `offset` into the shared polygon vertex buffer (unchanged). Preview uniforms pick up new geometry on the next param-only or full build as needed.

## Rendering Pipeline: Full vs Fast SDF Evaluation

The scene SDF is compiled into two variants that serve different roles in the pipeline:

### sceneSDF vs sceneSDF_fast

- **sceneSDF(p)** returns a full `SDFResult` struct: distance (`d`), gradient magnitude (`g`), analytical normal (`n`), object IDs, blend weights, and seam metadata.
- **sceneSDF_fast(p)** returns a `FastSDFResult` struct: `d`, `g`, and `safeStepMul` (conservative step scaling). It has no normals, no IDs, no tie-breaking, and no `normalize()` calls.

`sceneSDF` results contain everything the fast path needs for distance/gradient stepping and more. The fast path is cheaper and is used wherever distance, gradient magnitude, and step scaling are sufficient; the full path is used when normals, IDs, or other attributes are needed.

### Regular vs \_fast Primitives and Operators

Each primitive and CSG operator has two implementations:

- **Regular (Ex)**: e.g. `fSphereEx`, `fBoxEx`, `opUnionEx`, `fOpUnionRound` — return `SDFResult` with analytical normals, object IDs, and gradient magnitude. Used by `sceneSDF`.
- **Fast**: e.g. `fSphereFast`, `fBoxFast`, `opUnionFast`, `fOpUnionRoundFast` — return `FastSDFResult` (`d`, `g`, `safeStepMul`). Used by `sceneSDF_fast`.

The fast operators still compute gradient magnitude `g` and `safeStepMul` for correct ray-march steps in smooth blend regions (where |∇f| < 1). They omit normals, IDs, and tie-breaking to avoid `normalize()` and extra branching.

### SDFResult Struct

`SDFResult` (defined in hg_sdf.wgsl) carries:

- **d**: Distance value (may not be true Euclidean distance for smooth CSG).
- **g**: Gradient magnitude estimate (1.0 for true SDFs, <1.0 in smooth blend regions). Used to correct projection steps when |∇f| < 1.
- **s**: Sign for inside/outside.
- **id**: Primary object ID for coloring and selection.
- **n**: Analytical normal (unit vector). Not available from \_fast functions.
- **id2**, **blend**: Secondary ID and blend weight for smooth blend color interpolation (0 = fully id, 1 = fully id2).
- **seamA**, **seamB**, **seamOp**, **seamGap**, **seamTangent**: Metadata for hard CSG seams (union/intersection/difference). Used for seam selection and edge classification.

None of these attributes (normals, IDs, blend, seam) are present in the \_fast path.

`FastSDFResult` is defined in `hg_sdf.wgsl` alongside `SDFResult`; use `.d`, `.g`, and `.safeStepMul` (e.g. step as `sr.d * sr.safeStepMul`) instead of legacy `vec2` swizzles.

### Using SDFResult to Avoid Unnecessary Computations

`sceneSDF` returns everything `sceneSDF_fast` returns and more: `SDFResult.d` is the distance, `SDFResult.g` is the gradient magnitude. If you already have an `SDFResult`, use it—do not call `sceneSDF_fast` to recalculate distance or gradient.

The pipeline uses `sceneSDF_fast` where the full result is not needed, because it is cheaper (no normals, IDs, or tie-breaking):

1. **Ray marching (preview.wgsl)**: Every step uses `sceneSDF_fast`. When a hit is detected, the shader calls `sceneSDF` once at the hit point to get the analytical normal and IDs for shading.

2. **MDC (mdc.wgsl)**: Voxel distance sampling uses `sceneSDF_fast`. The full `sceneSDF` is used for:
    - **resolveSignAtPos**: When a sample is near the iso-surface (epsilon band), the analytical normal `sdf.n` is used to nudge the point and resolve inside/outside deterministically. Finite-difference gradients would be unstable at CSG seams.
    - **Edge projection**: After bisection finds an approximate intersection, projection to the surface uses analytic normals from `sceneSDF` instead of finite-difference gradients for stability at seams where gradients are discontinuous.
    - **Vertex normals**: Final mesh vertex normals come from `sceneSDF` at the converged position.

3. **Bounds pass and beam pre-pass** (`beamMarch` in `preview.wgsl`): Use `sceneSDF_fast`; they never need normals or IDs. Preview and beam share one compiled shader module.

When adding new scene operations: use `sceneSDF_fast` when you only need distance, gradient magnitude, and step scaling and can avoid the extra cost. Use `sceneSDF` when you need analytical normals, object IDs, blend weights, or seam metadata—or when you need distance and will use the other attributes anyway. If you already have an `SDFResult`, do not recalculate; use `r.d` and `r.g` instead of calling `sceneSDF_fast`.

## Camera Resolution and Resolution Scale

`camera.res` in the preview shader is set to the actual render resolution (sceneWidth × sceneHeight), not the display resolution. This is required so the beam pre-pass and scene fragment shader agree on tile coordinates.

When Camera halfres (resolutionScale 0.5) is enabled, `wppu` (world-pixels-per-unit) and aspect ratio are computed from the scaled resolution. As a result, edge detection thickness at half-res is ~2× wider in world space than at full-res. This is an accepted tradeoff for the performance benefit; edge selection may behave slightly differently when Camera halfres is on.

## Shader Programming Tips

When doing shader programming, remember that this is WebGPU and so the language is WGSL, not HLSL or GLSL. Keep in mind
the syntactic and semantic differences between WGSL and other shading languages.

This project uses an esbuild plugin to transform wgsl shader files at compile time (build/wgsl-loader.mts). It allows you
to import the shader code as a string in TypeScript, and it can perform some preprocessing as well. Namely, it creates
a C-style include which uses the following syntax:

//:) include "hg_sdf.wgsl"

That would insert hg_sdf.wgsl into the file, similar to a C include.

A shader can be loaded into TypeScript like this:

import previewShader from "./shaders/preview.wgsl"

That results in previewShader being a string with the processed content of the code.

### Intercting with WebGPU on the TypeScript side

When making changes to binding groups, make sure all the bindings and mappings are the same in TypeScript and WGSL, make sure you always keep them in sync and don't forget to update things like byte offsets or indexes, etc.

## Learned User Preferences

- Do not browse to the app or attempt in-agent visual validation; the user runs manual visual QA. For WGSL and preview rendering work, use `make build` for compile validation instead of relying on automated visual checks.
- When only the SDF preview should change, skip mesh viewer shader parity unless the user asks to update the mesh viewer too.
- Add artist-facing preview/rendering tunables to the dev tools panel when the user wants on-screen knobs.
- Welcome-screen release label: show the build-injected `VERSION` string exactly as provided (concatenate with the fixed prefix text); do not add a `v` prefix or other conditional formatting around `VERSION`.

## Learned Workspace Facts

- Camera hotkeys 2, 4, 6: derive from 1, 3, 5 by 180° rotation to avoid vertical flip — 2=1×R_Y, 4=3×R_Z, 6=5×R_Y.
- External-change conflict: compare disk to `lastWritten`, not editor content, when deciding whether to show "modified externally" dialog. Async pick (Cmd/Ctrl+drag): use drag session ID so stale pick results do not apply to a new drag session.
- In `render-worker-core.mts`, defer `previewParams*` uniform uploads (including `previewParamsMat3` and `previewCapParamDrag`), `boundsSceneParams`/`mdcSceneParams` storage writes, and `polygonVertices` writes until after the new pipeline is assigned (`this.#pipeline = pipeline`), or the old shader can briefly render with reset params. Full builds use `#uploadBuildBuffers` (same dedup as param-only). Only call `destroy()` on buffers, textures, and other actually destroyable GPU resources; do not declare fake `destroy()` on WebGPU interface types in `global.d.ts`.
- SDF scene preview (`SDFRenderer` in `sdf.mts`) submits GPU ray-march work only when `#needsRender` is true—not on every animation frame when nothing changed (camera, hover/selection, resize, builds, etc., still set it). The main thread may still run `requestAnimationFrame` to notice those transitions. The mesh viewer (`mesh-viewer.mts`) redraws every frame while `startLoop()` is active.
- Session and welcome screen: on startup/refresh restore only previously open documents (closed documents stay in the document explorer / closed-document list). Welcome thumbnails and opening a sample share the render-worker preview `build` path and can race; the viewport may show the wrong sample until the next rebuild (abort sample fetches when the welcome screen is removed; restore the prior built scene body after each thumbnail render in the worker).
- Push/pull activation: shift-hold on a selected surface (not double-click). `dropToHighlight()` must NOT call `onDeselect` — it overwrites the GPU face-highlight buffers. After cap drag completion, update `node.h`/`node.pos.y` on the stored reference before `dropToHighlight` so subsequent drags don't snap back. For extrude, loft, and threaded_rod, cap length source rewrites expect a `.height()` call in the fluent chain (mirrors extrude). While push/pull has any face state, suppress canvas click events (`stopImmediatePropagation` in capture phase) so CameraController does not toggle selection via shift-click.
- All scene SDF evaluation for rendering and export pipelines must stay on the GPU; do not reimplement the scene SDF on the CPU.
- Polygon editing UX: double-clicking polygon2d, loft, union, or other cross-selectable symbols selects in the preview; Monaco should keep `occurrencesHighlight: "off"` and `selectionHighlight: false`; polygon editing opens from a hover-only "Edit Polygon" menu, not right-click; right-click over `polygon2d` in Monaco should use Monaco's built-in context menu; keep a safe-zone AABB between trigger and menu so it stays open while the cursor moves toward it.
- CAD scene source is transpiled with the TypeScript compiler (`transpileModule` in `cad-transpile.mts`, transpile worker), not esbuild-wasm. Multi-operand smooth unions (`round`, `soft`, `chamfer`, `columns`, `stairs`, etc.) are not associative when folded left; for three or more operands the evaluator blends the two nearest children at each sample—see `docs/smooth_union_ordering.md`.
- Preview (`preview.wgsl`): orthographic rays use `RAY_ORIGIN_DEPTH` off `camera.position`—keep that offset consistent in `computeRayOrigin`, the fragment ray setup, and `beamMarch`; if you change near depth, adjust `MAX_DIST` so the forward march still covers the scene. Primitives’ `compileAuxFast` must return `FastSDFResult` via `sdfFast(...)`, not `vec2f`, so fast CSG (`opUnionFast`, etc.) type-checks.
- Diagnostic logging: `src/logging/debug-log.mts` (`log("ModuleName").debug` / `.info` / `.warn` / `.error`), persisted as `app.debugLogModules`, toggles under Dev Tools **Logs**, flags pushed to the render worker with `setDebugLogModules` on ready and when toggles change. **`log("Module").error` is not gated** by those toggles (always browser console + dev log bridge). **`debug` / `info` / `warn`** are gated per module. Known modules include **App** (shell / scene orchestration / startup banner when **App** is on), **Settings**, **RenderWorker**, **WelcomeScreen**, **MdcExport**, **SourceParser**, **Wgsl** (`logWgsl` always-on), and others listed in `DEBUG_LOG_MODULES` in `debug-log.mts`. Dev log **buffer** entries are `{ line, module? }`: `line` is `[timestamp] [level]` plus optional `[thread]` and message text **without** a `[Module]` tag; `module` is set only for `log("ModuleName")` output so the devserver can filter by module. The second bracketed token in `line` is still the level (`debug`/`info`/`warn`/`error` from `log()`, or mirrored `console` method names); filtering for `GET /_logs` uses query parameters, while the in-browser bridge uses that token when bucketing lines. Mirrored `console.*`, window errors, and similar lines omit `module`.
- ThreadedRod: `threadedRod.left`/`right` (default right) and `profile.fdm()`/`iso()`/`acme()` after profile; bare `radius(...)` is FDM. ACME profile defaults meridional `threadAngle` to 61° (90° − 29°) because nominal ACME 29° uses a different angular reference than meridional `threadAngle`. In `cad-types-decl.mts`, avoid backticks around `fdm`/`iso` in ThreadedRod JSDoc comment bodies—TypeScript can misparse that line.

## Building and Linting

See `.cursor/rules/build-commands.mdc` for build/test command rules.

- **Build**: `make build`
- **Test**: `make test`

**Do not run build or lint commands on WGSL files directly.** WGSL files will be compiled with `make build` by the custom build logic. This means when making changes to WGSL files, you should run `make build` to validate them. If they don't compile, you will see the compiler error in `make build`. This custom build logic is what handles the `//:) include` directive, meaning this shader compiler output is indicative of what happens at runtime.


### Devserver logs endpoint (optional browser console)

When the watch devserver is running (`make serve` / `make start`, or `make serve` inside a [Dev Container](.devcontainer/devcontainer.json) with the dev port forwarded per container config), the same HTTP port serves **`GET /_logs`** at `http://localhost:<port>/_logs`. **Read `<port>` from `.devserver.run`** (JSON `port` field) when the server starts; if that file is absent, the devserver is not running and there is **no** default port to use for `/_logs`. The recorded port may differ from the configured default if the listen port was already in use.

- **Response format**: `text/plain; charset=utf-8`, one log line per line: the same text as in the in-browser buffer **after** dropping the leading `[timestamp] [level]` prefix (optional `[thread]` and message remain). No extra severity prefix. If no browser tab is connected, bridge times out, or nothing matches filters, response is **200 with empty body**.
- **`level`**: optional single threshold among `error`, `warning`, `info`, `debug` (case-insensitive). Cumulative: `error` → errors only; `warning` → errors and warnings; `info` → errors, warnings, and info; `debug` → all four. Default when `level` is missing, empty, or not recognized: **`info`** (errors, warnings, and info—no debug). URL token `warning` maps to the internal warn bucket.
- **`only`**: optional comma-separated **exact** buckets using the same tokens (`error`, `warning`, `info`, `debug`). If `only` is present and parses to at least one valid bucket, **only** those buckets are returned and `level` is ignored. If `only` is present but every token is invalid (or the value is empty), behavior falls back to the same default as missing `level` (**info** threshold). Legacy presence flags (`err`, `warn`, …) are not read; omit them.
- **`n`**: optional integer cap per level bucket (default `20`, clamp `1..10000`), newest-first within each bucket, duplicate raw lines removed per bucket.
- **`module`**: optional comma-separated names (e.g. `module=App,MdcExport,WelcomeScreen` or `module=Settings`). Missing/empty means all modules. Non-empty module filter restricts to module-tagged/module-attributed lines and excludes generic mirrored console noise. **`log("Module").error` lines still carry `module`** and are included only when that module matches the filter (or when `module` is omitted).
- **What is captured**: the same pipeline as `src/logging/debug-log.mts`: **`log("Module").error` always**; other `log("Module")` levels when enabled in Dev Tools; plus mirrored **`console.*`** on the main thread and on **render** / **transpile** workers (forwarded to the main ring buffer), plus **`window` error** and **unhandledrejection** on the main thread. This is **best-effort** runtime signal; it does **not** replace `make build`.

**Agent workflow**

1. Prefer **`make build`** for compile-time WGSL and bundling errors after shader edits.
2. If **`.devserver.run`** exists with a `port`, use shell `curl` against `http://localhost:<port>/_logs` (default response uses **`level=info`** semantics; add `level=debug` or `only=…` only when you need a different mix; omit `n` unless asked).
3. If `.devserver.run` is **missing** (devserver not running), **do nothing**; do not guess a port or fail the task for missing runtime logs.
4. See [`.cursor/skills/devserver-logs/SKILL.md`](.cursor/skills/devserver-logs/SKILL.md) for the standard runtime-log check flow.

**Optional cleanup**: if a local `.cursor/mcp.json` still contains stale `galacticad-devserver` MCP settings from older workflows, users can remove that entry manually (file is gitignored).

## Performance regression triage

- **Worker `#doBuild` timing:** `RenderWorker` debug logs fine-grained buckets (`sceneConstructMs`, `fingerprintMs`, `packSceneMs`, `packPreviewMs`, `serializeNodesMs`, plus full-build `wgslSceneMs`, `shaderModulesMs`, `pipelinesMs`, `gpuBuffersMs`). The same breakdown is sent on `buildComplete` as `timingMs` and is readable from `SDFRenderer.getLastBuildTimingMs()` after each successful build for the active document.

- **Bounds:** `SceneInfo` memoizes `computeBounds()` per node id per build (`getOrComputeBoundsForNode`). `getAllNodes()` returns a cached snapshot for packing and repeated walks.

- **Param-only uploads:** `#uploadBuildBuffers` skips `writeBuffer` for polygon, bounds/MDC scene params, and preview banks when packed bytes match the last upload.

- **Benchmarks:** `runBenchmarkSuite` measures steady-state GPU frame time. `runBuildBenchmark` (`benchmark/benchmark.mts`) runs a structural build then a param-only pair (`SDFRenderer.benchmarkBuild`) to compare paths. Re-check preview WGSL hot paths only after CPU buckets no longer dominate; optimize shaders only when measured.

