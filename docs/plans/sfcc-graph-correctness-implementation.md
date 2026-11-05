# SFCC: from the private graph refusal to a validated construction repair

Status: stage 1 implemented and mechanically validated, November 3, 2026;
[executed capture and limitations](../research/sfcc-graph-rejection-capture/README.md).
Stage 2 has [exact early replay and a bounded source continuation proof](../research/sfcc-endpoint-obligation/README.md), followed by
[executed causal localization to finite-flank trimming](../research/sfcc-endpoint-lineage/README.md).
Stages 1–2 are complete for this witness. Stage 3's
[first competing repair round](../research/sfcc-stage3-exposure-repairs/README.md)
restores the target interval but fails lower-junction preservation. The
[next revision](../research/sfcc-stage3-junction-revision/README.md) establishes
source-junction location, conditional local source equivalence and corrected
original/final parameter provenance. The subsequent
[incoming-connection round](../research/sfcc-stage3-incoming-connection/README.md)
selects A-rollback for the bounded Stage 3 witness: its source-derived chart
restores the lower attachment, retains upper continuation, preserves non-target
families and rolls back an injected late refusal. All 12 focused tests pass.
Stage 3's local exit is satisfied. The
[Stage 4 validation attempt](../research/sfcc-stage4-component-validation/README.md)
reidentifies the current source charts but refuses with `endpoint_missing` before
octree or component construction: both upper ends remain unresolved. The original
private graph guard and geometric/interface checks were not reached. Stages 4–5
remain open; the next prerequisite is the current upper source transition and
ordered handoff, without relaxing complete-arc admission.
Current production baseline:
`421f5a9`. This expands the next five steps of
[E4 in the critical-repairs plan](sfcc-critical-repairs.md), then defines the
handoff to the remaining E4 work, E5 and E6. It does not supersede their acceptance
requirements or claim general SFCC correctness.

## Objective and established starting point

Produce a source-justified repair of the knob's first private feature-graph
failure, validate the entire affected component, and integrate only after current
native/WASM and full-model preservation checks pass.

The [frozen Round 18 prototype](../research/sfcc-e4-prototype/README.md) is an
experimental overlay on E3 commit `3abea38c93679fff5e6e7c600b23d8a0f46974a6`.
It is not the production mesher. Its original-scene run establishes:

- 198 typed-face certificates and 396 pin-to-root bounds passed for the selected
  199-leaf component, with 1,001 required faces.
- Its reservation was 19,865,723 bytes under the unchanged 64 MiB policy.
- Private construction refused at cell `[7,36,79,29]`, its second selected cell.
  Eight fallback triangles were returned by the cell mesher but rejected by the
  private caller. The entire candidate was discarded; live state was unchanged.
- The snapshot is post-return. It lacks the exact internal rejection and complete
  graph state. It is not sufficient for an exact local replay.

Terminal corner 27 originally lists charts 20/33. Removing alias chart 33 may
leave an unsupported terminal incidence, but this remains a hypothesis. In
particular, **degree one in a feature graph is not by itself a mathematical proof
of invalid surface geometry**. A real crease may terminate. We must distinguish
source discovery, classification and the mesher's representation assumptions.

## Execution model

Each numbered stage uses three independent forked agents, A/B/C, followed by a
fourth consensus agent D after all three handoffs are complete. The coordinator
plus A/B/C occupies the four available slots; release those slots before D starts.
Do not spawn nested teams. D may request a focused correction from an author,
but integration remains single-writer.

Each competitor receives the same frozen inputs, obligations and budgets and
must submit its own causal argument, proposed implementation/checker, negative
controls and limitations. Distinct assigned approaches below are starting points,
not instructions to defend a predetermined answer. A counterexample that rules
out a proposed repair is a useful result; do not invent three patches for symmetry.

Agents may inspect, edit isolated source and run lightweight static checks. The
coordinator runs builds, native/WASM tests, captures and exports **serially**.
Competing patches do not imply three whole-scene exports. D selects the minimum
experiment that resolves the disagreement; findings return to the competitors
for independent interpretation before D records the stage's final disposition.

Every handoff contains source/patch hashes, assumptions, actual commands/results,
untested claims, failed controls, remaining obligations and the next smallest
discriminator. D resolves contradictions by evidence, not voting. Combining
candidates creates a new candidate requiring fresh tests.

## Preparation: preserve two baselines

The coordinator prepares this packet before stage 1:

| Baseline | Purpose | Required identity |
| --- | --- | --- |
| Historical H0 | Explain the known failure | E3 plus the archived Round 18 patch; verify all 155 source/config hashes and the original source manifest |
| Current C0 | Establish production improvement | `421f5a9`, then explicitly re-freeze if HEAD changes before integration; record all effective options and actual native/WASM binaries |

Restore H0 in an isolated checkout; never apply the complete experimental overlay
to the production working tree. Reuse archived receipts instead of rerunning
already answered experiments. Record the scene, full expression, root cube,
lattice bits, source occurrence identities, selected inventory and compiler.

H0 used Rust 1.99.0/LLVM 23.1.2 and audited hashbrown 0.17.1 storage. The installed
compiler was subsequently observed as Rust 1.99.1/LLVM 23.1.3. Inspect the actual
compiler at execution time. If the old toolchain is unavailable, label the
rebuild H1, audit the storage-layout assumptions under that compiler and rerun
the six retained controls. Never label it an exact historical reproduction.
Predeclare at most one additional uninstrumented 120-second baseline capture
if needed to separate compiler effects from observation changes.

C0 uses the [aligned defaults](../feat/sfcc/export-options.md): multi-sheet and
decimation off, the quality experiments off, vertex-link checks on. Record all
31 active values explicitly. Saved GUI overrides are not a baseline definition.
Native/WASM comparisons also require matching cubes, generic simplification off
and `renormalizeTriangles: false`; display-only copies may use flat normals.

Deliverable: a baseline manifest and run ledger under a new immutable directory
in `.testresults/sfcc-critical-repairs/e4-invalid-construction/`. Name paths at
execution time; do not reuse or overwrite a previous round.

## 1. Capture the actual graph rejection

**Question:** which executed predicate first rejects this cell, and what exact
inputs make it reject?

| Agent | Independent approach |
| --- | --- |
| A | Instrument the actual return paths in `cell_mesh::mesh_feature_graph`; propose stable rejection codes and the smallest operand record. |
| B | Trace cell classification, boundary loops, pins and corner incidences; propose the minimum pre-call state needed to distinguish upstream misclassification from a graph failure. |
| C | Audit observational equivalence and completeness: detect missing return paths, hidden mutation, serialization loss, truncation and query/budget side effects. Propose an alternative minimal capture. |
| D | Select one observational patch, settle the capture schema and review the executed first-failure receipt. |

Implementation belongs in the isolated overlay around `mesh_feature_graph`, its
caller in `mesh_cells_subset`, and the private constructor's diagnostic observer.
Reuse the existing observer and receipt lifecycle. Do not add a general tracing
framework or modify graph acceptance, feature classification or fallback behavior.

Capture the selected cell's exact pre-call loops/pins/corners and point positions;
the graph's actual nodes, edges and source/parameter labels as constructed;
the rejection code and operands; and any newly added corner/interior points.
Record source occurrence paths, retained/omitted chart mappings and relevant
parameter spans. Preserve binary64 values as exact bits using hex strings where
cross-language readers would otherwise lose integer precision.

Observation must use already computed values, make no additional field/curve
queries and not change iteration order. Bound allocations before recording;
keep diagnostic storage separate from the private 64 MiB reservation. Preserve
the existing 512 KiB local-detail cap. Truncation or unsupported state means the
fixture is incomplete, not permission to infer missing data.

First test rejection-code coverage, empty/early-return cleanup and truncation
behavior. D then selects **one** preparation-inclusive original-scene capture
under 120 seconds. Stop at the first private failure; do not run a complete export.
Check the protected source/root functions, unchanged geometric admission records,
query behavior and live-state digest against the appropriate baseline.

**Exit:** the exact executed rejection and operands are captured without a
behavior change. If another refusal precedes it, retain that result and resolve
baseline drift; do not force execution past the guard. This exit confirms a
mechanical failure, not its mathematical cause or a repair.

## 2. Establish the local obligation and failing regression

**Question:** what does the original composed surface require in this cell, and
which implementation assumption violates that requirement?

| Agent | Independent approach |
| --- | --- |
| A | Analyze the original CSG expression, feature sources and exposure near the endpoint. Determine whether continuation, termination or branch transition is required. |
| B | Reconstruct the embedded local graph and surface-patch incidence. Test whether the existing graph acceptance rule excludes a legitimate configuration. |
| C | Audit identity and parameter transport: prove or disprove that alias removal, endpoint classification or stale incidence creates the observed obstruction. |
| D | Separate proved premises from sampled observations, choose the causal discriminator and approve a minimal regression fixture. |

Build a fixture from the stage-1 **pre-call** state and verify that local replay
hits the same rejection code, operands and relevant graph state. Use existing
kernel source construction/evaluation for this diagnostic; do not introduce a
new CPU scene-reference evaluator. Omit the octree build only after demonstrating
that the replay includes all dependencies actually read by the local operation.

State a bounded contract: supported source/branch equations and domains; endpoint
classification; required physical feature arcs and parameter intervals; boundary
constraints; incident surface patches; and numerical premises. If making a
continuous existence/uniqueness or exposure claim, provide a justified bound or
equation-based argument. A finite sample can falsify a claim but cannot establish
unobserved continuation or complete coverage.

Controls must distinguish at least: a required continuation omitted from the
graph, a legitimate terminal feature, two nearby distinct curves, a genuinely
duplicate chart, an off-domain endpoint, reversed/missing parameter coverage,
and a geometrically invalid embedded graph. Use controls relevant to the actual
cause; record an unsupported case rather than manufacturing a certificate.

The primary regression should assert the required geometric/source behavior and
fail on the baseline, not merely snapshot a particular rejection string. Keep a
separate diagnostic assertion tying it to the original execution. Primitive
controls supplement the actual transformed knob witness; they do not replace it.

**Exit:** deterministic local reproduction, a supported causal explanation and a
falsifiable repair contract. If source completeness cannot be established, the
next package targets that discovery gap; no triangulation workaround advances.

## 3. Compete on a narrowly justified repair

All candidates must satisfy stage 2's same contract. Reassign approaches if the
confirmed cause rules one out.

| Agent | Candidate emphasis |
| --- | --- |
| A | Source/feature construction: recover a missing continuation or correctly represent the source transition, if the contract requires it. |
| B | Classification/identity: correct endpoint and chart incidence while preserving every genuinely distinct source obligation. |
| C | Local meshing representation: handle a proved legitimate terminal graph without inventing a feature, or independently show why a meshing-only repair cannot work. |
| D | Compare proof premises, old-fails/new-passes behavior and adversarial results; select the smallest sufficient patch or reject all three. |

Implement each candidate in a separate checkout based on the same captured
baseline. Keep the accepted inverse transport, source restrictions and typed-face
root checks fixed unless stage 2 specifically disproves an assumption in them.
Any such change requires a separately stated contract and renewed controls.

No blanket welding, coordinate nudges, constraint deletion, unconditional
acceptance of the fallback fan, hidden retries or tolerance widening. A genuine
terminal crease may require different local graph representation, but that change
must preserve surface-patch topology, boundary incidence and feature identity.

Root executes each viable candidate's focused controls serially within its
declared budget before D's final selection; a candidate ruled out by a concrete
counterexample needs no redundant build. Successful results must retain ordered
coverage, endpoint/source memberships, winding and the represented local geometry. Unsupported configurations must still refuse
explicitly. A net improvement in triangle counts is not a selection criterion.

**Exit:** one reviewed candidate passes the real witness and negative controls.
Preserve the rejected alternatives. Commit the isolated experimental patch,
fixture and evidence; do not enable it in production at this stage.

**Executed selection:** [A-rollback](../research/sfcc-stage3-incoming-connection/README.md)
contains the reviewed A-final runtime and a matching late-refusal preservation
regression. B's chord theorem is retained, but its runtime is rejected after an
executed injected refusal deletes a source-family run. C remains a query prototype.
The source-derived replacement chart establishes the bounded connection; it does
not prove the old Newton parameterization monotone or close the whole component.

## 4. Validate the whole affected component

**Question:** does the local repair produce a valid replacement in its complete
context, including the interface with geometry outside the component?

| Agent | Independent validation emphasis |
| --- | --- |
| A | Geometry in working f64 and emitted f32: invalid faces, winding, distinctness, slivers and local nonincident contacts. |
| B | Combinatorics and interfaces: edge incidence, vertex links, component topology, boundary ownership and matching-stage outside contacts. |
| C | Source obligations: every required chart interval, ordered chain, endpoint, incident patch and metadata mapping. Audit whether A/B's checks miss source loss. |
| D | Reconcile all inventories and certify only the obligations actually tested or proved. |

Freeze the selected integration, rerun its focused controls, then run one bounded
private reconstruction of the full selected component. Every selected cell must
succeed; a new first failure becomes the next focused witness. Do not interpret
passing the original cell as completion of the component.

For the selected A packet, first reidentify feature/component obligations by source
occurrence and geometry. Dense curve IDs, ranges, corner incidence, fingerprint,
query semantics and inline storage changed. Regenerate dependent faces, pins and
source intervals; reuse old 198/396 results only after demonstrating identical
inputs. Re-establish complete storage/reservation/lifecycle bounds before the new
component run. The selected isolated source is the captured Stage 1 baseline plus
the archived flat A-rollback patch, not a patch applied directly to current HEAD.

**Current attempted result:** [source admission refuses](../research/sfcc-stage4-component-validation/README.md)
on the correctly identified physical/alias pair `[20,38]`, both with range `[0,31]`
and upper corner `-1`. Their upper numerical points differ by about 0.0023014 mm.
The unchanged private gate rejects before transport, octree, faces, staging or
construction. Selected repair controls and source-only clone accounting pass,
but actual combined storage and all component geometry/interface exits are not
reached. The conditional capture's success path is compiled, not validated on
the unavailable component.

The next bounded prerequisite is to capture the current upper raw frontiers and
derive full composed-field continuation, branch transition or legitimate
termination. Check nonzero blend operands and active domains explicitly; old
zero-locus equivalence does not supply that contract. Preserve the accepted lower
repair, prove any ordered outgoing handoff, then rerun the unchanged complete-arc
admission before resuming component construction. No endpoint welding, invented
corner, smaller obligation or relaxed admission is authorized by this refusal.

Check these independently:

1. All required consumers/faces/pins remain accounted for; the 198/396 historical
   certificates remain identical when their inputs are unchanged, or are freshly
   justified when a contract explicitly changes those inputs.
2. Boundary/frontier coordinates, connectivity and source obligations match the
   retained surrounding mesh. A matching point set alone is insufficient.
3. Every emitted triangle is valid after f32 conversion as well as in f64, with
   appropriate winding, edge incidence and vertex links. Internal crease incidence
   is evaluated as a stratified surface, not assumed to be a hole or boundary.
4. Check component self-intersections and nonincident contacts against the complete
   relevant outside geometry at the **same pipeline stage**. Broad-phase exclusion
   must be conservative. Missing outside geometry leaves this exit open.
5. Preserve feature chains, source memberships and complete parameter intervals.
   Keep physical geometry and metadata success as separate verdicts.
6. Candidate construction and every refusal leave the live mesh unchanged. A
   final publication transaction must validate the replacement before mutation.

**Exit:** the whole candidate component passes, not just its target cell. If the
retained surroundings contain an incompatible pre-existing defect, preserve the
obstruction and define the smallest source-justified component expansion as a new
contract. Do not enlarge scope automatically to make a test pass.

## 5. Transfer to current HEAD and establish production behavior

Only begin after stage 4's historical component obligation closes.

| Agent | Independent integration proposal |
| --- | --- |
| A | Minimal dependency port of the selected repair into C0; enumerate which experimental overlay pieces are actually required. |
| B | Native-kernel integration alternative using current types/helpers; audit taper admission, lattice effects and supported-source boundaries. |
| C | Differential integration proposal/control harness: look for accidental semantic changes, default/bridge mismatches and native/WASM arithmetic or worker differences. |
| D | Select the integration, define the evidence invalidation boundary and review the frozen release candidate. |

Do not transplant all 36 experimental files merely because the patch applies.
Resolve the new `CsgNode::Taper` case explicitly: reject unsupported proof admission
until its premises are established. Current lattice construction uses extra levels
even with multi-sheet mode off. Match the witnessed feature by source and geometry,
not by old cell IDs or chart numbers. Re-audit compiler-dependent storage bounds.

First recapture C0's original knob inventory and first failure under explicit
defaults. Compare candidate C1 against C0 with the same toolchain, source, cube,
settings and checker. Record which H0/H1 claims transfer analytically, which were
retested and which no longer apply. An improvement on H0 alone is not a C0 repair.

Run actual native and shipped release-WASM regressions, then the complete knob
and affected collateral cases. Predeclare transforms using the existing rotation
controls plus rotation about normalized `(1,2,3)` by 17 degrees and a translation
`(0.37h, 0.19h, 0.43h)`, where `h` is C0's recorded finest lattice step. Transform
source witnesses with the model, record newly computed cubes, and compare
obligations rather than triangulation identity. Use a bounded worker/transform
pairing; do not multiply every test combination blindly.

Before production integration, run `make build`, applicable native/release-WASM
tests, acceptance checker corruption controls and `make acceptance-tests` on the
five complete torture models. Add the bowl as an explicit collateral case because
the recent construction changes targeted it. Keep experimental multi-sheet and
decimation results separately labeled; they cannot replace default-mode results.
Collect images automatically; manual visual acceptance remains with the user.

**Exit:** the targeted construction family is valid on current native/WASM output
and its declared transforms; preserved obligations show no new defect identities.
Retain all FAIL/INCOMPLETE/TIMEOUT rows. A partial E4 repair may be committed with
those exits explicitly open; it must not be called overall acceptance. If the
baseline has changed during work, freeze a new C0 and repeat affected comparisons.

## Bounds and stop rules

| Work | Initial bound / policy |
| --- | --- |
| Historical diagnostic build | 120 seconds; no-LTO/codegen-units=16 profile, separate from release performance evidence |
| Focused campaign per frozen candidate | 60 seconds total |
| Original-scene private capture/reconstruction | 120 seconds including preparation; one selected run after prerequisites pass |
| Local/component contact audit | 60 seconds initially; timeout is inconclusive, not a pass |
| Complete acceptance export | Existing 180-second per-model limit; a separately bounded longer diagnosis never replaces it |
| Private geometry | Existing caps: 256 leaves, 1,536 faces, 1,024 pins, 2,048 intervals/events, 4,096 vertices/triangles |
| Queries/source proof | Existing 16,384 total charges, 64 new queries/request, 64 iterations, 128 pieces and 2,048 observer reservation |
| Private reservation | 64 MiB combined policy; preserve checked staging/source accounting |
| Local capture detail | 512 KiB; explicit incomplete/truncated outcome rather than silent omission |

Release builds and GPU capture/setup have separate predeclared watchdogs based
on the existing toolchain; their duration must not consume or extend the model's
export limit. A budget change is a new recorded experiment contract, not an
automatic retry. No need to ask the user again for already authorized diagnostics;
the coordinator and D make the execution decision from the completed packet.

Check disk headroom, host load and memory pressure before heavy work. Reuse bounded
build caches, never run competing heavy jobs, and preserve unique evidence before
reclaiming task-owned caches. Watchdogs kill/reap only their owned process groups.
Do not touch the interactive browser or unrelated jobs. Stop on a first new failure,
source drift, unsupported premise, budget exhaustion or incomplete fixture.

## Remaining E4, E5 and E6

After stage 5, repeat the same three-plus-consensus method for each remaining
construction family, beginning with knob and then Mess 2. E4 closes only when both
complete models emit zero invalid faces and the preservation checks pass. A reduced
fixture or a repaired largest family cannot close that full-model obligation.

E5 then treats two separate packages: feature-chain/source completeness, followed
by raw worker reconstruction. A/B/C compete on missing geometry versus lost
interval/identity metadata versus invalid feature expectations, with D resolving
the source evidence. Worker evidence separates raw merge, recovery and serial
outputs, starting with recorded reverse-order bracket/housing failures and then
2/4/8 workers with declared completion orders. Successful serial recovery does
not establish correct partition reconstruction.

E6 diagnoses Mess 1 under its original 180-second limit, then addresses measured
cost without weakening geometry. A/B/C propose competing phase-specific reductions;
D selects using preservation evidence and repeated paired timing. Keep the existing
one warm-up plus five alternating baseline/candidate pairs, reversing pair order
and retaining every sample. Reassess housing separately on a suitable host.

General multi-sheet reconstruction remains a distinct open problem. It must not
be treated as completed by enabling the current experimental mode or by finishing
this bounded feature-graph repair.

## Evidence and reviewable deliverables

Each stage records: implementation status, executed validation status, accepted
scope, open obligations, source/toolchain/configuration/binary hashes, A/B/C
handoffs and D's decision. Commit compact replay fixtures and regression tests;
keep large immutable captures in `.testresults` with hashes and durable links.
Experimental source remains a reviewable overlay until production gates pass.

The result report must include the complete original cases, SDF/mesh/wireframe/diff
images, triangle counts, export time, separate measurement overhead, f64/f32 invalid
face identities, topology/contact verdicts, feature intervals and source memberships,
coverage status, worker recovery and resource refusals. Counts must not hide newly
introduced defects. Preserve native-only and sampled evidence as such.

The first implementation deliverable is the **stage-1 rejection capture and its
observational controls**. The first repair deliverable comes only after the local
source obligation and regression in stage 2 have been established.
