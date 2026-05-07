# Agent 1 to-do implementation
_Exported on 5/7/2026 at 15:46:40 PDT from Cursor (3.2.16)_

---

**User**

Implement the following to-dos from the plan (the plan is attached for your reference). Do NOT edit the plan file itself.

You have been assigned the following 1 to-do(s) with IDs: agent-1

1. [agent-1] Agent 1: cube/tet tables + IsoSimplicialConstants + unit tests

These to-dos have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the assigned to-dos.

---

**Cursor**

Implementing Agent 1: porting reference tables and constants, adding `src/export/iso-simplicial/` modules, and unit tests. Exploring reference files and the project's test layout.



Implementing modules and tests: adding `cubeIndexFromBits`, `TraversalType` enum matching C++, and the handoff document.



## Done: Agent 1 foundations

Implemented **Agent 1** under `src/export/iso-simplicial/` (plan file untouched).

### What was added

1. **`constants.mts`** — `IsoSimplicialConstants` with defaults aligned to reference `main.cpp` / `iso_common.h`: `oversampleQef`, `dualVertexBorderFraction` (maps to `BORDER` / interior clamp margin), `depthMin` / `depthMax`, `findRootDepth` (`FIND_ROOT_DEPTH`), and `qefRelativeErrorRefineThreshold` (the `badqef` `1e-3` ratio in `iso_method_ours.cpp`). JSDoc spells out each mapping.

2. **`cube-tables.mts`** — Tables from `cube_arrays.cpp`: `cubeEdge2Vert`, `cubeEdge2Orient`, `cubeFace2Vert`, `cubeFace2Edge`, `cubeFace2Orient`, `cubeFace2Opposite`, `cubeOrient2Face`, `cubeOrient2Edge`, plus `cubeCornerIndex` / `cubeCornerBits` matching reference `Index` (x + 2y + 4z).

3. **`tet-tables.mts`** — `tet_edge2vert`, `tet_trisNum`, `tet_triStrips`, `tet_tris` from `tet_arrays.cpp`.

4. **`extract-tables.mts`** — `extractFaceTable` and `extractFlipTable` from `VisitorExtract::on_edge`, and `TraversalType` enum matching `traverse.h`.

5. **`index.mts`** — Re-exports for a single import surface.

6. **`iso-simplicial-handoff.md`** — Short handoff for later agents (per plan).

7. **`iso-simplicial-tables_test.mts`** — Asserts constant defaults, table dimensions, several fixed index rows vs the reference literals, `cubeCornerIndex` round-trip for all 8 corners, and `TraversalType` ordering.

`make build` and `make test` both pass (46 tests total, 9 new).

