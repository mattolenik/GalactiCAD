# Stage 1 result review: exact degree-one rejection established

**Stage 1's mechanical diagnosis passes. The private graph is rejected by the
executed `vertex_degree_lt_two` guard at newly created point 633, keyed
`corner:27`, whose only neighbor is boundary pin 620. The source-geometric reason
for that terminal incidence remains unproved. No repair or accepted mesh results.**

This follows the [selection decision](http://md.localhost/tmp/sfcc-graph-stage1-consensus.md)
and its corrected B manifest
`396d712b35b9cf70793509055afc6fdb8af83a9e7a6934bddef580e86d0ad82e`.
Root evidence is in
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round19-graph-capture/selected/`.
The actual capture SHA256 is
`6acd91cc9a04c34ac394bf669ec1d54ba487ab4ad8ed18559a9b7e894c4a3543`.

## Executed checks and independent verification

Root's pinned Rust 1.99.0 diagnostic build passed in 13.153 seconds. All thirteen
focused tests passed: six `graph_b_` controls, the existing modeled two-boundary-loop
graph test with added observed success/failure controls, and six retained source/
transport/root/storage tests. The ordinary serde-only library check passed in
5.090 seconds, establishing that diagnostic cfg removal compiles. One original
private capture completed in 18.127 seconds under its preparation-inclusive
120-second limit; the test-process exit is successful evidence collection, not
successful component construction.

I independently verified all 156 executed source/configuration hashes, the saved
binary hash and the recorded executed-manifest binding. I decoded receipts with
integer-preserving Python, recomputed the thirty-five historical field comparisons,
and found exact equality for every compared value. These include the source,
requested/effective settings, cube/lattice, complete consumer inventory, all 198
face-certificate records and their 396 pin bounds, original feature inventory,
private outcome, failure state, 46 generated-query records, 9,950 final charges,
19,865,723-byte reservation and live-state digest. Provenance and new observation
fields are correctly excluded from the historical comparison.

The observed graph's compact JSON is 127,936 bytes, below 524,288. Its declared
capture is complete, its graph returned false, its cell matches the final private
failure, and standalone replay remains explicitly unestablished.

## What the capture establishes

The actual entry context is cell `[7,36,79,29]`, classified with corner 27,
`featureCurve = -1`, `degenerate = false`, one distinct pin curve, and
`curvedCorner = true`. The query view is unpruned. That curved-corner condition
causes this otherwise single-corner cell to attempt `mesh_feature_graph`.

The pre-call table has exactly 633 points with IDs 0 through 632. It has no key
`corner:27`. The selected corner's incidence is `[[20,1]]`; its source-stratum
list is `[10,15,30]`. There is one ordered eight-vertex boundary loop and one pin:
point 620 on chart 20 at parameter bits `403ec575c721f0be`.

Graph construction adds exactly one point, ID 633 with key `corner:27`; its
position bits exactly match the recorded corner 27 position. It inserts one
feature edge `(620,633)` labeled by strata `[10,15]`, with a chart-20 interval
from the pin parameter to chart 20's endpoint bits `403f000000000000` (parameter
31). No intermediate arc point is added in this attempt.

I independently reconstructed adjacency from the captured edges:

- the eight unlabeled edges are exactly the cyclic boundary edges;
- feature edge `(620,633)` is the only additional edge;
- corner point 633 has degree one, neighbor `[620]`;
- boundary pin 620 has degree three;
- every other graph vertex has degree two.

This independently reproduces the operands of the recorded degree guard. It is
an adjacency check from the actual captured state, **not** an executable replay
of the entire mesher or a new proof about the original surface.

The graph's query range is `[40,46)` within the enclosing generated-query log:
six successful chart-20 queries. It is incorrect to attribute the entire run's
46 queries to this cell. The graph guard occurs before polygon walking and patch
triangulation. The later corner fallback emits eight triangles, but the unchanged
private caller rejects the component on its fallback result. Live digest remains
`5f3600b1ef212fb0` before and after; publication and export closure remain false.

## Scope and remaining limitations

A degree-one feature endpoint is not automatically invalid geometry. The result
establishes that this mesher's minimum-degree assumption rejects the actual
private graph. It does not establish whether the composed source requires a
continuing crease, permits a true termination, or was compiled/classified with
incorrect endpoint incidence. Deleting the degree guard, inventing an outgoing
edge or accepting the fallback fan has no justification from this capture alone.

The record contains the full bounded pre-call point/key payloads, actual source
occurrence paths and private corner/curve incidences. It deliberately does not
include complete source-carrier geometry, patch/protection metadata or all later
rotation/patch-walk state. Stage 2 must prove dependency sufficiency and reconstruct
those inputs before asserting exact full-function replay. Source root-address
labels are process-local sharing information, not stable cross-run IDs.

There is one remaining cross-language encoding caveat: stratum 30's `leafIndex`
is numeric `usize::MAX` (`18446744073709551615`). An ordinary JavaScript JSON
reader rounds that sentinel even though floating-point bit payloads and numeric
point keys are correctly hexadecimal strings. Continue integer-preserving Rust/
Python decoding and normalize that source sentinel to a string/hex value in a
Stage 2 cross-language fixture. The exact original value is present in this
receipt; no new live capture is required to normalize it. Do not claim the whole
receipt is lossless under arbitrary JSON-number consumers.

## Next bounded work

Preserve this capture and the observational patch before modifying construction.
The next three competitors should independently analyze source continuation,
local graph/surface incidence and source identity/parameter transport using this
same actual witness. Their common regression must target the geometric/source
obligation, not merely demand that `vertex_degree_lt_two` return true.

First establish executable local replay from the captured pre-call dependencies
and immutable original source/private edits. Then determine which hypothesis can
be proved or falsified. No new original-scene capture is justified solely to
reconfirm the now-known degree guard. An additional capture needs a named missing
operand that the current evidence cannot supply.

I ran no Rust builds/tests, field evaluations, geometry jobs or exports and edited
no runtime source. This review accepts the bounded mechanical diagnosis; exact
mesher replay, mathematical cause, repair and complete-mesh acceptance remain open.
