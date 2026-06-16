# OpenSCAD import fixtures + geometry oracle

Fixtures for the OpenSCAD → gcad importer (`src/import/openscad/`). Two layers of testing,
per the implementation plan §8:

## 1. Deterministic conversion tests (run today)

`src/import/openscad/convert_test.mts` asserts on the emitted gcad DSL text — fast, no
rendering, no devserver. Run:

```
node_modules/.bin/tsx --test src/import/openscad/convert_test.mts
```

(or `make test` for the whole suite).

## 2. Geometry image oracle (the convention check — wiring TBD)

The `.scad` files here are inputs for the image oracle: render each in real OpenSCAD, render
the converted `.gcad`, and image-compare. This is how we confirm the two **provisional**
conventions before building on them:

- the **Z-up → Y-up** root transform sign (`emit.mts` `Z_UP_TO_Y_UP`, plan §5.1) — `up-axis.scad`
- the **rotate Euler** order/sign (plan §5) — `rotate-cube.scad`

Intended flow (not yet automated — needs the offline openscad-wasm render step wired):

```
# reference: render the .scad in OpenSCAD (offline, openscad-wasm) → reference PNG
# candidate: convertOpenScadToGcad(fixture) → .gcad → scripts/agentcli render → candidate PNG
scripts/agentcli compare reference.png candidate.png   # assert SSIM ≥ ~0.98
```

Until that is wired, eyeball the converted DSL by opening the import in gcad, or use the unit
tests above. `up-axis.scad` and `rotate-cube.scad` are the two to look at first: if the cap of
`up-axis` lands on +Y and the bar of `rotate-cube` points the same way as the OpenSCAD render,
the conventions in `emit.mts` are correct; otherwise flip `Z_UP_TO_Y_UP` / the rotate mapping.

## Fixtures

| File | Exercises |
|---|---|
| `cube.scad` | corner-origin box → half-size shift |
| `up-axis.scad` | **Z-up→Y-up** root transform (asymmetric, capped top) |
| `rotate-cube.scad` | **rotate** Euler convention |
| `csg.scad` | union / difference / intersection / cylinder / `for` |
