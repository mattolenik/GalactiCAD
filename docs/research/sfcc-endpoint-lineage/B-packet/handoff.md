# B: actual trim and endpoint lineage observation

Frozen source: `/tmp/sfcc-graph-lineage-b`, based on executed
`/tmp/sfcc-graph-stage1-b-reviewed`. Main runtime is untouched. This is a proposed
feature-only diagnostic, not an executed capture or a repair.

## Small scope

Three changed inputs: observation hooks in `trim.rs`, one test-only observer module,
and an appended test-only immutable `FeatureCurve` geometry snapshot accessor.
All hooks/module/accessor are compiled only with `all(test, feature="serde")`.
The status/flank bodies are wrapped to record their existing returned result;
removing the wrappers/hooks restores the original non-whitespace/comment token
stream. The sequence of field, normal, domain, point/projection and triple-solver
call lexemes is unchanged. No observer calls an evaluator or repeats a predicate.
The existing native source compilation is used, not a reimplemented pipeline.

Raw observation selects carrier pairs10/15 and30/15, accepting either order.
Detailed classifier/flank events additionally require the actually computed point
inside x[-6.9,-6.5], y[2.67,2.72], z[-8.65,-8.2]. This spatial window surrounds the
actual endpoint, not arbitrary other arcs with the same pair/height. The raw and
final identities remain explicit; no raw/final curve-ID or parameter equivalence
is assumed.

## Recorded joins and already executed decisions

The receipt records:

- source occurrence descriptors for strata10,15,30, bound by the enclosing original
  scene/configuration and fingerprint. Root-address labels are process-local only;
  the large leaf-index sentinel is string encoded;
- selected raw-list index, raw curve ID, carrier pair, type/native/owner flags,
  range/wrap and complete bounded indexing polyline;
- the actual near-endpoint curve-status sample parameter/point, return reason and
  result, with each executed flank probe's scale/sign/delta, projected point and
  rejection reason. Field residual and normal error are recorded only when the
  original code computed them. Short-circuit carrier-domain failure remains a
  combined reason; it is not reevaluated to invent which operand failed;
- actual bisection input and final alive/dead parameter bounds, plus complete trim
  runs for the selected raw curve;
- transition seed, accepted candidate (if any), output point, distance limit and
  whether the seed was retained. Near the endpoint, direct/alternate triple trials
  record the executed projection/domain/distance branch; the early seed filter
  retains its original combined same-pair-or-far condition rather than adding an
  evaluation for logging;
- candidate insertion/merge with offered and retained positions. Candidate origins
  from other source pairs are retained when their offered/kept position lies in the
  endpoint window, as are native-corner origins. A relevant nonselected refinement
  also records its raw curve descriptor;
- raw-list index and raw ID to split-run and adjusted-remake spans, pre-dedup curve
  data and pre-compaction corner IDs; dedup pre-ID to final-ID; full corner remap
  and the final selected curve/corner records.

The test constructs explicit lineage joins for final20/33, demanding their raw
record, trim runs, remake record, dedup mapping, candidate creation origin and
corner-compaction mapping to27. A missing join fails the test after writing the
receipt. Raw indexing-height extrema are reported as indexing observations, not
as a continuous coverage proof. A large spatial-index span alone cannot establish
that the actual raw trace covers A's source-certified continuation.

## Bounds, controls and equality

The observer has one thread-local owned scope, a per-raw-curve scope and one
current status sample. Scope drop clears state; nested top-level capture refuses.
It retains at most4096 events and8192 indexing words per curve. Element counts
are checked before building large curve records. Serialized event rows are counted
by a nonallocating bounded writer before insertion; checked aggregate accounting
caps them at512KiB. The final complete receipt, including lineage joins, is checked
against the same compact-JSON byte cap. Overflow returns explicit incomplete
metadata, never a truncated complete lineage. This is not a process-RSS claim.

The controls filter `endpoint_lineage_b_controls` tests disabled lazy logging,
scope cleanup, event cap, row-byte refusal and exact writer capacity/+1 failure.
These tests are authored, not run.

The actual discriminator filter
`endpoint_lineage_b_original_feature_compile_is_observational` does two original
feature compilations in one test: first unobserved, then exactly one observed
capture. It checks the known fingerprint and exact curve/corner scalar snapshots:
all public curve flags/owners/end links/ranges/wraps/indexing values; hidden segment
and circle geometry; hidden traced samples/count/refinement settings and carrier
IDs; all corner positions/strata/incidences. Run IDs and source Arc addresses are
execution identities and are not compared. Hidden traced-carrier source
construction is unchanged by static token/prefix verification; no deep Debug
source-tree expansion is used.

The final receipt is written before equivalence/completeness/join assertions, so
failure preserves evidence. `actualLossLocalized:false` intentionally leaves
causal interpretation to root and fourth review. No claim that finite probing is
the first actual loss is hard-coded. No queries are rerun inside the observer.

## Root execution

Use pinned Rust1.99.0, `--offline --locked --release --features serde,sfcc-profile
--lib`, no-LTO/codegen16. Root builds within120seconds, runs the controls first,
then the single original-feature discriminator within the declared60-second
focused budget. Set fresh `SFCC_ENDPOINT_LINEAGE_B_RECEIPT` for the discriminator.
No octree, private reconstruction, whole-mesh export, GPU job or browser is needed.

Author ran source inspection, static observation-stripping and query-call sequence
checks, and pinned rustfmt parsing only. No build, test, feature compilation or
geometry query has run. `static-controls.json` records the checks; candidate and
manifest hashes freeze the proposed inputs for fourth review.

Potential limitation: the bounded event window may omit an upstream dependency
if raw tracing already stops before reaching it, and compact-JSON cap can refuse.
Either outcome is useful but incomplete; do not widen the window/cap automatically
or infer a missing event. A raw-trace stopping cause remains a separate next
predicate if this receipt shows raw input was already short.
