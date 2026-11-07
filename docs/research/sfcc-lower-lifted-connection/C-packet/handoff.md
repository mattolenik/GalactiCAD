# C — query-cost observation with unchanged refusal policy

The candidate is `/tmp/sfcc-lower-c`, copied from the selected A-cell source
`/tmp/sfcc-closure-a-cell`. It changes accounting observations only. It does not
change a geometric predicate, query result, cache key/value, search proposal,
reservation amount, cap, accepted event, validation ordering, or publication path.
Root alone must build and run it. No tests, geometry, builds, or component attempts
were executed by this agent.

## Scope and changed files

- `correlated_transport_a.rs`: fixed-size per-transport counters; cumulative phase
  snapshots; actual new consume count per inverse request (65 bins for 0..64);
  last snapshot on drop, including early refusal.
- `correlated_transport_a_tests.rs`: initializes the added observational fields in
  the existing deliberately failed-query harness. The old test is not otherwise
  changed or claimed current.
- `private_arc_a.rs`: phase markers around reserved admission and initial complete
  transport; counts actual direct external query attempts; records generated-scope
  reservation, attempted/successful work, unused capacity, exhaustion and
  finish-versus-drop. No refund occurs.
- `shared_arc_plan.rs`: phase markers for original rechecks, typed faces, required
  pins, generation, generated validation and post-graph edge transport; records
  generated total, successfully validated prefix and whether graph construction
  had already failed. Direct external attempts are recorded before the actual query.
- `lower_query_cost_c_tests.rs`: two new source-backed controls for query/cache/
  request/total accounting, and repeated inverse work.
- `private_arc_a_tests.rs`: one new generated-scope control for failed attempts,
  nested-scope rejection, finish/drop cleanup and the unchanged 2,048-attempt cap.

No production tree, fixture, configuration, export option or general SDF evaluator
is changed. The existing private construction is never published. The new state is
fixed-size temporary observation (~one KiB per Transport), separate from the
owned source-clone ledger. Existing bounded diagnostic JSON is materialized into
the same receipt. The handful of static phase labels limits snapshot growth;
there is no per-call/event cost log.

## Root execution

Use the current root runner and frozen source with:

- filter `lower_c_`: three tests, nonzero discovery required;
- `SFCC_LOWER_C_RECEIPT`: writes the inverse first/repeated-call receipt;
- retained A-cell focused controls;
- serde-only non-test library check;
- one fresh `stage4_component_b_original_source_attempt` under the unchanged
  120-second preparation-inclusive cap.

Read `admissionAndQueryEvidence.queryCosts`, `lastQueryPhase`, and
`generatedQueryCost` in the resulting component receipt. Phase rows are cumulative;
subtract successive rows to obtain phase costs. `generatedValidated` is only the
successfully completed validation prefix; its difference from `generatedTotal`
is explicitly not accepted. Existing graph capture and privateMesherFailure remain
unchanged, so the first graph refusal and later validation refusal stay distinct.

`queryCosts` invariants:

1. `charged = consumeAttempts + externalReserved` exactly, including failed consumes.
2. `cachedEvents = consumeAttempts - consumeFailures` for this immutable cache;
   failed consumes are never inserted, retried failures are charged again.
3. `mapRequestNewQueryHistogram[k]` counts map calls (successful or failed) that
   actually invoked consume `k` times. Its sum equals `mapCalls`; all `k <= 64`.
4. A cache hit does not spend a new curve-query slot. It still increments lookups,
   and the unchanged query cancellation check remains before cache lookup.
5. Failed external reservations leave `externalReserved` and `charged` unchanged;
   attempted reservation calls and total-cap refusals still record the failure.
6. Generated 2,048 slots remain charged on finish, drop, failure and exhaustion.
   Actual failed/abandoned probes count, including NaN queries rejected by the real
   checked-curve entry. The 2,049th call is refused before evaluation and absent
   from attempted work, while exhaustion is true.

These counters measure curve-query calls, not all field samples or wall time.
ConsumedPiece validation and retained-point checks perform source predicates;
those operations do not become equivalent work merely because each consumes one
curve-query slot. External admission is reserved conservatively and is not
individually instrumented as actual field/curve calls by this packet. External
single-query calls in required/generated point validation are counted explicitly.

## Static audit findings

The current total is deliberately a conservative charge, not a performed-query
count. `reserve_external(2048)` increments Transport.total before the mesher can
make any generated query. `GeneratedQueries::finish` takes the log and disables
that scope, but no unused reservation is returned. On the old capture 838 actual
attempts leave 1,210 unspent slots charged. This observation alone does not show a
refund is sufficient to pass or permit releasing performed work.

The inverse already caches successful `(chart, parameter bits)` checked events
under one immutable source instance. Repeating the same inverse follows the same
cached knot/midpoint path and can have zero new queries while still redoing height
search, outward separation checks and many lookups. A correspondence cache would
primarily address repeated CPU work; it does not necessarily solve cap exhaustion.
The new fixed histogram and phase counters distinguish this from hundreds of
new source-to-alias inversions on distinct generated parameters.

The current generated-validation loop intentionally runs after a cell's graph
has already refused. If it then reaches TotalCap, the returned Refusal identifies
validation rather than the earlier graph failure. This candidate does not reorder
that loop. The recorded graph_failed flag, validated prefix and unchanged graph
capture establish chronology without suppressing an unmet obligation.

A future refund would require a reservation lifecycle bound to this exact
Transport and the stopped generated scope: allocated slots stay unavailable while
callbacks can run, every successful or failed performed query stays charged,
and unused slots can be released exactly once only after the scope is disabled.
This packet implements no such policy. A future numerical inverse proposal could
reduce fresh bisection queries, but must still be accepted only by the same actual
source/branch/container/query/3D-distance checks and the unchanged 64/16,384 caps.
The measurements should decide whether either change is worthwhile.

## Not checked

No build/test/geometry result is claimed by this agent. Root reported the archived
Rust 1.99.0 installation was removed and is revalidating with Rust 1.99.1; neither
old binary equality nor the archived standard-library ownership hashes are assumed.
No whole-component, native/WASM/GPU or full-model correctness follows from this audit.
