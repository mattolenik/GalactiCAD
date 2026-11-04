# Stage 2 candidate B: exact early-path replay and graph incidence

Frozen source: `/tmp/sfcc-graph-stage2-b`, based on the executed Stage 1 source
`/tmp/sfcc-graph-stage1-b-reviewed`. No production algorithm change. This candidate
adds only a test child module, its fixture and a test-module declaration.

**Authored, not executed:** the two tests selected by `endpoint_replay_b_` reconstruct
the original source/point inputs and require the actual mesher to reproduce the
captured early rejection. Root must build and run them before claiming replay.
This is a diagnostic regression, not yet a source-correctness regression or repair.

## What the replay checks

The fixture is derived from the saved original-scene receipt SHA256
`6acd91cc9a04c34ac394bf669ec1d54ba487ab4ad8ed18559a9b7e894c4a3543`.
It retains the full original scene JSON/cube, feature fingerprint, all original
chart-20/33 polyline/range/stratum/endpoint bits, the complete Stage 1 graph capture
and its six graph-local query results. All f64 values are hexadecimal bits. The
numeric `usize::MAX` source sentinel is converted to its exact decimal string;
other integer values remain unchanged. This fixture conversion uses Python's
integer-preserving parser, never JavaScript Number.

The main test:

1. Rebuilds the original CSG and feature set through existing kernel APIs, without
   an octree or face-contour pass. It checks fingerprint `9875508341830920921` and
   all recorded original chart-20/33 data.
2. Performs the existing source admission and then exactly reproduces the private
   view edit: omit alias 33 from the spatial index; remove alias incidences only
   from corners also incident on physical chart 20. Corner 27 must retain `[20,1]`.
3. Restores all 633 pre-call PointTable values in their original ID order using
   the original numeric/string/unkeyed insertion APIs. Duplicate keys or ID gaps
   fail restoration. `corner:27` must be absent before entry.
4. Calls the actual unchanged `mesh_feature_graph` with the saved loops, pin,
   corner, cell box and all meshing options. No simplified primitive replaces
   the original source. The actual cell query view was unpruned; the replay uses
   the complete original tree wrapped only by a call counter.
5. Requires the exact rejection, point 633 allocation/key/position/normal bits,
   complete pre-call values/source identities, graph edges/memberships and all
   six query results/parameters to equal the capture. Process-local source-root
   addresses are normalized by their equality partition, not mistaken for stable
   source IDs. The local query slice is `[0,6)` rather than the original run's
   `[40,46)`; each corresponding attempt must match exactly.
6. Asserts no output triangles, unchanged false retained-unresolved flag, no
   numerical failure counters, and zero calls through the incoming cell-query
   interface before the degree guard. This zero count does **not** mean no field
   work occurs: curve projection and carrier/domain operations still use their
   rebuilt original source references.

A generated-query scope is installed through the existing admitted Transport.
It reserves the existing 2,048-query allowance for each local run; the three
runs remain below the unchanged total limit. No new evaluator or unbounded query
collector is introduced.

## Why missing PointTable metadata is irrelevant to this specific stop

This is a path-specific dependency argument, not a claim that a PointTable can
usually be reconstructed from positions alone:

| Executed part before degree rejection | Read dependencies | Captured/reconstructed coverage |
| --- | --- | --- |
| Boundary edge construction | Ordered loop IDs | Exact captured loop |
| Pin-path insertion | Pin chart/parameter/point IDs; loop membership | Exact captured pin and loop |
| Corner insertion | Corner position, strata order and curve-end list; string-key lookup; normals evaluated from original strata | Full pre-call key/value table; rebuilt feature set; exact alias edit; compare created point bits |
| Path sorting/deduplication | Parameters and point identity | Same captured/rebuilt inputs |
| Chart-20 midpoint query and in-cell arc sampling | Original traced curve data/carriers, parameter interval, cell box and options; domain checks and source-backed projection | Original expression/feature compilation; chart bit checks; all six query results exactly compared |
| Shared-arc processing | Previously constructed local arc list | Empty before the sole actual interval; no prior arc transport branch executes |
| Edge overlap processing | Local boundary/feature edge map | Actual new `620–633` edge is absent from the boundary; no occupied-edge support query executes |
| Adjacency and rotations before ID 633 | Built graph; stored point positions/normals | Entire point table restored; graph/newpoint bits compared |
| Degree rejection | Point 633 adjacency `[620]` | Exact observed guard/operands |

Protection, curve-edge metadata, patch owners, arrangement/coverage flags and
outside-mesh data are not read in this executed prefix. Metadata commitment and
patch triangulation occur only after the rejected degree guard. The actual
sampler emits no interior points here; only `corner_point_id` adds point 633.
The tests also seed deliberately different protection, curve-interval, patch,
arrangement and coverage records on existing IDs and require the same graph and
query sequence, with those records left unchanged. This strengthens but does not
replace the code-path argument.

The test does not reconstruct previous-cell triangles or the outer private
constructor: the graph function never reads/appends its output vector before this
guard. It therefore checks zero *new* triangles, not an entire component output.
The outer classification is recorded for comparison, but its octree decision is
not rerun or proved by this test. Its `cell.key` is not read by graph execution or
the observation context; only the captured cell coordinates/tags are reproduced.

## Controls and graph-theoretic result

The authored controls are:

- repeated exact-source replay with contradictory unused metadata: same guard,
  graph and six queries;
- pin retagged to alias chart 33 while the corner retains physical chart 20:
  actual guard changes to `path_nodes_lt_two`, with no curve queries. This is an
  identity-mismatch control, not a claim that chart 33 is a distinct physical curve;
- duplicate pre-call key: restoration refuses instead of silently changing IDs;
  equal unkeyed payloads retain distinct IDs and all 633 entries.

Static integer-preserving checks of the saved fixture have run. They establish
633 contiguous point IDs, 627 unique keyed entries, no prior `corner:27`, one
8-vertex boundary cycle, and one added edge `620–633`. The graph is connected,
with 9 vertices, 9 edges and cycle rank one. The feature edge is a bridge ending
at the degree-one corner. This is the graph of a boundary cycle with an interior
slit; it is not two closed patch boundaries. Simply deleting the degree guard
would not establish that downstream simple-polygon/stratum meshing is valid.

## Degree one is not a universal surface-invalidity theorem

A symbolic counterexample distinguishes graph assumptions from surface validity.
Let `g(y)=max(y,0)^2` and consider the embedded surface graph
`z=|x| g(y)` over a disk around the origin. For `y>0` its crease is `x=0`;
for `y<=0` the surface is flat. The one-sided normals on the crease are
proportional to `(-g(y),0,1)` and `(g(y),0,1)`, so their angle is
`2 atan(g(y))`, tending to zero at the interior endpoint. The graph remains
homeomorphic to the disk and the terminating crease has degree one.

This is a mathematical counterexample to a universal degree>=2 rule, **not** a
replacement scene, sampled reference evaluator or proof that the knob's corner
is a legitimate termination. Whether the actual knob must continue its crease
requires the original source/exposure analysis from the independent candidates.
No source-correctness assertion is manufactured here before that obligation is
established. A nonzero limiting normal jump and regular source equations may
exclude this particular kind of termination, but those premises need proof.

## Root execution and handoff

Use pinned `/opt/homebrew/Cellar/rust/1.99.0_1/bin/{cargo,rustc}`, the existing
no-LTO/codegen16 native diagnostic profile, `--offline --locked`, kernel lib tests
with `--features serde,sfcc-profile`. Build within120seconds; run the filter
`endpoint_replay_b_ --nocapture --test-threads=1` within60seconds. Set a fresh
`SFCC_ENDPOINT_REPLAY_B_RECEIPT` path. Two tests are selected. No original-scene
capture, octree, full export, GPU job or browser is needed for this package.

The main test compiles the original feature set once and performs three local
graph calls (exact capture, unused-metadata control, identity mismatch). The
receipt distinguishes `earlyPathReplayEstablished` from
`wholeCellOrSourceContinuationEstablished:false` and `publicationReady:false`.
Only after root's successful execution may the former be reported as established.

Author ran static source review, lossless fixture extraction, integer graph/key
assertions and pinned rustfmt parsing only. No builds, tests or geometry evaluation
were run. Risk: root compilation/execution may expose an uncaptured read dependency
or a reconstruction mismatch; that must be recorded rather than relaxed away.
