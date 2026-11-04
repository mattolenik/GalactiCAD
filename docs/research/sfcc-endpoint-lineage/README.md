# SFCC endpoint loss: actual compilation lineage

The remaining causal discriminator in stage 2 of the
[implementation plan](../../plans/sfcc-graph-correctness-implementation.md)
is complete for this witness. **Finite flank probing prematurely trims the
required crease.** The raw curve reaches beyond the recorded endpoint; later
endpoint refinement and wiring preserve the trimming cutoff rather than causing
it. No geometry repair or production integration is claimed.

This result builds on the [exact graph capture](../sfcc-graph-rejection-capture/README.md)
and the [local replay and continuous source obligation](../sfcc-endpoint-obligation/README.md).
The [fourth-agent result review](result-review.md) independently verifies the
complete causal chain and states the stage-3 repair contract.

## Executed chain

| Stage | Physical curve | Alias curve |
| --- | --- | --- |
| Raw list index / raw curve ID | 103 / 103 | 131 / 131 |
| Actual stored carrier IDs | 10 / 15 | 30 / 15 |
| Raw indexing extent | Extends beyond the checked source neighborhood | Extends beyond the checked source neighborhood |
| Relevant trim result | Last alive point at y=2.6909777686167193 | Last alive point at y=2.6909793801528004 |
| Transition refinement | No accepted triple; seed retained | No accepted triple; seed retained |
| Candidate wiring | Creates candidate 27 at the physical trim point | Merges into existing candidate 27 |
| Pre-dedup → final curve ID | 20 → 20 | 39 → 33 |
| Candidate → final corner ID | 27 → 27 | 27 → 27 |

The actual stored-carrier occurrence descriptors agree with the expected source
paths; they are not inferred from canonical tags alone. Raw parameters and final
parameters are different: traced remaking resets the final range to `[0,31]`.
The record explicitly joins each raw span through remaking, deduplication and
corner compaction to the final curves 20/33 and corner 27.

For raw curve 103, the relevant upper trim boundary is:

| Actual classification | Raw parameter | Height (mm) | Flank outcomes |
| --- | ---: | ---: | --- |
| Last alive, sample 986 | 65.72141966101242 | 2.6909777686167193 | Native side succeeds; cylinder succeeds only on its tenth probe |
| Final dead bracket, sample 987 | 65.72143066963649 | 2.6909800203269927 | Native side succeeds; all ten cylinder probes fail their domain check |

The ten cylinder attempts are both signs at scales `1, 1/2, 1/4, 1/8, 1/16` of
the 0.1 mm probe distance, with the existing direction magnitude. No probe is
reported uncertain in this decisive result: `flank_survives` returns `Ok(false)`,
and `curve_point_status` returns `Ok(false)`. The sample has reached the flank
checks; it was not rejected earlier as an off-domain curve point.

Bisection makes 14 midpoint classifications and stops at the existing
quarter-corner-merge parameter-distance threshold. Its returned last-alive point
is bit-identical to the point later stored as corner 27. Refinement finds no
acceptable replacement and keeps that seed. The later merge/remake/renumbering
steps preserve the same physical endpoint.

Both bracket heights lie inside the continuously checked source neighborhood.
The previous interval argument proves a regular exposed supporting crease there,
and the local query/replay checks retain the same source branch. Thus the stored
cutoff is a boundary of the finite probe heuristic, not a genuine termination of
the represented source crease.

This does **not** show that `domain_contains` is wrong. The observer records its
actual boolean outcome at each displaced probe; it does not record which inner
ancestor rejects each probe. The invalid inference is that failure of the finite
flank search establishes absence of the crease itself.

## Capture integrity and failed attempts

Three agents proposed independent observations/audits, followed by a fourth
reviewer. [A](A-packet/handoff.md) proposed a narrower trim observer;
[B](B-packet/handoff.md) supplied the selected explicit lineage joins;
[C](C-packet/handoff.md) challenged raw/final identity assumptions and the
incomplete feature fingerprint. [Selection and execution contracts](decision.md)
record the required corrections.

The first selected build failed on one `json!` expression requiring parentheses.
That failure was preserved and corrected in a separate source revision. The next
build and four controls passed, but the feature capture correctly failed its
completeness assertion: repeated source payloads exhausted the 512 KiB limit
before the final corner record. It preserved 765 events and the exact compiled
output, but no causal attribution was accepted from that incomplete run.

Root and the reviewer independently found that 32 refinement source payloads
duplicated earlier raw-source records exactly. The reviewed correction replaces
those copies with checked raw-index references, retaining inline data for external
origins. Missing, ambiguous or unequal references mark the capture incomplete.
An expansion control verifies complete event equality. The byte cap, event cap,
observation window, queries and geometry remain unchanged.

| Final check | Result |
| --- | --- |
| Diagnostic build | Pass, 13.983 seconds; 120-second cap |
| Five observation/reference controls | Pass, 0.303 seconds |
| One feature-only comparison/capture | Pass, 1.980 seconds |
| Focused campaign cap | 60 seconds |
| Events / encoded event bytes | 766 / 347,817 |
| Complete compact receipt | 356,778 bytes, below 524,288 |
| Completeness / target lineage joins | Both true |
| Observed vs unobserved compiled output | Exactly equal for the declared complete snapshots |
| Feature fingerprint | `9875508341830920921`, unchanged |
| Expanded old event prefix | All 765 retained old events exactly preserved |

The equality check covers public curve metadata, endpoint links, indexing arrays,
hidden segment/circle/traced geometry and refinement settings, plus all corner
positions/incidences. It does not rely only on the fingerprint. Static stripping
of observation code restores the original trim tokens and query-call sequence.
Source-root address labels are process-local and normalized by sharing partition
when comparing separate compilations. Times are execution records, not benchmarks.

## Artifacts and restoration

- [Complete feature lineage](compact/lineage-B.json)
- [Alive/dead bracket and actual flank results](compact/endpoint-bracket-summary.json)
- [Expanded prefix equality](compact/prefix-equivalence.json)
- [Compact source handoff](compact-packet/handoff.md) and [patch](compact-packet/candidate.patch)
- [Executed source manifest](compact/manifest.json) and [binary identity](compact/binary.json)
- [Retained incomplete capture](selected-fixed/lineage-B.json) and [size analysis](selected-fixed/capture-size-analysis.json)
- [Syntax correction](compile-fix.patch) and [failed build](selected/build-execution.json)
- [Machine-readable causal summary](summary.json)

Restore the executed stage-1 source, then apply the compact packet's full patch.
It already includes the syntax fix and representation correction. Manifest SHA256:
`5dc7bc3246efee636c1f8edf91b9ade34af5c5505cfb7f6be7592f70584cb836`.
The executed manifest records all 157 source/configuration inputs and the pinned
Rust 1.99.0 compiler/profile. The patch remains an isolated test-only diagnostic.
No new field evaluator, octree, private reconstruction, full export or browser
operation was introduced by this package.

## Stage 3 repair boundary

The next candidates must repair source exposure/continuation, not relax the cell
mesher's degree guard. They must demonstrate that the **actual compiled feature
graph** preserves the required source interval and correct identities/order.
Testing a manually extended supporting curve alone is insufficient.

A failed finite search must not be promoted to a proved dead/terminal interval.
Use a justified positive continuation/exposure method and explicit unresolved
results when its bounded premises cannot decide. Keep true terminal creases,
hidden/capped extensions, distinct nearby curves, wrong-source identities and
insufficient budgets as negative controls. Blindly reducing the global probe
factor, nudging the endpoint, restoring a duplicate edge or accepting the fallback
fan does not satisfy this contract.

The source crease later enters an outer rounding region inside this same cell.
That continuation/handoff, including the separately observed intermediate-chamfer
branch issue, remains open. Fixing this short premature cutoff alone cannot
establish a complete component replacement. Full-component f64/f32 validity,
topology, feature transport, contacts, current-HEAD native/WASM checks and the
full-model campaign still gate production integration.
