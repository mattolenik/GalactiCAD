# A-cell: consume qualified closure in the actual cell arc sampler

Frozen source `/tmp/sfcc-closure-a-cell`. Parent for this bounded change is
`/tmp/sfcc-closure-a-component-fixed`, the source that produced the recorded
`sample_in_cell_arc_none` component refusal. Common flat-patch baseline remains
`/tmp/sfcc-stage3-base`. The component diagnostic modules are retained from that
parent. No author build, test or geometry execution was performed.

## Runtime correction

`cell_mesh::sample_in_cell_arc` previously called only the stratum discovery-domain
predicate. The actual captured outgoing span queries succeeded, and its transition
point was strictly inside the cell, but native_band denied discovery ownership.
The independently admitted source closure was therefore lost at this consumer.

The local predicate now receives each actual query parameter and accepts ordinary
domain ownership OR `curve.upper_source_member` for that parameter, point and
source registry. This existing positive proof retains its tighter stored numerical
allowance even though the caller's surface tolerance is larger. All three predicate
uses are updated: endpoint/knot samples, adaptive quarters, and post-coalescing
rechecks. Existing checked curve queries, residual guards, cell box, chord tests,
point cap, failure counters and endpoint-parameter handling are unchanged. The
native ownership band and all generic discovery behavior remain unchanged.

A scoped test-only legacy toggle restores the old domain-only decision for the
same sampler; it is not a runtime option.

## Actual-source replay and controls

The compact fixture `fixtures/upper-cell-sampler.json` records the exact cell,
span, options, point, fingerprint and original component receipt SHA256. It also
retains the two actual outgoing checked-query points from the original capture.
The test rebuilds the complete original source through the real pipeline context,
selects the outgoing representation through the proved incoming event, verifies
its source pair and full fingerprint, and requires those own queries to reproduce
the captured bits. Dense IDs are recorded witness bindings, not runtime admission.

The actual sampler is then invoked with the exact captured cell/span/options.
Legacy domain-only mode must return None; corrected mode must return Some with
unchanged endpoint parameter bits and no new numerical failure. Ordinary ownership
is false and qualified closure true at the captured transition. A smaller span
inside the excluded band exercises actual nonzero-parameter closure at the sampler's
quarter queries. Reverse direction retains ordered endpoint parameters.

A fresh local PointTable is sufficient for this sampler replay: it reads no old
point IDs or geometry and appends only after every source/query/chord check passes.
This is not a complete graph replay. The test additionally performs the private
view's exact alias-index omission and corner-incidence removal and checks identical
sampler parameters and newly appended point coordinates. Those private edits do
not affect the source registry or actual outgoing curve queries.

Refusal controls keep unsupported no-certificate curves, foreign source registry,
corrupted checked query, out-of-cell geometry and zero point budget rejected.
The legacy test scope restores itself on unwind. This does not establish validity
of any triangle or complete component.

## Observational inventory addition

The existing read-only diagnostic consumer inventory is exposed to its sibling
Stage4 harness and recorded before construction with the freshly selected source
pair. Its original caps and explicit refusal status remain intact. It issues no
field or curve queries and adds no constructor admission rule. This captures the
current leaf/required-face inventory even if private construction later refuses;
old199/1001 counts are not reused.

## Root execution

Pinned Rust1.99.0, no-LTO/codegen16, offline/locked, serde,sfcc-profile; fresh kernel
cache and positive test discovery. Same120s build and60s focused campaign limits.

- `upper_cell_` (2 tests), `SFCC_UPPER_CELL_RECEIPT` for the replay receipt.
- Retain the selected closure/source/lower/storage and Stage4 harness controls.
- After focused checks, one new preparation-inclusive120s
  `stage4_component_b_original_source_attempt`, using fresh receipt paths.

No author execution. The complete graph/component outcome and same-stage outside
contacts remain unknown until root runs the new frozen diagnostic.
