# SDF meshing acceptance suite

Status: implementation plan, October 22, 2026. No acceptance run or image capture
has been performed for this plan. Repository inspected at `70f6862`.

## Objective and completion criterion

Create a repeatable acceptance suite for actual complex CAD models, starting
with **all five torture scenes used by the Manim animation**. SFCC is the first
required exporter. The result of every run is a self-contained Markdown report
with images, triangle counts, export times, geometric measurements, validation
failures, and comparisons with a pinned earlier run.

Success means the report makes missing surfaces, damaged seams, transform
problems, excessive tessellation, and unacceptable runtime apparent. A passing
primitive suite, a watertight mesh, or a high image-similarity score alone is
insufficient. Keep the complete original models as acceptance cases even when
smaller reproductions are added for diagnosis.

Deliver the first useful five-model report before expanding the matrix or
changing meshing algorithms. This work builds measurement and acceptance
infrastructure; it does not silently repair meshes or change SFCC defaults.

## 1. Initial corpus: the animation torture models

Use the existing YAML files as the source of truth. Preserve their source,
operator ordering, transforms, saved camera, and `simplifyOnExport: false`.
Store a hash and exact snapshot for each run instead of maintaining another
hand-copied scene definition. Existing animation PNGs are historical illustrations,
not fresh results or correctness baselines.

| Case | Source | What it exercises | Required detail views and assertions |
| --- | --- | --- | --- |
| Torture bracket | [torture_bracket.yaml](../manim/scenes/torture_bracket.yaml) | Rounded plate/boss union, rotated 200° twisted extrusion, nested chamfer, spherical clipping, multiple bores and dents | Twisted rib junctions, boss rims, bore openings, thin connections; retain existing independent seam-point checks |
| Torture housing | [torture_housing.yaml](../manim/scenes/torture_housing.yaml) | Rotated cylinders, rounded tee, square-to-ring loft flange, cone port, chamfer, hollowing, transformed cutters, base clipping | Tee transitions, flange perimeter, screw-hole boundaries, bore/chamfer junction, internal passages; retain existing boundary and triangle-interior checks |
| Torture knob | [torture_knob.yaml](../manim/scenes/torture_knob.yaml) | Lathed profile, 220° twisted fins, smooth unions, cylindrical trimming, lathed groove, socket cutter, rounded crown intersection | Fin roots/tips, groove, lathe profile transitions, and socket region; establish which intended features actually survive the full expression before assigning topology expectations |
| Torture mess 1 | [torture_mess1.yaml](../manim/scenes/torture_mess1.yaml) | Arbitrary rotations/translations, lathe cutter, 270° twisted star, deeply nested hard/rounded/chamfered CSG, stairs and columns | Periodic transitions, cut boundaries, narrow connections, twisted surfaces, and suspected missing pieces; explicitly classify field discontinuities or unsupported operator semantics |
| Torture mess 2 | [torture_mess2.yaml](../manim/scenes/torture_mess2.yaml) | Transformed mixed primitives, lathe vase, stairs, nested subtraction, cone spike, spherical trim, 400° twisted ribbon | Vase/core join, ribbon folds and attachment, spike junction, stair cuts, thin gaps, and interior voids |

Names/comments are not geometry oracles: do not assume an intended hole or
attachment exists without checking the full field. Do not replace stairs,
columns, twists, or lofts with easier operators to make the suite pass.

Add real user failure scenes as permanent cases as they become available.
Small analytic controls remain useful for testing the harness and identifying
faults, but do not count as completion of this acceptance corpus.

## 2. Existing infrastructure and required changes

Reuse these paths rather than introducing a separate scene interpreter:

| Existing component | Reuse | Gap to close |
| --- | --- | --- |
| [Manim PNG target](../manim/Makefile) and [agentcli](../../scripts/agentcli) | YAML loading, SDF/mesh capture, solid/wireframe modes, serial access to the agent browser | Animation asset generation does not produce a mesh acceptance record; do not overwrite animation assets during test runs |
| [Agent render pipeline](../../src/agent-autotest/agent-render-pipeline.mts) | Production scene build and rendering | Currently returns PNG only; add a structured capture result tied to the export |
| [Mesh capture](../../src/agent-autotest/agent-mesh-capture.mts) | Render a supplied `MeshData` from multiple views | Retain the captured mesh so new views/overlays do not repeat meshing |
| [SFCC exporter](../../src/export/sfcc-rs/sfcc-rs-exporter.mts) | Actual WASM exporter, worker mode, timing boundaries and validation data | Preserve raw `ok`, unrounded timing, actual worker count and recovery information in structured results; do not scrape console logs |
| [Mesh metadata](../../src/export/export.mts) | Counts, feature intervals and existing SFCC validation | Distinguish unavailable metadata from zero; an empty failed-cell overlay buffer is not evidence of zero failed cells |
| [Housing](../../gcad-wasm/fixtures/sfcc-housing_test.mts) and [bracket](../../gcad-wasm/fixtures/sfcc-bracket_test.mts) tests | Existing independent geometric assertions | They check selected properties and do not require complete overall acceptance; reuse their assertions in the report without overstating their scope |
| [Quality benchmark](../../gcad-wasm/fixtures/sfcc-quality-benchmark.mts) | Raw samples, input/artifact hashes, phase information, output size and triangle-quality measurements | Its direct Node/WASM timings are a separate backend from browser end-to-end export; add all five models without conflating results |

The torture YAMLs name `sfcc`; the current exporter registry names `sfcc-rs`
and has a fallback. Resolve this explicitly in the suite, record requested and
actual exporter IDs, and reject unexpected fallback. Record **effective normalized
tuning**, not just the sparse YAML overrides. Snapshot the actual export cube,
padding and bounds; verify that the object is not clipped by the test domain.

Capture one mesh artifact per measured export, identified by a digest of its
vertex/index buffers and feature data. Counts, geometric audits, solid images,
wireframes and detail views must refer to that same artifact. Treat mesh
serialization/readback, rendering and audits as separately timed work. Preserve
the existing PNG interface while adding the minimum structured result/mesh
reuse support needed by the suite.

## 3. Configuration and coverage matrix

Start with five canonical models under resolved production-default SFCC settings,
with simplification disabled. Explicitly record all optional quality switches.
Do not increase depth, relax tolerance, or enable repair in a failing baseline.

| Lane | Cases and configurations | Purpose |
| --- | --- | --- |
| Core acceptance | All five original models; production SFCC; saved hero view, reverse view, two fixed detail views per model | Main report and correctness gate |
| Candidate comparison | The same five models under one named proposed configuration/change | Compare measured error, triangles, failures and runtime with the pinned baseline |
| Transform sensitivity | Full torture models with deterministic non-axis rotations, translations relative to the grid, and moderate uniform co-scaling | Reveal coordinate-space mistakes, lost features and lattice sensitivity without removing complexity |
| Resolution/tolerance | Small explicitly listed coarse/default/fine sweep, one setting changed at a time | Show convergence and error/triangle/time tradeoffs; a finer success does not erase default failure |
| Worker/cleanup | Serial and 2/4/8 workers, reversed completion order; audit-only and named quality/simplification modes | Expose merge, recovery, cleanup and metadata regressions |
| Cross-exporter | Other installed exporters on the same corpus, domain and views | Compare practical output; another exporter's mesh is not ground truth |
| Diagnosis | Reduced regions derived from a failing full model | Locate the first broken stage; link each reduction to its original acceptance row |

Use a bounded, explicit list and pairwise coverage for extended lanes, not the
Cartesian product of every option. Establish a fixed smoke subset from measured
costs; do not silently drop expensive failing models from full acceptance.

For rigid-transform variants, compare inverse-transformed output geometry and
required features within declared tolerances. Do not demand identical triangle
indices/counts: a world-aligned octree changes its sampling under rotation.
For scale variants, co-scale dimensional tolerances and domain padding and record
the ratio; do not assume arbitrary nonuniform transforms preserve signed-distance
semantics. Keep smooth-CSG operand order fixed unless testing an explicitly
defined ordering contract.

Test field/transform consistency separately from reconstruction quality using
the existing evaluators. Additional reference field evaluation stays on the
GPU. No new CPU implementation of the scene SDF is introduced.

## 4. Images: useful evidence rather than a single attractive view

For every core case/configuration, collect:

1. SDF reference, solid mesh, and wireframe mesh for the saved hero camera.
2. The same views from the reverse side and two model-specific detail cameras.
3. SDF-versus-solid-mesh difference images, with SSIM **and** differing-pixel
   count/percentage. Wireframe images are for inspection, not similarity scoring.
4. In the extended lane, the six principal directions and fixed cross-sections
   through holes, cavities and close sheets; surface views alone hide interiors.

Use identical camera/projection, crop, framing, resolution, background and
shading convention for each SDF/mesh comparison. Record actual PNG dimensions:
the current agent pipeline doubles requested dimensions and mesh capture clamps
them. The saved 1200×1000 viewport must not be assumed to mean a 1200×1000 PNG.
Assert equal output sizes and camera signatures before comparing.

Keep full-frame images for metrics. Do not independently trim/auto-fit images;
that can conceal missing geometry or displacement. Make matching thumbnails
only after measurement and link them to full-resolution originals. Compute
both full-frame and fixed foreground/feature-region metrics so black background
does not dominate the score. Store masks and crop rectangles.

Use `scripts/agentcli compare --json` for existing image comparisons. Its nonzero
verdict is different from a tool failure. `triangle` is a useful quick diagnostic,
but its current repeated export/SSIM-only workflow is not the report's complete
measurement path. Add mask/depth channels only where required by the later
geometry checks; do not assume the current PNG endpoint already provides them.

Images are generated from the actual application and mesh, never synthesized.
Automate collection; keep visual acceptance and image annotation human-reviewed.
This planning task does not launch a browser or perform visual QA.

## 5. Measurements and acceptance rules

### Geometry, features and SFCC status

| Measurement | Report and acceptance interpretation |
| --- | --- |
| Mesh validity | Vertex/triangle counts, nonfinite values, invalid indices, zero-area triangles, duplicate faces, winding errors; malformed output fails |
| Topology | Boundary/nonmanifold edges, nonmanifold vertices, connected components, per-component Euler characteristic; use explicit per-case expectations, not “every object has one component” |
| Mesh-to-surface error | Sample vertices, edges and triangle interiors, with deterministic area-weighted and feature-region sampling; report maximum, p95/p99, sample count and locations exceeding tolerance |
| Surface-to-mesh coverage | Generate independent GPU surface witnesses and measure distance to the saved mesh using geometric queries; include occluded/internal regions so a missing component cannot pass a one-sided residual test |
| Feature preservation | Required region/curve-to-mesh distance, connectedness, endpoint/junction preservation and gaps; retain housing/bracket assertions and add independent full-expression witnesses for the other scenes |
| Intersections | Nonincident triangle intersection candidates, narrow-phase classifications and unresolved cases; distinguish touching, coplanar overlap and penetration instead of claiming each broad-phase pair is a defect |
| Triangle quality | Minimum/p5 angle, sliver count and declared formula, area/edge-length distribution; fewer triangles is an improvement only at comparable geometry and feature error |
| Size | Vertex/index/feature buffer bytes and artifact size; peak WASM memory only if actually measured, never inferred from output size |
| SFCC diagnostics | Raw `ok`, validation status, unresolved/failed/degenerate cells, fallback/recovery counts, branch paths, feature-chain gaps/missing curves, projection/chord failures, invalid triangles and coverage scope |
| Visual fidelity | SSIM, pixel differences, silhouette/feature-region defects and review notes per view; use the worst affected view as well as aggregate summaries |

Use the existing full scene's GPU field as a practical reference, with independent
analytic checks where already available. It is not an infallible oracle:
ray-marching, field/normal evaluation and operator discontinuities can be wrong.
Record missed/ambiguous reference roots and field-versus-mesh disagreements;
classify them separately instead of blaming triangulation automatically.

For blends and transformed fields, `abs(f(p))` need not be Euclidean distance.
Label it **field residual**. Obtain geometric distances from validated surface
witnesses/brackets and mesh queries; a Newton correction or gradient normalization
alone is not a distance certificate. GPU reference sampling must record spacing,
budgets, root ambiguity and convergence checks. Finite sampling gives empirical
coverage, not a global Hausdorff proof. Unresolved reference regions remain visible.

Lock geometric thresholds to each case's declared surface/feature tolerance,
with a separately stated reference/numerical allowance. Calibrate image thresholds
with reviewed good outputs and deliberately corrupted outputs. Do not adopt
“98% SSIM means correct” as an acceptance rule. Until a required metric's
threshold/reference is established, label that obligation `NOT_ESTABLISHED`.

SFCC's `outsideScope` coverage classification does not itself fail a complex
scene: the narrow analytic certificates are not the acceptance suite. Conversely,
`ok=true` and passed compiled-feature checks cannot waive independently detected
missing surfaces or features that were never compiled.

### Verdicts: acceptance and regression are separate

Every row has an **acceptance status** and a **comparison status**:

- `PASS`: all required measurable obligations pass, expected exporter capability
  is present, required diagnostics are complete, and required review is recorded.
- `FAIL`: a concrete required geometric, feature, topology or resource limit fails.
- `INCOMPLETE`: unresolved cells, missing mandatory measurements, unresolved
  reference ambiguity, or pending required human review prevent acceptance.
- `UNSUPPORTED`, `TIMEOUT`, `ERROR`, `NOT_RUN`: explicit execution outcomes with
  the failing stage and reason. They remain in the table and prevent a full
  acceptance pass for required cases.

Comparison is separately `IMPROVED`, `UNCHANGED`, `REGRESSED`, `MIXED` or
`NOT_COMPARABLE`, with per-metric deltas. An unchanged known-bad mesh remains
bad. A baseline can be a **measurement baseline** without being an approved
correctness reference. Known issues need IDs, affected regions and a stated
expected failure; they are not removed, counted as passes, or silently rebaselined.

Use separate overall acceptance and no-regression summaries/exit codes so CI
can preserve known limitations without displaying a false all-green acceptance
result. A completed report with failed cases is a successful harness run and
an unsuccessful mesher acceptance run.

### Runtime and resource protocol

The primary table shows **export wall time**, excluding image rendering and
geometric audits. Also record cold scene/build time, total case time, image/audit
time, available SFCC phase times, actual partitions and serial recovery.

First inventory: one export per model, labeled `single sample`. Benchmark mode:
one warm-up plus three measured exports per case/configuration; retain every
sample and report median and range. Use five alternating baseline/candidate
pairs when validating a claimed performance improvement. Do not report p95 from
three samples or compare profiled native time with unprofiled browser time.

Run exports and captures sequentially on the shared agent browser. Exclude
concurrent builds/benchmarks from performance runs, record hardware/browser/GPU,
and identify the exact sample whose artifact supplies the images. Check repeated
output consistency; report variation instead of selecting the nicest mesh.

Proposed initial limits: 180 seconds per export, 60 seconds per capture, 30
minutes for a core run, and 60 minutes for an explicitly selected extended run.
Record these limits in the manifest and revise them explicitly after inventory.
If a case is expensive, report fewer measured samples and the reason; never
continue an unbounded timing campaign. The timeout watchdog must run outside
the synchronous WASM worker/process. Terminate/recover the isolated test context,
write partial results, and continue other cases where the run budget allows.

## 6. Markdown report and artifact contract

Write each run to `.testresults/sdf-meshing/<run-id>/`. Keep the Markdown and
all linked assets together so the directory is portable as a CI artifact.
The report is generated from structured records; no hand-transcribed statistics.

```text
<run-id>/
  report.md
  manifest.json                 # source/config/artifact/environment provenance
  results.json                  # full per-case/view/sample data and verdicts
  cases/<case-id>/<config-id>/
    source.yaml                 # exact run snapshot
    effective-config.json
    mesh.verts.bin / mesh.tris.bin / mesh.features.bin
    stats.json / samples.json / checks.json / log.txt
    hero-sdf.png / hero-mesh.png / hero-wire.png / hero-diff.png
    thumbs/...
    views/...                   # reverse/detail/extended views
```

The header records commit plus dirty diff/source digest, scene and serialized
input digests, WASM digest/version, requested/resolved exporter, normalized
settings, world cube, worker count, simplification/quality flags, camera and
reference versions, platform/toolchain/browser/GPU, timestamps and sample policy.
Missing metrics use `N/A` with a reason, never zero. Escape Markdown-sensitive
case names and error text. Preserve completed rows and failures after interruption;
write artifacts atomically and validate all report links before finalization.

The primary table uses one row per case/configuration and clickable thumbnails.
This is an output template, **not measured results**:

```markdown
| Case / configuration | SDF reference | Result mesh / wireframe | Difference | Triangles (Δ) | Export time | Acceptance | vs baseline |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| Bracket / default | [![SDF](cases/bracket/default/thumbs/hero-sdf.png)](cases/bracket/default/hero-sdf.png) | [![Mesh](cases/bracket/default/thumbs/hero-mesh.png)](cases/bracket/default/hero-mesh.png) · [wireframe](cases/bracket/default/hero-wire.png) | [![Diff](cases/bracket/default/thumbs/hero-diff.png)](cases/bracket/default/hero-diff.png) | <measured> | <median; range; n> | <status> | <status> |
| Housing / default | <thumbnail> | <thumbnail + wireframe> | <thumbnail> | <measured> | <measured> | <status> | <status> |
| Knob / default | <thumbnail> | <thumbnail + wireframe> | <thumbnail> | <measured> | <measured> | <status> | <status> |
| Mess 1 / default | <thumbnail or explicit failure> | <thumbnail or explicit failure> | <thumbnail or N/A> | <measured or N/A> | <measured or timeout> | <status> | <status> |
| Mess 2 / default | <thumbnail or explicit failure> | <thumbnail or explicit failure> | <thumbnail or N/A> | <measured or N/A> | <measured or timeout> | <status> | <status> |
```

Follow with a compact diagnostic table: components, open/nonmanifold edges,
invalid triangles, unresolved cells, missing/gapped features, worst sampled
forward/reverse distance, SSIM plus pixel-diff percentage, and recovery status.
Per-case sections show all view pairs, feature-region failures, source/config
links, raw samples, thresholds, first failing stage, and reviewer notes.
Failures retain available SDF/mesh images; unavailable images have explanatory
text rather than a broken link or a reused old PNG.

## 7. Implementation sequence and acceptance of the harness

| Step | Work | Required exit evidence |
| --- | --- | --- |
| 1. Freeze corpus and obligations | Manifest referencing all five originals; explicit exporter/default resolution; named views, feature regions, resource limits and provisional thresholds | Every source parses; hashes and intended configurations recorded; unknown expectations remain explicit |
| 2. Capture one accountable export | Structured result, raw status/timing, saved mesh, reuse for multiple images; one browser owner and external watchdog | A single complex model's images/counts/audits share its mesh digest; repeated views do not remesh; timeout produces a recoverable result |
| 3. Publish the first full report | Run all five defaults once; capture core images and existing diagnostics; generate Markdown and machine-readable records | Five visible rows including any failures; valid image links; no historical images/values passed off as current; unfinished checks marked incomplete |
| 4. Add independent acceptance measurements | Reuse housing/bracket assertions; define other feature witnesses; forward/reverse GPU-reference coverage, topology and intersection checks | Deliberate missing-piece and bridging corruptions are detected, including defects hidden in the hero view; reference limits and sample counts recorded |
| 5. Add comparisons and stress lanes | Repeat timing, pinned baseline comparison, transform/resolution/worker/quality variants and optional other exporters | Original complex scenes remain mandatory; changed fidelity cannot be hidden by triangle/time gains; comparisons reject incompatible environments/settings |
| 6. Make it maintainable | CLI/CI entry point, retention, report verification, known-issue workflow and manual review record | Reproducible user-run command, complete portable report, distinct harness/acceptance/regression outcomes, interruption recovery and documented operating cost |

Suggested implementation locations: `test/acceptance/sdf-meshing/` for manifest,
expectations and checker tests; `scripts/sdf-meshing-acceptance.mts` for the runner;
small extensions to existing agent capture/export plumbing; formal outputs only
under `.testresults/`. Final names can follow nearby conventions. Do not create
a second rendering stack or another general SDF evaluator.

Harness tests must include: missing component, deleted patch, bridged gap,
flipped winding, degenerate triangle, missing seam, small localized defect on a
large background, wrong camera, stale mesh/image digest, absent diagnostics,
unknown exporter fallback, render failure, export timeout and interrupted run.
Apply mesh corruptions only to test copies. Include valid complex controls so
the checker cannot pass its own tests by rejecting everything. A sampled check
must demonstrate detection on its declared witnesses without claiming all
possible omissions are detectable.

Validate implementation changes with `make build` and appropriate focused tests.
Keep SFCC native/actual-WASM tests, including both `_test.mts` and `_test.mjs`,
when changing its adapter/transport. Browser image collection is exercised by
the user-invoked suite; visual interpretation remains manual. Documentation-only
planning does not require running a build or generating new images.

If using the established three-competitor/fourth-reviewer workflow during
implementation, assign competitors different complete proposals for capture
integrity, geometric acceptance, and report/verdict design. The fourth reconciles
them against the same five-model contract. Only one runner owns browser captures
and performance measurements; do not run three redundant expensive campaigns.

## First milestone to implement

Implement steps 1–3 first: **one honest Markdown report covering all five original
torture models**, with fresh linked images, actual triangle counts and export
times, complete available SFCC diagnostics, and explicit incomplete/failed rows.
Then use that report to prioritize steps 4–5 and actual meshing fixes. The report
must be useful before a comprehensive reference sampler or another meshing
theorem is finished.
