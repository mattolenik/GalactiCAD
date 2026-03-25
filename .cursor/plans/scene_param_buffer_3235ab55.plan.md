---
name: scene param buffer
overview: Move primitive/operator numeric parameters out of generated WGSL and into shared GPU scene-parameter buffers so source edits only trigger shader recompilation when the scene topology or generated control flow changes.
todos:
    - id: define-scene-param-layout
      content: "Design packed scene parameter layout: array<f32> storage buffer, WGSL helpers (sp_f32, sp_vec3), per-node paramOffset/paramCount assigned during build()."
      status: completed
    - id: migrate-shader-bindings
      content: Add shared sceneParams storage buffer to preview, beam, bounds, and MDC shader/bind-group plumbing. Keep nodeParams alive during transition (dual-buffer phase).
      status: completed
    - id: handle-bvh-bounds
      content: Move BVH AABB data into sceneParams so sdBound reads from buffer instead of compile-time literals. Consider contiguous bounds region for cache locality.
      status: completed
    - id: port-codegen-vertical-slice
      content: Port Sphere, Box, and compileEdgeHelpers() to buffer reads. Validate with make build.
      status: completed
    - id: add-structural-fingerprint
      content: Implement structural fingerprint including node types, child relationships, polygon counts, and conditional-structural discretized values (twist zero/nonzero, blend mode, winding, BVH eligibility).
      status: completed
    - id: enable-param-only-build-fastpath
      content: Split build flow into evaluate/pack vs recompile. Skip shader compilation when fingerprint unchanged. Log timing for both paths. Target <10ms for param-only.
      status: completed
    - id: port-remaining-nodes
      content: Port remaining primitives, unary operators, then binary/smooth operators to buffer reads.
      status: completed
    - id: migrate-push-pull
      content: "Migrate push/pull from nodeParams to sceneParams: update PushPullController writeBuffers to use paramOffset, include paramOffset in SerializedNode."
      status: completed
    - id: remove-legacy-nodeparams
      content: Remove legacy nodeParams buffer, argIndex, and updateScene() once all consumers are on sceneParams.
      status: completed
    - id: verify-preview-export-parity
      content: Validate that preview, bounds, MDC export, and push/pull all consume the same sceneParams buffer with identical layout.
      status: completed
isProject: false
---

# Scene Parameter Buffer Plan

## Goal

Keep the existing `SceneInfo`/WGSL codegen pipeline for structural scene changes, but stop baking numeric primitive/operator parameters into generated shader text. On each source edit, rebuild the CPU scene graph, compare its structural shape to the currently built scene, and choose between:

- `param-only update`: repack scene parameter buffers and rewrite GPU buffers
- `full rebuild`: regenerate WGSL and recreate pipelines

## Current Constraints

- [`/Users/matt/galacticad3/src/scene/scene.mts`] currently emits scene-specific WGSL via `compile()`, `compileFast()`, `compileMid()`, `compileAux*()`, and `compileEdgeHelpers()`.
- [`/Users/matt/galacticad3/src/render-worker-core.mts`] `#doBuild()` always recompiles preview WGSL and recreates pipelines, even though it already uploads some runtime data (`polygonVertices`, `nodeParams`).
- [`/Users/matt/galacticad3/src/shaders/preview.wgsl`], [`/Users/matt/galacticad3/src/shaders/bounds.wgsl`], and [`/Users/matt/galacticad3/src/shaders/mdc.wgsl`] already bind the same narrow dynamic path:

```92:94:src/shaders/preview.wgsl
// Per-node parameters: .x = h (half-height), .y = posYDelta (Y offset from compiled position).
// Indexed by node ID. Updated during cap push/pull drag.
@group(0) @binding(12) var<uniform> nodeParams: array<vec4f, 256>;
```

- Many primitives/operators still inline parameters directly into WGSL, for example:

```40:47:src/scene/primitives/sphere.mts
    override compile(indentLevel = 0): CompileResult {
        const funcName = `Sphere${this.id}`
        const varName = decapitalize(funcName)
        return {
            funcName,
            varName,
            text: `fSphereEx(p - ${this.pos.wgsl}, ${this.r}, ${this.id}u)`,
        }
```

## Proposed Architecture

### 1. Introduce a first-class scene parameter layout

Add a scene-owned parameter layout that is independent from WGSL source generation.

Files:

- [`/Users/matt/galacticad3/src/scene/base.mts`]
- [`/Users/matt/galacticad3/src/scene/scene.mts`]
- likely new file: [`/Users/matt/galacticad3/src/scene/scene-params.mts`]

Plan:

- Replace the currently unused `argIndex`/`updateScene()` idea with an explicit packed layout API.
- Give every node a stable `paramOffset` and `paramCount` assigned during `build()`/scene registration. The layout is derived from depth-first tree traversal order, which is stable for identical structures.
- Provide helpers like `sceneParamF32(offset, slot)`, `sceneParamVec3(offset, slotBase)` for codegen and `packParams(view: Float32Array)` per node for CPU packing.
- Keep `node.id` for selection/highlighting; do not overload parameter addressing with selection semantics.
- Store enough metadata on `SceneInfo` to answer both:
    - how to pack all runtime parameters into a typed array
    - whether two scene graphs have the same structural layout

### WGSL buffer type

Use `array<f32>` in a storage buffer. This gives maximum flexibility for variable-width parameter schemas and avoids padding waste from `vec4f` alignment.

```wgsl
@group(0) @binding(12) var<storage, read> sceneParams: array<f32>;
```

Provide WGSL helper functions for typed reads:

```wgsl
fn sp_f32(offset: u32) -> f32 { return sceneParams[offset]; }
fn sp_vec3(offset: u32) -> vec3f {
    return vec3f(sceneParams[offset], sceneParams[offset + 1u], sceneParams[offset + 2u]);
}
```

Codegen then emits e.g. `fSphereEx(p - sp_vec3(${this.paramOffset}u), sp_f32(${this.paramOffset + 3}u), ${this.id}u)` instead of `fSphereEx(p - vec3f(1.0, 2.0, 3.0), 5.0, 0u)`.

### Buffer capacity

With up to 1022 scene nodes, each having ~10 f32 params + 6 f32 bounds = ~16 floats, the worst case is ~64KB. A storage buffer accommodates this easily (WebGPU storage buffer max is typically 128MB+). Allocate conservatively (e.g. 256KB) and grow if needed.

## 2. Define what is structural vs runtime data

Create a strict rule: if a value changes SDF behavior but not scene topology/code shape, it must come from the parameter buffer.

Runtime (exact numeric value is runtime; changing it triggers param-only update):

- primitive transforms and dimensions like sphere radius, box size, box/sphere position
- operator tunables like shell thickness, offset amount, taper amount, twist angle, morph amount
- extrude/loft/threaded-rod fields already partly in `nodeParams`
- edge-helper data such as box center/half-size, which is currently emitted inline in `compileEdgeHelpers()`
- union blend radius (exact value), union `n` column/stair count (exact value)

Still structural (changing any of these forces full recompilation):

- node type changes
- child count / tree topology changes
- polygon vertex count or polygon topology changes
- helper-function shape that depends on arity or generated loops
- any code path whose WGSL structure changes, not just its numeric inputs

### Conditional-structural parameters

Some numeric parameters control WGSL code shape through discrete transitions. The structural fingerprint must include their _discretized_ form (not the exact value). Changing the exact value within the same category is a param-only update; crossing a category boundary is structural.

| Parameter                 | Discretization for fingerprint                                      | Why                                                                               |
| ------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Extrude `twistDegrees`    | zero vs. nonzero                                                    | `compileAux*()` emits entirely different code paths                               |
| Union `radius`            | zero vs. nonzero                                                    | Selects `opUnionEx` vs. `fOpUnionRoundEx`; controls fold vs. nearest-pair codegen |
| Union `mode`              | exact enum value (`round`, `chamfer`, `soft`, `columns`, `stairs`)  | Selects which WGSL blend function is called                                       |
| Union child count         | exact count (already structural via tree topology)                  | >2 children with radius triggers nearest-pair instead of fold                     |
| Polygon winding direction | sign of signed area (CW vs. CCW)                                    | `windSignStr` is baked into extrude WGSL                                          |
| BVH eligibility per node  | whether `codegenCost() >= BVH_MIN_COST && computeBounds() !== null` | Determines if `sdBound` guard is emitted                                          |
| `bvhEnabled` global flag  | boolean                                                             | Controls whether any BVH guards are emitted                                       |

Deliverable:

- add a structural fingerprint method on `SceneInfo`/`Node` that ignores runtime parameter values but includes node types, child relationships, polygon segment counts, conditional-structural discretized values (see table above), and any other code-shape inputs.

## 3. Handle BVH bounds staleness

BVH bounding checks are currently baked as inline WGSL literals derived from `computeBounds()`, which reads runtime parameters (position, size, radius). For example, `Union._emitChildBlock` emits `sdBound(p, vec3f(1.0, 2.0, 3.0), vec3f(5.0, 5.0, 5.0))` using `aabbCenterWgsl()`/`aabbHalfWgsl()`. If those parameters move to the buffer but the bounds stay as compile-time literals, moving an object can take it outside its stale bounding box — the BVH guard culls it and the object disappears.

### Options

- **Option A — Dynamic BVH bounds from buffer**: Store each node's AABB center+half (6 floats) in a reserved region of `sceneParams`. `sdBound` reads from the buffer instead of using literals. Bounds are always fresh. Adds buffer reads in the SDF hot loop, but `sdBound` is a cheap box-distance check and the reads are coherent.
- **Option B — Treat bound-affecting params as structural**: Any parameter change that alters `computeBounds()` forces recompilation. Severely limits the fast path — most edits change position or size.
- **Option C — Inflated static bounds**: Use generously padded bounds at compile time (e.g. 2-3x). Fragile and wastes evaluation cycles on false positives.
- **Option D — Skip BVH on param-only updates**: Only emit BVH guards on full recompile. On the param-only fast path, use a second compiled shader variant without BVH guards (or a single variant that conditionally skips bounds via a uniform flag). Simple but loses the BVH optimization during interactive editing.

### Decision

Use **Option A** for correctness and simplicity:

- During `build()`, each node that has computable bounds writes its AABB into `sceneParams` at a reserved per-node region (6 floats: cx, cy, cz, hx, hy, hz).
- `aabbCenterWgsl()`/`aabbHalfWgsl()` emit buffer reads (`readVec3(boundsOffset)`) instead of literals.
- On param-only updates, the CPU repacks bounds from the new `computeBounds()` values into the buffer alongside the regular parameters.
- If Option A proves measurably expensive in profiling, fall back to **Option D** as a pragmatic alternative.

### Consideration: bounds buffer locality

Consider storing all node bounds contiguously in a dedicated region of `sceneParams` (or a separate small `sceneBounds` buffer) rather than interleaving with per-node params. BVH checks happen early in the SDF tree walk and sequential bounds reads will be more cache-friendly if they're packed together.

## 4. Move codegen to parameter references instead of literals

Refactor primitives/operators so generated WGSL reads from the scene parameter buffer rather than interpolating JS numbers into strings.

Files:

- [`/Users/matt/galacticad3/src/scene/primitives/*.mts`]
- [`/Users/matt/galacticad3/src/scene/operators/*.mts`]
- [`/Users/matt/galacticad3/src/scene/scene.mts`]

Plan:

- Update each node type to declare its parameter schema and packer.
- Rewrite `compile*()`/`compileAux*()` methods to emit buffer reads, for example replacing `this.r`, `this.pos.wgsl`, `twistRad`, etc. with `sp_f32(offset)` / `sp_vec3(offset)` lookups.
- Keep compile-time constants only when they are truly structural (see conditional-structural table in section 2).
- Convert `compileEdgeHelpers()` to read box extents from buffers so box resize/move does not force recompilation. Note: the `switch/case` structure (which node IDs are Boxes) is structural; the position/half-size values within each case are runtime.
- Migrate existing extrude/loft/threaded-rod use sites from the ad hoc `nodeParams[id]` layout to the new shared layout (see section 9 for detailed push/pull migration plan).

Note on Twist: `Twist.compile()` uses regex replacement (`/\bp\b/g`) to inject `twistPoint(p, rate)` into the child's compiled expression. When `rate` becomes a buffer read like `sp_f32(offset)`, the regex still works — just verify the longer expression doesn't break any edge cases in the child's WGSL text.

## 5. Upgrade GPU bindings from narrow `nodeParams` to shared scene params

The current `nodeParams: array<vec4f, 256>` uniform is too small and too specialized for all primitives/operators.

Files:

- [`/Users/matt/galacticad3/src/shaders/preview.wgsl`]
- [`/Users/matt/galacticad3/src/shaders/bounds.wgsl`]
- [`/Users/matt/galacticad3/src/shaders/mdc.wgsl`]
- [`/Users/matt/galacticad3/src/render-worker-core.mts`]
- [`/Users/matt/galacticad3/src/export/mdc.mts`]

Plan:

- Replace or supplement `nodeParams` with a single `sceneParams` GPU buffer that all scene shaders bind.
- Prefer a storage buffer over a uniform buffer so capacity is not capped by small uniform limits and packing can stay scalar-oriented.
- Keep binding parity across preview, bounds, and MDC; they must all see the same scene data at their respective binding slots.
- Update `RenderWorkerCore.#createBuffers()`, preview/beam bind groups, bounds bind groups, and `MDCExport` bind groups together.
- Preserve the current ordering rule from `#doBuild()`: swap new pipelines first, then write the new scene buffers.

## 6. Add a worker-side fast path for source edits

The worker should always reconstruct the CPU scene graph from source, but only rebuild WGSL if the structure changed.

Files:

- [`/Users/matt/galacticad3/src/render-worker-core.mts`]
- [`/Users/matt/galacticad3/src/render-worker.mts`]
- [`/Users/matt/galacticad3/src/render-worker-protocol.mts`]
- [`/Users/matt/galacticad3/src/sdf.mts`]

Plan:

- Split the current build flow into:
    - `evaluateScene(body)` -> `SceneInfo`, structural fingerprint, packed buffers
    - `recompilePipelines(scene)` -> current full WGSL/pipeline path
    - `applySceneBuffers(sceneData)` -> GPU buffer writes only
- On each build request, compare the new scene fingerprint with the built fingerprint.
- If fingerprints match, skip `ShaderCompiler.compile()` and pipeline creation; just update scene-owned buffers and serialized node metadata.
- If fingerprints differ, run the existing full rebuild path.
- Extend `writeBuffers` only if needed for granular source-edit updates; otherwise a full-buffer rewrite on param-only edits is fine for phase 1.

### Fingerprint storage

Store the built structural fingerprint on `RenderWorkerCore` alongside `#scene` and `#sceneShader`. After a successful full build, save the fingerprint. On the next build request, the new scene's fingerprint is compared to this stored value. `#scene` always holds the last successfully-compiled scene.

### Latency budget

The param-only fast path floor latency is: transpilation (~~1-2ms) + JS eval + `build()` (~~1-3ms) + `packParams` + `writeBuffer` (~0.5ms). Target: **param-only edits should reach the GPU in < 10ms**. Full recompilation (shader module + pipeline) typically adds 50-150ms on top. Measure both paths after implementation and log timings via `log("RenderWorker").debug`.

### Scene graph reconstruction cost

The plan always reconstructs the scene graph from source (transpile + JS eval + build) even for param-only changes. This is pragmatic for phase 1 — the alternative (caching the scene graph and patching parameter values in place) would require a diffing mechanism between old and new source and is much more complex. If the reconstruction floor latency proves problematic, this can be revisited.

## 7. Preserve preview/export/bounds parity

The buffer-driven scene must stay identical anywhere the SDF is evaluated.

Files:

- [`/Users/matt/galacticad3/src/render-worker-core.mts`]
- [`/Users/matt/galacticad3/src/export/mdc.mts`]
- [`/Users/matt/galacticad3/src/shaders/mdc.wgsl`]
- [`/Users/matt/galacticad3/src/shaders/bounds.wgsl`]

Plan:

- Reuse the same packed `sceneParams` buffer for preview, bounds, and MDC export.
- Make `handleRenderMesh()` and `#computeSceneBounds()` consume the exact same scene-param layout as preview.
- Include `sceneSDF_mid` and any MDC-only helpers in the parameterization audit so export does not lag behind preview.

### Buffer sharing strategy

The single `sceneParams` GPU buffer owned by `RenderWorkerCore` is shared across all consumers:

- **Preview + Beam**: bind via the main scene bind group (same as today's `nodeParams` slot).
- **Bounds compute** (`#computeSceneBounds`): currently creates its own bind group per call. Pass the existing `sceneParams` buffer into the bind group entries instead of allocating a new one.
- **MDC export** (`handleRenderMesh`): currently receives `this.#uniformBuffers.nodeParams` in the `MDCExport` constructor. Replace with `sceneParams`. Since MDC creates a separate shader module, it still needs the same WGSL `sceneParams` declaration — the codegen is shared, so this is automatic.

Lifetime: the `sceneParams` buffer persists for the life of the renderer. Its contents are overwritten on each build (full or param-only). MDC and bounds calls always run after a build, so the buffer content is always current.

## 8. Rollout strategy

Implement this in slices so the app stays buildable throughout.

Suggested order:

1. Introduce `sceneParams` buffer layout + WGSL helpers (`sp_f32`, `sp_vec3`) + worker plumbing while keeping existing full rebuild behavior. All scenes still do full recompilation.
2. Port a thin vertical slice: `Sphere`, `Box`, and `compileEdgeHelpers()`. BVH bounds also read from the buffer at this stage.
3. Add the structural fingerprint + param-only fast path for scenes composed only of migrated nodes.
4. Port remaining primitives, then unary operators, then binary/smooth operators.
5. Migrate push/pull from `nodeParams` to `sceneParams` (see section 9).
6. Remove or repurpose legacy `nodeParams`/`argIndex` paths once all consumers are on the new layout.

## 9. Push/pull migration

Push/pull is the most delicate transition because it already does live buffer writes mid-interaction, and it must continue working throughout the rollout.

### Current behavior

Push/pull writes to `nodeParams[nodeId]` via `writeBuffers` with layout `[0] = h (half-height), [1] = posYDelta`. The byte offset is computed as `nodeId * 16`. Extrude's WGSL reads `nodeParams[id].x` (h) and `nodeParams[id].y` (posYDelta).

### Migration steps

1. **Phase 1 — Dual buffers**: During the transition (rollout steps 1-4), keep both `nodeParams` and `sceneParams` alive. Extrude/loft/threaded-rod continue reading h and posYDelta from `nodeParams` while other primitives read from `sceneParams`. Both buffers are bound simultaneously.
2. **Phase 2 — Migrate extrude params**: Move extrude's h and pos.y into `sceneParams` at the node's `paramOffset`. Update `compileAux*()` to read `sp_f32(paramOffset + N)` instead of `nodeParams[id].x/.y`.
3. **Phase 3 — Migrate push/pull writes**: Update `PushPullController`'s `writeBuffers` callback to write to the correct `sceneParams` offset instead of `nodeId * 16`. The main-thread needs to know the node's `paramOffset` — include it in the `SerializedNode` sent back from the worker on build completion.
4. _Phase 4 — Remove `nodeParams`_: Once all consumers are migrated, remove the `nodeParams` buffer, its binding slot, and the related bind group entries.

### Key constraint

Push/pull writes happen during drag (between builds, without recompilation). The `sceneParams` buffer must accept partial writes at arbitrary offsets via `writeBuffer(buffer, byteOffset, data)`. This is already supported by WebGPU `queue.writeBuffer`.

## Validation

- Use `make build` after each migration slice.
- Verify param-only edits no longer recreate preview pipelines, while structural edits still do.
- Verify mesh export and bounds computation match preview after parameter-only edits.
- Regression-check push/pull and any feature that currently depends on live `nodeParams` updates.
- Measure and log fast-path latency vs. full-rebuild latency; verify the param-only path stays under ~10ms.
