# SFCC bracket edge audit

> **Historical audit and implementation checkpoints:** the findings below refer to their stated baselines. See the [current algorithm explanation](../sfcc-meshing-algorithm.md) and [September 7 audit results](sfcc-analytical-feature-completeness-results.md) for subsequent fixes and remaining limitations. The later continuity check invalidated the old scan’s remaining transition as a local crease; normal-transition counts are not independently confirmed crease counts.

Date: 2026-09-06. Implementation baseline: `17783042`.

Scene: `docs/manim/scenes/torture_bracket.yaml`, SHA-256
`9da4b9d3dba0643f97e968aa1b83a001d91dfeabe79bd2eec1403e38d743f044`.

## Conclusion

Two reproduced failures share a cause: generated blend carriers contain piecewise operand fields, but feature generation and tracing do not represent all of their internal branch boundaries. Exact scalar evaluation fixed earlier field-value errors; it did not make these carriers smooth or enumerate their creases.

1. The extrusion cap/side field switch becomes an exposed sharp edge inside the chamfer. SFCC does not generate this edge.
2. A seam intersecting a piecewise blend carrier stops at a sharp turn, even though a valid exposed continuation exists. The tracer treats the turn as a correction failure instead of a junction between branches.

The mesh also misses portions of existing native rib curves. That is a separately measured failure requiring cell-level tracing; this audit does not establish that repairing candidate generation alone resolves it.

The initial audit made no production algorithm changes or PNG updates; the implementation checkpoint below records the subsequent fix. Measurements use the existing native kernel and the actual application's serialized scene, without visual inspection or a new CPU SDF implementation. GPU parity and user visual QA remain necessary when implementing fixes.

## Method and baseline

The scene was instantiated with `SceneInfo` and exported through `serializeSceneToBridgeJson`, then loaded with `build_csg_tree_from_json`. Both nested unions actually serialize as chamfer radius 1.2: the outer chamfer propagates to the child union, replacing its source-level round setting.

Feature checks use `compile_feature_set` with default tolerances and scene diagonal 90. Mesh checks use `run_sfcc_pipeline`, default `PipelineTuning`, and input cube minimum `[-26.4, -21.1, -26.4]`, size 52.8. This explicitly specified native diagnostic cube is not a claim of byte-identical browser export bounds.

The feature graph contains 79 curves and 72 corners. Trace diagnostics report 292 correction bails, with no tangency bails or step-cap hits. Hidden supporting extensions contribute to these counters; 292 is not a count of visible defects.

The mesh contains 38,984 vertices and 77,988 triangles. Edge incidence, vertex links, face segments and vertex residual checks pass. Its overall validation remains incomplete: 22,570 unresolved cells and one curve-projection failure are reported. Feature fallback count is zero.

The exposed native plate edges and rib-edge samples are represented in the feature graph to numerical precision. Sampling both sides of all six hole boundaries, 360 angular positions per side, found no feature gap above 0.02 mm; the worst observed gap was below 1e-7 mm. This checks candidate coverage at these samples, not full mesh fidelity.

## 1. Missing cap/side switch creases inside blends

Relevant implementation:

- `gcad-wasm/kernel/src/primitives/shapes.rs::extrude_dist`: `max(polygon_distance, abs(y) - h)`, with twist angle clamped at the caps.
- `gcad-wasm/kernel/src/sfcc/field_branches.rs::sample_leaf`: preserves that piecewise field and its derivatives.
- `gcad-wasm/kernel/src/sfcc/blend_surfaces.rs::append_chamfer_carriers`: creates a combined carrier from complete operand fields.
- `gcad-wasm/kernel/src/sfcc/seam_trace.rs::trace_chamfer_seams`: intersects generated carriers with other carriers, but does not enumerate internal field-switch constraints.

The extrusion's cap and side fields can be equal at a **positive** distance from the original primitive. When a chamfer puts that location on the final zero surface, the derivative changes sharply across their equality boundary. Intersecting the original cap and side zero surfaces cannot find this displaced edge.

For the actual bracket, solve the cap/side equality and the chamfer zero equation together. Check root residual and compare normalized raw derivatives on opposite sides, using an x displacement of 1e-5 mm. Representative results:

| Point (mm) | Normal jump | Nearest compiled curve | Nearest mesh edge |
| --- | ---: | ---: | ---: |
| `(12.345640, 5, 6.845640)` | 45.00° | 1.2903 mm | 0.0563 mm |
| `(-12.204348, 5, 6.992667)` | 49.93° | 1.6947 mm | 0.0312 mm |
| `(-12.880146, 6, 6.258267)` | 53.25° | 0.5563 mm | 0.0357 mm |
| `(12.8, 8, -6.349803)` | 57.97° | 0.6180 mm | 0.0457 mm |

Root residuals are below 1e-7 mm at these points. These are real creases, substantially above both crease-angle gates, rather than ordinary smooth-surface tessellation.

### Minimal reproducer

Construct an untwisted square extrusion with profile `[-2,-2], [2,-2], [2,2], [-2,2]`, half-height 2. Make a native `CsgNode::Blend` with two copies of it, `Smin`, `Chamfer`, radius 0.8.

For equal operand values `d`, the displaced zero surface is `d = 0.4`. Thus `(2.4, 2.4, 0)` lies on its sharp cap/side rim. The current compiler emits **zero curves** for this solid. Its field residual at that point is approximately -1.57e-16.

This small case isolates the omission without twisting, holes, triple junctions, seeding complexity, or cell triangulation. Existing duplicate-operand blend tests check a later hard cut; they do not check the generated surface's own internal creases.

## 2. Tracing stops at a nonsmooth operand transition

`seam_trace.rs::trace_direction` rejects a corrected candidate when its tangent turns more than 0.35 radians (20.05°). It halves the step, with a lower step limit and ten attempts. A finite tangent discontinuity does not disappear under step reduction.

In the bracket, compiled curve 73 (strata `[41,14]`, generated outer chamfer / rib side) ends at approximately:

`(9.627958084, 4.697003201, 6.798101519)`.

Starting from that endpoint, offset along the carrier-pair tangent and project back to the same two carriers:

| Predictor offset | Projected point | Tangent turn from endpoint |
| --- | --- | ---: |
| -0.001 mm | `(9.627059094, 4.696584802, 6.798230975)` | 0.0043° |
| +0.001 mm | `(9.628387409, 4.697634936, 6.798194897)` | 40.0839° |
| +0.010 mm | `(9.631632964, 4.703601671, 6.799326259)` | 40.1023° |

Both carrier domains accept all three points. Root residual magnitudes are below 5.3e-8 mm. This demonstrates a valid continuation beyond the endpoint and a turn exceeding the tracer's acceptance limit.

The correct response is to locate the branch transition, create its junction, and continue on the next branch. Raising the turn threshold alone could bridge unrelated components and would leave the missing boundary from finding 1 unresolved.

Distance-only seed consumption and midpoint duplicate rejection in `trace_carrier_pair` are additional risks when tracing stops partway through a component. Their contribution to this particular missing continuation has not been isolated.

## 3. Existing curves are not always preserved by the mesh

Sampling 33 positions per compiled curve and measuring distance to every exported triangle edge gives:

| Curve / adjacent strata | Worst sampled edge gap | Location |
| --- | ---: | --- |
| 15 / `[12,13]` | 0.0577 mm | `(-8.159497, 4.2, 6.815424)` |
| 16 / `[13,14]` | 0.0832 mm | `(9.437513, 4.682120, 6.854849)` |
| 73 / `[41,14]` | 0.0239 mm | `(9.480749, 4.627410, 6.819174)` |

Sampled points on these compiled curves pass the root-field and adjacent-domain checks. Increasing candidate coverage is therefore insufficient as a complete acceptance test.

Inspect `cell_mesh.rs` graph/fan selection and `refine_criteria.rs::feature_cell_classify` during implementation. In particular, the graph route can fail and fall through to a single-corner fan; that fan only protects incident corner-to-pin edges. These are audit targets, not yet an isolated explanation for the measured gaps. A zero fallback counter is not proof that every curve segment is represented.

## 4. Validation misses triangle-interior fidelity

451 triangle centroids have absolute native field residual above 0.02 mm. The worst is 0.0611 mm near `(-13.200682, 5.111478, 5.966127)`. All exported vertices pass, with maximum residual 0.00250 mm.

These are sampled **field residuals**, not certified Euclidean distances or Hausdorff bounds. Nevertheless they expose triangles bridging geometry that vertex-only checks cannot detect. `validation.rs::check_vertices` correctly documents this limitation; regression coverage must account for it.

## Fix and regression order

1. Add the minimal displaced-extrusion-rim regression, plus full-bracket reference points for both rib cap/side switches. Require expected crease components and connectivity as well as point-to-curve distance.
2. Represent operand branch boundaries explicitly. Trace the final surface equation together with the branch-equality equation, validating both adjacent active branches through ancestors. Start with extrusion cap/side and twist-clamp transitions; audit nested hard-CSG branch changes, loft clamps and nearest-pair changes under the same contract. Do not classify an equality as a crease without checking exposure and one-sided derivatives.
3. Split tracing at branch transitions and resume each valid continuation. Deduplicate by branch/component continuity; report unresolved exposed continuations separately from harmless supporting extensions. Add the measured 40° turn as a regression, including changes to seed spacing and equivalent transforms.
4. Trace the existing-curve-to-mesh failures through cell classification and assembly. Require every exposed in-cell feature arc to be consumed by the final triangles or explicitly reported unresolved, including when a graph attempt falls through to a corner fan. Preserve the housing regressions.
5. Add bracket triangle-interior and seam-to-mesh checks, then run native and application suites, serial/worker checks, and GPU scalar parity. Regenerate the animation PNGs after fixes for manual visual QA.

## Local diagnostic artifacts

The audit harness and output are outside the repository:

- `/tmp/sfcc-doc-review/bracket_dump.mts`: scene serializer; run from the repository with `node --import tsx /tmp/sfcc-doc-review/bracket_dump.mts`.
- `/tmp/sfcc-doc-review/bracket.json`: actual serialized scene.
- `/tmp/sfcc-doc-review/bracket-audit/src/main.rs`: native measurements and minimal reproducer.
- `/tmp/sfcc-doc-review/bracket-audit.log`: recorded results.

Run the native diagnostic with `cargo run --offline --release --manifest-path /tmp/sfcc-doc-review/bracket-audit/Cargo.toml`. These scratch artifacts are session-local; the scene, formulas, coordinates, settings and expected failures above record the durable reproduction specification.

## Implementation checkpoint

Implemented after the audit:

- Explicit lifted branch pairs for extrusion cap/side and twist regions, loft cap/side and height regions, nested hard/chamfer operations, and multi-operand nearest-pair selection. Domains validate the selected branch at every intervening combiner. Enclosing chamfers retain their affine supporting extension so constraints stay independent at attachment endpoints.
- Bounded continuation across exposed tangent jumps, with a forward-progress guard, explicit shared junction endpoints, and preservation of adaptive source knots during trimming. Hidden extensions retain the original rejection behavior; the 27-case blend coverage regression runs in roughly 0.65 seconds in the native test run.
- Raw derivative agreement in trim flank tests, and singularity rejection before accepting a zero-residual pair projection.
- Cell graph faces choose geometrically agreeing carriers even when native and lifted patches have different IDs. An incomplete graph or unconsumed incident arc is explicitly reported even if a later corner fan produces a disk.
- Conforming post-assembly refinement for sampled blend-surface errors. Protected edges follow the modeled curve. Iterations and added geometry are bounded, and remaining failures enter the chord-budget diagnostics. Serial and worker assembly use the same function.

The actual serialized bracket probe now has no sampled compiled-curve-to-mesh gap above 0.02 mm (33 samples per curve), and no triangle centroid residual above 0.02 mm. Representative displaced cap/side mesh gaps are approximately 0.00001–0.003 mm. The native bracket regression additionally checks all triangle centroids and edge midpoints against the 0.02 mm limit. Its source tree includes the normal leaf-index/stratum preparation, and the WASM test independently consumes the animation YAML through the application serializer.

Regression coverage includes a minimal displaced rim, Smin/Smax with rotation/translation/scale, nearest-pair operand reversal, the complete bracket, the previous primitive/blend matrix, both housing flange faces, and the existing serial/worker equivalence suite. This establishes the tested fidelity, not universal feature completeness. Fixed seed discovery, arbitrary polygon medial-axis branches, and periodic stairs/columns branch enumeration remain broader audit work. The bracket can still report incomplete validation due to bounded cell and numerical diagnostics; the implementation does not hide those counters.

Final validation: 195 native workspace tests and 354 application/WASM tests passed. `make -C docs/manim pngs` completed all 30 render requests and regenerated all 60 full/cropped PNG assets successfully. Image decoding was checked by the target; visual QA remains manual.

## Follow-up: remaining noise and incomplete curve coverage

The implementation checkpoint is **not a complete fix**. A subsequent independent surface scan finds exposed derivative discontinuities absent from the compiled feature graph. Sampling already-generated curves cannot detect these omissions, and triangle field-residual refinement cannot replace missing crease topology.

Using the actual serialized bracket, scan both outer z surfaces at y = -2.9 + 0.15j (110 rows), x = -24 + 0.05i (961 columns). Locate each outer surface with the existing native field and bisect sharp changes in its analytical gradient. Reject apparent jumps that disappear under refinement or reflect a discontinuous surface location. This is a sampled diagnostic, not a completeness certificate. It found 884 sharp-transition samples, of which 19 were farther than 0.002 mm from any compiled curve.

Two representative failures:

| Point (mm) | Final normal jump | Nearest compiled curve | Origin |
| --- | ---: | ---: | --- |
| `(4.894351433, 3.7, -2.368354250)` | 36.08° | 0.65942 mm | Plate/right-boss chamfer attachment, displaced by the outer rib chamfer |
| `(-12, 5.8, 6.444199773)` | 27.17° | 0.64542 mm | Rib twist changes from linear angle to its clamped end angle |

Root residuals at these points are below 2e-11 mm. Walking every ancestor confirms the same discontinuity survives the outer chamfer, dome intersection, six cylindrical subtractions, and spherical subtraction. At the first point the inner body field is 0.7 mm and rib field is 0.5 mm; the inner body changes from the plate branch to the plate/boss affine chamfer branch. At the second point the rib field is 0.755800227 mm; its own normal jumps about 40.06° at the twist clamp.

Both candidate constraint pairs are already present and domain-valid: strata 42/46 and 52/53 in this compilation. Tracing each pair in a 0.4 mm box centered on its reference point produces a live arc without correction, tangency, or step-cap failures. Thus these concrete omissions are failures of full-scene curve discovery/tracing or subsequent trimming, rather than missing scalar formulas or suppression by the later cutters. Candidate enumeration alone is insufficient.

A further pre-trim control traces the same pairs over their enclosing blend bounds, `[-24.4,-5.4,-16.4]` to `[24.4,19.4,16.4]`. It fails to recover the local portions: the nearest domain-valid trace samples are 5.86 mm and 13.07 mm away, respectively, with 10 and 40 correction bails. The local controls have samples within 0.018 mm and no bails. This reproduces the loss before trimming and narrows the immediate fault to global discovery/tracing. It does not yet distinguish failed seed capture, premature termination, and erroneous component deduplication.

The wider representation audit also remains open: `ExtrudePart(0)` contains the complete piecewise polygon distance, and enclosing chamfer overrides dynamically select the nearest other operand. Neither is a general decomposition into smooth patches. Those are structural limitations; this scan does not establish that polygon medial branches cause the two measured failures above.

### Revised next steps

1. Add independent expected-crease regressions for the two reference points and their surrounding arcs, at intermediate operation stages and in the final bracket. Require coverage and connectivity, not merely proximity to arbitrary mesh edges.
2. Instrument these pairs before and after trimming. Repair the first stage that drops their live components. Audit the scene-wide seed spacing, distance-only seed deduplication and component consumption; local tracing success is the control case. Check stability under changed bounds, seed spacing and equivalent transforms.
3. Preserve branch identity and all incident arcs through junction wiring and cell assembly. Replace geometric carrier guessing with verified adjacent-patch membership where identities differ.
4. Audit exported normals separately: cell assembly still calls `CsgNode::grad`, whose blend path combines already-normalized child gradients, while feature tracing uses raw composed derivatives. Do not assume a low scalar residual proves normal fidelity.
5. Re-run the independent seam scan, existing housing/bracket regressions, and serial/worker checks before regenerating PNGs. Retain bounded triangle refinement only as a curvature approximation step; it is not an acceptance criterion for analytical-feature completeness.

Session-local diagnostics: `/tmp/sfcc-doc-review/bracket-audit/src/bin/{scan,probe,local}.rs`, with scan and branch-walk output in `/tmp/sfcc-doc-review/bracket-{scan,probe}.log`. This follow-up changes the audit document only; production code and PNGs remain at the preceding implementation checkpoint.

## Follow-up implementation

The full-scene omission was reproduced before trimming. Scene-scale seed deduplication and sample-radius consumption removed distinct continuations; midpoint-only duplicate rejection could then discard a partially new arc. The replacement keeps numerically distinct seeds, uses finite-segment proximity only as a broad phase, checks local carrier orientation, and projects the existing locus onto a normal plane through the seed to establish agreement at numerical precision. Endpoints do not consume untraced extensions. An arc is discarded only when all its samples are covered.

Recovering those components exposed downstream inconsistencies, now addressed in the same change:

- The band excluding native zero-surface ownership from displaced branches is fixed during compilation. Relaxing positional tolerance no longer makes an accepted branch disappear during cell meshing.
- Closest-point parameter refinement now backtracks and has enough iterations to converge; inaccurate parameter projections previously prevented overlapping traces from splitting at the same corners.
- Numerical trace endpoints receive bounded triple refinement. When a composite carrier becomes redundant with a selected branch exactly at the junction, the refiner tries an independent basis of explicit incident branches and verifies the original curve equations and domains at the result. Singular triples remain rejected.
- Interior corner insertion validates the analytical carriers within the trace's chord envelope. It does not require the approximate parameterization to hit a branch kink to corner-merging precision. Oppositely oriented neighboring sheets remain separate.
- Endpoint snapping requires carrier agreement and updates traced geometry as well as the corner record. Split duplicate arcs are removed using carrier identities, shared endpoint identities, and mutual interior coverage; corner incidence is rebuilt afterward.
- Cells with multiple corners, degenerate cells with multiple pinned curves, and single corners incident to curved arcs attempt the complete local graph. Ordinary straight-corner cells retain the exact corner fan, preserving the housing's square flange rim. Traced in-cell arcs preserve adaptive source knots and check quarter points as well as midpoints, with an internal chord-error margin and the existing point budget.
- Face-duplicate repair breaks equal segment-index ties by face coordinates before allocating midpoint IDs. Hash-map iteration order no longer changes graph embedding between serial and worker assembly.
- Spatial-index curve candidates are sorted before carrier recovery and face tagging. Equal-residual carrier ownership previously depended on hash iteration order, producing inconsistent fallback counts even between repeated serial runs.
- Final surface refinement splits all edges of a failing triangle and chooses the shorter diagonal when a neighboring triangle has two split edges. This prevents repeated reconnection to a distant vertex. The original eight-round and added-geometry bounds remain; merely raising the round cap did not resolve the reproduced failure and was not retained.

New regressions derive expected arcs independently from the plate/boss attachment equation and the transformed twist-clamp plane, then check coverage and connectivity at the outer chamfer, dome, drilled body, and final subtraction with two seed spacings. They also check one shared analytical triple junction, monotonic domain acceptance, and concentric components separated by both 0.1 mm and 0.01 mm. The full bracket mesh checks all generated curves, triangle centroids and edge midpoints, topology, and worker/serial equivalence. The WASM fixture includes both newly reproduced reference points from the animation scene.

The diagnostic checkpoint before narrowing graph selection passed edge incidence, vertex links, face segments and vertex residual checks, with zero sampled chord-budget failures and maximum vertex residual approximately 0.002499 mm. It still reported bounded-algorithm limitations (unresolved cells, feature fallbacks and curve-projection failures). These remain visible; this change does not certify universal feature completeness or continuous embedding. The separate rendering-normal API audit and arbitrary polygon/periodic branch enumeration remain outside the corrected discovery-and-wiring failures.

Follow-up validation: all 198 native workspace tests and all 354 application/WASM tests pass. This includes exact bracket worker/serial geometry, normals and validation equivalence, the animation YAML fixture, and the existing housing square-rim test at its unchanged 0.00001 mm threshold. The independent sharp-transition scan recovers 18 of the 19 previously missing samples; the remaining feature gap is approximately 0.003724 mm, below the 0.02 mm mesh tolerance but above that diagnostic's stricter 0.002 mm threshold.

PNG generation exposed the headless bridge's two-minute render deadline on `torture_mess1`. The bridge now allows nine minutes, bounded below agentcli's ten-minute HTTP deadline; `make build` passes with this change. This accommodates the detailed export without lowering scene resolution or skipping features.

Generation also reproduced a separate scene race: welcome thumbnails rebuilt the shared worker during agent capture, producing an unrelated solid render and an unsupported `threaded_rod` error for a testcase containing no threaded rod. Agent capture now stops thumbnail loading and waits for in-flight thumbnail tasks before starting. Both sample and recent-document thumbnail loops honor cancellation before issuing another build. The shell PNG target retries bridge startup for a bounded interval. All 354 application tests pass after these changes.

Final image validation: `make -C docs/manim pngs` completed all 30 render requests and regenerated all 60 full/cropped PNGs from the final code with thumbnail loading stopped. The target decoded every image before replacing the asset set. Visual QA remains manual.
