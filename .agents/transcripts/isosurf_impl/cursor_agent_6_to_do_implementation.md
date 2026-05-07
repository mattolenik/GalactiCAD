# Agent 6 to-do implementation
_Exported on 5/7/2026 at 16:29:53 PDT from Cursor (3.3.22)_

---

**User**

Implement the following to-dos from the plan (the plan is attached for your reference). Do NOT edit the plan file itself.

You have been assigned the following 1 to-do(s) with IDs: agent-6

1. [agent-6] Agent 6 (optional): Phase 5 snap/degenerate pass behind flag

These to-dos have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the assigned to-dos.

---

**Cursor**

Implementing Agent 6: Phase 5 snap/degeneracy pass behind a flag. Exploring the iso-simplicial export code and the reference `rootfind.h`.



Implementing Phase 5: GPU bisection (reference `rootfind.h`), degenerate-triangle removal when quality is enabled, and an async extractor when a GPU `sample` is provided. Checking for circular imports and running tests.



Implementing visitor capture mode, GPU bisection (matching `rootfind.h`), degenerate filtering, and async extraction.



Adding helper functions and updating the visitor class, finish path, and public extract APIs.



Swapping test order to check whether the first traversal mutates the octree.



Identifying the issue: the test compared unfiltered sync extraction (`a`) with async Phase 5, which always runs `filterIsoExtractDegenerateTriangles`. Updating the test to compare sync extraction with the same Phase 5 degenerate filter (no sample).



## Agent 6 done

### Behavior
- **`IsoExtractOptions.phase5`** (`IsoExtractPhase5Options`): `enabled` (default off), optional GPU `sample` (`IsoOctreeBatchFn`), `findRootDepth` (defaults to `IsoSimplicialConstants.findRootDepth` / reference `FIND_ROOT_DEPTH`), `minTriangleAreaSq` (defaults to `ISO_EXTRACT_DEFAULT_MIN_TRIANGLE_AREA_SQ`), `signal`.
- **`extractIsoSimplicialMesh`**: Unchanged when `phase5` is absent or `enabled` is false (same as Agent 5). With `enabled` and **no** `sample`, runs **degenerate filtering** only. With `enabled` **and** `sample`, **throws** so callers use the async API.
- **`extractIsoSimplicialMeshAsync`**: If `phase5.enabled` and `sample` are set, traverses in **pending-snap** mode, resolves each MT edge with **`isoExtractSnapEdgeVertexGpu`** (reference `rootfind.h`: bisection with midpoint values **only** from `sample`, then terminal `findZero`), maps `worldBounds`, `renormalizeTriangleNormals`, then **`filterIsoExtractDegenerateTriangles`**. Otherwise delegates to the sync extractor.
- **`filterIsoExtractDegenerateTriangles`**: Exported; drops sub-threshold / non-finite area triangles and compacts vertices, then re-normalizes.

### Files
- `src/export/iso-simplicial/iso-extract.mts` — Phase 5 types, snap, filter, async entry.
- `src/export/iso-simplicial/iso-extract_test.mts` — throw test, parity test (sync degenerate-only vs async `findRootDepth: 0` with the same filter), degenerate filter unit test.
- `src/export/iso-simplicial/iso-simplicial-handoff.md` — Agent 6 notes + parity note.

`make build` / `make test`: all **61** tests pass.

