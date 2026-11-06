# SFCC upper closure: handoff admitted, component advances to new refusals

**The bounded upper handoff now passes private-arc admission.** Native and alias
charts end at the proved source event and connect to the outgoing lifted curve.
The cell sampler now consumes that same positive closure evidence. The selected
isolated packet is **A-cell**, with 26 focused checks and a non-test library build
passing.

**The complete component is still not accepted.** A fresh reconstruction progresses
beyond the original upper cell, then records a lower-junction graph failure.
Subsequent validation exhausts the unchanged private query cap. Both refusals are
preserved in execution order; no partial candidate is published.

[Consensus decision](decision.md) · [Implementation plan](../../plans/sfcc-graph-correctness-implementation.md) ·
[Upper source theorem and operator correction](../sfcc-upper-handoff/README.md).

## What was implemented

The source-derived round activation replaces the two incompatible numerical upper
cutoffs. A bounded transaction requires the actual native, alias and outgoing
source representations. It prepares all three replacements and their joins before
changing the feature set:

- The incoming last spans use the fixed-radius source helix, ending at activation.
- The outgoing first span uses the proved positive-angle source curve, extending
  from activation to an associated existing join.
- The shared event records all three chart ends and every incident source pair.

Original incoming cut proposals receive bounded inverse searches and checked
three-dimensional association. Stored raw ranges are provenance for a checked
replacement; they do not prove universal equality with the old Newton map. In
particular, the old outgoing raw start is not asserted to equal activation.

Incoming source margins are rechecked below activation; sphere inactivity follows
from the algebraic endpoint relation and monotonic radius. Outgoing conditions
retain the previous full-scalar proof. Actual queries keep their original carrier
residual and displacement checks. Failed certified queries cannot fall back to
ordinary interpolation. Exact joins, source images, tangents, indexing bounds,
fingerprint, clone ownership and storage accounting include the new chart semantics.

Positive closure membership is restricted to the stored source/branch/span and
actual query point. Immutable root identity, embedded carrier identity and a fresh
matching source contract prevent a stale certificate from authorizing a changed
model. The discovery ownership band is unchanged. Qualified membership is used by
the four private endpoint/query consumers and, after the first reconstruction
identified a missing consumer, by the cell arc sampler.

Known continuing source events also require the outgoing interval and complete
incident inventory. Deleting the new metadata cannot fall back to incoming-only
endpoint acceptance. Generic legitimate terminals are not rejected merely because
of graph degree. Nearby existing corners, ambiguity, unsupported sources, query
failures and failed proposals remain refusals.

Two source events are constructed in the original model:

| Event corner | Incoming native / alias charts | Outgoing chart |
| --- | --- | --- |
| 55 | 17 / 33 | 84 |
| 56 | 20 / 39 | 76 |

These dense IDs describe the executed inventory; source bindings provide authority.
Counts change from 101 curves / 55 corners to 101 curves / 57 corners. The
discovery diagnostic retains 95 unresolved trims. The lower repair remains intact.

## Why endpoint labels alone were insufficient

C constructs a test-only, source-associated activation corner containing only the
incoming native and alias ends. The old private admission passes its declared
endpoint and transport checks, despite a proved continuing source curve. After
alias removal, only one physical end remains. The mandatory rejection control
therefore fails on that predecessor.

This is a synthetic omission counterexample, not a naturally emitted mesh. It
shows that the old gate cannot be treated as complete incident source coverage.
The new runtime recognizes the proved source event independently of optional
chart metadata and refuses that incomplete event with `upper_event_incomplete`.
It also rejects omitted incident stratum labels.

B independently implements distinct canonical-closure and consumed-query evidence.
It can prove a source point valid while rejecting the detached old outgoing
endpoint. That prototype does not install a connected interval or change admission
consumers; its complete-source gate remains failing. Point membership is not
promoted into whole-handoff authority.

## First reconstruction: a missing cell consumer

With the upper handoff installed, the first bounded component attempt reaches
cell `[7,36,79,29]`. It now has source corner 56 and two distinct pin curves. All
eight recorded own queries succeed. The new failure is
`sample_in_cell_arc_none` on outgoing chart 76, not the old degree-one rejection.

The failed sample is the transition at parameter zero. It is strictly inside the
original cell box, with minimum axis margin about 0.03855 mm. The sampler checks
only discovery ownership, which is false for both lifted strata there; positive
source-qualified closure is true. This isolates a missing consumer of the existing
proof rather than a failed projection or cell-bound violation.

A compact replay reconstructs the full source and exact captured curve/span/box/
options. It calls the actual sampler: old ownership-only mode returns `None`, while
qualified mode returns `Some` with the same endpoint parameters and no new numerical
failure. The replay also covers the private alias-omitted view, narrow-band quarter
queries, reverse direction, and bad-query/source/box/budget refusals. It is a local
sampler replay, not a complete graph replay; the sampler reads no pre-existing
PointTable geometry before this refusal and appends only optional interior points.

The runtime correction passes the actual parameter into all three sampler liveness
checks and accepts ordinary ownership **or the existing tight source certificate**.
Query, residual, box, chord, coalescing and resource checks remain unchanged.

## Second reconstruction: lower graph failure, then query exhaustion

The next frozen attempt completes in **30.389 seconds**, inside its 120-second
preparation-inclusive budget. It records a fresh affected inventory and reservation:

| Quantity | Current evidence |
| --- | ---: |
| Leaf consumers | 199 |
| Required faces | 1,000 |
| Changed/shared faces | 198 |
| Typed pins / pin-to-root bounds | 396 |
| Successful typed-face certificates | 198 |
| Actual staging reservation | 18,921,424 bytes |
| Combined owned-source/staging reservation | 20,243,822 bytes |
| Reservation cap | 67,108,864 bytes |

The certificates and reservation records exactly match the preceding newly
executed attempt; they were regenerated, not copied from historical acceptance.
The older 1,001-required-face count is not reused.

Two distinct failures occur:

1. **Construction first fails at cell `[8,51,116,172]`.** The graph guard is
   `path_nodes_lt_two`: lifted chart 75, source pair `[38,39]`, has only boundary
   pin 453 in this cell. Its range is `[0,13]` and corners are `[31,-1]`. The nearby
   cell corner is 13; that corner does not declare chart 75. A feature fallback
   occurs and its nine returned triangles are not accepted as a replacement.
2. **Post-meshing query validation then reaches `TotalCap`.** There are 838
   recorded successful generated queries. Validation reaches 16,384 charged queries
   and returns `retained_point_own_query` with detail `TotalCap`, before the later
   code would return the already recorded graph refusal.

The final returned reason therefore must not conceal the earlier construction
failure. This does not show that every selected cell meshed successfully, and no
complete candidate reaches final f64/f32 or interface validation.

The live digest remains **`aa6ab69dfb79125d`**, identical before and after both
attempts. The whole private candidate is discarded; no pin-only or partial mesh
publication occurs.

The query ledger reserves 2,048 generated-query slots up front; only 838 were
used here, and the current code does not reconcile the difference. This is
conservative reservation accounting, not proof of an incorrect spend count or
permission to refund it without a lifecycle argument. Reservation reconciliation,
cache reuse and inverse-query costs are concrete next measurements. The cap was
not raised and required validation was not skipped.

## Validation scope

- A-cell: **26 focused tests pass**, including source-event completeness, actual
  admission, source/ownership identity, query/transaction refusals, lower repair,
  source-only clone/storage checks, sampler replay and harness controls.
- The serde-only non-test library build passes. This catches test-only helper
  leakage; it is not native/WASM equivalence or production acceptance.
- B: 17 typed-closure/source/lower controls pass; normal admission still fails
  because it performs no runtime handoff.
- C: three theorem/consumer controls pass, then the required outgoing-omission
  rejection fails against the old admission behavior, providing the counterexample.

Counts overlap across candidates. Root executed builds and geometry serially with
pinned Rust 1.99.0, offline/locked, no-LTO/codegen16, fresh kernel caches and nonzero
test discovery. Build/focused budgets stayed 120/60 seconds. The first component
attempt took 29.737 seconds. Timings are diagnostic records, not export benchmarks.

The feature-construction phase records 453 curve-query attempts and four source
attempts under its explicit finite loop limits. It is separate from the later
16,384 private-admission/construction ledger. No shared accounting claim is made.
Duplicate endpoint queries were removed from the new event guard; the existing
charged endpoint loop still performs its own-query checks.

Earlier failed builds are preserved: A's initial ownership audit attempted `Copy`
on a non-Copy proof, and the first diagnostic composition omitted a test-module
registration. Their corrections were rebuilt and retested. The ownership audit
now traverses copied and retained fields explicitly and checks retained root identity.

## Next work

1. Bind the new lower-cell witness to its actual composed chamfer-region source.
   Establish the required lower incident-curve arrangement and chart 75's ordered
   continuation/closure. The old lower attachment repair is not a proof of the
   complete lower junction. Shared lifted stratum IDs do not authorize reuse of
   the upper round certificate at this different event.
2. Audit query reservation versus performed work, cache/inverse costs, and failure
   reporting order. Preserve both the first graph refusal and any later validation
   refusal. Do not raise the cap or hide unvalidated events.
3. After justified corrections, rerun the fresh complete component. Retain final
   f64/f32 validity, links, interfaces, same-stage outside contacts and complete
   source/patch ownership as separate exits. A one-dimensional curve certificate
   does not certify a whole two-dimensional triangle patch.

## Artifacts

| Artifact | Purpose |
| --- | --- |
| [Consensus decision](decision.md) | Selection, proof limits and next obstructions |
| [Summary](summary.json) | Separate handoff, component and production verdicts |
| [Selected A-cell patch](A-cell-packet/candidate.patch) and [handoff](A-cell-packet/handoff.md) | Runtime integration, local replay and diagnostic composition |
| [Upper transaction handoff](A-minimal-packet/handoff.md) | Canonical charts, source identity, installation and resource scope |
| [Handoff/admission receipt](A-cell/closure-A.json) | Actual source events and checked query evidence |
| [Incoming-only rejection](A-cell/closure-A-event-refusal.json) | New gate rejects the old false pass |
| [Sampler replay](A-cell/cell-replay.json) | Exact captured inputs, old-fails/new-passes and preserved refusals |
| [First component attempt](A-component-fixed/component-attempt.json) | New upper sampler refusal and first fresh certificates/reservation |
| [Second component attempt](A-cell/component-attempt.json) | Complete consumer inventory, lower graph refusal and later budget cap |
| [B typed closure](B-packet/handoff.md) | Independent point/query evidence and scope limits |
| [C counterexample](C/closure-C.json) | Old admission accepts an incomplete synthetic event |
| [Restoration checks](preservation.json) | Every executed input reproduced; certificate/storage invariance checked |
| [Runner](run.py) | Toolchain, watchdogs, library check and conditional component invocation |

Apply one flat packet to the captured Stage 1 baseline in isolation; competing
packets already include prior selected work and must not be stacked blindly.
Exact commands, discovered test names, source manifests and binary hashes are
retained with each execution. Binaries remain local under `.testresults`.

Production is unchanged. Stage 4, full-model validity, native/WASM/GPU agreement,
outside-contact closure and general multi-sheet reconstruction remain open.
