# Agent 7 to-do implementation
_Exported on 5/7/2026 at 16:38:40 PDT from Cursor (3.3.22)_

---

**User**

Implement the following to-dos from the plan (the plan is attached for your reference). Do NOT edit the plan file itself.

You have been assigned the following 1 to-do(s) with IDs: agent-7

1. [agent-7] Agent 7: ExporterKind + handleRenderMesh + Dev Tools + AGENTS note

These to-dos have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the assigned to-dos.

---

**Cursor**

Implementing Agent 7: wiring the iso-simplicial exporter into the protocol, render worker, Dev Tools, and AGENTS.md. Exploring the codebase and marking the task in progress.



Implementing protocol types, worker branch with cubic bounds and timing logs, settings persistence, Dev Tools exporter UI, and AGENTS.md note.



Applying changes: updating the protocol and worker first, then settings and UI.



Implementing settings and Dev Tools UI.



Here is what was implemented for **Agent 7**:

### Protocol (`src/render-worker-protocol.mts`)
- Extended `ExporterKind` with `"isoSimplicial"`.
- Added `IsoSimplicialTuning`, `DEFAULT_ISO_SIMPLICIAL_TUNING`, and `isoSimplicialTuning?: IsoSimplicialTuning` on the `renderMesh` worker message.

### Render worker (`src/render-worker-core.mts`, `src/render-worker.mts`)
- `handleRenderMesh` takes `isoSimplicialTuning`, branches on `exporter === "isoSimplicial"`.
- Builds a **cube** around the padded bounds (max edge length, centered), compiles `iso_sample_batch.wgsl` with the same `sceneAux*` / `sceneSDF` inserts as tests, runs `IsoOctree.build` with `IsoSampleBatch` + `createIsoOctreeSampleFn`, then `extractIsoSimplicialMesh` or `extractIsoSimplicialMeshAsync` when `phase5Snap` is true.
- Logs with `log("IsoSimplicialExport").info` (tree cell count, triangle count, octree/total ms).

### Main thread (`src/sdf.mts`)
- `renderMesh` options and pending transpile payload include `isoSimplicialTuning`; worker post includes it.

### Settings (`src/storage/settings.mts`)
- `app.meshExporter`, `app.isoSimplicialTuning`; **`useShrecExporter` stays in sync** (`true` iff `meshExporter === "shrec"`) for older data.
- Load: `meshExporter` from disk, or migrate from legacy `useShrecExporter`.
- `normalizeIsoSimplicialTuning`, `updateGlobal` merges `isoSimplicialTuning` and sets `useShrecExporter` when `meshExporter` is patched.

### Dev Tools
- **Mesh export** (`dev-tools-mesh-export-section.mts`): exporter radios (MDC / SHREC / Iso-simplicial), nested **Iso-simplicial** controls (Phase 5 GPU snap, depth min/max, defaults). SHREC section no longer has its own exporter checkbox (copy points to Mesh export).
- **Panel** (`dev-tools-panel.mts`): `meshExporter`, `isoSimplicialTuning`, `syncMeshExporterFromSettings`, `syncIsoSimplicialTuningFromSettings`, `onMeshExporterChange` / `onIsoSimplicialTuningChange`.

### App (`src/app.mts`)
- Syncs exporter + iso tuning from settings; remesh on exporter/iso tuning changes; `#meshRenderOptionsForExport` passes `exporter`, `isoSimplicialTuning`.

### Diagnostics & docs
- **`IsoSimplicialExport`** in `DEBUG_LOG_MODULES` (`debug-log.mts`).
- **`AGENTS.md`**: new “Mesh export (iso-simplicial)” subsection and **IsoSimplicialExport** in the dev-log modules sentence.
- **`iso-simplicial-handoff.md`**: short Agent 7 note.

`make build` and `make test` both succeed.

