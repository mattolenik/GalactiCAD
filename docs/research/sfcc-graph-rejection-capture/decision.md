# Stage 1 consensus: select corrected B for the bounded graph capture

**Select corrected B for root compilation and focused validation. If those checks
pass, run one preparation-inclusive 120-second original-scene private capture.
This approves observation of the first executed graph rejection, not a geometry
repair, exact standalone replay, or production acceptance.**

Selected source: `/tmp/sfcc-graph-stage1-b-reviewed`.
Selected manifest SHA256:
`396d712b35b9cf70793509055afc6fdb8af83a9e7a6934bddef580e86d0ad82e`.
The original A/B/C packets remain frozen. No runtime implementations were merged.

## Independent comparison

| Candidate | Useful result | Decision |
| --- | --- | --- |
| A | All 16 direct guards, local paths/rotation rows and exact bits; lazy diagnostic-only hooks; bounded source descriptors | Retain as an alternative. Its narrower pre-call point snapshot and absent caller classification leave more reconstruction ambiguity. Its `signHex` name for the FieldRef branch scalar is also misleading: that scalar is a native-band value. Do not transplant descriptors without checking their meaning. |
| B | Actual caller classification and entry gate, full bounded pre-call private point/key payloads, source occurrence paths, failure edges/memberships/new points, per-graph query range, final private-cell association | Select the corrected version. It gives the next causal investigation more of the actual read dependencies without creating a general snapshot framework. |
| C | Complete static rejection inventory; demonstrated post-return snapshot insufficiency and JSON-number precision loss; observation/lifecycle/budget controls | Accept as the adversarial audit. Its intentionally empty patch is a valid outcome, not missing implementation work. |

The suspected degree-one endpoint remains unproved until capture. Even if that
is the executed guard, degree one in a feature graph is not by itself a proof of
invalid surface geometry. Source continuation, legitimate termination and graph
representation remain stage-2 questions.

## Review and corrections

I read the connected graph/caller/observer/source-descriptor code and both original
diffs. I verified all recorded changed/base hashes for A and B, and verified that
the original `strata.rs` and `field_branches.rs` contents remain exact byte
prefixes. I checked all 16 direct false exits against C's independent inventory.
The observation-removal token check is also recorded by both authors; the inspected
changes preserve the original geometric predicates, short-circuit decisions,
query locations, graph mutation and iteration order.

Original B evaluated rejection JSON before `finish` checked whether observation
was active and compiled hooks into every serde build. That violated the intended
diagnostic-only scope. The corrected B resolves this with:

- `all(feature="serde", any(test, feature="sfcc-profile"))` on all added hooks,
  module declarations and source accessors. The ordinary serde-only library has
  no new observer types or calls. Macro operand tokens are removed with the gated
  statement, so they introduce no unresolved production symbols.
- `FnOnce() -> Value` rejection operands, invoked only after the active check,
  including the empty-loop path. The occupied-edge case copies its already-read
  boolean before borrowing the complete edge map; it adds no field query.
- Checked loop-entry accumulation after the 64-loop limit.
- Clearing both context and capture on every `note_active_cell`. A later cell
  with no graph attempt cannot retain a previous cell's record.
- Controls for real active/inactive degree rejection, real success followed by
  failure, new-cell/no-attempt cleanup, inactive operand nonexecution, lossless
  high-bit numeric keys/NaN/signed-zero payloads, and exact serialized-cap boundaries.

I verified the corrected manifest and all six changed files, reviewed the isolated
correction diff, and inspected cfg sites for consistency. These are static checks;
root compilation is still required, including the serde-only library check.

No numerical/source guard, storage reservation, feature removal, curve evaluator,
projection method or production algorithm was changed. The six retained source,
transport, face-root and storage tests must pass again on this exact source.

## Capture contract and limits

The record at `admissionAndQueryEvidence.graphCaptureB` distinguishes entry state,
constructed graph state, graph return and final private-cell refusal. The actual
cell/classifier fields, ordered loops/pins/corners, all current private point
positions/normals/keys, selected curve spans and source paths are retained before
the graph can mutate the PointTable. At a false return, the actual rejection code,
operands, edge/membership map and newly added points are retained. The query range
is half-open into the existing generated-query log and excludes fallback queries.

All numeric floating-point payloads use hexadecimal bit strings. Numeric point
keys also use exact hex. Source root addresses are process-local sharing labels,
not durable source identities; the pinned outer scene and source fingerprint must
bind reconstruction. The helper does not evaluate fields, gradients, domains,
curves, projectors or candidate scores to collect evidence.

The 512 KiB limit is a serialized-detail policy. Structural collection/string/path
limits bound observation allocations before JSON materialization; this is not a
512 KiB heap/RSS theorem. These costs remain separate from the private 64 MiB
staging/source reservation and its 16 KiB typed ledger allowance. Oversized or
unsupported data explicitly yields an incomplete capture. It must not be promoted
to an exact fixture because a rejection code survived.

`complete:true` means the declared captured fields fit their bounds. It does not
mean executable replay is complete. `completeReplayEstablished:false` and
`sourceGeometryIncluded:false` remain correct. Compound coefficients, full patch/
protection metadata and the full ordered patch-walk state are not serialized.
Stage 2 must establish the read dependencies relevant to the executed guard and
verify reconstruction before claiming exact replay. Nested helper-internal None/
Err reasons are likewise not invented by a top-level guard label.

The frozen private loop invokes the cell mesher for one cell at a time and stops
at the first failed-cell or feature-fallback result. Both assignments clearing the
local `feature_graph_failed` boolean already increment fallback counts; they do
not recover private acceptance. The outer failure record is therefore needed to
associate a graph observation with the actual private refusal. Graph observation
alone is not a component success/failure theorem.

## Root execution decision

Use explicit pinned paths:
`/opt/homebrew/Cellar/rust/1.99.0_1/bin/cargo` and
`/opt/homebrew/Cellar/rust/1.99.0_1/bin/rustc`.
Root already verified the historical compiler identity and ten standard-library
storage-audit source hashes and passed the baseline six retained controls.

1. Build the selected libtest binary under 120 seconds with `--offline --locked
   --release --features serde,sfcc-profile --lib`, no LTO and 16 codegen units.
2. Within one 60-second focused campaign, run serially:
   `graph_b_` (six tests),
   `modeled_feature_paths_connect_two_boundary_loops_without_caps` (one test),
   and `correlated_` (six retained tests). Use the existing six fresh receipt paths.
3. Check the ordinary serde-only library for cfg consistency, with a separate
   bounded compile command; this performs no geometry.
4. Only after those checks pass, run one
   `private_a_original_knob_serial_round0_diagnostic --nocapture --test-threads=1`
   under the unchanged 120-second preparation-inclusive cap. Use a fresh
   `SFCC_PRIVATE_A_RECEIPT` and record the executed source manifest through
   `SFCC_PRIVATE_A_SOURCE_MANIFEST_SHA256`.

Compare the original source/options/lattice/inventory, all 198 face-certificate
records and 396 pin bounds, storage ledger, generated query sequence and final
charged count, private outcome, failure cell and live digest against Round 18.
Any difference needs attribution before interpreting the new rejection. Timing is
an observation of diagnostic cost, not a mesher performance claim.

A compile/control failure blocks the original-scene capture until its narrow cause
is resolved and the corrected freeze is reviewed. An incomplete capture or an
unexpected earlier guard is useful evidence, but leaves the corresponding stage
exit open. Do not retry automatically or weaken a guard.

I performed no builds, tests, geometry runs, runtime edits or exports. The actual
executed predicate and its mathematical validity remain open pending root evidence.
