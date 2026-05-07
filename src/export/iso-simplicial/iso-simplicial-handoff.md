# Iso-simplicial exporter — handoff notes

## Agent 1 (this drop)

- **Modules:** `src/export/iso-simplicial/` — `constants.mts`, `cube-tables.mts`, `tet-tables.mts`, `extract-tables.mts`, barrel `index.mts`.
- **`IsoSimplicialConstants`:** frozen defaults aligned with reference `main.cpp` / `iso_common.h` (+ `badqef` ratio from `iso_method_ours.cpp`). See JSDoc on `constants.mts` for symbol mapping.
- **Tables:** byte-for-byte parity with `cube_arrays.cpp`, `tet_arrays.cpp`, and `VisitorExtract` static `faceTable` / `flipTable`. Corner order uses reference `Index` (x + 2y + 4z).
- **Tests:** `iso-simplicial-tables_test.mts` — dimensions and spot-checks vs reference literals.

## Gaps / next agents

- Agent 2: GPU batch sampler; no wiring to these tables yet.
- Agent 3+: QEF solvers consume Hermite samples; iteration order for oversampling must match reference triple loops in `iso_method_ours.h` (x outer, y, z inner with `<= OVERSAMPLE_QEF`).
