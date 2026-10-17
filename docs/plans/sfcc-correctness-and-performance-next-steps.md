# SFCC correctness and performance plan

Status: execution in progress. Step 1 consensus diagnostics and broad acceptance gate are complete (324 default native tests, 176 profiling library tests plus 11 diagnosis tests, 26 WASM fixtures, and application build). Step 2 consensus and broad gate are complete from the Step 1 milestone (`5b9f190`): application build, 341 native tests, 34 WASM fixtures, and 180 profiling library plus 11 diagnosis tests passed. Step 3 starts from the Step 2 milestone; Step 4 remains pending. Starting implementation revision: `234f3cb`, including discovery implementation `e36db4a`.

The next work proceeds through four steps: identify the remaining failure mechanisms, establish sound numerical exclusion, strengthen discovery of Boolean-clipped components, and optimize repeated work. Each step has three independent competing agents followed by a distinct fourth consensus agent. The next step begins only after the preceding consensus has passed its acceptance gate.

The target is a defensible improvement to the existing exporter, with an explicit supported domain and useful successful controls. General correctness for every accepted scene, universal termination, and a global Hausdorff or embedding guarantee are separate obligations.

## Starting evidence and constraints

- The application build, 324 native tests, and 23 WASM fixture tests passed at the discovery checkpoint. Some native tests still lack their external TS binary-oracle fixtures; their native assertions do not constitute that missing comparison.
- The supplied hidden sphere produces one component and four unresolved cells at default depth. At depth 14 with `surfaceTolMm=1e-5`, two components reconstruct, but 36 cells remain unresolved. Their individual causes have not been established.
- The exact lens example passes the primitive discovery guard. This demonstrates insufficiency of that guard as a completeness certificate; it does not establish that the production feature-aware pipeline misses the lens.
- Current bounds use an engineering roundoff allowance. Original-tree discovery removes one dependence on pruned views, but earlier empty-culling and other pruning still have numerical assumptions.
- Controlled native measurements showed approximately 3–11% overhead on the main controls, 26.5% for four duplicate operands, and 59.8% for sixteen. The 48-sphere blend retained 22,142 unresolved cells and 19 components in both versions; it is a cost workload, not a successful reconstruction oracle.

References: [current algorithm](../sfcc-meshing-algorithm.md), [discovery proof and evaluation](../research/sfcc-discovery-rule.tex), [raw discovery measurements](../research/sfcc-discovery-costs.jsonl), [correctness specifications](../research/sfcc-correctness-proofs.tex), and [fixed-grid obstruction review](../research/sfcc-refinement-obstruction-review.tex).

Keep these constraints throughout execution:

1. Preserve signed original occurrences and their ancestor paths. Candidate counts, leaf IDs, sampled winners, and manifoldness are not component-coverage evidence.
2. Reuse the existing SFCC Rust/WASM evaluator and existing application/GPU sampling paths. Do not add a second production scene evaluator. Independent analytic fixture calculations are test oracles, not a replacement runtime.
3. Preserve explicit uncertainty and existing depth/budget limits. A finite budget guarantees the program stops; it does not guarantee every cell can be accepted.
4. Keep ordinary positive controls as well as adversaries. A policy that makes every multi-primitive seam unresolved is not an acceptable improvement.
5. Keep visual QA manual. Do not inspect `dist/`, create repository-root scratch files, or introduce CRLF.
6. Do not silently change operator semantics, regularize away zero sheets, re-orthogonalize input transforms, increase tolerances, or raise default depth to make a test pass.

## Agent execution protocol

There are **16 planned subagents**, four per step, in addition to the coordinating agent. With four active slots, the coordinator and the three competitors fill the available concurrency. The fourth agent is spawned only after all three competitors finish; it is not a fourth simultaneous competitor.

| Round | Concurrent competitors | Subsequent consensus | Baseline |
| --- | --- | --- | --- |
| 1 | `diagnosis_a`, `diagnosis_b`, `diagnosis_c` | `diagnosis_consensus` | `234f3cb` |
| 2 | `bounds_a`, `bounds_b`, `bounds_c` | `bounds_consensus` | Validated Step 1 result |
| 3 | `coverage_a`, `coverage_b`, `coverage_c` | `coverage_consensus` | Validated Step 2 result |
| 4 | `cost_a`, `cost_b`, `cost_c` | `cost_consensus` | Validated Step 3 result |

### Common instructions to every competitor

Every competitor owns the **entire step**: its hypothesis, mathematical argument, implementation or diagnostic artifact, relevant tests, counterexamples, and cost analysis. The different approaches below encourage independent solutions; they do not split proof, code, and testing among separate agents.

- Start from the same frozen source and acceptance matrix. Include prior consensus contracts and known counterexamples in each task packet.
- Work in an isolated checkout or source copy with a separate Cargo target directory. Shared dependencies may be read-only. A changed kernel needs its own matching WASM artifact; do not validate one variant against another variant's package.
- Do not read another competitor's solution during independent work. Send findings and blocking questions to the coordinator. Contract clarifications go to all three; one competitor's design is not supplied to the others.
- First try to disprove the proposed invariant. State the geometric target, supported inputs, arithmetic assumptions, and what an inconclusive result means before changing acceptance.
- When relying on an existing theorem, cite its primary source and map its hypotheses to this implementation. Distinguish established ingredients from any new result; a literature analogy does not certify the code.
- Run the common targeted matrix plus tests specific to the approach. No weakening, ignoring, or relabeling a failed assertion to manufacture success.
- Deliver a reviewable patch, proof or disproof, reduced reproductions, exact commands/results, complexity bounds, and unresolved questions. Distinguish default runs, instrumented runs, native execution, and WASM execution.
- Do not commit to the shared branch or run expensive full-scene timing campaigns independently. Report all owned process completion before the consensus performance window.

### Instructions to each fourth agent

1. Read all three reports and their actual source, including connected callers and existing tests.
2. Build a claim/evidence table: what is proved, empirically supported, contradicted, or still unknown. Resolve disagreements by reproducing the disputed case or checking the argument.
3. Select the smallest solution that satisfies the complete step, or combine compatible pieces with an explicit explanation. Test count, majority vote, and an attractive mesh are not selection criteria.
4. Preserve independent oracles and useful negative controls when removing duplicate test scaffolding. Re-run the selected tests on the integrated code.
5. Review serial, direct-entry, pruned-query, resumable, and worker paths that the change affects. A serial recovery result cannot establish correctness of raw worker merging.
6. Produce a durable consensus report with the chosen contract, rejected alternatives, exact scope, failures, and remaining obligations.
7. If no proposal satisfies the gate, reject all three. Return a bounded counterexample and rework task; do not advance by weakening the contract. The coordinator can re-engage the original competitors without creating an unlimited agent tree or exceeding four active slots.

The coordinator independently reviews the integrated result and runs the broad validation gate. It advances automatically after each technical gate passes. Each accepted step becomes a separate reviewable milestone commit. Competing variants stay isolated; publishing or pushing is a separate action. Milestone results are recorded only after validation.

## Step 1 — Identify the remaining failure mechanisms

### Question and deliverable

Determine what the actual production pipeline does with the lens, and why each of the 36 final cells in the fine hidden-sphere fixture remains unresolved. Produce a reproducible failure ledger and narrowly scoped diagnostics. This step should explain behavior before attempting to change it.

### Three competing approaches

| Agent | Primary approach | Required independent challenge |
| --- | --- | --- |
| A | Capture reason and provenance at the actual decision branches, including refinement and recovery rounds. | Prove that the observer does not change decisions, meshes, or diagnostics when enabled. |
| B | Capture actual cells and replay their predicates independently, with analytic geometry witnesses and controlled changes to depth/quality settings. | Separate the first executed rejection from other possible reasons; a counterfactual replay is not the original execution trace. |
| C | Follow expected components and features through serialization, feature compilation, trimming, octree decisions, meshing, and worker merging. | Find the first stage that loses or leaves a required object unresolved, rather than attributing every failure to refinement. |

All three must investigate both the lens and the fine hidden-sphere fixture and propose a complete explanation. The fourth agent chooses the smallest reliable diagnostic mechanism and reconciles the ledgers.

### Work sequence

1. Freeze scene JSON, world cube, effective tolerances, depth settings, quality switches, source revision, and native/WASM toolchains. Preserve the existing default hidden-sphere fixture as a separate control.
2. Run the lens through the actual bridge with normal strata and feature construction. Its local mathematical witness is the intersection of radius-10.01 spheres centered at `(10,0,0)` and `(-10,0,0)`, unioned with the box `[-3,-0.5] × [-3,3]^2`. The lens lies within `|x|≤0.01` and `y²+z²≤0.2001`, separated from the box. Use a world cube containing the entire exported object; do not substitute the local witness cell for the export domain.
3. Independently check connected components, their geometric locations, the separating gap, and expected exposed seam geometry. If production already reconstructs the lens, retain that positive result. Keep the guard-only counterexample separate.
4. Exercise a bounded matrix of grid phases, translations, uniform scales, and legal depths. Include near-tangent lenses, Boolean-clipped caps, and a cavity variant. Reduce any demonstrated production failure to a small reproducible scene.
5. Trace the fine sphere case at depth 14 and `surfaceTolMm=1e-5`. Attribute all final unresolved cells; also distinguish behavior at the default `0.01` tolerance. Do not assume the remaining cells are all quality failures or all discovery failures.
6. Trace relevant serial and worker paths, including the existing zero-failed-cell/no-recovery case and a separate forced-recovery case. Reconcile the final unresolved count with the actual final cells.

### Diagnostic contract

Use stable cell coordinates/level, export and round identity, and original occurrence paths where needed. Candidate categories include feature classification, forced re-refinement, primitive corner/edge/face ambiguity, arithmetic indeterminacy, root/curve visibility, sampled normal criteria, balance-induced subdivision, projection/chord budgets, and meshing fallbacks. Final categories must reflect the source's actual branches.

Record the first triggered decision reason separately from secondary facts obtained by replay. Track parent/child history and the round responsible for a final cell. Keep decision attempts, split requests, final degenerate cells, and failed-cell accounting distinct. Do not sum intermediate attempts into final unresolved counts or double-count failed degenerate cells.

Prefer a test/profile observer or bounded export-local trace using existing diagnostics. Avoid a new UI or mandatory worker wire field unless the evidence requires it. If a trace budget truncates records, mark the ledger incomplete; truncated evidence cannot satisfy the full-attribution gate. Nested serial recovery must not leak counters across exports.

### Acceptance gate

- Every final unresolved cell in the selected fine fixture has reproducible provenance; totals reconcile with validation and recoveries.
- The lens has an independently established production outcome. A passing guard alone is never reported as an exporter failure.
- Diagnostics enabled/disabled preserve existing decisions, canonical oriented mesh geometry, validation status, and feature tags.
- Workers at 1/2/4/8 partitions and reversed completion preserve the required evidence; the designated raw-merge cases explicitly forbid recovery.
- Every claimed defect has a reduced witness and identified first failing stage. If a case is simply beyond a stated budget or template capability, report that outcome without inventing a defect.

Primary code: `sfcc/pipeline.rs`, `refine_criteria.rs`, `octree.rs`, `validation.rs`, `worker.rs`, the discovery tests, and feature compilation/trimming code as the trace requires. Paths are under `gcad-wasm/kernel/src/` unless otherwise specified.

Expected artifacts: a fixture/first-failure ledger, runnable diagnostic tests, a small instrumentation patch if needed, and a Step 1 consensus report. No meshing acceptance policy change belongs in this step.

Consensus deliverable: [Step 1 diagnosis and evidence](../research/sfcc-step1-diagnosis.md). The integrated observer combines actual branch attribution, captured-cell replay and feature/triangle provenance. All 36 fine cells first reject at sampled normal variation; the ordinary lens reconstructs both components with explicit unresolved status. The contained-cell and depth-10 failures are retained as bounded witnesses. Focused checks and the coordinator’s final broad validation are recorded separately; the broad gate passed and Step 2 is authorized to begin.

## Step 2 — Establish sound numerical exclusion

### Question and deliverable

For supported sphere/box hard CSG, establish when a computed interval can safely exclude zero over the actual queried region. Implement that contract at every relevant discard boundary. Improving the discovery helper alone is insufficient because the octree can discard a cell before calling it.

### Three competing approaches

| Agent | Primary approach | Required independent challenge |
| --- | --- | --- |
| A | Outward interval evaluation of primitive formulas and transform operations, with checked hard-node composition. | Derive bounds for the operations actually executed, including underflow, overflow, and library norm/square-root operations. |
| B | Analytic geometric enclosures for spheres and transformed boxes, with explicit error bounds for represented transforms and coordinates. | Demonstrate enclosure of the declared field under the matrices actually emitted by serialization, not only ideal exact rotations. |
| C | A proved fast floating filter with conservative fallback when its error test is inconclusive. | Show that every fast exclusion is justified and fallback exhaustion yields uncertainty, including on WASM. |

Each submits a mathematical argument, implementation covering all identified callers, independent tests, and a cost comparison. A single final `next_up` or a larger empirical epsilon does not constitute a proof.

### Contract to settle before implementation

- Define the continuous real-valued geometric field induced by supported serialized inputs. State the relationship between that field, rounded transforms, and floating evaluation. Enclosing a finite set of computed sample values is not the desired theorem.
- For a region `Q`, a valid result `[lo, hi]` encloses the declared field throughout `Q`. Only `lo > 0` or `hi < 0` permits zero exclusion. Equality remains possible.
- Uncertain arithmetic yields a conservative enclosure or explicit uncertainty. Intentional opaque bounds are distinct from malformed geometry and accidental NaNs; min/max must not hide invalid arithmetic.
- Query boxes must enclose the actual cell, point, edge, or face coordinates used by the caller, including rounding in coordinate construction.
- Treat serializer-generated approximate rotation matrices explicitly. A tolerance test is not proof of exact orthogonality. Do not silently alter matrices or the scalar field to obtain a cleaner theorem.
- State the allowed parameter domain and exceptional cases. Preserve useful ordinary rotated/scaled scenes; rejecting every rounded rotation is not an acceptable substitute for addressing the representation.

### Work sequence

1. Inventory all interval and discard users: leaf and CSG box/ball intervals, `certified_empty`, initial descent and child culling, discovery signs, and region-pruned views. Identify any caller that substitutes a scalar sample or gradient estimate for a bound.
2. Reproduce failures of the existing assumptions using boundary ULP cases, cancellation, large translations/tiny gaps, scale factorization, approximate rotations, subnormals, extreme finite values, zero touching, and invalid input.
3. Derive operation-level enclosures and composition rules. Cover both signs, nested min/max, normalized subtraction, and coordinate transforms. Address the actual compiler/target arithmetic; do not assume unproved accuracy properties for a library norm operation.
4. Integrate the selected approach once through a shared checked path. Prove a pruning rule before treating it as certified; where proof is unavailable, retain the full subtree for the certified scope. Do not add unchecked fast paths that bypass the contract.
5. Specify behavior for mixed opaque/supported expressions without inventing a guarantee for unsupported operators. Expand that scope only with additional bounds and tests.
6. Test the real culling pipeline with known zero witnesses, not only the interval helper. Deliberately insufficient depth must retain the appropriate unresolved cell.

### Independent evidence

Use exact rational comparisons where the geometry permits them and validated algebraic or arbitrary-precision enclosures where necessary. A fixed-precision decimal evaluation or dense sample grid is supplementary evidence, not a universal enclosure oracle. Keep reference calculations separate from the production formula being tested and avoid introducing a second general scene evaluator.

For known points or sets satisfying the supported field's zero equation, neither ancestor exclusion nor initial/child culling may remove the region containing them. Include both exact-contact and comfortably separated positive/negative controls. Co-scaled cases with representable clearance should retain their geometric classification; precision-limited cases may become uncertain, so do not require identical cell counts across arbitrary magnitudes.

### Acceptance gate

- The proof states the field, arithmetic model, parameter scope, operation bounds, transform treatment, and caller conditions precisely enough for the fourth agent to check them.
- Independent witnesses expose no false exclusion in the targeted matrix, including production culling and coarse pruning. Passing tests alone does not substitute for the argument.
- Native and actual WASM execution satisfy the same exclusion/uncertainty contract. Diagnostics remain honest at the ceiling and through workers.
- The guard and the earlier discard paths use compatible guarantees; there is no retained unproved cull that invalidates the claimed supported result.
- Existing successful controls stay useful. Record extra refinement and cost explicitly; a whole-scene uncertainty flood fails the usefulness gate.

Primary code: `sdf.rs`, `math/similarity.rs`, `math/grid.rs`, `sfcc/octree.rs`, `refine_criteria.rs`, and pruning consumers in `pipeline.rs`/`worker.rs`. Tests extend field bounds, scene transforms, discovery, and actual WASM boundary controls.

Expected artifacts: an exclusion theorem with an explicit machine-arithmetic contract, a caller coverage table, adversarial oracle fixtures, the selected implementation, and measured work/cell changes. If proof covers only a restricted domain, state that restriction and keep all other cases outside the certified result.

Consensus deliverable: [Step 2 numerical exclusion](../research/sfcc-step2-exclusion.md). The selected geometric enclosures use the actual baked coefficients; supported hard query views retain every occurrence, while checked cell regions cover nominal dyadic cells and existing rounded coordinate constructions. Independent native/WASM oracles capture their actual input bits. The coordinator broad gate passed; Step 3 is authorized to begin from the committed result.

## Step 3 — Discover Boolean-clipped components and justify local acceptance

### Question and deliverable

Determine whether the exposed pieces inside a cell are completely represented and whether the current mesher can fill them compatibly with neighboring cells. Primitive visibility is necessary but insufficient: individually visible spheres can form a hidden lens after intersection.

Start with valid hard CSG over spheres and boxes, using the Step 2 exclusion contract. Include actual exposed two-surface seams. Handle singular tangencies, coincident/opposite-sign fields, and unsupported arrangements explicitly; do not silently adopt different regularized-solid semantics.

### Three competing approaches

| Agent | Primary approach | Required independent challenge |
| --- | --- | --- |
| A | Local analytic arrangements of sphere/sphere, sphere/plane, and plane/plane intersections, clipped through signed ancestor domains. | Account for closed loops, inactive branches, coincidences, and multiple exposed pieces without assuming one candidate means one component. |
| B | Certified interval subdivision with exclusion and local charts for edge roots, face curves, and interior pieces. | Establish coverage and uniqueness where claimed; finite seeds, residual convergence, or subdivision alone are insufficient. |
| C | Verify the existing feature and face graphs against independently enumerated regional obligations, using a narrowly bounded fallback for missing local cases. | Show why an uncompiled component cannot escape the verification; checking only the already compiled curves is insufficient. |

All three must implement and test a useful bounded acceptance rule, or provide a concrete obstruction to their approach. Their implementations must preserve useful ordinary seams, not make every multi-primitive cell permanently unknown.

### Required local obligations

The chosen rule must account for these separately:

1. **Exposed domains:** every potential boundary piece and relevant branch/feature event is represented or conservatively excluded through its complete signed ancestor path.
2. **Edges:** all relevant crossings are accounted for, including equal-sign multiple crossings and ambiguous tangencies. A sign-changing edge is not globally unique merely because each primitive is convex.
3. **Faces:** the complete represented trace includes closed interior loops, multiple arcs, order, and incidence. Four corner signs cannot certify this.
4. **Cell interior:** every exposed connected piece is linked to a represented boundary/feature structure, or explicitly handled as a closed internal component. Piece count cannot be inferred from primitive IDs.
5. **Mesher capability:** the certified local topology matches a filling construction the implementation actually supports. Certifying an annulus or multiple patches does not make a single-disk template adequate.
6. **Interfaces:** neighboring cells agree on canonical shared face geometry and incidence, including 2:1 subdivisions, crease parameters, orientation, and worker partitions.

Use conceptual outcomes of excluded, certified for a supported local construction, or unresolved. Prefer existing data structures where they suffice. Passing the current `NoDiscoveryRejection` result must not be renamed or reinterpreted as full coverage. An incomplete certificate requests refinement and remains unresolved at the existing budget ceiling.

Scope is separate from that outcome: a blend or unsupported family outside the new theorem does not become certified by omission. Preserve its existing behavior and explicit coverage limitation unless a broader policy change is justified. The absence of a new proof for an opaque subtree must not, by itself, force every legacy blend to maximum depth.

### Work sequence and tests

- Begin with Step 1's actual production outcomes. Retain the lens as a positive control if existing feature compilation already handles it; target demonstrated gaps and incomplete acceptance reasoning without manufacturing a failure.
- Include hidden lenses, clipped caps, exposed and buried seam loops, narrow intersections/cavities, multiple face arcs, triple intersections, and near-tangent limits. Keep ordinary sphere, planar box, and successfully resolved two-surface seam controls.
- Specify expected component locations and seam/face topology analytically. Test both missing and spurious structures. Connected components and correct incidence are distinct from vertex proximity.
- Test reordered hard operands, signs, duplicates, coherent transforms and grid phases. Do not impose hard-CSG order invariance on non-associative smooth blends outside the scope.
- Exercise the guard, real feature-aware exporter, shared faces, and actual worker merges. A cell certificate must survive integration with the existing local mesher and cleanup.
- Keep vertex residual, triangle-interior field error, Euclidean distance, and topology as separate claims. This step does not acquire a Hausdorff or f32 embedding theorem from a component test.

### Acceptance gate

- For every certified local case, the argument accounts for all exposed pieces and the supported filling/interface construction. The fourth agent actively seeks a missed loop or component satisfying the proposed premises.
- Targeted production scenes reconstruct their independently specified components/features or identify the responsible region as unresolved. Unrelated warnings do not satisfy the gate.
- Success controls still have genuine successful certificates; there is no blanket rejection of ordinary multi-primitive seams.
- Any previously unresolved cell that becomes accepted has a stated justification stronger than a tolerance increase or favorable sampling.
- Known fixed-grid/template obstructions remain respected. Increasing depth is not a proof that a finite accepted partition exists. If a bounded fallback is necessary, its scope and conformity obligations must be explicit.

Primary code: `sfcc/feature_set.rs`, `feature_curves.rs`, `seam_trace.rs`, `trim.rs`, `segment_exposure.rs`, `refine_criteria.rs`, `face_contour.rs`, `cell_mesh.rs`, and integration through `pipeline.rs`/`worker.rs`.

Expected artifacts: a bounded local coverage/acceptance contract, proof or exact counterexample for each proposed condition, independent geometric fixtures, an integrated implementation, and a revised failure ledger. General curved-CSG termination and unsupported blend/periodic families remain separate until their premises are addressed.

## Step 4 — Reduce repeated work without changing the accepted contract

### Question and deliverable

Reduce measured cost while retaining signed ancestry, conservative uncertainty, mesh decisions, and validation. Compare each candidate with the validated Step 3 baseline; use the original discovery measurements only as labeled historical context.

### Three competing approaches

| Agent | Primary approach | Required independent challenge |
| --- | --- | --- |
| A | Validate immutable primitive/transform data once per export and reuse the checked result. | Preserve validation for direct APIs and invalidate correctly across changed scenes, reused IDs, transforms, and nested recovery. |
| B | Share identical primitive interval/sign work while keeping every original signed occurrence and ancestor path. | Use keys that include every field and coordinate affecting the calculation; approximate geometric equality or reused leaf IDs cannot establish equivalence. |
| C | Reuse per-worker scratch and compute shared cell/edge/face query boxes once as needed. | Preserve exact query coordinates, reentrancy, cancellation, recovery isolation, and bounded retained storage without penalizing the common single-candidate case. |

Each agent must submit a complete optimized variant, correctness argument, the common regression matrix, structural cost results, and preliminary fast-case measurements. The fourth agent may select none if the gains do not justify the added state or complexity.

### Correctness contract

- Exact geometry may share computation; it does not merge ownership. Opposite signs, distinct domains, duplicates with identical advisory IDs, and near-duplicate thin shells remain semantically distinct.
- Equivalent mathematical formulas are not automatically equivalent floating computations. Preserve the established arithmetic path unless a separate proof and tests justify the change.
- Scope caches to immutable data and valid regions. Test scene rebuilds, transformed parameters, identity reuse, repeated exports, cancellation, independent workers, and nested serial recovery.
- Retain validation in direct entry points. A prevalidated pipeline context must not become a public unchecked bypass.
- Require unchanged decision/tagged-leaf results, validation and represented feature chains, plus matching canonical oriented mesh data on the unchanged contract. A proposal that changes exclusions or acceptance belongs back in Steps 2–3 with its own correctness review.
- Preserve candidate identities and the work bound. Reduced query counts are allowed; update tests that currently assert uncached exact counts while retaining coverage and complexity assertions. Do not weaken geometric tests for performance.

### Measurement protocol

1. Build the same harness, compiler, release settings, and scene/tolerance matrix for baseline and candidate. Record source and artifact hashes, toolchain, architecture, and features.
2. Separate normal release timing from `sfcc-profile` counters. Measure total export time, relevant stages, final/decided/unresolved cells, interval queries, allocations or peak scratch where measurable, and worker behavior. Retained buffer capacity is not the same as live candidate count.
3. Include box, sphere, default and small seams, hidden sphere, four/sixteen duplicates, many buried hard leaves, and the many-hard hidden case. Add successful/failing representatives introduced by Steps 2–3.
4. At consensus, stop other agent builds/tests/benchmarks. Use alternating baseline/candidate pairs, five fast samples per version with matched warmup policy, and preserve raw observations.
5. Recheck the existing expensive 48-sphere blend at the final performance gate, or earlier if a changed path could materially affect it. One consensus runner performs matched three-sample timing; do not repeat the roughly 10-minute comparison in all competitors. Profile work is measured separately.
6. Run real WASM timing on a small targeted subset if claiming a WASM speed improvement. Native timings alone support native cost claims; no browser or GPU performance claim follows.

### Acceptance gate

- Correctness and uncertainty behavior match the validated baseline, including worker and recovery paths.
- The intended workload shows a repeatable useful improvement. Compare ordinary-case changes against observed measurement variation, not a threshold chosen after seeing the results.
- Ordinary controls avoid a material unexplained regression; memory growth and added cache lifetime are reported.
- The chosen implementation is justified by its benefit and complexity. If gains are absent or inconsistent, retain the baseline and document the negative result.

Expected artifacts: one selected optimization or an evidence-backed no-change decision, a cache/lifetime correctness argument, targeted invalidation regressions, and reproducible baseline/candidate measurements.

## Validation and handoff between steps

Competitors run focused checks appropriate to their changes. After each consensus integration, the coordinator runs the application build, full native workspace suite, all WASM fixtures, and relevant profiling checks. Repeat broad checks only after a meaningful integrated change, failure, or unresolved concern; do not run every full suite in every competitor.

Use `make build` for application/WGSL/type validation. With dependencies already installed, the previous offline build used:

```sh
PATH="/Users/matt/.cargo/bin:$PATH" CARGO_NET_OFFLINE=true \
  make build -o setup TSX='node --import tsx'
cargo test --offline --release --manifest-path gcad-wasm/Cargo.toml \
  --workspace --no-fail-fast
node --import tsx --test --test-concurrency=1 gcad-wasm/fixtures/*_test.mts
```

Verify installed toolchains at execution time. The previous native measurements used Homebrew Rust 1.99, while the installed Rustup 1.96 toolchain supplied the WASM target. Record the actual choices rather than assuming the default PATH has the required target. Rebuild a candidate's WASM artifact after kernel changes before running its fixtures.

The permanent matrix includes signed/nested ownership, strict exclusion versus contact, malformed and opaque cases, exact edge/face adversaries, the guard-only lens limitation, duplicates/thin shells, useful buried controls, both corner entries, actual >12-leaf pruning, coherent transforms, and 1/2/4/8 worker partitions with reversed completion. Designated no-recovery fixtures retain zero failed cells and forbid serial recovery; recovery is tested separately.

Each accepted handoff contains:

- The exact input revision and selected changes, with rejected alternatives explained.
- A claims table distinguishing mathematical proof, finite regression evidence, unsupported scope, and known counterexamples.
- Updated tests, failure ledger, counts, and cost observations, without counting repeated executions as independent coverage.
- A caller/integration checklist and source/documentation links; compiled research artifacts go outside the repository unless explicitly intended as tracked deliverables.
- No running benchmark processes or unresolved artifact-provenance questions.
- A reviewable milestone commit and a clear input contract for the following trio.

The execution order is strict: diagnosis consensus → numerical-exclusion consensus → clipped-component consensus → performance consensus. A blocked correctness gate returns to that step; it is not deferred into the optimization phase.
