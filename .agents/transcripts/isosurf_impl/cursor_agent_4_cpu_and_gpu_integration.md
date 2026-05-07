# Agent 4 CPU and GPU integration
_Exported on 5/7/2026 at 16:16:49 PDT from Cursor (3.3.22)_

---

**User**

Implement the following to-dos from the plan (the plan is attached for your reference). Do NOT edit the plan file itself.

You have been assigned the following 1 to-do(s) with IDs: agent-4

1. [agent-4] Agent 4: CPU octree build + GPU batch integration + subdivision parity

These to-dos have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the assigned to-dos.

---

**Cursor**

Implementing Agent 4: CPU octree build with GPU batch integration. Exploring the codebase and reference implementation.



Implementing the octree in normalized [0,1]³ coordinates (matching reference subdivision thresholds), converting to world only for GPU sampling. Checking `dual-vertex-qef_test` for expected plane layouts:



Implementing `iso-octree.mts` and tests.



Rewriting `iso-octree.mts` — the previous write was incomplete and broken.



Rewriting the file: fixing trilinear interpolation to match the reference and completing `vertNode`, `vertFace`, `vertEdge`, and child recursion.



Fixing `function(p)` semantics: refresh only the scalar `w` (distance), not the full vec4 from the GPU.



Here is what was implemented for **Agent 4**.

### `src/export/iso-simplicial/iso-octree.mts`
- **`IsoOctree.build`** — Builds an octree aligned with reference `TNode::eval` / `TNode::changesSign` / `is_outside` / depth / `badqef` (`iso_method_ours.cpp`).
- **Normalized `[0,1]³` storage** for corner / edge / face / cell duals so `DEPTH_MIN` / `DEPTH_MAX` and `is_outside` behave like the reference; **`sample`** is always called with **world** positions (linear map from cubic `bounds`).
- **Hermite + QEF** — `vertNode` / `vertFace` / `vertEdge` mirror reference loops (x outer, y, z inner for the cube), batch GPU samples, then Agent 3 **`computeDualVertex*`** + **`encode*HermitePlane`** / **`qefAccumulatePlane`**.
- **`function(p)`** — Implemented as **`sampleScalarWAtNorm`**: only **`w`** (distance) is refreshed at the minimized `(x,y,z)`, matching `rootfind.h` `function`.
- **Subdivision** — Same 3×3×3 trilinear stencil as the reference; midpoints go through **`sample`** in one batch; corner “gradients” reuse parent corners or midpoint batch normals, like `grad[Index(x>>1,...)]` vs fresh eval.
- **`createIsoOctreeSampleFn`** — Wraps **`IsoSampleBatch.run`** into **`IsoOctreeBatchFn`**.
- **Exports:** `isoOctreeChangesSign`, `isoOctreeIsOutside`, `IsoOctreeNode`, `IsoOctreeBuildParams`, `IsoOctreeBuildConstantsOverrides`, `IsoOctreeRuntimeConstants`, etc.

### `src/export/iso-simplicial/iso-octree_test.mts`
- Unit tests for **`isoOctreeChangesSign`** / **`isoOctreeIsOutside`**.
- **`IsoOctree.build`** with a **mock** plane field only (no `SceneInfo` / transpile).
- **Deterministic `treeCellCount`** under fixed overrides.

### `src/export/iso-simplicial/index.mts`
- Re-exports **`./iso-octree.mjs`**.

### `src/export/iso-simplicial/iso-simplicial-handoff.md`
- Agent 4 API notes and the gap that **guide-tree** eval is not implemented yet.

**Intentional gap:** `TNode::eval(..., guide)` (second pass guided by an existing tree) is **not** implemented; the builder always uses the `!guide` path.  

`make test` and `make build` both succeed.

