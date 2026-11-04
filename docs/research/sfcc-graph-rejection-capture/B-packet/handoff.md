# Stage 1 candidate B: local provenance and guard capture

Frozen source: `/tmp/sfcc-graph-stage1-b`, based on the155-file restored Round18 source at `/tmp/sfcc-graph-stage1-baseline`. No main-tree changes. This is observational instrumentation, not a repair or an accepted replay fixture.

## Scope and actual implementation

The existing diagnostic's `DIAGNOSTIC` lifecycle owns the result. A new child module of `private_arc_a` records a pre-call snapshot immediately before `mesh_feature_graph` can mutate the private PointTable. Its caller supplies the actual selected cell, classifier tags, degenerate flag, curved-corner gate, number of distinct pin curves and whether the already-created query view is pruned. No classifier, field, gradient, curve, root, projection or scoring call is added.

Pre-call payload:

- exact ordered loops and pins; selected corners with their actual curve-end and stratum incidence;
- every current private point's exact position/normal bits and full supported key;
- relevant curves' native/type/owner identities, parameter ranges/wrap and corner links;
- relevant strata's owner/leaf/local indices, sign, field/domain occurrence paths, branch tag/native-band bits and process-local shared-root address labels;
- the actual cell box and meshing options;
- graph query-log start index.

At each of16 top-level false-return sites, capture records the code and already-computed operands, the actual current edge map and curve memberships, any new points added since entry, and the graph query-log end index. The indices are a half-open slice into the existing run-wide `generatedQueries` array; later corner/fallback queries are excluded. Reading the log length neither charges nor performs a query. A null index means that no generated-query scope was installed, as in the small observer tests.

The final private failure hook separately marks whether this graph record's cell equals the cell rejected by the private constructor. A graph return value is not promoted into a whole-cell or replacement success. Starting another graph context clears the previous attempt. An abandoned observer marks its record incomplete.

The exact source paths use two appended read-only helpers in `strata.rs` and `field_branches.rs`; existing contents of those files remain exact prefixes. No storage layout, memory guard, query implementation, admission rule or source proof changes.

## Return-site inventory

| Code | Executed predicate / operands retained |
| --- | --- |
| `empty_loops` | Input loop count is zero |
| `path_nodes_lt_two` | Post-sort/dedup chart node count and full surviving node list |
| `midpoint_query_none` | Actual midpoint query returned None; chart/endpoints/exact span |
| `sample_in_cell_arc_none` | Actual sampler returned None; chart/endpoints/exact span |
| `occupied_or_unsupported_edge` | Edge endpoints, existing-feature boolean and already-computed support boolean |
| `vertex_degree_lt_two` | Actual point ID, all neighbors and degree (<2 makes the list inherently bounded) |
| `invalid_vertex_normal` | Point ID, actual pre-normalization normal and length bits |
| `directed_edge_revisited` | Current/first directed edge and polygon length |
| `polygon_walk_bound` | Actual polygon length and edge count |
| `mixed_boundary_orientation` | Actual forward/backward flags, first edge and polygon length |
| `polygon_lt_three` | Full polygon (length<3) |
| `no_patch_candidates` | First edge and polygon length |
| `empty_patch_candidates` | First edge and polygon length |
| `boundary_or_feature_incidence` | Used/required boundary and feature-edge counts; edge/membership snapshot |
| `triangle_sample_validation` | Actual stratum and rejected triangle IDs |
| `triangle_contact` | Actual rejected triangle IDs |

Nested helper-internal reasons are not invented. If the captured first stop is a helper None/Err rather than the hypothesized degree guard, identifying the helper's exact internal predicate requires a subsequent focused observation. The full visited rotation system/patch-walk history is not separately serialized; graph positions/normals/edges and the recorded guard are retained. The frozen function still determines its ordering.

## Bounds and honest completeness

Input guards precede collection/encoding: at most1,024 pre-call points/loop entries/pins,64 loops/corners,128 relevant curves/strata,64 corner incidences,128-byte point strings,32 path entries,64 partner indices and16 field domains. Failure graph records allow1,024 edges/memberships, at most128 stratum memberships per edge, and the same point limit. These are finite diagnostic allocation bounds, not part of the16KiB source ledger or an RSS claim.

A bounded writer preallocates512KiB and refuses before writing beyond that limit. Oversized serialized detail becomes an explicit incomplete capture retaining context and essential rejection code. `complete:true` means the declared captured fields were not truncated; it does **not** mean a complete standalone executable fixture. `completeReplayEstablished:false` and `sourceGeometryIncluded:false` are explicit. Replaying source queries still needs the outer receipt's immutable scene/configuration and the private feature-view edits. Compound-carrier presence is recorded, but its recursively expanded coefficients are deliberately not duplicated here. Process-local root-address labels only express sharing inside this one capture; they are not persistent source IDs.

## Controls and root execution

Author performed only source inspection, standalone rustfmt parsing, hash/diff generation and a structural equivalence self-check. **No build, test, feature preparation, scene query, private job, export or render was executed.**

The self-check removes added observation statements/macros from `mesh_feature_graph`, maps each rejection macro back to its original `return false`, and compares all remaining non-whitespace tokens to the frozen base. It passes. Thus field/curve evaluations, their order, graph mutations, numerical predicates and return behavior are textually retained. The test-only additions are outside that function.

Root should use pinned `/opt/homebrew/Cellar/rust/1.99.0_1/bin/{cargo,rustc}`, the existing120-second diagnostic build policy, and `--offline --locked --release --features serde,sfcc-profile --lib`, no-LTO/codegen16.

Focused filters, serially within one60-second campaign:

1. `graph_b_` — four tests for exact hex/byte cap, inactive scope, abandoned scope cleanup and read-only query indices.
2. `modeled_feature_paths_connect_two_boundary_loops_without_caps` — existing positive/negative mesh test, now adds observed/unobserved negative comparison for `path_nodes_lt_two`, actual `empty_loops` rejection and unchanged point count/no emitted triangles. This invokes real mesher guards; it is not only a serialization test.
3. `correlated_` — all six retained source/transport/face/storage controls.

No new environment variables. Retained controls require the same six fresh receipt paths described in Round18. For the one selected original private capture, use `SFCC_PRIVATE_A_RECEIPT` and set `SFCC_PRIVATE_A_SOURCE_MANIFEST_SHA256` to this packet's manifest hash. Filter remains `private_a_original_knob_serial_round0_diagnostic --nocapture --test-threads=1`, preparation-inclusive120-second cap. New data appears at `admissionAndQueryEvidence.graphCaptureB`.

All original budgets and first-failure behavior remain. Compare198 face certificates/396 pin bounds, original inventory, reservation, generated query sequence/charged count and live-state digest before interpreting the new guard. A passing test process is still only a diagnostic capture.

Skipped: compilation, execution and full replay proof, pending root and fourth review. Risk: the512KiB/structural bounds can yield explicit incomplete capture; helper-internal reasons and complete standalone source reconstruction remain outside this observer.
