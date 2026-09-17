# SFCC performance improvements: implementation plan

Status: implementation delivered September 10, 2026; see [results](sfcc-performance-improvements-results.md) for passed geometry/runtime checks and the remaining native peak-memory exceptions. The original plan below was proposed September 9, 2026. Based on the [performance analysis](../sfcc-performance-analysis.md) and its [measurements](../sfcc-performance-measurements.json). This plan changes computation cost while preserving the current SFCC result and validation behavior.

## Objective and scope

Implement the improvements with the strongest combination of measured benefit potential and a verifiable equivalence contract:

1. Evaluate each hard-CSG candidate scalar once during winner selection.
2. Reduce allocations and redundant work in exact intersection predicates.
3. Reuse field and ancestor-survival computations within one geometric query.
4. Reuse tolerance-independent patch preparation across strict/coarse attempts.
5. Reuse successful feature classification and lattice values across recovery rounds, preserving the existing rebuild algorithm.

The first four primarily address the experimental path, while field reuse and recovery caches can help default exports. Reference medians are 23.550/104.862 s for housing baseline/all-stages and 16.864/68.073 s for bracket. Housing's experimental cell bucket alone is 31.980 s; its final audit/validation interval is 23.313 s. Default recovery repeats 8.172 s of housing work and 7.227 s of bracket work. These are opportunities, not promised savings.

Full incremental contour/topology repair, worker-context persistence, distributed octree decisions, carrier-index construction, and incremental remesher connectivity are follow-up work. They require broader invalidation or scheduling changes than the first implementation should take on. In particular, the recovery slice below cannot eliminate the entire measured recovery duration: contouring and meshing still rebuild.

## Required invariants

- Keep all current tolerances, depth/recovery limits, candidate ordering, edit budgets, analytical feature identities, and quality defaults. Quality stages remain opt-in.
- Preserve scalar and raw-gradient bits on the same backend. Keep the distinction between `CsgNode::f` and raw `FieldSample.value`; do not assume they are interchangeable merely because they describe the same surface.
- Preserve hard-CSG `total_cmp` selection and tie behavior, signed zero, nested smooth-operation ordering, and raw derivative magnitude. Do not reassociate arithmetic as part of caching.
- Preserve every ancestor-survival, branch/partner, domain, displacement, orientation, topology, and f32 contact check. Equal final distances do not establish equal analytical ownership.
- Preserve exported geometry, feature memberships, validation results and failure counts. Existing incomplete validation must remain visible. Preserve cancellation and the isolation provided by `NumericalGuard`.
- Keep the default kernel dependency-free. Extend the existing Rust evaluator; introduce no separate scene evaluator or preview shader changes.
- Keep caches bounded and scoped to an immutable query/export. No spatially quantized point keys, shared mutable process-wide scene caches, or pointer identities in worker payloads.

## Delivery sequence

Each row is an independently reviewable change, with its own before/after measurement. Complete its correctness gate before using it as the next baseline.

| Slice | Deliverable | Dependencies | Primary evidence |
|---|---|---|---|
| P0 | Equivalence fixtures and diagnostic counters | None | Current report has stable counts, but not before/after buffer equivalence |
| P1 | Cached hard-CSG winner values | P0 | `min_by` repeatedly evaluates the incumbent subtree |
| P2a | Proven exact-zero shortcuts | P0 | Coplanar/shared-point checks enter allocating exact fallback |
| P2b | Inline exact storage and local predicate reuse | P2a | Audit stacks show allocator and dyadic arithmetic cost |
| P3 | Point-local field/domain query context | P1 | Bracket cell stacks descend from `disk` into `surface_live` |
| P4 | Reusable patch preparation | P3 | Strict/coarse attempts repeat chart and boundary computations |
| P5 | Recovery classification/value caches | P0; measure after P1–P4 | Octree decisions dominate the repeated recovery work |
| P6 | Combined native/WASM validation and results report | All accepted slices | Confirm cumulative benefit, memory cost, and preserved output |

### P0 — Establish a trustworthy comparison

Files: [`sfcc_quality_bench.rs`](../../gcad-wasm/kernel/examples/sfcc_quality_bench.rs), kernel tests, and the existing housing/bracket and quality-worker fixtures under `gcad-wasm/fixtures/`.

1. Capture the production source revision/digests, source/bridge hashes, resolved tuning, native binary/WASM module hashes, and host/compiler versions. Preserve the current uncommitted report/benchmark work and existing PNG edits.
2. Add a deterministic mesh comparison artifact to the benchmark/test harness: vertices with normals, oriented triangle connectivity, feature edges and their memberships, and full validation. For unchanged serial ordering, compare raw buffers. For worker reordering, compare canonical oriented geometry and feature provenance without coordinate rounding. Retain enough data to locate the first mismatch; hashes alone only flag it.
3. Use same-backend old/new results as the equivalence reference. Native/WASM already have small differences; do not introduce a new cross-backend bit-equality requirement.
4. Retain test-only versions of the original scalar-selection and exact-predicate routines for differential checks, alongside independent mathematical controls. Do not add a production tuning UI for choosing old/new performance implementations.
5. Add opt-in diagnostic counters, compiled out of normal timing builds: scalar/raw subtree calls, ancestor checks and query-cache hits; exact fallback/zero-shortcut counts and maximum limb sizes; patch preparation/strict/coarse attempts; recovery cache hits and avoided evaluations. Count allocation behavior in a separate diagnostic harness where necessary.
6. Split audit geometry checks, intersection checks, and index construction in diagnostic timing without changing their execution order. Do not interpret the existing audit-to-`Done` interval as intersection time alone.

Gate: capture a reproducible baseline and verify that instrumentation-disabled builds preserve output. Diagnostic runs and stack sampling remain separate from measured repeats.

### P1 — Evaluate hard-CSG candidates once

Files: [`field_branches.rs`](../../gcad-wasm/kernel/src/sfcc/field_branches.rs), existing field/pruning tests.

1. Replace the comparator-based min/max selection in both `sample_tree` and `sample_pruned` with an ordered scan retaining `(winner, scalar_value)`.
2. Evaluate each child scalar once per selection, updating the incumbent only according to the original comparison/tie semantics. Preserve the empty-combiner precondition and single-child behavior.
3. Continue calling the existing raw derivative evaluator on the selected child. Do not substitute the cached scalar for the returned raw field value; that broader reuse belongs to P3 and requires its own equivalence proof.
4. Leave multi-child smooth selection unchanged in this slice.

Tests: min/max and nested subtraction; equal-valued children with different derivatives; positive/negative zero; representable values immediately either side of ties; repeated operands; finite extreme magnitudes; comparator behavior for nonfinite values if reachable under the current contract. Compare full/pruned raw samples against the original routines and retain scalar/pruning parity controls. Use a counted selection harness to demonstrate one scalar evaluation per child without altering evaluation order.

Gate: identical samples, ownership and final scene artifacts; reduced selection call counts. Measure simple primitives as well as housing/bracket to detect new overhead.

### P2a — Recognize exact zero without allocating

Files: [`predicates.rs`](../../gcad-wasm/kernel/src/sfcc/predicates.rs), [`mesh_edit.rs`](../../gcad-wasm/kernel/src/sfcc/mesh_edit.rs).

1. Add finite-input shortcuts for repeated points in orientation predicates.
2. Add structural zero tests for `orient2d` when all three points have the same x or y coordinate, and `orient3d` when all four have the same coordinate on an axis. Document why each test implies an exactly zero determinant.
3. Keep the floating-point filters and exact fallback for every other case. Do not treat a computed zero determinant, small determinant, or matching carrier ID as proof of coplanarity.
4. Keep nonfinite-input rejection/preconditions consistent with current callers; fast paths must not accidentally accept malformed input that previously reached rejection.

Tests: all repeated-point positions and permutations; signed-zero coordinates; axis-aligned planes and collinear segments at large translations; exact zeros and nearby nonzero determinants; subnormals, underflow/overflow-prone coordinates, and determinant cancellation. Compare against the retained exact reference and independent integer examples whose signs are known.

Gate: identical predicate signs and complete f64/f32 contact results, including pair identities in the diagnostic audit. Zero shortcuts should avoid the exact-storage allocation path on their controls.

### P2b — Reduce exact-storage and triangle-pair overhead

1. Use P0 limb-size measurements to choose a small inline capacity for signed dyadic limbs. Support heap spill for arbitrary binary64 exponent spreads; do not cap or truncate exact arithmetic.
2. Implement the common conversion, shift, add/subtract and multiply operations over that storage. Avoid cloning a whole operand just to negate its sign. Reuse bounded local scratch where it demonstrably reduces allocation; avoid a large fixed buffer at every recursive call.
3. Preserve the old heap implementation under tests as a reference. Add independent carry/borrow, cancellation, exponent-alignment, inline-to-heap spill and maximum-finite/subnormal controls. Use deterministic randomized finite bit patterns, including deliberately near-degenerate configurations.
4. In a triangle-pair test, reuse already computed directed orientation signs. A small local memo must key the full ordered inputs or explicitly account for permutation parity; it must not survive geometry mutation.
5. Skip a duplicate rounded contact evaluation only when both triangles' rounded coordinate representations match those already checked and the same topological IDs are used. Keep shared-edge, coplanar-overlap, duplicate-triangle and T-junction handling intact. Do not apply this shortcut wholesale to tolerance-dependent projection tests.

Gate: same signs, contact-pair set and export artifacts. Report allocations per predicate, spill distribution, contact-stage time, and end-to-end time. If inline storage or memo lookup adds more cost than it saves, retain P2a and revise P2b rather than weakening exactness.

### P3 — Reuse field and ancestry work at one point

Files: [`field_branches.rs`](../../gcad-wasm/kernel/src/sfcc/field_branches.rs), [`branch_surfaces.rs`](../../gcad-wasm/kernel/src/sfcc/branch_surfaces.rs), [`strata.rs`](../../gcad-wasm/kernel/src/strata.rs), [`sdf.rs`](../../gcad-wasm/kernel/src/sdf.rs), patch/edit validation callers.

1. Introduce an internal evaluation context for one exact point and immutable root. Store scalar results, raw samples, and selected children separately; compute raw derivatives lazily. Route recursive evaluation through the context so caching the outer call also saves repeated descendant work.
2. Use a small reusable/sparse workspace initially. Avoid clearing or allocating a whole-tree hash map for every point. Bound retained capacity and measure shallow-scene overhead before adopting denser indexing.
3. Scope node identity to the lifetime of the borrowed root or retained `Arc`. `FieldRef` roots can be shared copies distinct from the pipeline's `CsgNode`: never alias their cache entries using a coincident local stratum ID or an unchecked semantic hash. Start by sharing within each actual root. Reuse across roots only with an explicit verified mapping; otherwise evaluate separately.
4. Thread the context through `FieldRef::surface_live` and domain checks so each ancestor reuses the descendants already evaluated at that point. Return or expose the actual-root raw sample for the caller when root identity matches.
5. Preserve branch overrides, partner lists and fixed native-band semantics. Override samples require a distinct identity containing the override/path/partner context; they must not overwrite the unmodified node sample.
6. Cache tolerance-independent values, gradients and selection results. Reapply survival and domain comparisons for the supplied tolerance. A cached Boolean from a strict query is not an answer to a coarse query.
7. Keep full-tree and pruned-view caches distinct. A pruned query is valid only within its certified box; projection/backtracking outside it must follow the existing full-tree route. f64 points and f32-rounded points also have separate exact point identities.
8. Adopt the context first in `surface_live` and patch/edit validation, then in other measured repeated-query callers. Retain the existing simple entry points as wrappers. Do not cache Newton outcomes across points, tolerances or budgets.

Tests: original versus cached raw sample bits; nested hard and smooth unions/intersections/subtractions; three-or-more-child smooth nearest-pair ordering; branch equality and partner permutations; transforms and equation scaling; hidden operand surface followed by a subtractor returning the final field to zero; both sides of the flange screw holes; distinct roots with identical local IDs; changed points differing by one bit; strict/coarse tolerance changes; full/pruned query boundaries; cancellation/unwind isolation.

Gate: identical per-query acceptance and scene artifacts, with lower subtree evaluation counts and measured cell/validation time. Keep caches local enough that no export-to-export invalidation protocol is required.

### P4 — Prepare a patch once for strict/coarse attempts

Files: [`surface_patch.rs`](../../gcad-wasm/kernel/src/sfcc/surface_patch.rs), [`cell_mesh.rs`](../../gcad-wasm/kernel/src/sfcc/cell_mesh.rs).

1. Separate tolerance-independent patch preparation from acceptance. Preparation owns the immutable boundary geometry, chart coordinates, constrained triangulation/quad candidates, and reusable carrier projections where the projection does not depend on tolerance.
2. Evaluate the strict attempt first. Only on its original failure path evaluate the coarse attempt, using the same candidate order and ranking. Reuse raw field/domain inputs through P3, but repeat all tolerance-dependent comparisons.
3. Do not reuse controlled projection results whose tolerance, convergence epsilon or displacement budget changed. Do not precompute expensive/diagnostic operations that the original early-exit path would never execute.
4. Preserve numerical diagnostic effects. If a skipped repeated operation can record failures, keep that operation uncached initially; do not silently reduce validation counters.
5. Keep current carrier search order and fallback behavior. Candidate-owner propagation and indexing are deferred because reordering the first successful carrier can change ownership and subsequent edits.

Tests: strict success; strict failure/coarse success; both fail; ambiguous/equal-ranked quad candidates; protected collinear boundaries; holes and concavity; the existing cylindrical invalid-diagonal control; f32 degeneration; rejected exposure; projection failure diagnostics. Compare ordered output and acceptance, not just triangle counts.

Gate: preparation happens once on the retry path, while acceptance, ownership, diagnostics and output match the original implementation. Measure retry frequency to establish the actual saving.

### P5 — Reuse recovery computations without changing recovery topology

Files: [`pipeline.rs`](../../gcad-wasm/kernel/src/sfcc/pipeline.rs), [`octree.rs`](../../gcad-wasm/kernel/src/sfcc/octree.rs), [`refine_criteria.rs`](../../gcad-wasm/kernel/src/sfcc/refine_criteria.rs), [`feature_curves.rs`](../../gcad-wasm/kernel/src/sfcc/feature_curves.rs).

Implement and measure two separate sub-slices:

**P5a: successful feature classification memo.** Own a cache in the per-export pipeline context, keyed by exact lattice cell identity `(level, ix, iy, iz)` under its fixed features/options. Cache `classify_cell_features` only when it adds no numerical failures and the export is not cancelled. Initially leave failure-producing calls uncached, matching the existing curve-plane-cache policy. Reuse classification across recovery builds, but preserve the current sequence: classification and its split result first, current forced markers second, then the remaining criteria. Never reuse a final decision that captured an older forced-marker set. Remove the redundant sort of the already sorted feature-grid candidates as a separate small cleanup.

**P5b: retained scalar values with round-local visibility.** Move or share previously computed finite lattice values into an export-scoped value pool instead of cloning a large sample map each round. Maintain a distinct current-build presence set: `has_sample_key` is used by face contouring for hanging-node behavior, so a retained value must become visible only when the current build would have sampled it. A read-only `SampleView` miss must retain its existing non-inserting behavior. Audit evaluation side effects before retaining values; bypass any failure-producing or otherwise stateful query.

Both caches are destroyed on export completion/cancellation. Apply deterministic entry/byte caps that bypass further caching when full, with results unaffected. Keep octree descent, frontier ordering, balance ripple, forced recovery, face construction and point-table reconstruction unchanged. Do not extend this slice to cross-export/worker context retention.

Tests: zero, one and two recovery rounds; cells newly forced after an earlier accepted decision; feature classification that itself requests a split; numerical query failures on repeated calls; hanging nodes and edge-interior samples; unchanged versus newly visited lattice keys; different lattice jitter/depth/tuning across consecutive exports; cache-cap exhaustion; cancellation and nested serial recovery. Compare tagged leaves, face segments, mesh/feature output and full diagnostics with caches disabled. A test must specifically show that a value retained from round one does not prematurely satisfy round two's `has_sample_key`.

Gate: default housing/bracket results remain identical and measured recovery decision/sample work decreases. Do not claim the 35–43% recovery share is eliminated. If successful classification caching has a low hit rate because failures dominate, report that result and defer diagnostic replay/local topology changes.

## Validation and performance acceptance

Use three layers of evidence:

| Layer | Required checks |
|---|---|
| Local correctness | Differential predicate/field/query controls plus independent exact geometry, nested-ownership and invalidation examples |
| Pipeline correctness | Housing, bracket, primitive controls and existing seam/feature tests; identical same-backend output, feature provenance, full validation and contact pairs where affected |
| Execution modes | Native release and actual WASM; baseline, audit-only and all-quality modes; actual 1/2/4/8-worker parity with reversed completion order, retaining existing serial-recovery reporting |

Reuse existing unit/integration suites and fixtures. Extend them for the new failure modes; do not substitute mesh-to-old-mesh comparison for the independent flange, bore, screw-hole and bracket seam assertions. A performance-only change should preserve known failures, not simply reduce their counters.

For performance, run each accepted slice against the immediately preceding baseline, and the final combination against the report's production baseline. Use one warmup and at least five measured exports per configuration on the same host; alternate old/new process batches to reduce drift. Keep workload, tolerances, backend and audits matched. Record all raw times, phase/recovery breakdowns, medians and ranges, exact output hashes, validation, cache size/high water, native peak memory and WASM linear-memory high water. Small primitive scenes guard against per-query setup overhead. No concurrent builds, benchmark instances or sampling in measured runs.

Proposed acceptance policy: require a repeatable reduction in the targeted operation count/allocation cost and relevant scene phase; investigate any total-runtime regression above 5% or peak-memory increase above 10% on an unchanged workload. Repeat noisy comparisons before drawing a conclusion. These thresholds are engineering gates, not predicted gains. A cache that saves calls but loses wall time should be narrowed or removed. If reliable memory measurement is unavailable, explicitly leave that gate open rather than treating output-buffer size as peak usage.

Commands during implementation:

```sh
cargo test --offline --release --manifest-path gcad-wasm/Cargo.toml --workspace --no-fail-fast
make build
make test
SFCC_TEST_QUALITY=1 node --import tsx --test \
  gcad-wasm/fixtures/sfcc-housing_test.mts gcad-wasm/fixtures/sfcc-bracket_test.mts
node --import tsx --test gcad-wasm/fixtures/sfcc-quality_test.mts
```

Use the repository's installed-dependency workaround only when required by the environment, as recorded in the performance report's preceding implementation results. Native/WASM timing uses the existing benchmark entry points; add diagnostics and artifact comparison there. No automated browser visual QA or PNG regeneration is required for an equivalence-preserving optimization. Unexpected geometry changes fail the gate and require diagnosis.

## Completion criteria and handoff

P6 writes `docs/plans/sfcc-performance-improvements-results.md` and machine-readable before/after measurements. For every slice, record implemented behavior, equivalence evidence, runtime/allocation/memory changes and any rejected experiment. Update the performance analysis with a dated follow-up rather than replacing its historical measurements.

The implementation is complete when P1–P5 have passed their stated gates or an explicitly documented measurement has justified omitting an optimization, the combined native/WASM regression checks pass, and all outstanding gates are reported. An unimplemented slice or an unavailable measurement is not a completed gate. Quality defaults remain unchanged; promotion of experimental meshing quality requires its separate geometry and rollout acceptance work.
