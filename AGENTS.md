This is an in-browser CAD application that uses SDFs (signed distance functions) for representing geometry instead of
polygons. It uses WebGPU and the WGSL shading language for rendering SDFs. It is a CAD-as-code design, similar in
concept to OpenSCAD.

The CAD models are defined by JavaScript code that the user edits in-app using the Monaco code
editor. The code should be an expression or block that eventually returns a Node object, which is a scene object such
as a Sphere, Cube, Union, or other construct. This source will be loaded into a Function object and executed, giving a
scene tree. The scene tree that results will be walked and evaluated and the result is a string that contains the WGSL
code for rendering the SDF scene, which will then be injected into the shader code at runtime.

### Mesh export (iso-simplicial)

The **iso-simplicial** exporter (Dev Tools → Mesh export → Exporter) evaluates the scene SDF only on the GPU via batched WGSL samples (`iso_sample_batch.wgsl`); TypeScript builds an adaptive octree and extracts triangles with Marching Tetrahedra on the CPU (`src/export/iso-simplicial/`). It is an alternative to MDC and SHREC for triangle mesh export from the same scene build and `mdcSceneParams` bindings.

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

## Line endings

**Never use Windows line endings (CRLF, `\r\n`).** All text files in this repo must use Unix line endings only: a single newline character (`\n`) to end each line. Do not introduce `\r` before newlines when editing or generating files.

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
- Preview (`preview.wgsl`): orthographic ray origins use `camera.position + vec3(offsetX, offsetY, RAY_ORIGIN_DEPTH)` — the `camera.position` (eye = pivot + (0,0,1)) is critical because `lookAt` in `camera.transform` subtracts it, leaving a pure camera-space offset that `R` rotates into world space. Do NOT remove `camera.position` from the shader. Keep `RAY_ORIGIN_DEPTH` consistent in `computeRayOrigin`, the fragment ray setup, beam compute (`beamMarch`), CPU pivot snap (`PREVIEW_RAY_ORIGIN_DEPTH`), and mesh viewer parity; if you change near depth, adjust `MAX_DIST` so the forward march still covers the scene. Primitives' `compileAuxFast` must return `FastSDFResult` via `sdfFast(...)`, not `vec2f`, so fast CSG (`opUnionFast`, etc.) type-checks.
- Diagnostic logging: `src/logging/debug-log.mts` (`log("ModuleName").debug` / `.info` / `.warn` / `.error`), persisted as `app.debugLogModules`, toggles under Dev Tools **Logs**, flags pushed to the render worker with `setDebugLogModules` on ready and when toggles change. **`log("Module").error` is not gated** by those toggles (always browser console + dev log bridge). **`debug` / `info` / `warn`** are gated per module. Known modules include **App** (shell / scene orchestration / startup banner when **App** is on), **Settings**, **RenderWorker**, **WelcomeScreen**, **MdcExport**, **IsoSimplicialExport**, **SourceParser**, **Wgsl** (`logWgsl` always-on), and others listed in `DEBUG_LOG_MODULES` in `debug-log.mts`. Dev log **buffer** entries are `{ line, module? }`: for `log("ModuleName")` / `logWgsl`, `line` is `[timestamp] [level] [Module]` plus optional `[thread]` (e.g. `main`, `render-worker`) and message text; `module` duplicates the module name for filtering. The second bracketed token in `line` is still the level. Mirrored `console.*` lines use `[timestamp] [method]` and optional `[thread]` without a module bracket; window errors and similar omit `module`.
- ThreadedRod: `threadedRod.left`/`right` (default right) and `profile.fdm()`/`iso()`/`acme()` after profile; bare `radius(...)` is FDM. ACME profile defaults meridional `threadAngle` to 61° (90° − 29°) because nominal ACME 29° uses a different angular reference than meridional `threadAngle`. In `cad-types-decl.mts`, avoid backticks around `fdm`/`iso` in ThreadedRod JSDoc comment bodies—TypeScript can misparse that line.

## Code Search (ast-index vs grep)

This repo has [`ast-index`](https://crates.io/crates/ast-index) available on the path. It indexes the TypeScript AST of the codebase and answers symbol-level queries far faster and more precisely than text grep. Prefer it whenever you are looking for something that is part of the TypeScript AST — class, interface, function, method, property, enum, type alias, import, or cross-references between them.

Useful subcommands (run `ast-index <cmd> --help` for full options):

- `ast-index symbol <Name>` — find a symbol by exact name. `--pattern '*Foo*'` for glob, `--type class|interface|function|property` to narrow, `--fuzzy` for exact → prefix → contains fallback.
- `ast-index class <Name>` / `ast-index hierarchy <Name>` / `ast-index implementations <Name>` — class/interface lookups and subclass/implementor chains.
- `ast-index refs <Symbol>` — definitions, imports, and usages of a symbol in one shot. `ast-index usages <Symbol>` for usages only; `ast-index callers <fn>` / `call-tree` for call graph.
- `ast-index search <query>` — universal search across files and symbols (use `--type` / `--in-file` / `--module` / `--fuzzy`).
- `ast-index file <name>` / `ast-index outline <file>` / `ast-index imports <file>` — find files, list symbols in a file, list imports of a file.
- `ast-index map` / `ast-index conventions` — high-level project map and detected architecture/frameworks; good first step when orienting in unfamiliar areas.
- `ast-index update` — incremental reindex if results look stale after large edits.
- `ast-index rebuild --path src --path build` — full reindex. **Always pass `--path src --path build`** so both the app source and the build/devserver code are indexed; without it the index can miss one or the other and queries will silently return incomplete results.

When to use grep instead:

- The target is **not** TypeScript: WGSL shaders, Makefiles, JSON/YAML configs, Markdown, HTML, CSS, build scripts. ast-index does not index these.
- You are searching for **string content** rather than a symbol: log messages, error strings, comments, magic constants, regexes, route paths, CSS class names.
- You are tracing a TypeScript symbol into **non-TS** territory — e.g. a TS function name that may also appear in a WGSL `//:) include`, a binding-group label referenced in both `.mts` and `.wgsl`, a class name embedded in a YAML testcase, or a string key looked up dynamically. Use `ast-index refs` for the TS side, then `grep` for the cross-language references.
- Dynamic / stringly-typed lookups where the AST does not capture the relationship (e.g. `someObj["methodName"]`, message tags, debug log module names).

Rule of thumb: **named TypeScript thing → `ast-index`; raw text or non-TS file → `grep`; both → `ast-index` first to anchor the symbol, then `grep` to find the off-AST references.**

**NEVER EVER EVER grep, search, read, or otherwise look inside `dist/`.** It is generated build output — bundled, minified, and duplicated from source. Searching it produces noisy, misleading hits and wastes context. Always search the source tree (`src/`, `build/`, etc.) instead. This applies to `grep`, `rg`, `find`, `ast-index`, Glob, and any other search tool — exclude `dist/` unconditionally.

## Building and Linting

See `.cursor/rules/build-commands.mdc` for build/test command rules.

- **Build**: `make build`
- **Test**: `make test`
- **Type check**: `make check` — use this instead of invoking `npx tsc --noEmit`

**Do not run build or lint commands on WGSL files directly.** WGSL files will be compiled with `make build` by the custom build logic. This means when making changes to WGSL files, you should run `make build` to validate them. If they don't compile, you will see the compiler error in `make build`. This custom build logic is what handles the `//:) include` directive, meaning this shader compiler output is indicative of what happens at runtime.

### Devserver HTTP (logs, scene source, agent render)

**Agents (Cursor/automation):** Run **`make start AGENT=true`** for a headless bridge (**`.devserver.agent.run`**). Use that **`port`** for **`/_agent/render`**, **`POST /_agent/render/testcase-body`**, and for **`/_logs`** after those runs. To **mirror a human’s interactive tab** ( **`make start`** — **`.devserver.run`** ), **`GET /_agent/capture-testcase`** (and optionally **`/_sceneSource`**) on the **interactive** port, then render on the **agent** port; see [`.agents/skills/devserver/SKILL.md`](.agents/skills/devserver/SKILL.md) (**Mirror interactive → agent**). Do **not** launch Chromium or Chrome yourself—the Makefile/devserver starts the headless browser the bridge needs.

**Interactive use:** When the watch devserver is running (`make start`, including inside a [Dev Container](.devcontainer/devcontainer.json) with the dev port forwarded per container config), the same HTTP port serves **`GET /_logs`**, **`GET /_sceneSource`**, and **agent automation** routes. **Read `<port>` from `.devserver.run`** (JSON `port` field); if that file is absent, that devserver is not running and there is **no** default port. The recorded port may differ from the configured default if the listen port was already in use.

**WebSocket bridge:** log, scene-source, testcase capture, and render RPCs are delivered to the **first connected browser client** in OPEN state (not broadcast to every tab). Prefer a single connected tab for automation.

- **`GET /_logs`** — `http://localhost:<port>/_logs` (query parameters below).
- **`GET /_sceneSource`** — active editor tab’s scene source as `text/plain`. **200 with empty body** if no browser is connected, the bridge times out, the getter throws, or there is no active model (e.g. welcome-only). No query parameters.

**Agent automation** (WebGPU in the browser; see [`.agents/skills/devserver/SKILL.md`](.agents/skills/devserver/SKILL.md) for curl examples and workflow):

- **`GET /_agent/capture-testcase`** — returns **`application/x-yaml`**: current session as an agent testcase (`schemaVersion`, multiline **`source`**, camera, viewport, `meshExport`, optional **`meshOverlay`** when mesh-viewer debug toggles are on, optional fields). **`503`** if no browser / timeout / capture failure.
- **`POST /_agent/render/testcase-body`** — **`POST`** with **raw testcase YAML** in the body (same schema as capture). Query params match **`GET /_agent/render/testcase/...`** (`mode`, viewport overrides, mesh-overlay flags). Use to **pipe** capture from **`.devserver.run`** into **`.devserver.agent.run`** (see skill).
- **`GET /_agent/render/testcase/<relative>`** — `<relative>` is a path under **`./test/testcases/`** (e.g. `meshing/polygon-twisted.yaml`). Server reads YAML, builds **`AgentRenderRequest`** via **`mergeAgentRenderRequest`** (does **not** put testcase `documentName` on the wire payload, so replay is not tied to the active tab name). Query: optional **`mode=sdf|mesh`**, **`viewportWidth`**, **`viewportHeight`** (these two **override** YAML `viewportWidth` / `viewportHeight` when present—omit them for faithful testcase replay unless the user explicitly wants a different resolution), **`label`**, **`role`**, optional mesh-overlay flags (when any overlay flag is present it replaces a testcase-embedded **`meshOverlay`**). Wrong path (e.g. bare **`GET /_agent/render`**) → **400** with a short hint. Missing file → **404** with relative path and resolved path in the body.
- **`POST /_agent/render`** — **only** at exactly **`/_agent/render`**. JSON body: **`AgentRenderRequest`** (`mode`, `camera`, `viewCenter`, `viewportWidth`, `viewportHeight`, `meshExport`, optional `previewUvRect`, optional `documentName`) plus optional **`label`**, **`role`**, **`testcase`** (relative under `test/testcases/` for suggested download basename only; stripped before dispatch).
- **Agent testcase files (`./test/testcases/`):** Do **not** modify existing testcase YAML on your own (experiments, tuning, or “fixes” to make a render pass). Those files are shared fixtures; changing them breaks replay for everyone unless the user explicitly asked for that edit. If you need a different camera, `meshExport`, or scene body, **add a new YAML** under **`./test/testcases/`** with a new basename instead of overwriting an existing one.

Successful PNG responses set **`Content-Disposition`** (suggested filename **`<basename>-<mode>.png`**) and **`Access-Control-Expose-Headers: Content-Disposition`** so **`curl -OJ`** can save with the right name. **`400`** / **`503`** on failure return **plain text** (browser pipeline error vs no bridge / timeout). Server also mirrors successful PNGs under **`.agents/imagelog/`**.

When an agent writes ad-hoc test images or other capture files into the repo (for example **`curl -o …`** instead of **`curl -OJ`** in the cwd), put them under **`.agents/testimages/`** (create the directory if needed). Do **not** drop PNGs or similar loose under **`.agents/`** root—that directory holds skills, scripts, and other agent tooling; **`testimages`** keeps disposable renders separate from **`imagelog`** (server-written) and the rest of **`.agents/`**.

**Agent devserver:** **`make start AGENT=true`** ( **`AGENT=true`** ) writes **`.devserver.agent.run`** and spawn headless Chromium for the WebSocket bridge—this is what automated agents must use (see above).

- **Response format**: `text/plain; charset=utf-8`, one log line per line: the **exact** in-browser buffer lines (including `[timestamp] [level]` and the rest), newline-joined with no server-side rewriting. If no browser tab is connected, bridge times out, or nothing matches filters, response is **200 with empty body**.
- **`level`**: optional single threshold among `error`, `warning`, `info`, `debug` (case-insensitive). Cumulative: `error` → errors only; `warning` → errors and warnings; `info` → errors, warnings, and info; `debug` → all four. Default when `level` is missing, empty, or not recognized: **`info`** (errors, warnings, and info—no debug). URL token `warning` maps to the internal warn bucket.
- **`only`**: optional comma-separated **exact** buckets using the same tokens (`error`, `warning`, `info`, `debug`). If `only` is present and parses to at least one valid bucket, **only** those buckets are returned and `level` is ignored. If `only` is present but every token is invalid (or the value is empty), behavior falls back to the same default as missing `level` (**info** threshold). Legacy presence flags (`err`, `warn`, …) are not read; omit them.
- **`n`**: optional integer cap per level bucket (default `20`, clamp `1..10000`), newest-first within each bucket, duplicate raw lines removed per bucket.
- **`module`**: optional comma-separated names (e.g. `module=App,MdcExport,WelcomeScreen` or `module=Settings`). Missing/empty means all modules. Non-empty module filter restricts to module-tagged/module-attributed lines and excludes generic mirrored console noise. **`log("Module").error` lines still carry `module`** and are included only when that module matches the filter (or when `module` is omitted).
- **What is captured**: the same pipeline as `src/logging/debug-log.mts`: **`log("Module").error` always**; other `log("Module")` levels when enabled in Dev Tools; plus mirrored **`console.*`** on the main thread and on **render** / **transpile** workers (forwarded to the main ring buffer), plus **`window` error** and **unhandledrejection** on the main thread. This is **best-effort** runtime signal; it does **not** replace `make build`.

**Agent workflow**

1. Prefer **`make build`** for compile-time WGSL and bundling errors after shader edits.
2. For **`/_agent/render`** and **`/_logs`** after a headless render: ensure **`make start AGENT=true`** and **`.devserver.agent.run`**, then read **`port`** with **`jq -r .port .devserver.agent.run`**. To read the **interactive** editor ( **`make start`** ), use **`jq -r .port .devserver.run`** for **`/_sceneSource`** / **`/_agent/capture-testcase`** only. Use shell **`curl`** (for **`/_logs`**, default response uses **`level=info`** semantics; add `level=debug` or `only=…` only when you need a different mix; omit `n` unless asked). Do **not** guess a port, do **not** launch a browser yourself.
3. If **`.devserver.agent.run`** is still missing after **`make start AGENT=true`** (or you cannot start the devserver), **do not** invent a port; treat runtime HTTP checks as unavailable rather than failing the whole task unless the user asked specifically for a running browser.
4. See [`.agents/skills/devserver/SKILL.md`](.agents/skills/devserver/SKILL.md) for curl examples, **mirror interactive → agent**, **`POST /_agent/render/testcase-body`**, and **`GET|POST /_refresh`** on the agent port after code changes.

## Documentation

- Puppeteer: https://pptr.dev/api

## Performance regression triage

- **Worker `#doBuild` timing:** `RenderWorker` debug logs fine-grained buckets (`sceneConstructMs`, `fingerprintMs`, `packSceneMs`, `packPreviewMs`, `serializeNodesMs`, plus full-build `wgslSceneMs`, `shaderModulesMs`, `pipelinesMs`, `gpuBuffersMs`). The same breakdown is sent on `buildComplete` as `timingMs` and is readable from `SDFRenderer.getLastBuildTimingMs()` after each successful build for the active document.

- **Bounds:** `SceneInfo` memoizes `computeBounds()` per node id per build (`getOrComputeBoundsForNode`). `getAllNodes()` returns a cached snapshot for packing and repeated walks.

- **Param-only uploads:** `#uploadBuildBuffers` skips `writeBuffer` for polygon, bounds/MDC scene params, and preview banks when packed bytes match the last upload.

- **Benchmarks:** `runBenchmarkSuite` measures steady-state GPU frame time. `runBuildBenchmark` (`benchmark/benchmark.mts`) runs a structural build then a param-only pair (`SDFRenderer.benchmarkBuild`) to compare paths. Re-check preview WGSL hot paths only after CPU buckets no longer dominate; optimize shaders only when measured.
