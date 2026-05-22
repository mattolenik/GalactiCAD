# Iso-simplicial × FeatureGraph integration

## Context

The FeatureGraph (FG) — a CSG-survival-aware set of corner vertices, crease edges, and cap loops extracted from primitives like Box, Extrude, Cylinder, Loft, Lathe — currently flows into only the SHREC exporter (via `featureGraphToContours` adapter feeding SHREC's MergeSharp snap) and the debug overlay. The iso-simplicial exporter doesn't read the FG at all; its mesh is purely SDF-driven plus the existing GPU-sampled "mid-feature" path (`compileAuxMid` → `SDFResultMid` → `injectCubeFeaturePlanes` in the per-cell QEF).

We want iso-simplicial to also benefit from the FG. Specifically:
- Sharp primitive corners (Box vertices, polygon-extrusion top corners, etc.) should pull dual vertices toward themselves so the meshed output reproduces the explicit features instead of approximating them from SDF gradient samples alone.
- Crease edges (cap-meets-side dihedrals, side-edge creases, lathe rings) should constrain the QEF along the crease line.
- CSG-survival semantics from the FG (features killed by a CSG cut or smooth blend are absent) propagate to the iso-simplicial mesh.

The existing per-cell QEF machinery already accepts arbitrary Hermite plane constraints (`encodeFeaturePlane`, `qefAccumulatePlane`); the FG spatial index already supports per-cell range queries. The integration is largely a matter of plumbing FG-derived planes into the same QEF pipeline that `featurePlaneEnabled` already uses for GPU mid-feature samples.

User-confirmed design choices:
- **Worker pool supported from the start** — FG-derived per-cell feature data packed into a shared buffer the QEF worker can decode (not main-thread-only).
- **Soft Hermite planes only** — FG corners and creases add planes that compose with the existing GPU mid-feature planes. No hard pinning / snapping; the QEF solver weighs FG planes alongside SDF-derived planes.

## Approach

Extend the existing iso-simplicial feature-plane injection path with a FG-derived second source of Hermite planes — same encoders (`encodeFeaturePlane` / `encodeEdgeFeaturePlane` / `encodeFaceFeaturePlane`), same accumulator (`qefAccumulatePlane`). FG features are queried per octree cell via `FeatureGraphSpatialIndex`, distance-gated using the same `planeDistFactor * cellSize * worldScale` rule the existing path uses, and injected alongside (not replacing) the GPU mid-feature planes.

Worker pool support: per-cell FG feature lists pre-packed into a SharedArrayBuffer alongside the existing `sharedCornerFeature` data. Workers decode FG features and run the same plane-encoding inline.

## Key design decisions

### 1. FG built at iso-simplicial's finest cell size

The existing `handleRenderMesh` builds the FG at `voxelSizeMm` for the SHREC branch. For iso-simplicial, the relevant cell size is `(cube.max[0] - cube.min[0]) / 2^depthMax` — computed at [`render-worker-core.mts:1466`](src/render-worker-core.mts#L1466) as `isoBatchVoxelSize`. Build the FG at THAT size for the iso-simplicial branch so the spatial index's cell granularity matches the deepest octree cells. Coarser octree cells span multiple FG cells; the per-cell query iterates over the spanning FG cells and unions their refs.

### 2. Per-cell FG feature query helper

Add a module `src/feature-graph/feature-graph-cell-query.mts` exporting `queryFeatureGraphForCell(index, cpu, world, cellAABB, distFactor, worldScale)`:
- Compute the FG cell-key range that overlaps the octree cell AABB (widened by `distFactor * cellSize` so distance-gating works at the edge)
- Iterate FG cells in that range, union refs into a `Set<number>` (dedup; same edge or vertex can appear in multiple FG cells due to the existing ½-cell widening)
- For each unique ref: extract world position(s) and normals from `cpu.vertexPositions`, `cpu.vertexFlags`, `cpu.vertexNormals`, `cpu.edgeEndpoints` etc.
- Return a flat `FgCellFeatures` struct: arrays of corner positions+normals and crease positions+normals, ready for the QEF injection step.

### 3. QEF plane injection from FG

Reuse the existing encoders in [`dual-vertex-qef.mts`](src/export/iso-simplicial/dual-vertex-qef.mts):
- `encodeFeaturePlane(nx, ny, nz, px, py, pz)` for cube
- `encodeEdgeFeaturePlane(nXi, pXi)` for 1D edge QEF
- `encodeFaceFeaturePlane(nXi, nYi, pXi, pYi)` for 2D face QEF

Add three new functions mirroring the existing `injectCubeFeaturePlanes` / `injectEdgeFeaturePlanes` / `injectFaceFeaturePlanes`:
- `injectCubeFgFeaturePlanes(packed, fgCellFeatures, cellAABB, distFactor, worldScale)`
- `injectEdgeFgFeaturePlanes(packed, fgCellFeatures, edgeAABB, axis, distFactor, worldScale)`
- `injectFaceFgFeaturePlanes(packed, fgCellFeatures, faceAABB, axes, distFactor, worldScale)`

Each iterates the FG features, gates by distance to the relevant cell/edge/face, and accumulates planes. An FG corner with N normals contributes N planes; an FG crease (with 2 normals) contributes 2 planes per endpoint, projected to the edge/face axes for sub-dim QEFs (same projection logic as the existing edge/face injection).

### 4. QEF flavor terminology

iso-simplicial runs three QEF flavors per cell:
- **Cube QEF** (3D, unconstrained) → the main dual vertex (the one MT extraction emits)
- **Edge QEF** (1D, constrained to a cell-edge axis)
- **Face QEF** (2D, constrained to a cell-face plane)

"Cube" throughout this plan refers to the **cube QEF** in the dual-contouring sense, NOT the `Box` primitive. FG features (from Box, Extrude, Cylinder, Loft, Lathe, …) all contribute equally; the QEF flavor names only describe which sub-dimensional solve they feed.

### 5. Worker pool: shared-buffer FG feature packing

The existing worker pool dispatches batches via `QefWorkerPool.processBatch` with `sharedCornerFeature` (per-cell × 8 corners × 28 floats). Add a parallel sidecar buffer:

- `sharedFgFeatureOffsets: Uint32Array` (length = numCells + 1) — prefix-sum offsets (in *stride units*, not floats) into the flat data
- `sharedFgFeatureData: Float32Array` — packed FG features, **per-batch dynamic stride**
- `sharedFgFeatureHeader: Uint32Array` (length = 1) — holds `strideFloats` for the current batch

**Per-batch dynamic stride.** Before packing, the main thread scans the batch's `FgCellFeatures` arrays to find the max normal count across all features in the batch (`maxN`). Stride = `4 + maxN * 4` floats:
- `[posX, posY, posZ, kindFlags, n0X, n0Y, n0Z, _pad, n1X, n1Y, n1Z, _pad, … nNX, nNY, nNZ, _pad]`
- `kindFlags` packs `FG_FLAG_*` bits plus the per-feature normal count in the low byte (workers read this to know how many normals to consume; never the batch `maxN`).
- All 4-float blocks remain vec4-aligned.
- Worker reads `strideFloats` from `sharedFgFeatureHeader[0]` once per batch and uses it to advance through `sharedFgFeatureData`.

Most batches will land at `maxN = 2` (cylinder/lathe ring crease has 2 normals; extrude top corner has 3) so typical stride is 12 floats; pathological batches with 4+-normal features pay only the bytes they need.

Main thread per-cell:
1. Call `queryFeatureGraphForCell` to get `FgCellFeatures` for the cell.
2. Apply distance gate ONCE on the main thread (avoid worker re-checking — saves work).
3. Track running max normal count across the batch.
4. Once the batch is fully queried, set `strideFloats`, size `sharedFgFeatureData`, then write each cell's features at its offset.

Worker per-cell:
1. Read `strideFloats` from `sharedFgFeatureHeader[0]`.
2. Read its cell's FG features from `sharedFgFeatureData` via the offset table.
3. Run the same `injectCube/Edge/FaceFgFeaturePlanes` (functions extracted to a worker-shareable module).

Files involved: [`iso-qef-worker.mts`](src/export/iso-simplicial/iso-qef-worker.mts), [`qef-worker-pool.mts`](src/export/iso-simplicial/qef-worker-pool.mts).

### 6. Distance-gating semantics

Reuse the existing `planeDistFactor * cellSize * worldScale` formula:
- Default `planeDistFactor = 1.0` matches the existing GPU-mid-feature default
- Single factor governs cube/edge/face FG injection; lives on `IsoSimplicialTuning` alongside the existing knobs

### 7. Tuning surface (extends `IsoSimplicialTuning`)

```ts
/** Inject FeatureGraph corners + creases as additional Hermite planes in the per-cell QEF (cube/edge/face). */
featureGraphPlanesEnabled?: boolean  // default false
/** Same dist gate as `featurePlaneDistFactor` but for FG-derived planes. */
featureGraphPlaneDistFactor?: number  // default 1.0
```

Both added to `DEFAULT_ISO_SIMPLICIAL_TUNING`, validated in `src/storage/settings.mts`, plumbed through `IsoFeatureRefineOptions` to the octree.

## File-by-file changes

### New files

| Path | Purpose |
|------|---------|
| [src/feature-graph/feature-graph-cell-query.mts](src/feature-graph/feature-graph-cell-query.mts) | `queryFeatureGraphForCell()` returns per-cell `FgCellFeatures` (corners + creases with world pos + normals) from the FG spatial index. Handles multi-resolution cell queries by iterating spanning FG cells with dedup. |
| [src/export/iso-simplicial/iso-fg-feature-planes.mts](src/export/iso-simplicial/iso-fg-feature-planes.mts) | `injectCubeFgFeaturePlanes` / `injectEdgeFgFeaturePlanes` / `injectFaceFgFeaturePlanes`. Pure functions (no scene/octree dependencies) so they can run on both main thread and worker. |
| [src/export/iso-simplicial/iso-fg-shared-buffer.mts](src/export/iso-simplicial/iso-fg-shared-buffer.mts) | Packing / unpacking helpers for the per-cell FG feature SharedArrayBuffer layout. Computes per-batch dynamic stride from observed max normal count. |
| Tests next to each new module. |

### Modified files

| Path | Change |
|------|--------|
| [src/render-worker-protocol.mts](src/render-worker-protocol.mts) | Add 2 fields to `IsoSimplicialTuning` (`featureGraphPlanesEnabled`, `featureGraphPlaneDistFactor`) + defaults in `DEFAULT_ISO_SIMPLICIAL_TUNING`. |
| [src/storage/settings.mts](src/storage/settings.mts) | Validate the new fields with the same pattern as `featurePlaneEnabled` / `featurePlaneDistFactor`. |
| [src/render-worker-core.mts](src/render-worker-core.mts) | In the iso-simplicial export branch (~line 1360), build FG at `isoBatchVoxelSize` (not `voxelSizeMm`). Pass FG cpu + worldPositions + spatial index + the 2 new tuning fields into `IsoFeatureRefineOptions`. |
| [src/export/iso-simplicial/iso-octree.mts](src/export/iso-simplicial/iso-octree.mts) | Extend `IsoFeatureRefineOptions` with the FG fields. In `computeNodeQefResults` (line 426-561) and in the inline path, call `injectCube/Edge/FaceFgFeaturePlanes` alongside the existing GPU-mid-feature injections. In the worker dispatch path (line 1211-1258), pre-pack FG features into the shared sidecar buffer per cell. |
| [src/export/iso-simplicial/iso-qef-worker.mts](src/export/iso-simplicial/iso-qef-worker.mts) | Decode per-cell FG features from the shared sidecar (reading per-batch stride from header), run the same injection logic. |
| [src/export/iso-simplicial/qef-worker-pool.mts](src/export/iso-simplicial/qef-worker-pool.mts) | Extend `QefBatchInputs` to carry the FG sidecar buffers (data + offsets + header) and the 2 tuning flags. |
| [src/components/dev-tools-mesh-export-section.mts](src/components/dev-tools-mesh-export-section.mts) | Add 2 UI controls (checkbox + slider) for the new tuning fields inside the existing "Iso-simplicial" nested collapse. Pattern matches the existing `featurePlaneEnabled` / `featurePlaneDistFactor` controls. |

## Phasing

Six chunks, each independently testable. Land in order:

**Phase IS-1: Plumbing + protocol surface (no behavior change)**
- Add the 2 tuning fields with defaults
- Settings validation
- Pass FG data through `IsoFeatureRefineOptions` (unused at the consumer end yet)
- Verify: `make check` + existing iso-simplicial tests still pass

**Phase IS-2: Per-cell FG query**
- Implement `queryFeatureGraphForCell` + tests
- Confirm multi-resolution queries work (deep cell ≈ 1 FG cell, shallow cell ≈ many FG cells, dedup correct)
- No iso-simplicial code calls it yet

**Phase IS-3: Inline cube QEF FG plane injection**
- Implement `injectCubeFgFeaturePlanes`
- Wire into inline `computeNodeQefResults` path only (no workers yet)
- Test: a single Box scene with `featureGraphPlanesEnabled = true` — verify a dual vertex near a Box corner pulls toward it
- Disable worker pool when FG enabled (temporary, removed in IS-5)

**Phase IS-4: Inline edge + face FG plane injection**
- Implement `injectEdgeFgFeaturePlanes`, `injectFaceFgFeaturePlanes`
- Wire into inline edge/face QEF paths
- Test: FG crease near an edge → edge dual vertex pulls along the crease; FG corner near a face → face dual vertex pulls toward it; distance gate suppresses far features

**Phase IS-5: Worker pool support**
- Implement shared-buffer packing/unpacking with per-batch dynamic stride
- Wire into worker dispatch path
- Worker decodes + injects
- Re-enable worker pool with FG
- Test: same output as inline (golden image comparison via existing `sdf-mesh-diff` skill)

**Phase IS-6: Dev tools UI + final smoke test**
- 2 controls in the iso-simplicial collapse
- End-to-end: load `subtract(box(10), translate([5,0,0], box(10)))`, export iso-simplicial mesh, toggle FG planes off vs on, compare meshes (FG-enabled should have sharper corners)

## Verification

### Unit tests
- `feature-graph-cell-query_test.mts`: dedup across FG cells, AABB widening, multi-resolution queries
- `iso-fg-feature-planes_test.mts`: cube/edge/face plane encoding matches existing convention; distance gate works
- `iso-fg-shared-buffer_test.mts`: round-trip pack/unpack preserves features; per-batch stride derived from observed max normal count; offset table correctness; mixed-stride batches (varying normal counts per feature within one batch)

### Integration tests
- `iso-octree_test.mts`: extend existing `featurePlane` tests with FG-equivalent assertions:
  - FG corner near a cell → cube dual vertex pulls toward it (mirror existing `featurePlane: enabled — vertex pulls toward featurePoint x/y` test pattern)
  - FG crease near a cell → edge dual vertex pulls along the crease
  - Distance gate suppresses far FG features

### End-to-end smoke (via the dev server)
1. Load `subtract(box(10), translate([5,0,0], box(10)))` in the editor
2. Mesh export → iso-simplicial → export with FG planes **off**: note the corner geometry (likely rounded/QEF-blurred)
3. Toggle "FG planes" on → re-export → corners should be sharper
4. Compare via `scripts/agentcli compare` (the `sdf-mesh-diff` skill) — expect visible improvement at corners, no regression elsewhere

### Regression
- All existing iso-simplicial tests (`iso-octree_test.mts`, `iso-extract_test.mts`, `dual-vertex-qef_test.mts`, etc.) must still pass with FG tuning fields at default (false / 1.0) — equivalent to no FG path active.
- SHREC FG integration unaffected (different code path).

## Risks / known limitations

1. **Multi-resolution cell-size mismatch**: FG built at finest octree cell size; shallow octree cells span many FG cells. Mitigation: dedup via Set in `queryFeatureGraphForCell`. Worst case (entire octree at depthMin): O(2^depthMin per-cell) FG cells queried per octree cell — still cheap (depthMin default = 3 → 8 FG cells max).

2. **Worker shared-buffer sizing**: per-cell FG feature counts vary widely (0 to dozens), and per-batch stride varies with the max normal count observed. Worst-case per-batch size: numCells × maxFeaturesPerCell × strideFloats. For a 1000-cell batch with avg 4 features/cell at the worst observed stride of 24 floats (5-normal feature): 384 KB — well within SharedArrayBuffer norms. Allocate growable; mirror the existing `sharedCornerFeature` sizing pattern.

3. **Twist/warp gating**: the FG already skips emission under non-affine ancestors (Twist/Bend/Taper). Iso-simplicial integration inherits that — features under warps won't contribute. Same v1 limitation as the rest of the FG pipeline.

4. **Workers without `SharedArrayBuffer`**: the existing code path falls back to inline QEF when SAB is unavailable ([`render-worker-core.mts:1379-1399`](src/render-worker-core.mts#L1379)). FG inline path works there too — no new code needed, just ensure the worker dispatch path doesn't reference the FG sidecar when workers are disabled.

5. **FG build cost at depth-max cell size**: the existing FG build at `voxelSizeMm = 0.5` produces ~hundreds of feature vertices. Building at `isoBatchVoxelSize` (e.g. `bounds/256` = ~0.4mm for a 100mm scene) is the same order. Stage-3 subdivision scales with edge length / target seg, so re-using the existing FG pipeline at smaller cellSize is bounded.
