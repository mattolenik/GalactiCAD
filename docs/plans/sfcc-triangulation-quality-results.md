# SFCC triangulation quality implementation results

Status: experimental implementation, September 7, 2026. The four operation families are implemented for a conservative set of analytical patches. This is **not completion of the full general-field/chart coverage and rollout acceptance in the plan**. All quality switches remain off by default.

## Delivered behavior

| Improvement | Implementation | Current boundary |
|---|---|---|
| Surface-aware diagonals and flips | Both quad diagonals are checked; accepted alternatives maximize worst 3D shape before sampled displacement. Global flips require common analytical ownership, protected-edge checks, orientation, exposure and nonintersection. | Unidentified patches remain locked. A valid but coarse patch retains ownership for required refinement. |
| Constrained patch triangulation | Filtered orientation/incircle predicates with an exact dyadic fallback; simple-polygon validation; ear clipping retaining collinear vertices; unconstrained-edge legalization; visible hole bridges and explicit boundary-incidence checks. Integrated into eligible loops and feature-graph/edge-side patches. | Regular plane/sphere/cylinder/cone charts and planar compound carriers. Multiple coplanar loops without unrouted pins can represent holes or disconnected domains. General implicit, twisted/lofted, curved compound and multi-loop feature-graph charts remain incomplete. |
| Error-driven insertion | Deterministic geometry-first queue, projected interior insertion, shared-edge subdivision, multiple oriented curve memberships, quality-only splits when the affected minimum shape improves, bounded rounds/vertices and explicit residual failures. | Only identified eligible carriers can receive analytical edits. The existing blend refinement remains for unsupported fallback patches. Open boundaries are immutable. |
| Global remeshing | Post-assembly short-edge collapse with link checks; protected flips; bounded tangential relaxation and projection; fixed corners, pins, feature vertices and real boundaries. Refinement supplies the splitting stage. | Three sweeps and a configurable proposal budget. General field-sheet continuation and feature-vertex relocation/collapse are not supplied. |

The kernel stays dependency-free by default. Predicate fallback uses exact signed dyadic integers, including subnormal and overflow-prone binary64 inputs; it does not copy Triangle. Charts and geometric projection remain separately validated. The planar triangulator has a 4096-vertex cap and a deterministic work allowance; failure returns no partial triangulation.

`assembly.rs` is the sole serial/worker cleanup and refinement sequence. Per-triangle analytical owners survive creation, cleanup accounting, conforming subdivision and **SFP4** worker transport. Existing point keys and feature metadata determine mobility after assembly; no redundant per-worker mobility classification is serialized. Point keys retained after relocation describe historical source provenance, not permission to merge an already-remeshed point table again.

Candidate edits validate the complete changed neighborhood before adding points or changing topology. The broad phase includes f64 and rounded f32 bounds. Appended triangles use a batched spatial index instead of scanning every prior accepted edit; collapse exclusion tests no longer clone the growing set of removed triangles. Relaxation sums neighbors in geometric/provenance order, not temporary vertex-index order. Eligible larger trees amortize a per-cell pruned query over the full coarse-candidate projection allowance and f32 rounding margin; baseline pruning retains its existing gate. Both the original random-query parity tests and an independent dominated-sphere control check this optimization.

## Options and diagnostics

The existing exporter tuning JSON accepts:

```json
{
  "qualityTriangulation": true,
  "qualityRefinement": true,
  "qualityRemeshing": true,
  "qualityMaxEditTrials": 10000
}
```

Refinement/remeshing requests also enable the cell ownership/triangulation prerequisite. Quality triangulation always performs the accuracy refinement needed by coarse candidates. `qualityMaxEditTrials` bounds optional collapse/relaxation proposals, is clamped to 100000 by the bridge, and can be zero. A work-budget advisory does not itself invalidate geometry that passes every mandatory audit.

`qualityAudit: true` with the edit switches off runs the new final checks on the unchanged baseline algorithm. `validation.quality` reports before/after triangle and sliver counts, p5 angle, edit counts, unknown ownership, rejected proposals, sampled geometry failures, contact/intersection reports, cancellation and work-budget exhaustion. Serial progress includes diagonal, refinement, remeshing and final-audit labels within assembly. Existing total feature/octree/contour/cell/assembly timing buckets remain available.

The final quality audit is independent of the historical face-consumption audit. It includes failed projections and f32 degeneration in `geometryFailures`. Contact counts include nonincident touching and overlapping triangles; they must not be described as that many independently confirmed penetrations. These checks do not prove Hausdorff distance, all sheet identities, or analytical feature discovery.

## Baseline and validation

Baseline source: `52656d1b69f2b00a76410768cca3d867b58aaa61`. The existing 60 modified animation PNGs were preserved. This implementation did not regenerate them.

Baseline source SHA-256:

| File | SHA-256 |
|---|---|
| `cell_mesh.rs` | `1df524af24a78191beb5b60c0f562675a2b5f535f06012c446f211e672c45958` |
| `sliver_flip.rs` | `6067ea82b3742f5745f45c230ed9d7a142e546cdb4aa456b40fa8fa67b2bdada` |
| `surface_refine.rs` | `e394bf3c7d1ace7005fbe63ab7df3c9c1ac97cc40a10f78d2ea627d8cc4a6a7e` |

New controls cover exact determinant cancellation, binary64 exponent extremes, equation rescaling, concavity, collinear boundary vertices, annular area and holes, reversed hole orientation, crossing constraints, f32 collapse, protected or unidentified patches, nearby-sheet intersections, conforming hard-sphere refinement, cancellation, explicit work budgets and fixed planar-grid boundaries. Worker tests use real independent WASM instances at 1/2/4/8 partitions and reversed completion order, checking the exported oriented geometry and ownership diagnostics. The native worker gate also covers the enabled quality path.

The actual housing and bracket fixtures run both in baseline mode and with `SFCC_TEST_QUALITY=1`. They retain the flange-rim, screw-hole, bore/chamfer and bracket seam checks rather than replacing them with mesh-to-old-mesh agreement.

Validation commands:

```sh
cargo test --offline --release --manifest-path gcad-wasm/Cargo.toml --workspace --no-fail-fast
make test
SFCC_TEST_QUALITY=1 node --import tsx --test gcad-wasm/fixtures/sfcc-housing_test.mts gcad-wasm/fixtures/sfcc-bracket_test.mts
node --import tsx --test gcad-wasm/fixtures/sfcc-quality_test.mts
```

The installed dependencies were used via `make ... -o setup TSX='node --import tsx'` because the sandbox cannot create the tsx CLI IPC socket; mandatory GPU tests use `REQUIRE_WEBGPU=1` with Metal access. No direct shader lint, browser navigation, visual QA or second scene evaluator was introduced. Historical optional goldens are not counted as new independent acceptance.

## Measurements and rollout decision

The pure planar sliver control goes from one `quality < 0.02` triangle to zero with one flip, no added vertices and identical boundary segments. The coarse sphere control exercises refinement as well as remeshing; its initial mesh is not already within tolerance, so its before/after counts are not a matched-error export comparison.

Real-scene investigations found material runtime growth. The baseline-only final audit also exposes pre-existing housing interior/contact reports, so enabling a new stage is not equivalent to obtaining a globally certified mesh. Passing the preserved feature fixtures is necessary but does not clear those reports or complete missing-feature discovery. No stage has earned default promotion.

The native housing comparison uses one warm-up and five measured exports per mode on macOS 26.5.1. Every repeated export in a mode had identical geometry counts and validation diagnostics. A background build coincided with one slower experimental sample; the table retains all five samples in its median.

| Native housing export | Baseline | All quality stages |
|---|---:|---:|
| Median elapsed time | 24.042 s | 107.949 s |
| Triangles | 128946 | 115502 |
| Output buffers | 3610232 bytes | 3233800 bytes |
| Final audit contact reports | Not checked | 15538 |
| Final sampled geometry failures | Not checked | 582 |

This is **10.4% fewer triangles at 4.49× runtime**, not a successful performance gate. Output-buffer size is not peak memory. The enabled export retains passed edge-incidence, vertex-link, original face-consumption and vertex-residual checks. Its compiled-curve counters remain at the baseline values: 60 missing edges, 9 missing curves, 14 disconnected curves and 40 interval gaps, with no off-curve edges or invalid memberships.

An earlier WASM audit-only investigation of the unchanged housing algorithm reported 584 sampled geometry failures and 15644 contacts. Those figures establish that the new checks expose pre-existing failures; they do not prove that every reported pair is the same across algorithms/backends or that a lower total rules out new local failures. Housing/bracket preservation tests remain independent acceptance checks.

The [machine-readable measurements](sfcc-triangulation-quality-measurements.json) retain raw native timings and validation totals. The full matched-error/matched-budget native/WASM matrix is **not completed** and no performance or memory default-promotion gate is claimed.

Final validation:

- Native workspace: **244 passed**, followed by a **134-test unit-suite pass** containing two additional independent diagonal/narrow-neck controls; no production logic changed between those checks.
- `make test` with `REQUIRE_WEBGPU=1`: **421 tests, 420 passed, 1 skipped** (the explicitly opt-in performance benchmark).
- Actual WASM workers: box, sphere and the larger dominated-sphere tree pass at **1/2/4/8 workers**, with reversed partial order and exact exported oriented geometry comparison.
- Housing and bracket: **2/2 baseline preservation tests and 2/2 enabled-quality preservation tests passed**, including the final pruned implementation.
- Independent cylindrical controls prove that a shorter diagonal or shape-improving flip can be geometrically worse; the invalid choice is rejected. A scaled/translated narrow-neck polygon keeps its expected area and domain.

Passing these controls does not override the failed real-scene quality/performance audit or complete the remaining matrix below.

## Remaining plan work

- Connected branch/sheet continuation for general implicit fields and curved compound carriers; suitable charts for twisted/lofted surfaces and periodic seams.
- Multi-loop feature graphs with embedded arcs, nonplanar holes, and folded-chart subdivision, rather than retaining a reported fallback.
- Broader independent dense forward/reverse coverage tests, including the complete narrow-neck, close-sheet, acute-junction and transformed-geometry matrix.
- General stable provenance for equivalent carrier descriptions; current edits conservatively require identical carrier IDs across an edge.
- Full matched-error/matched-budget performance and memory acceptance across all scene/configuration combinations. Linear WASM memory high-water marks are reported by the benchmark, not a claim about live allocation or GPU memory.
- Investigation of existing real-scene contact/interior-error reports and remaining compiled-curve chain gaps. Triangulation cannot invent a curve missing from feature compilation.

The benchmark entry points are `gcad-wasm/fixtures/sfcc-quality-benchmark.mts` and `gcad-wasm/kernel/examples/sfcc_quality_bench.rs`. Each defaults to one warm-up and five measured exports and accepts a mode/scene subset for investigation. The WASM runner records source/scene/module digests, options, cube, raw timings, output size, linear-memory high-water mark, triangle/sliver/angle metrics and validation. Native runs consume the same serialized bridge tree and report existing phase timing buckets.
