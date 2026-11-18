# Round39 A reviewed capture

Preserves original `/tmp/sfcc-incident-a` and first runtime refusal. Updated only `/tmp/sfcc-incident-a-reviewed/gcad-wasm/kernel/src/sfcc/incident_a.rs`.

Replaces the invalid equality between raw rounded-point closed-box ownership and original face-record ownership with two separate checks:

1. Discrete ownership: original FaceRecord incidence, exact integer leaf-side plane and extents, two distinct opposite consumers, known retained consumer. Every raw-box consumer must be one of these represented owners; no boxes are enlarged.
2. Retained numerical defect: construct the represented original face rectangle from exact lattice face identity; outward intervals bound signed normal-plane displacement and a conservative L1 upper bound on distance to the closed rectangle. This bound must satisfy the original unchanged allowance, recomputed by the existing `shared_arc_plan::numerical` rule for the original selected pair. No new curve queries, extra ledger, box widening, or ideal-target membership assertion.

Adds `endpoint1116.rawClosedBoxConsumerCells`, `faceOwnershipAndRetainedDefect` and an explicit false `idealTargetFaceMembershipProved`. All earlier point/source/fan/emitted geometry bindings and replay caps remain unchanged.

Controls: `incident_a_record_owned_tiny_plane_offset_keeps_distinct_geometric_claims`; `incident_a_wrong_record_ownership_cannot_be_fixed_by_small_coordinate_defect`. The latter refuses same-sided owners, wrong known owner, extra unrepresented raw-box consumer, and excessive lateral rectangle defect.

Only static edits and rustfmt parsing performed. Root must compile/test/capture. Ideal source target membership and boundary transport remain separate obligations.
