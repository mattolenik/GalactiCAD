# Round 37 C: whole-face domain and one source attempt

Frozen initial source: `/tmp/sfcc-face-c`, based on `/tmp/sfcc-paired-proof-fixed` (215 inputs). C performed static source/receipt inspection and edits only. No Cargo, tests, field evaluation or geometry execution was run by C.

## Files

- `gcad-wasm/kernel/src/sfcc/face_join_c.rs`: new checker and three tests.
- `gcad-wasm/kernel/src/sfcc/exposure_a.rs`: test/serde module declaration only.
- `gcad-wasm/kernel/fixtures/face-fans-c.json`: compact actual four-fan input extracted from round36's archived candidate `orientationCaptureA.patch_output` and emitted outside `pairedFans`, preserving joined IDs and position bits.
- Hashes: `/tmp/sfcc-face-c-changes.json`.

The fixture's source receipt SHA is recorded in the JSON. Its own SHA256 is `f517cd0ed38c10b272e97ab4b8bd6506b49af0629b02cbbf1e2baaa14cadc32f`. It has patch order inside15 (6 triangles), outside15 (5), inside39 (4), outside31 (6), totaling21 triangles and17 used points. Both segments are `[40,38]` and `[39,40]`, meeting at40. The inside39 data came from actual emitted first-cell `patch_output`, not a guessed matching source ID. Every extracted triangle was checked for literal occurrence in the archived returned candidate/outside lists; root must still bind this fixture to the fresh B second-segment capture before acceptance.

## Contracts

`audit(points, patches, segments, endpoint)` checks the supplied triangle union, not an assumed cyclic four-fan layout:

1. Two to four distinct emitted patch families, bounded total128 triangles/128 points; all contain the common endpoint.
2. Existing indexed topology rejects duplicates, invalid links, nonmanifold or misoriented incidence.
3. Both declared contour segments have exactly two opposite triangle uses.
4. Triangle adjacency through edges is connected, the outer boundary is one directed simple cycle, and the common endpoint is interior (its valid link is a cycle).
5. All represented YZ vertices are unique, all triangles have a common nonzero exact projected orientation, and existing `GrowingIndex` projected contact predicates reject improper overlaps/contacts in working and rounded coordinates. The first index already includes rounded predicates, so refusal is deliberately named working-or-exported.
6. At most4096 logical triangle pairs per precision. This does not increase existing caps.

Together these give an embedded projected disk around both segments, including the shared endpoint. They do not establish ideal feature membership or intended full-cell coverage.

`combine_error` composes one exact-order source bound list with per-triangle outward f32 displacement bounds. It requires the common closed-domain/root uniqueness flags, exact original tolerance and negative projected orientation consistent with the admitted decreasing-X root graph. It is conditional until caller binding is established.

The actual test calls `fullfan_source_a::certify` **once** on the concatenated21 triangle input, under the same global128-check cap. It does not call it independently for each pair to avoid the limit. The separate second-pair geometry call uses the existing `paired_geometry_b` checker and makes no source query.

## Root execution

Set `SFCC_FACE_C_RECEIPT` to a new result file. Focus filter: `face_c_` (three tests).

- `face_c_union_requires_all_sectors_and_conforming_projection`
- `face_c_rejects_renamed_endpoint_and_export_collapse`
- `face_c_actual_second_pair_and_whole_face_source_attempt`

The actual test writes second-pair geometry, whole-face geometry, the single source result and combined result **before** assertions. If source admission/refinement exhausts128 checks, preserve the exact refusal; do not widen limits or silently split calls.

## Deliberately open claims

Even a successful surface graph and interior endpoint do not prove that the common root at40 lies on the ideal curve49 or retains its raw parameterization. A owns that direct source/parameter evidence. Numerical source-field evaluation and source-patch hypotheses are not substituted for ideal feature constraints.

The new maps and contact-index workspace are bounded by counts but not added to an allocator-complete64MiB proof. Existing whole-program allocation and publication gates remain open. No geometry, production behavior or patch labels are changed.

## Possible endpoint adjustment only after the source gate succeeds

If A supplies a physical fixed-X ideal feature root whose YZ enclosure lies strictly in point40's link-polygon kernel and whose X image lies inside the common source slab, a piecewise-affine domain map can move the interior vertex40 there while fixing the outer boundary. All intermediate vertex positions stay in the convex kernel, so the star remains a triangulation of the same domain. The unique source graph then maps that target to A's ideal feature root.

No new source-gradient API is needed for the error estimate: `|Phi(Tu)-M(u)| <= delta + |M(Tu)-M(u)| <= delta + L_mesh*beta`, where `L_mesh` is the largest affine graph Jacobian norm on the original star, beta bounds the YZ vertex movement and the path stays inside the star. Add the existing export bound afterward. This remains a proposal until the root executes the initial21-triangle gate and the target/star inequalities are implemented and checked.
