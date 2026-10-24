# SFCC critical repairs after the bracket/housing investigation

Status: bounded implementations complete; remaining acceptance and performance
exits are open, October 24, 2026. Baseline commit:
`5566520` (`Add SDF meshing acceptance diagnostics`). Milestone 1's construction
and focused native/WASM checks are implemented; see the
[corner repair record](../research/sfcc-corner-repair.md). The
[first candidate acceptance run](../../.testresults/sdf-meshing/2026-10-24T01-04-11-157Z/report.md)
retains all five original cases and all remaining failures. Milestone 2's
[membership repair](../research/sfcc-feature-overlap-repair.md) and
[five-model campaign](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/report.md)
preserve all four available meshes' geometry while restoring the eleven housing
memberships. Milestone 3's bounded
[float32 construction repair](../research/sfcc-f32-construction-repair.md) is
implemented: original/rotated/worker bracket and housing have zero exact invalid
faces, with the prior junction and overlap obligations preserved. The
[final campaign](../../.testresults/sdf-meshing/2026-10-24T06-37-24-409Z/report.md)
reproduces the focused meshes exactly. At milestone 3, overall acceptance was failed:
bracket retained earlier chain failures, housing was incomplete, knob and
Mess 2 retained malformed geometry, and Mess 1 timed out. Milestone 4 subsequently
made housing's independent GPU failures explicit, so its current status is FAIL. Four small Mess 2
memberships on already failed traces remain explicitly unresolved within the
[documented collateral limits](../research/sfcc-f32-construction-repair.md#retry-policy-controls-and-bounded-collateral-result).
Milestone 4's [independent GPU measurement infrastructure](../research/sfcc-gpu-regional-coverage.md)
is implemented and its targeted corruption checks detect deleted junction
patches, bridged passages, lost labels and flattened geometry. Its full
repaired-crease exit remains **open**: one housing loft/chamfer section fails
an empirical incident-normal check and flange crease references remain
ambiguous. The new measurements also expose a 0.0132767 mm main-bore surface
miss against the unchanged 0.01 mm budget. These are retained failures and
limitations, not mesher repairs or global coverage guarantees. The
[final milestone 4 campaign](../../.testresults/sdf-meshing/2026-10-24T07-12-23-548Z/report.md)
completed successfully as a harness run. All four available meshes' vertex,
triangle and feature buffers are byte-identical to milestone 3; all four
corruptions are detected. Overall bracket, housing, knob and Mess 2 remain
failed, while Mess 1 retains its 180-second timeout. Milestone 5's
[checked terminal-exclusion implementation](../research/sfcc-terminal-exclusion.md)
is implemented: final-binary timing receipts preserve all four available
meshes' vertex, triangle and feature buffers exactly, while unresolved counts
fall from 59,713 to 19,263 for bracket, 17,352 to 15,185 for housing, and
48,615 to 45,019 for knob. Mess 2 remains at 30,083. Five alternating Node/WASM
pairs show a 14.18% lower bracket export median. Housing's raw median is
25.44% worse amid severe host contention, so its performance exit remains
**open/inconclusive**; one-pair collateral timings support no speed claim.
The [final milestone 5 campaign](../../.testresults/sdf-meshing/2026-10-24T08-17-05-970Z/report.md)
completed with all four available meshes byte-identical to milestone 4. Complete
bracket/housing GPU regional records and all four corruption outcomes are also
unchanged. Bracket, housing, knob and Mess 2 remain FAIL; Mess 1 retains the
180-second TIMEOUT. Milestone 4's crease/bore/reference failures and milestone
5's housing performance exit remain explicitly open.

Evidence: [investigation](../research/sfcc-bracket-housing-investigation.md),
[acceptance report](../../.testresults/sdf-meshing/investigated-2026-10-23/report.md),
and [acceptance-suite plan](sdf-meshing-acceptance-suite.md).

## Goal and priorities

Repair demonstrated loss of geometry and malformed output on the complete
transformed Manim models. Keep their sources, tolerance settings, export domains,
and simplification settings fixed. Local reproductions supplement these models;
they do not replace them as acceptance gates.

| Order | Problem | Baseline evidence | Required outcome |
| --- | --- | --- | --- |
| 1 | Known corner disappears during construction | Bracket corner 18 is 0.057258117 mm from output; accepted cell has three pins and zero triangles | Preserve the junction and its incident surface/feature structure within 0.02 mm |
| 2 | Coincident feature geometry has inconsistent identity/membership | Eleven housing gap spans have physical edges with other curve labels | One compatible geometric representation retains every applicable curve interval |
| 3 | Triangulation produces invalid final coordinates | Bracket: 6 zero-area faces; housing: 180; housing weld/drop leaves 5 nonmanifold edges | Zero invalid faces on these two models, with valid topology and preserved features |
| 4 | Coverage checks can miss defects despite good images/topology | Bracket is closed and visually close while missing a junction | Independent GPU witnesses and targeted interior/crease checks detect the repaired failure modes |
| 5 | Conservative exclusion dominates unresolved counts and costs | Native first reasons: 96.93% bracket and 85.77% housing are same-sign interval uncertainty | Improve exclusion only where a conservative argument and measured benefit support it |

Steps 2 and 3 interact: establish shared geometric identity before making
triangulation depend on it. If step 2 exposes a zero-area face, retain that failure
until step 3 repairs the construction. Do not relax the validator to obtain an
intermediate pass. Step 5 must not delay the geometry repairs.

## Shared rules and baseline preparation

- Preserve the existing report and raw meshes. Reports under `.testresults/`
  are ignored artifacts; retain/share the complete directory, not only Markdown.
- Promote necessary investigation assertions into checked-in tests using the
  original YAML/fixture machinery. Recompute local records from the full scene;
  do not depend on an ignored prepared-worker binary to run a regression test.
- Track each repaired obligation separately from overall acceptance. Existing
  unrelated failures and Mess 1's 180-second timeout remain visible.
- Use actual WASM output for release gates. Native traces locate mechanisms but
  do not establish identical WASM behavior; native/WASM curve IDs 73/74 already
  disagree for bracket. Match evidence by geometry/provenance when IDs differ.
- No blanket coordinate welding, deleting bad triangles, increasing global
  depth, or enlarging tolerances as a substitute for construction correctness.
- No new CPU scene evaluator. Additional reference sampling uses the existing
  GPU scene evaluation. Existing native/WASM diagnostic APIs remain internal
  consistency checks, not independent references.

## 1. Preserve the known bracket corner

**Contract.** A recognized visible corner is a construction obligation. Equal
signs at the eight cell corners and no face-boundary crossings do not prove the
absence of an interior face contour. Accepting a corner is safe only when the
mesher can construct its incident patches or report that obligation unresolved.

Start with the actual failure at `(-3.2974043758686875, 11.496906301499829,
2.2091193968483966)` mm. The baseline accepted cell is `(7,56,77,69)`, with
incident curves 13/43/45. Cell IDs may change after a fix; the geometric witness
and full source hash are the stable regression target.

1. Add a failing actual-WASM regression for the missed junction, plus a local
   invariant detecting accepted visible corner/pin obligations that produce no
   surface. Preserve the complete octree context in selected-cell diagnostics.
2. Trace oriented stratum incidence through `face_contour.rs`,
   `cell_mesh.rs::mesh_cells_subset`, and `pipeline.rs::decide_cell`. Determine
   the actual face-interior arcs required by the three pins. Do not simply join
   three points into a triangle: their existence does not prove their pairing,
   winding, visibility, or the absence of another contour.
3. Construct the supported local contour from existing feature/stratum data.
   Adjacent cells must consume the same canonical shared-face record with
   opposite boundary orientation, including coarse/fine and worker boundaries.
4. Make ambiguous construction request bounded refinement through the existing
   failure/refinement path. At the limit, retain an explicit unresolved feature
   obligation. Removing silent success is necessary but does not complete the
   bracket repair if its geometric witness still fails.

**Exit gate:** actual final WASM mesh is within 0.02 mm of the corner; all three
incident curve ends connect to the reconstructed junction; local edge and
triangle-interior checks support the incident patches. The emitted patch has
nonzero area, correct shared-face use, and no new open/nonmanifold edges,
nonmanifold vertices, or local self-intersections. The baseline witness must
fail on the old mesh. A nearby unrelated triangle alone cannot satisfy the gate.

**Tests:** full bracket, targeted shared-face/coarse-fine cases, and actual
serial/worker paths. Inspect housing for collateral changes before merging this
milestone. New unsupported configurations stay explicitly unresolved.

## 2. Reconcile overlapping feature identities

**Contract.** A geometric vertex or edge can carry multiple feature memberships.
Membership identity is distinct from geometric identity. Equal rounded
positions alone are insufficient evidence that two sheets or features coincide.

1. Trace the eleven proven housing spans back to their strata, parameter ranges,
   face-pin keys, and graph edges. Determine which are duplicate descriptions
   of the same visible feature and which require a richer incident-patch model.
2. Define compatibility using proven common geometry, visible incident strata,
   endpoint correspondence and orientation. Start with the demonstrated straight
   spans; ambiguous curved overlaps retain an explicit unsupported result.
3. Reuse one canonical vertex/edge only for compatible coincidences. Subdivide
   partial overlaps at their interval endpoints. Preserve each curve's parameter
   range and direction; do not copy one curve's parameterization onto another.
4. Replace `mesh_feature_graph`'s unconditional duplicate-edge rejection only
   where this compatibility contract holds. Carry memberships through point
   tables, worker merge, assembly edits, output metadata and chain validation.
   Check existing transport support before changing any serialization format.
5. Treat housing curve 75 separately. Nearby ordinary edges do not establish a
   crease. Test ordered connectivity, endpoint incidence, adjacent patch normals
   and continuous interval coverage within the declared sampling limits.

**Exit gate:** all eleven diagnosed spans retain the expected memberships on
valid physical edges, without relaxing chain validation. Reversing orientation,
partial overlaps and worker ordering preserve the result. Closely separated
sheets remain distinct. Curve 75 either gains demonstrated sharp-chain coverage
or remains a separately reported open defect with a specific construction cause.

## 3. Make construction valid in final float32 coordinates

**Contract.** Valid f64 working geometry is not enough: the shipped float32 mesh
must have distinct corners and nonzero area for every triangle. Conversely,
small but nonzero triangles must not be rejected by an arbitrary area epsilon.

1. Audit the first defective stage separately: bracket feature-graph faces that
   collapse on conversion versus housing faces already degenerate in f64.
   Record responsible cells, patches and point provenance, not only final IDs.
2. Normalize duplicate loop vertices and compatible corner/pin identities before
   triangulation using step 2's contract. Preserve boundary constraints and
   memberships. Repair corner fans/patch triangulation where a proposed center
   lies on a boundary edge or creates collinear output faces.
3. Validate candidate patches in their eventual float32 coordinates before
   accepting them. Reuse existing robust predicates where sufficient; ensure
   the decision handles near-collinearity and tiny representable valid faces.
4. If a candidate fails, try a constrained local retriangulation with the same
   boundary. If safe construction cannot be established, refine or report an
   unresolved patch. Do not silently remove triangles from a closed surface.
5. Verify that assembly, refinement, flips and serialization cannot reintroduce
   the defect. Place the common validation at the appropriate shared boundary
   and preserve enough provenance to identify any later offending operation.

**Exit gate:** bracket and housing each have zero exact invalid output triangles;
edge incidence, winding and vertex links remain valid; local intersection tests
pass; steps 1/2 feature obligations still hold. In particular, the housing result
must not reproduce the five nonmanifold edges from hypothetical weld/drop.
Targeted quantization tests include points that collapse to one f32 value,
collinear fans, and tiny valid triangles. No global deletion/weld repair is used.

## 4. Strengthen independent coverage on the repaired regions

Extend the acceptance suite's planned measurement lane, using existing GPU batch
sampling and geometric mesh queries. First cover the bracket junction, housing
flange/curve 75 and neighboring internal passages, rather than implementing a
universal coverage certificate before these repairs can ship.

- Generate surface witnesses independently of compiled feature labels, with
  explicit root brackets, sample spacing, ambiguity and numerical allowances.
- Measure surface-to-mesh distance and mesh-to-reference residuals at vertices,
  edges and triangle interiors. Label field residual separately from distance.
- Add ordered crease samples and checks on incident patch normals; proximity to
  any edge is insufficient. Include reverse/internal views and cross-sections
  where they expose otherwise hidden geometry. Visual acceptance remains manual.
- Prove the checks detect deleted junction patches, bridged gaps, lost feature
  labels and smoothed creases by corrupting copies of real captured meshes.

**Exit gate:** the old bracket omission and deliberate regional corruptions are
detected; repaired regions pass their declared empirical thresholds. Sampled
coverage is never reported as a global Hausdorff or multi-sheet guarantee.

## 5. Reduce uncertainty and cost after correctness

Group `same_sign_root_interval` cells by subtree/operator and locate where bound
tightness is lost. Use their full complex-model contexts. Consider tighter local
interval composition or bounds over transformed subtrees only after identifying
the dominant cause. A box-only theorem is not the milestone.

For each proposed exclusion rule, state the enclosure assumptions, preservation
under the actual transform/CSG operators, and why zero can safely be excluded.
Construct counterexamples around thin sheets, grazing contacts and same-sign
hidden components. A favorable sample histogram cannot prove exclusion safety.

**Exit gate:** conservative justification plus adversarial tests; unchanged or
improved geometry/feature obligations; measured reductions in unresolved work
and export time on original scenes. Ambiguous cells remain unresolved. Use the
acceptance plan's alternating baseline/candidate repetitions for performance
claims, with no concurrent builds or export campaigns. Mess 1's timeout remains
a resource failure until it actually completes within the recorded budget.

Milestone 5 implementation evidence: [terminal-exclusion proof and results](../research/sfcc-terminal-exclusion.md).
The checked rule covers represented affine sphere/box/cylinder fields and
one-sided hard/round/chamfer composition, including opaque descendants and
nearest-pair selection. It runs only at the lattice ceiling and preserves
legacy arithmetic-failure eligibility. The all-depth experiment was rejected
because it changed surface tessellation. The broad performance exit remains
partially met until housing can be measured under suitable host conditions.

## Execution and review

This is the next implementation sequence for the **open exits**, not a restart
of completed repairs 1–5. Use commit `701997c` and the
[final five-model report](../../.testresults/sdf-meshing/2026-10-24T08-17-05-970Z/report.md)
as the recorded starting baseline. At execution time, record the actual checkout
and any intervening changes; do not reset another contributor's work to recreate
that revision. **E1 is implemented and its bounded diagnostic exit is validated**;
see the [decision and results](../research/sfcc-reference-diagnostics-e1.md) and
[report with recorded infrastructure recovery](../../.testresults/sdf-meshing/2026-10-24T09-14-43-401Z-postprocessing-recovery/report.md).
All four available meshes and original bracket/housing discovery-grid references
remained unchanged in E1. **E2's bounded housing bore repair is now implemented
and validated**; see the [repair, rejected candidate and final evidence](../research/sfcc-housing-bore-e2.md)
and [five-model report](../../.testresults/sdf-meshing/2026-10-24T11-16-12-570Z/report.md).
All 170 original and 626 fresh shifted GPU bore witnesses pass the unchanged
0.01 mm gate. Guarded additional refinement introduces no new measured
intersection-pair identities or malformed faces on the original collateral
models and the declared transformed matrix. Existing invalid faces, contacts,
feature failures and recovery remain visible; overall acceptance still fails.
**E3's bounded housing crease exit is implemented and validated**: the
[crease investigation and release record](../research/sfcc-housing-creases-e3.md)
retains the rejected candidates and the selected atomic paired-flip repair.
Fresh GPU checks pass all nine loft/chamfer and nine flange sections, including
incident normals, contrast, own-chart memberships, ordered paths and endpoints.
Original/shifted bore witnesses remain passing. The
[final five-model report](../../.testresults/sdf-meshing/2026-10-24T16-17-21-370Z/report.md)
matches the audited WASM meshes exactly; no new measured malformed faces or
intersection identities occur in the original and declared transformed controls.
Housing is now INCOMPLETE, while bracket/knob/Mess 2 remain FAIL and Mess 1
retains its 180-second TIMEOUT. E4–E6 remain pending in order.

### Baseline and non-negotiable obligations

The coordinator prepares one common baseline packet before the first fan-out:
source revision/digest, original YAML snapshots, effective tuning and export
cube, simplification/quality switches, toolchain versions, actual WASM hash,
GPU adapter, raw meshes, and links to the corresponding numerical receipts.
Reuse the existing acceptance manifest and structured results. If an ignored
artifact is unavailable, regenerate it from the pinned source and identify that
new run; do not silently substitute a current mesh or require a private binary
to run a checked-in regression.

| Case | Recorded starting obligations |
| --- | --- |
| Bracket | Preserve the repaired junction, zero invalid f32 faces and topology. Existing chain failures and 106 ambiguous GPU normal-line projections remain open; 19,263 unresolved cells. |
| Housing | Preserve zero invalid f32 faces and all restored memberships. Main-bore miss is 0.0132767 mm against 0.01 mm; one loft/chamfer section fails an empirical normal check; flange references remain ambiguous; 15,185 unresolved cells. |
| Knob | 4,582 invalid f32 faces and existing feature-chain failures; 45,019 unresolved cells. |
| Mess 2 | 17,953 invalid f32 faces, existing topology/chain failures and four recorded residual memberships; 30,083 unresolved cells. |
| Mess 1 | Full original model times out at the 180-second export limit; no accepted mesh or inferred zero defect counts. |

Keep **0.01 mm surface** and **0.02 mm feature** budgets separate. Record field
residuals in field units. A normal-line displacement upper bound exceeding a
budget is an unresolved projection obligation, not a lower bound on distance
to every surface point. Keep normal fidelity, positions, ordered connectivity,
labels, reference ambiguity, construction uncertainty and execution errors as
separate report dimensions. A demonstrated failure takes precedence over an
incomplete measurement; neither a missing reference nor a successful harness
exit can produce an acceptance pass.

### Team and concurrency model

For **each package below**, start three independent competitors on the same
contract and frozen baseline. Each must address the whole contract; the emphases
below are starting approaches, not three fragments of a predetermined solution.

| Agent | Responsibility | Required output |
| --- | --- | --- |
| A — construction | Find the first responsible stage and propose a bounded mathematical/construction repair. | Causal hypothesis, distinguishing experiment, proof premises, candidate patch and regression evidence. |
| B — representation | Independently solve the same failure through source identity, constraints, f64/f32 conversion and transport analysis. | Alternative cause/repair, point/edge/patch provenance, quantization and worker counterexamples. |
| C — falsification | Independently challenge the measurement and construction assumptions using GPU evidence and adversarial cases. | Alternative safe candidate, or a reproducible counterexample explaining why a proposed repair cannot satisfy the contract. |
| D — consensus | After A/B/C finish, read all three handoffs and the connected code; reconcile facts, disagreements and candidate costs. | Selected minimal repair, rejected alternatives with reasons, unresolved disputes, fixed validation gates and integration instructions. |
| Coordinator | Own baseline, scheduling, integration, final evidence and commit decisions. | One reproducible integrated candidate and an honest package/overall status. |

There are four concurrent slots including the coordinator: run coordinator plus
A/B/C, then finish those turns before D runs. Prefer a fresh fourth reviewer who
did not author a candidate. If the platform cannot allocate another thread, the
coordinator acts explicitly as D, provided it has not authored a competing
candidate. Do not describe an author's self-review as independent consensus.

Candidates use separate worktrees or the existing isolated-checkout workflow,
with uniquely named scratch/artifact locations. They do not edit the integration
tree or overwrite its generated WASM package. Do not create a new orchestration
framework. Analysis and isolated edits may run concurrently; one named owner
schedules builds, native/WASM exports, browser/GPU captures and benchmarks
sequentially. Ownership can be handed off explicitly, never held by two agents.

### Ordered remaining implementation packages

Execute one bounded package at a time, with a new A/B/C/D cycle for each. Split
a large package into construction-family commits when necessary; each such
repair retains the same independent review and release gates.

**E1 — Make ambiguous regional references diagnosable.** Start in
`test/acceptance/sdf-meshing/gpu-coverage.mts`, its tests, capture receipts and
reporting. Save every failed probe's endpoints, GPU values, search extent,
bracket width and rejection reason. Compare bounded nested normal searches,
alternative transverse/side sampling, and adversarial reference calibration.
Test same-sign endpoints containing two crossings, rounded-zero plateaus,
tangencies and nearby separated sheets. Preserve strict-sign brackets and the
shrinking-offset evidence; declare search budgets before running candidates.

Exit: the old bracket omission and all four deliberate corruptions remain
detectable; known good regional controls still pass; every attempted reference
has usable evidence or a specific unresolved reason. Run the revised checker on
both the baseline and candidate artifacts. Mesh buffers must remain identical
for this measurement-only package. A still-ambiguous flange remains INCOMPLETE.
This is a bounded diagnostic deliverable, not a requirement to solve universal
root discovery before E2: the existing bore witness already supports its repair.

**E2 — Repair the housing main bore.** Freeze the existing failed GPU witnesses,
including the worst near `(5.49795437, 0.150000006, -0.050000001)` mm. Trace
responsible cells, carriers and triangles through projection, refinement,
triangulation, assembly and final f32 conversion. Competing candidates should
distinguish inadequate interior approximation from projection/carrier mistakes
and later movement. Inspect `pipeline.rs`, `cell_mesh.rs` and
`patch_triangulate.rs` only as the evidence leads there. Vertex residuals alone
cannot validate this repair: the recorded failures include edge midpoints and
triangle interiors.

Exit: all original failing bore witnesses meet the unchanged 0.01 mm gate,
including their numerical allowance. Add a predeclared shifted/denser regional
GPU sample set to test between the original samples. Preserve passage topology,
housing memberships, zero invalid bracket/housing faces and prior junction
obligations. Attribute any additional tessellation to the restored accuracy;
do not raise global depth or substitute a simpler model.

**E3 — Resolve the housing crease obligations.** Investigate loft/chamfer section
5 near `(8.214349029, 4.772261598, 14.691963856)` mm independently of the bore.
The recorded centroid-normal error is 6.4895767 degrees against a 5.8702329-degree
empirical allowance; this is not evidence by itself of a positional miss or a
deleted crease. Compete on incident-patch approximation, feature representation,
and whether the reference pairs the correct surface sides. Evaluate flange
geometry only where E1 supplies an adequate reference.

Exit: supported crease sections pass their position, geometric-face-normal,
retained normal-jump, ordered-path, endpoint-incidence and membership checks
separately. Improve the geometry to satisfy the existing angular rule, or prove
a checker defect with independently justified positive/negative controls and
re-evaluate both old and new meshes. Do not choose a larger allowance because
the candidate fails. Label changes or display-normal changes cannot repair a
geometric crease. Any unresolved flange section leaves that acceptance exit open.

**E4 — Repair malformed knob and Mess 2 construction.** Inventory exact invalid
f32 faces by first defective stage and source/constraint provenance, beginning
with knob and then Mess 2. Keep the original full scenes mandatory. Use reduced
cases only to distinguish construction families. Compete on constrained patch
construction, legitimate shared-geometry identities and final-coordinate
validation. Preserve evidence of f64 defects separately from conversion collapse.

Exit per construction-family commit: its previously failing emitted faces are
valid, with retained boundary constraints, memberships, winding, vertex links
and local nonincident-intersection checks. Compare defect identities and
locations, not merely net counts: fewer total defects must not conceal newly
introduced ones. No blanket welding, face deletion, unconstrained filling or
arbitrary coordinate perturbation. E4 stays open until both full models have
zero invalid emitted faces; fixing the largest family is partial progress.

**E5 — Close remaining feature-chain and worker obligations.** After the relevant
construction families are stable, classify bracket/knob/Mess 2 chain failures
and the four recorded Mess 2 memberships. Compete on missing physical geometry,
lost metadata/parameter intervals, and invalid or incomplete compiled-feature
expectations. Match witnesses by geometry and source occurrence; native and
WASM curve IDs are not interchangeable. Removing a supposed phantom trace needs
evidence from the full expression and a counterexample test, not just a nearby
edge or a favorable aggregate count.

Use a separate subpackage for raw worker reconstruction: preserve pre-recovery
partition/merge receipts and compare them with the recovered and serial outputs.
Start with the existing reverse-order bracket/housing failures, then a bounded
2/4/8-worker and completion-order matrix. Retain recovery as a separate behavior.
Record requested and actual partition/worker counts and the recovery reason;
a clamped worker configuration does not establish the requested configuration.

Exit: targeted visible chains have ordered coverage, correct endpoints, incident
patches and every applicable parameter interval. Separately, the targeted raw
worker outputs satisfy the same geometric/topological obligations without
serial recovery. A passing recovered result does not close the raw-worker exit.
Unresolved compiler completeness stays explicit; these repairs do not establish
general multi-sheet reconstruction.

**E6 — Close resource and performance exits.** First isolate Mess 1's dominant
executed phase under the original source, settings and 180-second export limit.
Use an external watchdog; retain partial phase/worker/resource receipts. A longer
diagnostic run, if needed, must be separately named and bounded before launch;
it cannot replace the production acceptance row. Competing implementations must
preserve geometry/feature quality while reducing measured work. A first completed
mesh still needs all acceptance checks, not merely a triangle count.

Then reassess housing exclusion cost on a suitable host. Use a matching frozen
baseline/candidate pair differing only in the proposed optimization. The retained
milestone-5 pair can answer the historical claim; it cannot by itself establish
the performance of a later geometry repair. Start with diagnosis and measurement;
implement another optimization only if a repeatable cost warrants it.

Exit: Mess 1's resource exit closes only when the full original export finishes
within 180 seconds. A performance claim requires one warm-up per configuration
and five alternating baseline/candidate pairs with reversing pair order, unchanged
quality obligations, and every sample retained. Report backend, median, range,
paired outcomes, phase times and output hashes. Keep Node/WASM export-only and
browser end-to-end measurements separate. Housing's prior **+25.44% raw median**
remains documented; noisy or conflicting follow-ups stay inconclusive. One-pair
collateral observations cannot support speed claims. E6 has separate resource
and performance exits; neither can stand in for the other.

### Per-package implementation and consensus procedure

1. **Freeze the contract.** Name the failing obligations, full-model inputs,
   allowed edits, expected improvement, preserved invariants, numeric budgets
   and stop conditions. State whether this package repairs geometry, measurement,
   transport or cost. Preserve known failures by identity/region, not only count.
2. **Independent diagnosis.** A/B/C each submit a causal hypothesis and the
   smallest experiment that could disprove it before expensive validation.
   Sharing the common evidence packet is expected; copying another candidate's
   proposed answer is not an independent result.
3. **Competing implementation.** Each author produces a reviewable isolated
   patch, focused regressions and requested validation jobs. An alternative
   disproved by a concrete counterexample is a valid handoff; three production
   patches are not required merely to satisfy the agent count.
4. **Complete handoffs before consensus.** Include source revision/diff, proof
   premises and unsupported cases, old-fails/new-passes evidence, adversarial
   controls, commands/results, actual WASM/configuration/output hashes, affected
   obligations, cost/tessellation changes and remaining uncertainties. Clearly
   label evidence that has not yet run and native-only observations.
5. **Fourth-agent decision.** D resolves contradictions by experiments and
   invariants, never voting or averaging scores. Select the smallest sufficient
   candidate. Combining changes requires compatible assumptions and fresh
   integrated validation. If none satisfies the contract, retain the rejection
   evidence and return a focused follow-up to the competitors; do not merge a
   union of speculative repairs.
6. **Single-writer integration and freeze.** The coordinator or explicitly
   designated integrator applies the selected patch. Review the integrated diff,
   build it, and record source/toolchain/binary/scene/settings digests before
   release validation. Evidence from a different worktree binary does not
   automatically apply to the integration result.
7. **Validate and decide.** Apply the matrix below. A new defect blocks the
   candidate even when net defect counts improve. If a new checker exposes an
   existing defect, demonstrate that attribution by running it on the baseline;
   the defect still fails acceptance. Keep `implemented`, `target validated` and
   `overall accepted` distinct. Do not redefine a failed repair as a completed
   diagnostic task; any useful diagnostic commit leaves the repair explicitly open.
8. **Commit before the next package.** Commit the bounded implementation, tests
   and result record after review. Include compact necessary fixtures even if
   their directory is normally ignored. Preserve complete external artifacts and
   report links. State exactly which exits passed and which remain open; a partial
   family repair does not close its parent package.

### Validation matrix and evidence invalidation

| Change | Required validation before commit |
| --- | --- |
| Measurement/reference/report behavior | Harness tests, positive controls and all four corruption checks; matching baseline/candidate checker runs; targeted live GPU captures for sampling changes; verify captured mesh identity. Run the full five-model report when shared capture or release verdict behavior changes. |
| Geometry/construction | Relevant native and actual release-WASM regressions, f64/f32 validity, topology/intersections, ordered features and GPU regional checks; deterministic transformed full models and affected serial/worker paths; then one full five-model campaign. |
| Worker/transport | Separate raw and recovered receipts, production serial comparison, affected partition counts/orders, boundary/coarse-fine cases, feature transport and topology; final integrated five-model campaign. |
| Exclusion/performance | Numerical/adversarial enclosure tests, shipped-WASM arithmetic, full-model correctness gates and repeated paired timing after the freeze. For a change claiming unchanged construction, require exact vertex/index/feature-buffer preservation on the available original models. |
| Documentation only | Review links, baseline references and consistency. No build, export or full campaign rerun solely for prose. |

Use `make build` for application validation and `make acceptance-tests` for the
final production campaign. Run applicable native kernel tests and focused WASM
fixtures through their existing commands. Test discovery must include both
`*_test.mts` and `*_test.mjs` WASM fixtures. For acceptance checkers use
`node --import tsx --test test/acceptance/sdf-meshing/*test.mts`; selecting only
`*_test.mts` would omit `gpu-coverage.test.mts`.

Predeclare a small transform matrix that includes the existing rotations plus
non-axis rotation and grid-phase translation cases on the complete models.
Transform the witnesses with the model. Compare geometric obligations across
changed lattices, not identical triangulations. Use a bounded pairwise worker/
transform matrix rather than the Cartesian product of every option.

A runtime source, compiler flag, binary, scene, tuning or acceptance-rule change
invalidates affected evidence. Rebuild as needed and repeat the affected gates;
if it changes production geometry, shared sampling or release verdict behavior
after the full-campaign freeze, repeat that campaign. Tests run before a later
guard or synthesis must be labelled with their actual source/binary, rather than
silently presented as final-candidate receipts. Prose-only edits do not invalidate
runtime evidence. No new CPU scene-reference evaluator or in-agent manual visual
QA is introduced; automate image collection and leave visual acceptance to the user.

### Resource controls and final report

Before heavyweight work, check disk against expected compiler growth, temporary
writes, complete retained artifacts and a reserve; the previous 141 MB report is
not the whole working-space requirement. Avoid an unbounded target directory
per experiment. Record host load, memory pressure/swap and GPU/browser state.
For timing runs, predeclare a resource-suitability policy and run no competing
owned builds/exports. If conditions violate that policy, retain the observations
and mark timing inconclusive; do not discard slow samples or repeat until a
favorable median appears. Changes to conditions require a separately labelled run.

On disk exhaustion, preserve partial receipts and the frozen candidate, reclaim
only identified task-owned disposable compiler caches, and restart an immutable
new run after capacity is restored. Do not delete baselines, source or unique
evidence. On timeout, retain the stage, elapsed time and completed outputs, then
recover only the owned isolated test context. Distinguish export, sampling,
rendering and infrastructure failures. Verify ownership before terminating a
leftover process; unrelated workloads and interactive browsers are untouched.

For each accepted candidate, retain the generated Markdown report with all five
original rows, linked SDF/mesh/wireframe/diff images, triangle and buffer counts,
export time and separate measurement overhead. Add baseline deltas for geometric
errors, exact invalid faces, topology, feature identities/intervals, numerical
events, unresolved references/construction and worker recovery. Link the A/B/C
handoffs, D's decision, integrated source/binary receipts, tests, raw timing
samples and rejected experiments from a compact result record. A complete report
with FAIL/TIMEOUT rows is a completed harness run, not completed mesh acceptance.

The first new deliverable is E1's bounded reference-diagnostic patch and evidence
packet. E2 then targets the already demonstrated housing bore error. General
multi-sheet reconstruction remains outside these bounded completion claims.
