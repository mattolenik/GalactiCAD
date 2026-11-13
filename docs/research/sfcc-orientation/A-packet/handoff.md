# A: successful-cell graph and patch provenance

Frozen source: `/tmp/sfcc-orientation-a`, copied from exact restored `/tmp/sfcc-orientation-base`.
This agent performed static inspection, source edits and rustfmt only. Root owns all builds, tests, field queries and component execution.

## Change and scope

Exactly two files change:

- `gcad-wasm/kernel/src/sfcc/cell_mesh.rs`
- `gcad-wasm/kernel/src/sfcc/graph_capture_b.rs`

The existing graph capture already records exact pre-call loops, pins, corners, source descriptors, positions and normals, but successful-cell evidence is erased when the next cell begins. The added `orientationCaptureA` retains diagnostic evidence only for the witnessed cell `[7,25,58,86]`. The dense cell ID is a diagnostic selector, never geometry or acceptance authority.

Its first graph event copies the original pre-call snapshot and records graph edges, memberships, the sorted vertex rotation system, boundary-directed edges and selected patch polygons. Existing fan computations report selected stratum, boundary, mean, projected mean, already-computed carrier normal and full-tree gradient, wrong-patch decision, and chosen projected/boundary fan branch. Each patch output reports emitted triangle indices and new point positions/normals. A success event records the complete cell triangle list and unresolved flag.

The hook closures are evaluated only for the selected active diagnostic. They add no source-field, gradient or curve queries. Fan acceptance, short-circuit evaluation, graph traversal, stratum scores, projection arithmetic, triangle order and output remain unchanged. The existing computed `fan_from_stratum_vertex` boolean is saved then used by exactly the old unresolved branch.

The existing 512-KiB serialized capture bound applies to the retained record. A fixed 128-event cap marks refusal before evaluating an additional closure. Point serialization reuses the existing 1,024-point/string-length bounds and records explicit refusal if unavailable. Existing construction, geometry and query limits are untouched.

## Root checks

Run `orientation_a_` (two tests) then applicable retained controls and one bounded component capture. No new receipt environment is needed for this diagnostic: it appears in the standard component receipt at `admissionAndQueryEvidence.orientationCaptureA`.

The controls check inactive lazy behavior, target pre-graph retention after next-cell clearing, and explicit event/serialized-byte refusals. Root must compare every pre-existing component receipt field against the restored predecessor, excluding only the new retained capture and process-local root addresses. No geometry result is claimed here before that run.

## Independent saved-geometry observation

The prior saved component already reveals a stronger failure than one triangle facing the wrong normal. In the first cell, triangle11 is `[636,455,633]`, and triangle22 is `[636,633,455]`: exact opposite-winding duplicates. Similar reverse pairs occur at12/21 and13/20, among others.

The implied center636 fan boundary traverses feature chains out and back:

`[453,455,633,632,628,629,630,631,454,456,628,632,633,455,454,631,630,629,628,461]`.

This is not a simple polygon. Flipping one failed triangle would duplicate its opposite partner with the same orientation. A projected-center fan cannot be assumed valid for this repeated-chain boundary. The capture must distinguish a wrong rotation system, coincident source representations, a legitimate slit boundary, and incorrect patch selection before choosing a repair.

Static implementation facts: graph patch candidates union edge-stratum sets then select by summed absolute values at boundary vertices; single-loop graph output skips the later sampled patch and contact checks; `repair_planar_fan` returns success immediately for non-plane carriers. These are hypotheses' entry points, not yet a source-bound causal conclusion.

## Remaining obligations

Read the captured chosen stratum, exact patch polygon and rotation at the shared corner. Establish source-consistent physical ray order and whether apparent aliases are actually one local arc. Use a constrained triangulation only after its boundary and patch premises are valid; do not treat a whole-loop reversal or per-triangle flip as a repair. No runtime geometry change or production integration is included in this packet.

## Executed capture and causal refinement

Root reports eight focused controls passing and the bounded component capture completed. I compared the saved receipt against the prior Geometry-capture receipt: every pre-existing field is equal after excluding only `orientationCaptureA` and process-local root addresses.

The selected cell has one boundary loop. Pins in its directed order include curve49→point39, curve20→461, curve66→455, curve46→454 and curve75→456. At the shared corner628, the computed rotation places neighbors629(curve46),632(curve66),456(curve75),39(curve49),461(curve20) in cyclic order. Thus the two near-coincident native/chamfer representations occur in opposite order from their distinct boundary ports.

The graph generates three patch walks. The offending 20-entry walk selects lifted stratum38 and emits all20 center636 triangles through `fan_from_stratum_vertex`. Its projected-center carrier normal equals the already computed tree gradient bit-for-bit and `wrong_patch` is false. Consequently the observed opposite triangles are not explained by a carrier normal that merely points against the whole-tree reference.

C's independent combinatorial analysis refines the initial slit hypothesis: these radial paths are not abstract graph bridges; the rotation system creates the wrong face orbits. Reordering the corner alone would still introduce a thin sector between the two numerical alias ports. Correct physical reconstruction needs source-qualified interval/face-root correspondence before quotienting those representations, with both source identities and shared-face consumers preserved.

The separate `/tmp/sfcc-orientation-a-guard` candidate rejects repeated-vertex patch walks before fan construction. It is intentionally fail-closed, not an alias merge or a completed geometric repair. See `/tmp/sfcc-orientation-a-guard-handoff.md` for its exact one-file delta and root validation obligations.
