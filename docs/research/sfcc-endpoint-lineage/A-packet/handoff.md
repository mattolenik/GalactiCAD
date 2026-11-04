# Lineage candidate A: actual trim/wiring provenance

Frozen source: `/tmp/sfcc-graph-lineage-a`, relative to executed
`/tmp/sfcc-graph-stage1-b-reviewed`. Only `trim.rs` and one test-only child module
change. No production repair is attempted. Main runtime is untouched.

## Captured actual lineage

The observer is compiled only for serde-enabled tests. Its RAII scope owns one
bounded event stream and makes no source, curve, gradient, projection or distance
queries. It records values after the existing operations compute them.

The capture records raw-list index and raw curve ID separately, for carrier pairs
10/15 and30/15 (either order). Raw records retain native/type/owner flags, complete
indexing arrays, parameter ranges and corner IDs. It does not assume final chart20
came from raw curve20, or that final tmax31 is a raw parameter. Source occurrence
bindings for strata10/15/30 and the immutable full scene accompany the receipt.

For points within an axis-aligned0.05mm window around the captured corner, events
record the actual curve-point parameter/position, per-flank projected point and
failed domain/residual/normal test, and final flank/classification result. Raw
bisection begin/end parameters are recorded even outside that small detail window.
This is a deliberately bounded observation window, not a claim to trace every
classification of every curve.

The remaining joins are explicit:

- raw curve/list index → actual trim run;
- endpoint-refinement parameter/seed → selected triple improvements or unchanged
  seed when no triple is accepted;
- refined position → new or reused candidate ID and retained candidate position;
- split run/raw range → adjusted raw span, chosen candidate IDs and pre-dedup ID;
- pre-dedup ID → retained final curve ID (or duplicate disposition);
- candidate corner ID → final compacted corner ID and final incidence.

A near-target candidate originating from another raw carrier family explicitly
marks the capture incomplete. Native-corner origins are recorded separately.
This prevents incorrectly attributing a reused candidate solely to the currently
selected pair. Source-family labels and endpoint height alone are not identity.

Raw records expose whether their indexing span extends into the previously
certified positive-height interval. The observer does not claim that an indexing
box alone proves continuous curve coverage. If the first loss already occurs in
raw tracing, this capture identifies that boundary; the deeper tracer stop reason
would require its own focused discriminator rather than blaming trimming.

## Bounds and observational controls

The stream allows at most4096 events and512KiB serialized capture. A counter-only
writer checks encoded size without allocating an unbounded serialized byte buffer.
Individual raw/remade indexing arrays and the aggregate selected final arrays are
bounded at12288 scalar entries; final geometry/remap counts are bounded at1024,
with bounded nearby corner incidence. A failure is explicit `complete:false`.
The capture has bounded native JSON allocation by these collection limits, but
makes no process-RSS or private64MiB-reservation claim. Its allocation is separate
from the old source ledger.

The test compiles the exact full source once with observation disabled and once
with observation enabled. It compares all public curve attributes and indexing
arrays, traced refinement tolerances, all corner positions/incidences, source
identity descriptors with shared-root addresses normalized, unresolved paths and
trace diagnostics. The expected historical feature fingerprint is checked too.
The original hidden geometry constructors and all query expressions remain
unchanged; no repeated whole-source Debug expansion is used as a comparison.

Static stripping of marked observation-only blocks, plus removal of braces added
solely to hold an observation in one match arm, reproduces the original trim.rs
non-comment token stream exactly. The companion static control records the source
hashes and this check. No predicate, return value, evaluation order or original
call count is changed.

Authored focused controls cover inactive lazy payloads, abandoned-scope cleanup,
exact byte boundary/+1, event cap and byte overflow. The capture writes its receipt
before asserting completeness, so missing lineage remains inspectable rather than
silently becoming a pass.

## Root execution

Use pinned Rust1.99.0, offline/locked, existing no-LTO/codegen16 diagnostic profile,
`--features serde,sfcc-profile --lib`. Build under120seconds. Run the control filter
`endpoint_lineage_a_controls` first. If it passes, run
`endpoint_lineage_a_original_feature_compilation`, using fresh
`SFCC_ENDPOINT_LINEAGE_A_RECEIPT`, within the remaining60-second focused campaign.
The latter performs two feature compilations only; no octree, private component,
full mesh/export or browser is involved.

Root should compare the captured final20/33/corner27 values to the committed
stage1 receipt, then follow the actual ID/parameter remaps backward. Do not infer
which phase loses the curve merely from the nearby exposure counterexample.
The receipt initially reports `firstLossEstablished:false`; that interpretation
belongs to the executed evidence and fourth review.

Author performed source inspection, static token equivalence, pinned rustfmt
parsing/formatting and packet hashing only. No builds, test execution or geometry
evaluation was performed. Bounds can explicitly refuse this capture; early
point-status exits without flank evaluation are not reconstructed as flank failures.
