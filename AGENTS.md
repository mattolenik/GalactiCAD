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

## Rendering Pipeline: Full vs Fast SDF Evaluation

The scene SDF is compiled into two variants that serve different roles in the pipeline:

### sceneSDF vs sceneSDF_fast

- **sceneSDF(p)** returns a full `SDFResult` struct: distance (`d`), gradient magnitude (`g`), analytical normal (`n`), object IDs, blend weights, and seam metadata.
- **sceneSDF_fast(p)** returns only `vec2f(distance, gradientMagnitude)`. It has no normals, no IDs, no tie-breaking, and no `normalize()` calls.

`sceneSDF` results contain everything `sceneSDF_fast` returns and more. The fast path is cheaper and is used wherever distance and gradient are sufficient; the full path is used when normals, IDs, or other attributes are needed.

### Regular vs \_fast Primitives and Operators

Each primitive and CSG operator has two implementations:

- **Regular (Ex)**: e.g. `fSphereEx`, `fBoxEx`, `opUnionEx`, `fOpUnionRound` — return `SDFResult` with analytical normals, object IDs, and gradient magnitude. Used by `sceneSDF`.
- **Fast**: e.g. `fSphereFast`, `fBoxFast`, `opUnionFast`, `fOpUnionRoundFast` — return `vec2f(d, g)` only. Used by `sceneSDF_fast`.

The fast operators still compute gradient magnitude `g` because it is needed to correct ray-march step size in smooth blend regions (where |∇f| < 1). They omit normals, IDs, and tie-breaking to avoid `normalize()` and extra branching.

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

### Using SDFResult to Avoid Unnecessary Computations

`sceneSDF` returns everything `sceneSDF_fast` returns and more: `SDFResult.d` is the distance, `SDFResult.g` is the gradient magnitude. If you already have an `SDFResult`, use it—do not call `sceneSDF_fast` to recalculate distance or gradient.

The pipeline uses `sceneSDF_fast` where the full result is not needed, because it is cheaper (no normals, IDs, or tie-breaking):

1. **Ray marching (preview.wgsl)**: Every step uses `sceneSDF_fast`. When a hit is detected, the shader calls `sceneSDF` once at the hit point to get the analytical normal and IDs for shading.

2. **MDC (mdc.wgsl)**: Voxel distance sampling uses `sceneSDF_fast`. The full `sceneSDF` is used for:
    - **resolveSignAtPos**: When a sample is near the iso-surface (epsilon band), the analytical normal `sdf.n` is used to nudge the point and resolve inside/outside deterministically. Finite-difference gradients would be unstable at CSG seams.
    - **Edge projection**: After bisection finds an approximate intersection, projection to the surface uses analytic normals from `sceneSDF` instead of finite-difference gradients for stability at seams where gradients are discontinuous.
    - **Vertex normals**: Final mesh vertex normals come from `sceneSDF` at the converged position.

3. **Bounds and beam shaders**: Use `sceneSDF_fast`; they never need normals or IDs.

When adding new scene operations: use `sceneSDF_fast` when you only need distance or gradient and can avoid the extra cost. Use `sceneSDF` when you need analytical normals, object IDs, blend weights, or seam metadata—or when you need distance and will use the other attributes anyway. If you already have an `SDFResult`, do not recalculate; use `r.d` and `r.g` instead of calling `sceneSDF_fast`.

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

- Do not browse to the app; the user runs manual visual QA. For WGSL and preview rendering work, use `make build` for compile validation—do not rely on in-agent visual verification as part of the task.
- When only the SDF preview should change, skip mesh viewer shader parity unless the user asks to update the mesh viewer too.
- Add artist-facing preview/rendering tunables to the dev tools panel when the user wants on-screen knobs.

## Learned Workspace Facts

- Camera hotkeys 2, 4, 6: derive from 1, 3, 5 by 180° rotation to avoid vertical flip — 2=1×R_Y, 4=3×R_Z, 6=5×R_Y.
- External-change conflict: compare disk to `lastWritten`, not editor content, when deciding whether to show "modified externally" dialog.
- Async pick (Cmd/Ctrl+drag): use drag session ID so stale pick results do not apply to a new drag session.
- GPU `nodeParams`/`polygonVertices` buffer writes in `render-worker-core.mts` must be deferred until after the new pipeline is swapped in (`this.#pipeline = pipeline`), otherwise the old shader renders with reset params causing a visual snap.
- Welcome-screen thumbnails and opening a sample from the welcome screen share the render-worker preview `build` path and can race; the viewport may show the wrong sample until the next rebuild (mitigations: abort sample fetches when the welcome screen is removed; restore the prior built scene body after each thumbnail render in the worker).
- Push/pull activation: shift-hold on a selected surface (not double-click). `dropToHighlight()` must NOT call `onDeselect` — it overwrites the GPU face-highlight buffers. After cap drag completion, update `node.h`/`node.pos.y` on the stored reference before `dropToHighlight` so subsequent drags don't snap back.
- Click events on the canvas must be suppressed (`stopImmediatePropagation` in capture phase) while push/pull has any face state, to prevent CameraController's click handler from toggling selection via shift-click.
- All scene SDF evaluation for rendering and export pipelines must stay on the GPU; do not reimplement the scene SDF on the CPU.
- On startup/refresh, restore only previously open documents; closed documents stay available from the document explorer / closed-document list.
- Polygon editing UX: double-clicking polygon2d, loft, union, or other cross-selectable symbols selects in the preview; polygon editing opens from a hover-only "Edit Polygon" menu, not right-click; right-click over `polygon2d` in Monaco should use Monaco's built-in context menu; keep a safe-zone AABB between trigger and menu so it stays open while the cursor moves toward it.
- Monaco: set `occurrencesHighlight: "off"` and `selectionHighlight: false` so double-clicking cross-selectable symbols does not highlight other occurrences.
- Multi-operand smooth unions (`round`, `soft`, `chamfer`, `columns`, `stairs`, etc.) are not associative when folded left; for three or more operands the evaluator blends the two nearest children at each sample instead of chaining pairwise blends—see `docs/smooth_union_ordering.md` for behavior and implications.

## Building and Linting

See `.cursor/rules/build-commands.mdc` for build/test command rules.

- **Build**: `make build`
- **Test**: `make test`

**Do not run build or lint commands on WGSL files directly.** WGSL files will be compiled with `make build` by the custom build logic. This means when making changes to WGSL files, you should run `make build` to validate them. If they don't compile, you will see the compiler error in `make build`. This custom build logic is what handles the `//:) include` directive, meaning this shader compiler output is indicative of what happens at runtime.
