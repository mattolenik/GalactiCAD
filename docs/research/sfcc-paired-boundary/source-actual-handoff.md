# Round 36 C: actual paired source/geometry composition

Selected authored source: `/tmp/sfcc-paired-c-actual`. This extends the initial
C wrapper at `/tmp/sfcc-paired-c` with the actual captured fixture and one positive
composition test. It requires B's `paired_geometry_b` module in the composed source.
C performed static reads/edits only; root must execute all builds/tests/geometry.

## Exact inputs

Fixture `gcad-wasm/kernel/fixtures/paired-fans-c.json` is copied byte-for-byte from
root's v2 capture (`/tmp/sfcc-paired-fixture-v2.json`), SHA-256
`37938387b58654d9b6b7b642bc9525bea4f9fdcce941dba0aaccd1d0cf4b6ba3`.
It contains six inside and five outside triangles, eleven used joined vertices,
shared edge [40,38], source fingerprint and both actual cylinder hypothesis
identities. It also carries the original target record, actual capture checks and
outside observation accounting. `outsideCurveMemberships` explicitly uses outside-
local IDs; `outsideToJoined` must be applied before comparing them with fan IDs.
The core graph proof does not consume these memberships.

The test rebuilds the original source features and requires the fingerprint and
both hypothesis identities to match, excluding only process-local root addresses.
It checks the saved source/target identities, captured prerequisites and exact
surface tolerance against both original fixture and default pipeline tuning.

## Test and receipts

Focused filter: `paired_c_` — two earlier cheap binding controls plus
`paired_c_actual_common_source_graph_and_union`.

The actual test calls B's pair-domain audit and C's source wrapper independently.
The wrapper makes ONE existing fullfan source call over inside-then-outside
triangles, retaining the global 128-check cap and common world-X slab. It then
requires source/geometry triangle IDs, used point bits, per-patch counts and shared
edge to agree exactly before composing the source and export error bounds.

Receipts are written before result assertions:

- `SFCC_PAIRED_C_RECEIPT`: source Result, including exact refusal if any.
- `SFCC_PAIRED_B_RECEIPT`: geometry Result.
- `SFCC_PAIRED_COMBINED_RECEIPT`: both Results, exact input-binding verdict and
  combined Result; success flags are computed from the actual combined outcome.

No actual paired success is asserted in this handoff. An unsuccessful source
certificate must be preserved before considering a changed source argument.

## Scope

If both certificates and their binding pass, the common root graph and embedded
projected union establish a shared geometric source trace across this one original
face-contour edge, with the combined approximation bound. Neither code path claims
source-feature parameter transport, coverage of other interfaces, complete source
ownership, numerical CPU/WGSL parity or publication readiness.

The original shared edge40↔38 is a face-contour edge. Curve49 meets it at endpoint40
and belongs to neighboring feature edges; merely preserving that metadata does
not prove the lifted endpoint/feature path has the intended source parameterization.

Files and hashes: `/tmp/sfcc-paired-c-actual-changes.json`. The source wrapper was
not extended beyond the previously reviewed source family; any actual widened-slab
refusal remains the next discriminator rather than a reason to loosen limits.

## Root execution subsequently observed

Root preserved one compilation failure: the fresh-hypothesis comparison passed
`Option<Value>` to address normalization. Root's executable correction at
`/tmp/sfcc-paired-proof-fixed` adds an explicit `expect("bound source identity")`.
No source-family or numerical tolerance change was needed. The authored frozen
copy above remains the pre-correction snapshot; root's selected packet carries
that correction.

Root reports 57 focused tests passed. C independently read the saved `Proof-fixed`
source/geometry/combined JSON receipts (without running any evaluation):

- Both patch domains pass B's union checks and their source/geometry input binding
  is exact.
- One source call covers all 11 triangles with 55 accepted pieces and 99 attempted
  checks under the unchanged global128 cap.
- The common world-X slab is [-9.3690502954966,-9.203433300600462]. Minimum recorded
  reduced decrease rate is0.8417986595496135.
- Source displacement upper is0.0010236853133464587; composed export upper is
  0.0010241185705941118, below0.01.
- The shared boundary directions are [40,38] and [38,40].

The widened-slab certificate succeeds unchanged. The speculative all-support-plane
source extension is therefore unnecessary and was not implemented. The result
establishes this shared geometric source trace and paired source-graph disk,
conditional obligations having been bound by the actual composition. Source-feature
parameter transport, other interfaces and publication remain explicitly false.
