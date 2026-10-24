# SFCC common loft-rim membership repair

Milestone 2 of the [critical repair plan](../plans/sfcc-critical-repairs.md).
The starting mesh is the unchanged full housing from the
[bracket/housing investigation](sfcc-bracket-housing-investigation.md).

## Compatibility established from the full housing

The eleven diagnosed parameter gaps belong to nine coincident curve pairs:

| Curve pair | Side strata | Shared cap | Diagnosed gaps |
| --- | --- | --- | --- |
| 3 / 12 | 6 / 21 | 23 | 1 |
| 6 / 7 | 19 / 20 | 23 | 2 |
| 9 / 10 | 20 / 21 | 23 | 1 |
| 14 / 15 | 7 / 8 | 23 | 1 |
| 17 / 18 | 8 / 9 | 23 | 1 |
| 20 / 21 | 9 / 10 | 23 | 1 |
| 24 / 25 | 11 / 12 | 23 | 1 |
| 27 / 28 | 12 / 13 | 23 | 1 |
| 30 / 31 | 13 / 14 | 23 | 2 |

All pairs describe the same source loft occurrence, with the same lower profile
edge and cap. Their other profile edges differ. A loft side carrier has field
`g = (1-t) d_a + t d_b`; at the lower cap `t=0`, its restriction is exactly
`d_a`. Thus these are coincident rim descriptions, while their interior side
patches can remain different. The repair does not equate those side patches.
The complete compiled Segment charts of each housing pair are identical.

The production compatibility check requires:

- The same cap stratum and source leaf occurrence, sign, transform, loft segment,
  and oriented profile edge at that cap.
- Agreement of the cap plane with the transformed source cap equation.
- Exact collinearity of the represented finite Segment charts, using dyadic
  predicates on direction and origin displacement. Rounded-coordinate equality
  or distance to a nearby curve cannot establish identity.
- An overlapping domain in the two charts. Each membership retains its own
  oriented parameterization under their affine parameter map.

This relies on the existing compiled curves' exposed intervals. It does not
independently certify feature compilation, global visibility, or general curved
overlaps.

## Construction and transport

The shared serial/worker assembly finish now reconciles these memberships before
cleanup and refinement. The existing indexed physical edge is the geometric
identity; all compatible curve memberships are attached to it through the existing
`PointTable`. No worker format changes are needed: edge membership lists already
support multiple oriented intervals and their subdivision.

When a partial-overlap endpoint lies inside an existing edge, all incident faces
are split conformingly. Candidate children must preserve winding and remain
nondegenerate in working f64 and exported f32 coordinates before any mutation.
Inserted points must lie exactly on the original edge in both representations,
so accepted splits preserve its embedded geometry. General rotated partial cuts
that cannot satisfy this representability condition remain explicit chain gaps.
Each original interval is split using its own parameter chart, and patch ownership
is transported to children. A rejected split retains the missing membership and
its ordinary chain failure. A clipped interval is never attached to a longer edge.

Only edges belonging to valid f32 faces can gain memberships. The original
feature-chain validator remains unchanged. This is neither global coordinate
welding nor deletion of invalid faces. The cell feature graph's duplicate-edge
rejection remains conservative where no compatible incident-patch construction
has been established; the demonstrated housing spans already have physical edges
and need their missing memberships retained during common assembly.

## Validation and remaining defects

Focused native tests cover reversed charts, partial overlaps across both faces of
a closed manifold edge, metadata subdivision, different interior side carriers,
close distinct sheets/source occurrences, exact displacement predicates,
idempotence, invalid faces, and rejected f32 collapse without partial mutation.
The actual-WASM fixture uses the complete source-pinned housing and production
cube `min=(-22.45,-12.7,-22.2), size=44.9`; it checks every diagnosed gap and
reverse-order worker merging on valid physical edges.

The production-cube serial WASM gate passed with all eleven spans carrying both
memberships on valid physical edges. The full vertex and triangle buffers are
byte-identical to the original acceptance capture:

| Metric | Before | Candidate serial WASM |
| --- | ---: | ---: |
| Triangles | 126,192 | 126,192 |
| Exact invalid f32 faces | 180 | 180 |
| Parameter gaps | 40 | 29 |
| Disconnected curve reports | 13 | 8 |
| Removed/missing indexed feature edges | 79 | 79 |
| Missing curves | 1 | 1 |
| Off-curve / invalid memberships | 0 / 0 | 0 / 0 |

Vertex-buffer SHA-256: `61afdf36ed2729ec2408ad21904e0309cbb946a3c9c8b7e37accefcad9035b9e`.
Triangle-buffer SHA-256: `cf24c353ddf6159aec1e143d9fd3840a9f8d22b579bb78ea187ceb9c85613387`.

Seven pairs now have complete connected chains. Pairs 6/7 and 30/31 each retain
two indexed components and four endpoints in their combined physical edges.
The added memberships expose this existing malformed geometry on both labels,
so curves 7 and 31 now also receive strict disconnected-chain reports. This is
not a new vertex, face, or geometric defect: both complete buffers are unchanged.
The validator was not relaxed to remove those reports.

[Original duplicate-edge evidence](sfcc-feature-overlap/baseline-duplicate-rims.json)
records all six duplicate spans, original vertex/triangle indices, coordinates,
and 20 incident triangles. For example, original edges 62696–62699 (curve 7) and
63021–63025 (curve 6) coincide, while triangles 126184 and 126185 are collinear
fans on that span. On the opposite rim, edges 33–41 and 36–38 have the analogous
problem in triangles 47 and 51. These are direct targets for milestone 3.

All six focused full-model WASM tests passed: bracket and housing production
exports, rigid axis rotations, and reverse-order worker merges. Housing's worker
result uses `serialRecovery=true`; its final recovered vertex/index buffers equal
the serial result, which does not certify raw worker construction. The rotated
housing has 127,960 triangles and 175 invalid faces, with all eleven membership
obligations covered; curve 75 remains disconnected/gapped there.

- [Focused WASM gate log](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/provenance/feature-overlap/wasm-gates.log).
- [Nine native tests](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/provenance/feature-overlap/native-tests.log), including the final
  conservative representability guard and rejected rotated partial cuts.
- [Full native library: 224 tests passed](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/provenance/feature-overlap/all-native-tests.log) with `serde,sfcc-profile`.
- [Final application build](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/provenance/feature-overlap/build.log).
- [Fourteen acceptance checker tests](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/provenance/feature-overlap/acceptance-checks.log).
- [Validation record and source hashes](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/provenance/feature-overlap/validation.json).

The full-model WASM gates preceded the final conservative inserted-point guard;
the demonstrated complete duplicate charts do not insert points, so that guard
cannot change their result. Native tests and the application build cover the
final guard. The [final five-model acceptance campaign](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/report.md)
completed with all four available vertex/index buffers byte-identical to
milestone 1. Only housing's feature buffer changes; bracket, knob and Mess 2
feature buffers are also unchanged. Housing has 29 parameter gaps and eight
disconnected-curve reports. Mess 1 retains its 180-second timeout. All remaining
acceptance failures remain visible. The run's
[comparison record](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/baseline-comparison.json)
contains per-case artifact checks and metrics; single timing samples do not
establish a performance change.

Curve 75 remains a separate traced-crease construction obligation. The prior
trace reaches the `feature_multiple_curves` depth limit and falls back to ordinary
cell loops. Nearby ordinary edges do not establish its ordered crease or incident
patch normals. This change cannot infer a curved membership from proximity.

The 180 housing zero-area faces are a separate milestone. Membership reconciliation
must not be represented as a repair of those malformed triangles, conservative
refinement uncertainty, or the missing traced crease.
