# Stage 1 candidate A — exact graph rejection observation

Frozen isolated source: `/tmp/sfcc-graph-stage1-a`. Base is root's verified 155-file
Round 18 restoration in `/tmp/sfcc-graph-stage1-baseline`. Main runtime unchanged.
This is observation only: no graph predicate, source condition, tolerance,
projection, point insertion, iteration order or fallback behavior is changed.

## Patch and static controls

Five changed/added files: `cell_mesh.rs`, `private_arc_a.rs`, appended read-only
helpers in `strata.rs` and `field_branches.rs`, and `graph_capture_a.rs`.
`candidate.patch` is relative to the restored Round 18 source; `manifest.json`
records every changed/base hash. `static-controls.json` records all 16 labels.
Removing the cfg-gated hooks/macro and restoring each macro to `return false`
reproduces the original graph-function token stream after whitespace/comments
are ignored. Both source descriptor files retain the whole original file as an
exact byte prefix. Standalone rustfmt parsing passed; no cargo/test/geometry job
was run by the author.

## Runtime receipt

Existing enclosing original-scene receipt receives
`admissionAndQueryEvidence.featureGraphCaptureA` on actual graph failure. Existing
`note_active_cell` removes this one field before the next private cell, so it cannot
misattribute an earlier graph failure to a later private refusal. The report is
stamped with the existing active cell. No new thread-local observer is introduced.
The local Capture value drops naturally on success or abandoned scope.

Captured fields:

- pre-call loops, ordered pins, corners/incidences, options, referenced boundary
  point IDs/keys/positions/normals and point-count boundary;
- involved curves, ranges/wraps, owning occurrence IDs, adjacent stratum identity,
  bounded FieldRef paths/branch/partners and compound composition;
- sorted/deduplicated path nodes before the existing closed-curve wrap insertion;
- already-built edges, memberships and forward boundary at rejection;
- completed live rotation rows in their existing order (the observer never sorts);
- completed usage sets when that stage is reached;
- every referenced path/graph point and every newly added point since entry;
- stable rejection code and its existing operands;
- existing generated-query log start/end indices, or null if no query scope exists.
  These delimit this graph attempt; they are not the whole private-run log.

Numerical coordinates/normals/parameters/options/signs/compound coefficients use
16-digit f64-bit hex strings, preserving signed zero and nonfinite payloads.
Numeric point keys are decimal strings. `carrierDebug` is descriptive text, not
asserted to be the complete exact carrier representation. The original source
expression remains in the enclosing receipt; no immutable source graph is cloned.

`completeObservedState` only describes these declared observations. The receipt
always says `exactReplayEstablished:false`: this does not snapshot all PointTable
lookup/protection/patch metadata or prove that reconstructed source identities are
sufficient for exact mesher replay. IDs below `pointCountBefore` reveal reused
points when their path is observed, but the full pre-call key map is not copied.
Stage 2 must establish dependency sufficiency for the particular executed guard.
Source descriptors do not establish the mathematical continuation or termination.

## Bounds and observational behavior

The report is separate from the existing 16KiB native source ledger and unchanged
64MiB private policy. No field/curve/domain/projection query is called to observe
state. Scalar formatting and metadata reads do not consume geometric query charges.

Counts are checked before copying: 64 loops/corners, 1,024 total pre-call boundary
entries, 1,024 pins/edges/memberships/usage entries, 512 point IDs/new points,
128 paths with at most 1,024 aggregate path nodes, 128 curve IDs, 128-byte keys,
4,096 source descriptor nodes/path/partner entries and 16 nested compound levels.
Per-corner incidences/domain counts and per-edge stratum sets have additional caps.
The native JSON tree is count-bounded; these are not RSS claims. A bounded streaming
writer refuses serialized output beyond512KiB without building an unbounded byte
buffer. On any omitted state the completeness flag is false with the first relevant
limit; byte overflow emits compact cell/rejection evidence, never a complete fixture.
Source descriptor failure can prevent later graph-detail capture: the guard code
still appears, but that case is explicitly incomplete and must not be treated as
an exact replay input.

All 16 top-level graph false sites are labeled:

1. `empty_loops`
2. `insufficient_path_nodes`
3. `midpoint_query_failed`
4. `arc_sampling_failed`
5. `edge_overlap_or_uncertified`
6. `low_vertex_degree`
7. `invalid_vertex_normal`
8. `halfedge_revisited`
9. `walk_budget`
10. `mixed_boundary_orientation`
11. `short_polygon`
12. `missing_candidate_strata`
13. `empty_candidate_strata`
14. `edge_usage_mismatch`
15. `patch_sample_validation_failed`
16. `patch_intersection`

Nested sampler/validator internals retain their current behavior. A sampler failure
is distinguished from graph degree failure but its own internal reason is not newly
instrumented. No existing condition is reevaluated to generate a more specific error.
For late validation failures, the report is not a complete generated-triangle replay.

## Root validation request

Use the pinned historical compiler paths root found. One diagnostic no-LTO/codegen16
libtest build under120seconds, `--offline --locked --features serde,sfcc-profile`.
Run the existing SIX `correlated_` tests and the THREE tests selected by
`graph_capture_a` serially under the60second focused campaign budget. The new filter
needs no output environment variables and no whole-scene construction.

The new tests cover exact bit strings/streaming byte cap/point bounds; no-observer
behavior, scope drop, pre-call truncation and active-cell reset; and actual empty,
degree, normal and candidate-source graph rejection paths. A SdfQuery implementation
that panics on every evaluation verifies those observed and unobserved executions
make no field queries, and their return value, triangles, point count and unresolved
flag agree. These tests are authored, not yet executed.

Only after fourth review and fresh controls pass, root may run one120second
`private_a_original_knob_serial_round0_diagnostic --nocapture --test-threads=1`
with a fresh `SFCC_PRIVATE_A_RECEIPT` and `SFCC_PRIVATE_A_SOURCE_MANIFEST_SHA256`.
The unchanged six receipt variables remain required for `correlated_` controls.
Check inventory/certificates/query log/live digest against the appropriate frozen
baseline. The expected *diagnostic category* remains `private_graph_refused`; the
specific inner code is intentionally not asserted in advance.

No build, geometry capture, full replay or acceptance claim was made by the author.
Root compilation and execution remain required; incomplete source/key state remains
an explicit limit on what the subsequent replay can claim.
