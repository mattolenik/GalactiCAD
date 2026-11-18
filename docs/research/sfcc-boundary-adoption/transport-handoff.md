# Round39 B — interior transport on the complete supplied disk

## Files and validation status

Base: `/tmp/sfcc-spancomplete-combined`, copied to `/tmp/sfcc-boundary-b`.

Changed/new files:

- `gcad-wasm/kernel/src/sfcc/face_join_c.rs`: remove the unnecessary rule that *every* patch group contains endpoint40; the entire union must still pass the exact same bounded topology/projection checks, retain both shared segments, and make endpoint40 interior. Declare the child geometry module.
- `gcad-wasm/kernel/src/sfcc/boundary_transport_b.rs`: bounded simultaneous interior-target source-correspondence transport; four synthetic refusal/success controls and one actual first-cell union attempt.
- `gcad-wasm/kernel/fixtures/incident-first-cell-b.json`: copied, not numerically reconstructed, all four inside fans plus both outside fans and original metadata from round38 component receipt. Includes source fingerprint, parent receipt SHA256, exact point bits, individual patch provenance and two complete cell groups.

Only `rustfmt` parsing/formatting and static data extraction were performed. No cargo, tests, or geometry evaluations were run. The actual fixture test deliberately asserts the hoped-for geometry result and prints a structured refusal if false; parent must run it and retain any counterexample.

Run focused filter `boundary_b_`. The actual-case log prefix is `BOUNDARY_B_FIRST_CELL`.

## API and proof obligation

First call existing `face_join_c::audit(points, cell_groups, [[40,38],[39,40]], 40)`. It retains 128 points/triangles and4096 pair checks, indexed disk and exact f64/f32 projected embedding checks. Entire cell groups make no assumption that each group touches40.

Then call `face_join_c::boundary_transport_b::transport(domain, points, source, targets, tolerance)` where `targets: BTreeMap<usize,[Interval;3]>` contains at most the four consumed feature nodes. Every target ID must be used and absent from the outer boundary. Points are bound to the audited exact bits. Source triangle order, source instance, independently proved exact target roots, original per-point constraints, and complete incident consumers remain the caller's obligations, explicitly stated in the result.

For every changed triangle, enclose each projected vertex throughout its straight motion to every possible enclosed target. Strict signed determinant positivity over these hulls proves that every intermediate PL map has positive triangle Jacobians. Shared vertex IDs impose shared edge maps. The simple outer boundary is fixed. The degree-one argument then makes each intermediate map a self-homeomorphism of the same disk. This treats simultaneous changes together; it does not compose independently checked stars that might interfere.

The graph Jacobian bound is the maximum over *every* original triangle. Each point travels on a straight path remaining within the disk, so the old continuous mesh graph changes by at most `L_mesh * beta`, where beta is the maximum projected vertex displacement. Add this to the uniform source graph error and original f32 rounding bound. The mesh itself is unchanged. The target's exact source X lies strictly in the same common source slab, permitting the separately established root uniqueness to identify the adopted source point.

No interval midpoint is treated as the target. No tiny displacement permits moving an outer-boundary point. The returned theorem is conditional and does not establish full feature-curve transport.

## Expected next decisions

1. Execute the34triangle fixture test. It may fail because adding the native-side/chamfer fans breaks the existing YZgraph assumption; this is a useful bounded refusal, not grounds to change projection tolerances.
2. If it passes, C certifies this exact union in one unchanged128-check source call and supplies canonical647 target.1116 remains on this two-cell outer boundary and must be refused.
3. A captures actual opposite Z consumer(s) at1116 with original-stage point keys/bits and query provenance. Re-audit exact union before attempting simultaneous adoption.
4. If either enlarged union fails embedding or source certification, report its exact reason; do not reset the128 budget per fan or silently change outer boundaries.

## Deliberate limits

No production edits, dependencies, global cap increases, source/target numerical evaluations, or scene-SDF implementation. No claim of complete outside component coverage or publication readiness. Parent still must validate build, focused controls, actual geometry/source certificates, and metadata binding.

## Actual three-cell candidate follow-up

Root captured the actual opposite Z consumer `[7,26,58,87]`, with10 triangles. New copy `/tmp/sfcc-boundary-b-actual` adds `fixtures/incident-three-cells-b.json` verbatim from `/tmp/sfcc-incident-44.json`; SHA256 `a8c0145afa01a9cc450fbc1960e4836e0ae04c159d2b41fc3d5619edb7220cbb`.

New test `boundary_b_actual_three_cell_union_attempt` binds complete capture, source fingerprint,31 unique joined points, exact3cells/23+11+10 emitted triangles. Each emitted patch is consumed once, cell-group triangles exactly concatenate captured patch indices/order, and every patch point has exactly the global joined-point bits. It audits this44-triangle union as3cell groups with existing unchanged bounds and asserts647/1116 interior. Structured diagnostic prefix: `BOUNDARY_B_THREE_CELLS`.

This follow-up received only static metadata inspection and rustfmt, no build/test/geometry execution. Source certification and ideal-target adoption remain separate from its geometry result.

## Protected-fiber adaptation after global slab refusal

New copy: `/tmp/sfcc-boundary-b-fibers`. Only `boundary_transport_b.rs` differs from the actual44 candidate. Parent reported that the expanded global-slab source attempt refused at the unchanged128-check cap; that refusal is preserved.

New APIs:

- `combine_fiber_error(domain, points, source, tolerance)` requires C's explicit `slabDomain="original_triangle"`, `protectedFiberHalfWidth=tolerance`, exact `originalTrianglePointBits` in audited triangle order, and protected-fiber uniqueness/gluing certificate flags. It rebinds domain point bits and validates all source error bounds. It explicitly rejects pretending that `sharedEdgeRootsAgreeByCommonSlabUniqueness` is true or a common global X slab exists.
- `transport_fibers(domain, points, source, targets, tolerance)` uses the same simultaneous intermediate-orientation/fixed-boundary homeomorphism proof, then requires for each exact target enclosure `|target.X-original.X| + L_mesh*beta_target < protectedFiberHalfWidth`. This identifies the exact target as the protected-fiber root, conditional on the caller's exact-source target proof. The original `transport` remains an explicit common-slab path and refuses this new mode.
- `fiber_arc_containment(domain, points, source, targets, spanA, tolerance)` runs `transport_fibers`, binds four target images to A's three distinct actual interior edges, source fingerprint, physical-source proof flags and common ideal height enclosure. It requires strict canonical Z progression and `A.workingEdgeToPhysicalArcUpper + L_mesh*beta < protectedFiberHalfWidth` per edge. A's exact constant ideal Y and affine canonical Z then match the restriction of the PL transport to the original edge; protected-fiber uniqueness identifies the full ideal arc. Original A point/query/provenance binding remains a caller obligation, explicitly marked conditional in the report. Numerical equality of height enclosures alone is not promoted into a proof of exact common Y; A's analytical source construction supplies that premise.

Two new focused controls cover exact triangle order/point bits, explicit old/new-mode separation, strict target containment and unchanged radius. All edits received only rustfmt; no execution by B. Actual source/arc integration still requires parent validation. No caps, dependencies, or production files changed.
