# Iso-simplicial exporter — handoff notes

## Agent 1 (this drop)

- **Modules:** `src/export/iso-simplicial/` — `constants.mts`, `cube-tables.mts`, `tet-tables.mts`, `extract-tables.mts`, barrel `index.mts`.
- **`IsoSimplicialConstants`:** frozen defaults aligned with reference `main.cpp` / `iso_common.h` (+ `badqef` ratio from `iso_method_ours.cpp`). See JSDoc on `constants.mts` for symbol mapping.
- **Tables:** byte-for-byte parity with `cube_arrays.cpp`, `tet_arrays.cpp`, and `VisitorExtract` static `faceTable` / `flipTable`. Corner order uses reference `Index` (x + 2y + 4z).
- **Tests:** `iso-simplicial-tables_test.mts` — dimensions and spot-checks vs reference literals.

## Agent 2 (GPU batch sampler)

- **WGSL:** `src/shaders/iso_sample_batch.wgsl` — compute `isoSampleBatch`, `@workgroup_size(256)`. Uniform `sampleCount`; `positionsIn` = tight `f32` triples; `sdfOut[i]` = `vec4(nx, ny, nz, d)`. Bindings `0,1,2,25,27,28,30` aligned with `sample_grid.wgsl` scene bindings.
- **TS:** `iso-sample-batch.mts` — `IsoSampleBatch` mirrors `GridSampler` buffer lifecycle (local cancellation/uniforms/positions/out destroyed after `run`). Export from `index.mts`.
- **Compile:** `ShaderCompiler` replaces `sceneAuxFast`, `sceneAux`, `sceneSDF` (no `sceneAuxMid` — mid-path aux references `uniforms.voxelSize` which this shader lacks; no `sceneSDF_mid`). `render-worker-core.mts` imports the WGSL string so esbuild wgsl-loader validates it on `make build`.
- **Test:** `iso-sample-batch_test.mts` — expands includes with `fs`, `await import("webgpu")` **after** `SceneInfo` (static `webgpu` import pollutes `globalThis` and breaks the `sphere` binding). `Object.defineProperty(globalThis, "navigator", …)` for Node. Skips if no adapter. CAD source uses `return sphere.radius(10)` (fluent API). Compares batch vs `GridSampler` 1×1×1; sample points avoid the sphere center where the normal is singular.

## Agent 3 (QEF dual vertex, CPU double precision)

- **Modules:** `qef-matrix.mts` (Jacobi symmetric eigendecomposition, pseudoinverse matching reference eigen-thresholding; **column** eigenvector packing consistent with NR Jacobi; dense Gaussian elimination with partial pivot for well-conditioned solves); `qef-normal.mts` (`qefAccumulatePlane`, `unpackNormalEquations`, packed layout from `qefnorm.h`); `dual-vertex-qef.mts` (`encodeCubeHermitePlane`, `encodeFaceHermitePlane`, `encodeEdgeHermitePlane`, `computeDualVertexCube` / `Face` / `Edge` — ports `TNode::vertNode` / `vertFace` / `vertEdge` constraint cascade).
- **Solver:** Prefer `solveLinearSystem`; on singular pivot fall back to `symMatPseudoinverse` + `symMatVec` (rank-deficient parallel-plane stacks).
- **Tests:** `dual-vertex-qef_test.mts` — synthetic full-rank cube/face/edge cases plus boundary snap smoke test.

## Agent 4 (CPU octree + GPU batch integration)

- **Module:** `iso-octree.mts` — `IsoOctree.build({ sample, bounds, signal?, constants? })` builds a reference-aligned `TNode::eval` tree. `sample(positions)` is the only distance/normal source (world-space `Float32Array` triples in / interleaved `vec4` SDF out — same layout as `IsoSampleBatch`). Vertices are stored in **normalized** root-cell `[0,1]³` so `DEPTH_MIN` / `DEPTH_MAX` / `is_outside` match reference scaling; `createIsoOctreeSampleFn` adapts `IsoSampleBatch` + shader module.
- **Exports:** `isoOctreeChangesSign`, `isoOctreeIsOutside`, `IsoOctreeRuntimeConstants` / override types for tests.
- **Tests:** `iso-octree_test.mts` — `changesSign` / `is_outside` unit checks; `IsoOctree.build` with a **mock** plane field (no `SceneInfo` / transpile); deterministic `treeCellCount` with capped constants.

## Agent 5 (traverse + MT extraction)

- **Module:** `iso-extract.mts` — reference `traverse.h` with `TraversalType::trav_edge` (faces + edges, no `traverse_vert`). `IsoExtractVisitor` ports `VisitorExtract::on_node` / `on_face` / `on_edge` / `processTet`; Marching Tetrahedra uses `tetTris` / `tetEdge2Vert` from `tet-tables.mts`.
- **API:** `extractIsoSimplicialMesh(tree: { root: IsoOctreeNode }, options?: { worldBounds?: IsoOctreeBounds }): MeshData` — verts start in normalized root `[0,1]³`; optional `worldBounds` maps to world space before `renormalizeTriangleNormals` (face-derived normals, same stride as other exporters).
- **Helpers:** `traverseIsoExtract`, `genTrav`, `isOctreeLeaf` (matches reference `children[0]==0`), `isoExtractFindZero`.
- **Tests:** `iso-extract_test.mts` — `findZero` smoke; extraction on mock plane with subdivided octree (`triCount > 0`, finite verts); `worldBounds` scaling.

## Agent 6 (Phase 5 quality — optional)

- **`IsoExtractOptions.phase5`:** `enabled` (default off), optional `sample` (GPU `IsoOctreeBatchFn`), `findRootDepth` (defaults to `IsoSimplicialConstants.findRootDepth`), `minTriangleAreaSq` (defaults to `ISO_EXTRACT_DEFAULT_MIN_TRIANGLE_AREA_SQ`), `signal`.
- **Sync** `extractIsoSimplicialMesh`: with `phase5.enabled` and **no** `sample`, runs degenerate-triangle filter only. With `sample` set, **throws** — use async API.
- **Async** `extractIsoSimplicialMeshAsync`: when `phase5.enabled` and `sample` present, traverses in pending-snap mode, runs reference `rootfind.h`-style bisection (GPU midpoint evals only), maps `worldBounds`, `renormalizeTriangleNormals`, then degenerate filter.
- **Parity test:** compare `extractIsoSimplicialMesh(..., { phase5: { enabled: true } })` (degenerate filter only) to `extractIsoSimplicialMeshAsync` with `findRootDepth: 0` — async path always runs the same filter after snap; unfiltered sync mesh is not comparable.

## Agent 7 (worker + UI)

- **`ExporterKind`:** `"mdc" | "shrec" | "isoSimplicial"` in `render-worker-protocol.mts`; `renderMesh` message carries `isoSimplicialTuning?: IsoSimplicialTuning`.
- **Worker:** `handleRenderMesh` compiles `iso_sample_batch.wgsl`, `IsoOctree.build` + `extractIsoSimplicialMesh` / `extractIsoSimplicialMeshAsync` (Phase 5 when `phase5Snap`), cubic bounds from padded scene AABB; `log("IsoSimplicialExport").info` timing (`treeCellCount`, `octreeMs`, `totalMs`).
- **Dev Tools:** Mesh export → Exporter radios + Iso-simplicial collapse (depth min/max, Phase 5 snap, defaults); settings `meshExporter` + `isoSimplicialTuning` (legacy `useShrecExporter` synced when exporter is SHREC).
- **`AGENTS.md`:** iso-simplicial mesh export paragraph.

## Gaps / next agents

- Guide-tree (`TNode::eval` with non-null `guide`) not implemented (reference dual-pass); v1 always builds from scratch.
