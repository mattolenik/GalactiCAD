# Candidate C: observational-equivalence and replay-completeness audit

**Reject the narrow strategy “record a rejection name, then reuse the Round 18
post-return boundary snapshot as the replay fixture.”** It cannot establish the
stage-1 replay contract. C provides an independent static rejection inventory,
concrete captured-data counterexamples and a minimal integration contract. No
runtime patch is proposed; `candidate.patch` is intentionally empty. This is a
counterexample handoff, not a third speculative instrumentation implementation.

Source: `/tmp/sfcc-graph-stage1-c`, byte-identical to the restored Round 18 base
`/tmp/sfcc-graph-stage1-baseline`. Main runtime remains untouched. The original
source manifest and archived receipt remain authoritative. Root found the exact
Rust 1.99.0 toolchain and matching audited standard-library inputs; no source
storage or numerical gate changes are needed for this handoff.

## Independent findings

1. **There are sixteen direct false-return sites**, not one degree test. The
   companion `rejection-inventory.json` enumerates each source line, predicate and
   minimum operands against a hash of the complete function. The suspected
   degree-one endpoint is only the sixth direct guard. Earlier failures include
   insufficient incident nodes, failed own midpoint query, failed arc sampling
   and unsupported overlap. A capture must distinguish these actual branches.
2. **The graph mutates private state before refusal.** `corner_point_id` calls
   `get_or_create_str` before the first arc guard. Arc sampling can add points.
   `fan_from_stratum_vertex` mutates points/patch metadata before later sampled
   validation or intersection refusal. Reconstructing an entry snapshot from a
   post-return PointTable can therefore replay a different operation. The old
   surrounding `private_graph_refused` guard correctly discards this private
   mutation; this is not evidence of a live-state mutation bug.
3. **The actual receipt demonstrates incomplete scope despite `truncated:false`.**
   It captures eight boundary point IDs `[60,61,62,618,620,623,624,625]` while the
   actual private table has 634 entries. This is intentionally bounded boundary
   detail, not all graph/entry data. No explicit pre-call corner-point lookup,
   generated interior-point state or ordered adjacency is present.
4. **JSON numeric bit patterns lose precision in binary64 readers.** Actual
   parameter word `4629354576626184382` becomes `4629354576626184192` when routed
   through a JavaScript-style Number: a difference of 190 integer units. Hex
   string `403ec575c721f0be` preserves the original word. Numeric u64 JSON values
   are not a lossless cross-language bit format merely because Rust or Python
   can read them exactly. Verify the hex in the companion data, rather than
   treating this prose as the numeric fixture.
5. **The generated-query log is cumulative, not per graph attempt.** The old 46
   attempts cover multiple private cells. Record a monotonically identified
   graph attempt and its actual generated-query start/end indices. Do not claim
   all 46 belong to the failing graph or infer query order from chart IDs.
6. **Graph failure and final cell flags are different observations.** Both
   `feature_graph_failed = false` assignments in this frozen caller (lines 484/525)
   also increment `feature_cell_fallbacks` and push the fallback cell. The private
   constructor still rejects on that count. C found **no genuinely recovered
   graph-false path that makes this private component continue successfully**;
   flag clearing is not evidence of such recovery. Record the graph return and
   final flags separately. Per-attempt/cell cleanup remains necessary across
   tests, independent calls and success-before-failure sequences;
   `note_active_cell` alone is not that lifecycle mechanism.
7. **Copying state can change behavior if implemented carelessly.** Sorting the
   live adjacency for canonical JSON would change graph walking; reevaluating
   `score`, normals, midpoint queries or geometric support adds work and can alter
   existing query accounting. Record existing results, immutable copies or exact
   values at original evaluation sites. Keep original short-circuit evaluation.
8. **Checking serialized length after constructing unbounded JSON is not an
   allocation cap.** Bound element counts/key lengths and checked aggregate sizes
   before materialization. Keep at most the active attempt and selected refused
   attempt; retaining 512 KiB for each of 199 cells would exceed the intended
   diagnostic scope. The 512 KiB detail policy is separate from both the private
   64 MiB reservation and the typed source-ledger allowance.

The companion `capture-counterexamples.json` records the actual receipt hash,
counts, IDs and numeric precision counterexample. These are static/data checks;
none evaluates geometry or identifies which guard executed in the old run.

## Smallest acceptable observational implementation

Prefer the existing private diagnostic scope, with a disabled fast path outside
that scope. A per-attempt record should contain:

- cell identity/classification and attempt serial; exact cell box and meshing
  option bits; private point count and output-triangle offset at entry;
- exact pre-call loops, pins and corner list, retaining sequence and duplicates;
  corner position, strata and curve-end incidence; relevant curves' source
  identities and parameter spans; the exact private alias edit;
- all point values and key lookup outcomes actually required to reproduce the
  attempt, including whether each corner key existed before entry. Rebuilding
  from positions alone cannot reproduce keyed reuse. If complete table state is
  cheaper than a new dependency tracker, copy the bounded table once;
- at failure, actual graph edges with labels and membership parameter bits,
  existing adjacency in its current order, the specific guard code and already
  computed operands, and new/reused point IDs with exact values;
- query-attempt interval, output range and final cell result. Mark pre-call,
  intermediate and post-call state explicitly, never one ambiguous `points` list.

Tie source reconstruction to the immutable full scene and verified feature
fingerprint/private edits. A structural reference is sufficient only if replay
verifies that rebuilding yields the exact read dependencies. Do not dump repeated
Debug expansions of shared source graphs.

Keep separate booleans/statuses for `guardIdentified`, `captureComplete` and
`replayValidated`. A complete serialized capture is not yet a validated replay.
If a later guard requires state not retained by the chosen narrow schema, report
that gap explicitly; identifying a guard may pass the mechanical diagnosis while
exact replay stays open. Do not claim the entire stage-1 exit on that weaker result.

The sixteen ordinary return paths are not the only possible termination paths:
indexing and unwrap assumptions may panic, and cancellation can stop at callers.
Leave their behavior intact. The observer must clear state during unwind/early
drop and report capture absence/incompletion rather than fabricate a guard code.
No invented preconditions or geometry guards should be added to make observation
“safe” by changing which operation runs.

## Focused controls required before a live capture

Root, not C, runs these against whichever implementation D selects:

1. Observer disabled versus enabled: same graph return, emitted triangles, private
   point/key/metadata effects, and sequence of SDF/curve queries on the same test
   input. Use a counting query wrapper or the existing query observer; do not
   replace field evaluation with a new reference implementation.
2. Empty loops plus an early arc/degree rejection and a success: correct distinct
   codes, no success mislabeled as failure, and correct attempt/cell association.
   The degree control must assert the implemented guard, not mathematical
   invalidity of every degree-one feature.
3. A failure followed by another attempt, a successful attempt followed by a
   failed one, take/drop cleanup and nested-scope refusal: no stale fixture.
4. Maximum allowed collection/key size, one over, exact byte cap/one over where
   representable, and arithmetic overflow: bounded incomplete receipt, unchanged
   geometry and no fabricated replay-complete status.
5. Lossless bit round trips including the recorded parameter word, signed zero
   and nonfinite values as bit strings. A NaN payload must not become JSON null.
6. Static coverage of all sixteen direct returns, plus explicit scope for helper
   failure reasons and panic paths. If only some branches are richly captured,
   that distinction must appear in the receipt and test assertions.

The existing six `correlated_` tests and one selected original-scene diagnostic
remain necessary under the plan's 60/120-second limits. Root should compare live
state digest, face certificates, generated queries and charged queries against
Round 18; observational overhead is not a performance regression claim.

## Execution and limitations

C read source and archived JSON, enumerated and hashed the sixteen direct return
sites, checked the two mutation-order facts, demonstrated numeric precision loss,
and compared every restored runtime file with the immutable base. No Rust build,
Rust test, octree, curve query, source evaluation, private capture or export ran.
There is no C binary or new receipt environment variable. Candidate commands and
filters are therefore **not applicable**, rather than unexecuted code advertised
as a candidate.

D can use this handoff to reject incomplete A/B instrumentation or request one
small correction before root's single selected capture. The actual internal
predicate, its mathematical validity, and any repair remain unproved.
