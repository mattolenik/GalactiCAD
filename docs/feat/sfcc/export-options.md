# SFCC export options and defaults

Implementation audit: November 3, 2026. This covers the current Rust/WASM SFCC
exporter and the native kernel, including the GUI's separate mesh post-processing.
MDC, SHREC and iso-simplicial have their own unrelated tuning sets.

The supported SFCC configuration has **31 active options**. Nine old options had
no effect and have been removed from the TypeScript interface, normalization and
defaults; the three visible ineffective controls have been removed from Dev Tools.
Saved obsolete keys are ignored. The native structs retain two compatibility fields,
`blend_curvature_analytic` and `min_dihedral_deg`, whose values do not change meshing.

GUI/WASM and native **kernel defaults now agree**. Multi-sheet handling and native
decimation are explicit experimental options, both off by default. This preserves
the native baseline instead of enabling unvalidated construction to match the old
GUI. It may produce substantially more triangles on the bowl and other thin-wall
models. The existing 5/8 depths and 18-degree thresholds are practical starting
values, not proven optima for every model. These defaults do not establish complete
SFCC acceptance; the existing knob/Mess construction failures remain open.

Explicit saved settings still win. Click **SFCC defaults** to discard old overrides;
otherwise a previously saved `multiSheetCells: true` or `decimateTolMm: 0.05` remains
enabled. Do not silently overwrite an intentional user choice.

## Normal export controls

These eight numeric controls remain in Dev Tools. Lower error/angle settings
usually increase work; increasing maximum depth only helps cells that the
refinement criteria actually split.

| Option | Default | What the implementation does | Recommendation |
| --- | ---: | --- | --- |
| `depthMin` | 5 | Minimum surface-refinement level; empty-space pruning can still remove cells. | Keep. The uniform floor can be expensive; do not use it as the primary accuracy knob. |
| `depthMax` | 8 | Normal octree refinement ceiling. The lattice extends to `min(depthMax + 2, 14)` and unresolved sheet handling can use that extra resolution. This extension also exists with multi-sheet mode off. | Keep. It is not an absolute maximum level or a minimum detectable feature guarantee. |
| `boundsPaddingMm` | 2 mm | Adds padding on each side of the supplied root cube, before deterministic jitter. At fixed depths, more padding increases cell size. | Keep advanced. Native comparisons must also use the same input cube. |
| `surfaceTolMm` | 0.01 mm | Field-residual target used by projection, vertex checks, normal repair and sampled surface refinement. Some passes use the tighter of this and the chord target. | Keep as the primary surface target. It is **not a global Hausdorff-distance bound**, especially for non-distance fields and unsampled triangle interiors. |
| `curveChordTolMm` | 0.02 mm | Feature-polyline chord target and a budget used by several later mesh/feature checks. | Keep separately from surface tolerance. Setting it looser must not relax the requested surface target. Budget exhaustion is still possible. |
| `normalVariationDeg` | 18° | Sampled normal-variation threshold on analytic carriers, loft transitions and carrier-less warped surfaces. | Keep. Lower values refine curvature more; sampling does not prove a continuous normal bound. |
| `blendCurvatureDeg` | 18° | Sampled normal-variation threshold in carrier-less blend regions when blend refinement is enabled. | Keep. Blend radius alone does not bound curvature after composition. |
| `decimateTolMm` | **0 (off)** | Post-assembly edge-collapse simplification in the native kernel. Uses topology, orientation and sampled field/normal tests, with a planar shortcut and inherited-error allowance. | Keep experimental. A positive value is not a guaranteed maximum surface error; the decimator does not receive feature constraints. |

## Refinement, discovery and feature extraction

Only the balance, blend-refinement, analytic-heuristic and multi-sheet switches are
in Dev Tools; the other options are advanced API settings.

| Option | Default | Actual role | Recommendation |
| --- | ---: | --- | --- |
| `enforceEdgeBalance` | true | Adds edge-neighbor 2:1 balancing to the octree's face balancing. | Keep on. Disabling is a diagnostic/performance experiment with different transition conditions. |
| `blendCurvatureRefine` | true | Enables the blend-region sampled normal criterion. Warped carrier-less regions retain their regular normal criterion even when this is off. | Keep on. Disabling can under-refine fillets. |
| `normalVariationAnalytic` | false | Replaces sampled carrier normals with `curvatureBound * cellSize <= angle` where a carrier bound exists; otherwise falls back to sampling. | Keep experimental/off. Cell-edge length is not a proved surface-path-length bound. |
| `multiSheetCells` | **false** | Retains several approximately parallel sheets in featureless cells, samples fine edges, changes untagged face pairing and can stop ambiguous same-sign cells at a coarser floor. | Keep experimental/off. Useful for thin-wall cost, but can miss enclosed components and reports unresolved coverage. Feature-tagged cells retain the older path. |
| `tangentialEpsilon` | 0.05 | Splits feature crossings whose absolute tangent/face-normal dot product is below this threshold. | Keep advanced. Lowering it can leave poorly conditioned crossings; increasing it spends more refinement. |
| `featureQueryInflate` | 0.25 | Inflates feature-query boxes by a fraction of cell size. | Keep advanced. It affects which curves/corners participate in classification, not just speed. |
| `probeDeltaFactor` | 10 | Sets seam exposure flank-probe offset to this factor times `surfaceTolMm` (default 0.1 mm). | Keep advanced. [Executed knob lineage](../../research/sfcc-endpoint-lineage/README.md) demonstrates premature trimming from the finite probe schedule. Changing this global factor is not a correctness repair; too-small probes can also be inconclusive. |
| `minTangencyAngleDeg` | 2° | Conditioning floor for tracing pairs of nearly parallel carrier gradients. | Keep advanced. It is not a minimum visible crease angle. |
| `cornerMergeTolDiagFraction` | 1e-6 | Converts the input scene diagonal to a corner-merging radius. | Keep advanced. This is a scale-dependent identity decision, not a general vertex-weld tolerance. |
| `seedCellSizeMm` | 0 (auto) | Chooses seam-tracing seed-grid spacing; automatic spacing comes from the pair-overlap box. | Keep advanced/auto. A smaller grid costs more and still does not establish complete discovery. |
| `maxTraceSteps` | 20,000 | Bounds predictor/corrector tracing per curve. | Keep as a resource cap. Raising it does not resolve tangencies or missing source branches. |
| `recoveryCull` | true | Uses a carrier bound to skip hidden-arc recovery scans that cannot cross zero. Off runs the exhaustive scan. | Keep on; retain the off path for parity/debugging. Its correctness depends on the bound, not on sampled agreement alone. |

## Cell meshing and recovery

| Option | Default | Actual role | Recommendation |
| --- | ---: | --- | --- |
| `edgeRootTolFraction` | 0.001 | Root tolerance is `min(fraction * finestLatticeStep, surfaceTolMm * 0.1)`. | Keep advanced. The finest step now comes from up to `depthMax + 2`, not simply `depthMax`. |
| `maxPolylinePointsPerCell` | 16 | Caps local feature subdivision. Several code paths count segments (`params.len() - 1`), despite the historical “points” name. | Keep as an advanced budget. Exhaustion must remain visible; a larger cap is not a correctness fix. |
| `interiorVertexMode` | `project` | Projects an interior fan vertex onto the field when the loop needs one. `centroid` skips that projection; `fan` triangulates from a boundary vertex. Simple/feature/crease paths can bypass this selection. | Keep `project`; alternatives are diagnostics, not quality presets. |
| `projectMaxIters` | 8 | Maximum Newton projection iterations for applicable interior vertices. | Keep advanced. It does not control every curve projection or root solver. |
| `reRefineMaxRounds` | 2 | Recovery rounds that force splits after failed loops or initial feature fallbacks. | Keep. More rounds can be costly and cannot repair a missing feature-graph obligation by themselves. |
| `checkVertexLinks` | true | Checks each mesh vertex's incident fan, in addition to edge/manifold checks. | Keep on and visible. Off leaves validation explicitly incomplete. |

## Quality experiments and diagnostics

These five options remain in the API, off by default, and are not ordinary GUI
quality presets. Baseline sliver flips, blend surface refinement and feature-normal
repair still run with all quality switches off.

| Option | Default | Actual role | Recommendation |
| --- | ---: | --- | --- |
| `qualityTriangulation` | false | Enables alternative cell triangulation/patch diagonal optimization and the shared analytical refinement stage. | Retain for controlled experiments; needs full-model preservation evidence before default-on. |
| `qualityRefinement` | false | Enables analytical patch subdivision after the baseline blend refinement. That stage also runs when either other construction-quality flag is on. | Retain experimental. This is not the ordinary octree refinement switch. |
| `qualityRemeshing` | false | Enables analytical refinement followed by bounded remeshing edits. | Retain experimental; edits must preserve feature transport, geometry and embedding. |
| `qualityMaxEditTrials` | 10,000 | Work budget for remeshing trials, clamped at 100,000 by the bridge. | Keep advanced. It is not a global triangle, memory or execution-time cap. |
| `qualityAudit` | false | Requests additional triangle-quality, geometry/contact and metadata checks through the quality assembly branch. | Retain for diagnosis; potentially expensive. It is not a promise of full mesh acceptance or a universal byte-identical instrumentation switch. |

## Retired options

These options were already ineffective in the current Rust exporter. Removing
them does not disable an implemented capability.

| Old option | Why it is obsolete |
| --- | --- |
| `blendCurvatureAnalytic` | Blend refinement uses sampled normals regardless of the flag. The former blend-radius shortcut was unjustified. Native field retained for source compatibility only. |
| `minDihedralDeg` | Exposed features are no longer discarded by crease angle. Native resolved cosine is retained but does not gate exposure. |
| `faceSnapEpsFraction` | No Rust bridge field or exporter consumer. Actual face association uses kernel rules. |
| `ambiguityResolution` | No Rust bridge field. The kernel chooses its implemented face-resolution path. |
| `jitterRetries` | No Rust consumer. There is one deterministic lattice jitter; recovery rounds are controlled separately. |
| `failurePolicy` | No Rust consumer. Failed validation returns best-effort geometry plus failure information. The GUI “Throw on certification failure” checkbox was misleading. |
| `creaseAngleDeg` | No SFCC crease-split post-pass consumes it. This remains a real setting in other exporters, not SFCC. |
| `debugOutput` | No SFCC consumer. The wrapper always attaches available stats/validation/features and an empty failed-cell overlay buffer. |
| `profile` | No SFCC bridge consumer. WASM export already uses timed pipeline entry points; deeper native work counters use the separate `sfcc-profile` build feature. |

## GUI post-processing is a separate layer

The render worker applies generic post-processing **after** the SFCC exporter
returns. Old comments saying it is MDC-only or MDC/SHREC-only are inaccurate.
These settings are shared by exporters; this cleanup does not change their defaults.

| Setting | Current default | Meaning / SFCC advice |
| --- | ---: | --- |
| Simplify on export | false | Enables the separate meshoptimizer pass. Keep off for SFCC acceptance and native comparisons. It is distinct from native `decimateTolMm`. |
| `targetRatio` | 0.1 | Requests about 10% of input triangles when simplification is enabled; error/constraint limits can stop earlier. |
| `targetError` | 0.001 | Meshoptimizer approximation allowance, relative unless absolute-error mode is enabled; not an SDF validation target. |
| `lockBorder` | true | Protects mesh borders during generic simplification. It does not identify all CAD feature curves. |
| `sparse` | false | Meshoptimizer option for sparse input/index usage. Retain only for this post-pass. |
| `errorAbsolute` | false | Interprets generic simplification error in absolute units when on. |
| `prune` | false | Allows aggressive pruning in meshoptimizer; inappropriate for preserving small components without additional checks. |
| `regularize` | false | Biases generic simplification toward more regular triangle shapes. |
| `normalWeight` | 0 | Positive values add normal attributes to simplification cost; this does not enforce feature identity. |
| `renormalizeTriangles` | true | Actually creates flat face normals and splits vertices, despite old “smooth shading” comments. It changes buffers/indexing, though triangle positions stay the same. |

For raw native/WASM comparison, use the same scene, root cube and explicit SFCC
tuning, disable generic simplification, and set `renormalizeTriangles: false`.
The existing acceptance capture does this. Matching kernel defaults is not a claim
that the GUI's final post-processed buffers are byte-identical to native output.
The generic post-passes also retain the pre-pass SFCC debug object; do not assume
its feature vertex IDs or validation describe a rewritten index buffer.

The URL option `sfccPartitions=N` is execution configuration, not tuning. Default
is serial (`1`). Native serial calls and explicit worker APIs must be compared at
the same execution stage; a worker recovery/fallback is not serial parity evidence.

## Keeping defaults synchronized

The [defaults fixture](../../../gcad-wasm/kernel/fixtures/sfcc-defaults.json) is
checked independently by the TypeScript normalizer tests and Rust bridge tests.
The Rust test compares the entire active key set and values, and verifies that
both omitted JSON and explicit GUI defaults produce `PipelineTuning::default()`.
The overlapping feature defaults are reused directly by the native pipeline.
These checks add no runtime JSON loading or new dependencies.

Relevant implementation:

- [GUI tuning and normalization](../../../src/export/sfcc/sfcc-tuning.mts)
- [GUI controls](../../../src/components/dev-tools-mesh-export-section.mts)
- [Native pipeline/defaults](../../../gcad-wasm/kernel/src/sfcc/pipeline.rs)
- [WASM tuning bridge](../../../gcad-wasm/wasm/src/lib.rs)
- [Quality-stage orchestration](../../../gcad-wasm/kernel/src/sfcc/assembly.rs)
- [Multi-sheet behavior and limits](multi-sheet-cells.md)
- [Native decimator](../../../gcad-wasm/kernel/src/sfcc/decimate.rs)
- [Generic worker post-processing](../../../src/render-worker-core.mts)

Validation of this cleanup is configuration/compile validation, not a new
full-model acceptance campaign. Enabling multi-sheet or decimation by default
later requires renewed whole-model geometry, feature, coverage and worker checks.

Checks completed for this change:

- `make build`: passed, including the release WASM build and TypeScript validation.
- TypeScript defaults/migration plus acceptance capture/bridge tests: 8 passed.
- Native `gcad-wasm` `validation_tests`: 2 passed, including complete default parity.
- Native replay example: built with `serde,sfcc-profile`; four pre-geometry
  checks passed. Current defaults and legacy captures omitting the two new keys
  passed the tuning gate; explicit multi-sheet and decimation overrides were
  rejected by the defaults-only replay tool. The successful-gate controls used an
  intentionally absent cube to stop before any meshing.

`make test` includes the TypeScript contract test; `make gcad-test` includes the
native bridge contract test. Both sides must pass after changing defaults.
