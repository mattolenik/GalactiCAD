# Independent GPU regional acceptance measurements

Milestone 4 adds a second, bounded source of geometric evidence to the full
Manim torture cases. It does not change SFCC construction. The reference uses
`sceneSDF` in the existing GPU `IsoSampleBatch` shader, independently of the
exporter's compiled carriers, feature IDs, parameter intervals and native/WASM
field diagnostics. Both evaluators still originate in this application's scene
semantics; this is not an independent CAD model specification.

## Source and resource identity

The acceptance capture retains one mesh export and pins its source SHA-256 and
raw-buffer digest. Sampling is a separate RPC after that export, so its time is
not included in export time. The worker verifies the transpiled body against the
successfully built full scene and rejects isolation, stale geometry, nonfinite
positions/results and parameter edits. A source-build guard is invalidated at
the start of a build and by out-of-band polygon, cap, parameter and gizmo edits;
only a successful, non-superseded source build makes it clean again. Edits during
readback also invalidate the result. The source hash is not merely echoed as a
substitute for checking the built scene.

Sampling holds the scene build lock and uses its own `IsoSampleBatch` buffers.
It therefore does not alias the background feature-graph sampler's staging
buffer. The existing `polygonVertices` and `mdcSceneParams` storage bindings and
export WGSL emitters are reused. No scene SDF is evaluated on the CPU for this
reference. The renderer transfers finite float32 positions and returns GPU
`normal.xyz, field` records; CPU work consists of selecting positions and
measuring triangle geometry.

## What the measurements mean

Each source-pinned region has an explicit center, extent and grid spacing. All
three families of grid lines are scanned. Consecutive nonzero samples with
opposite signs produce brackets, including intervals spanning rounded-zero
samples. Bisection retains **strict** endpoint signs; a zero midpoint is not
invented into a sign or declared an exact real root. Quarter probes shrink a
bracket around a zero plateau where possible. The saved evidence includes the
actual float32 endpoints, field values, normals, final width and unresolved
brackets. Same-sign intervals and zero occurrences remain visible; neither is
an exclusion proof. Features thinner than the scan spacing, tangent sheets and
unsearched regions can still be missed.

For a bracket midpoint `p`, the nearest valid stored triangle is found using an
AABB tree over the complete retained mesh. Let `d` be that distance and `u` the
half bracket width plus the recorded float32 position allowance. The sampled
surface check passes when `d + u <= 0.01 mm`, fails when `d - u > 0.01 mm`, and
otherwise remains uncertain. This interpretation assumes a continuous field
and faithful signs from floating-point GPU evaluation. The position allowance
is **not** a certified error bound for arbitrary WGSL arithmetic. It is not a
Hausdorff certificate, even inside the sampled box.

The other direction samples vertices, edge midpoints and triangle centroids of
faces intersecting each region. The report records any deterministic stride if
the face count exceeds its cap. Raw field residuals are checked at the original
0.01 field-unit budget and explicitly distinguished from Euclidean distance:
blended fields need not be distance functions. A separate normal-line search
requires strict GPU sign brackets and records a displacement plus bracket
allowance. A value within the surface budget supports that sampled point under
the same sign/continuity assumptions. A value above the budget or lack of a
bracket is an **unresolved projection obligation**, not proof that every surface
point is farther away.

## Crease evidence

Investigation coordinates select a short search corridor; they do not supply
reference normals or a compiled curve chart. In each transverse section, nearby
GPU root normals identify candidate sides. Their local tangent-plane
intersection is refined using new bracketed GPU samples. Opposite directions
on each supporting tangent plane are tried, so the initial seed does not decide
which side is present. Independent surface-side probes at 0.02, 0.01 and 0.005 mm
must retain their normal contrast as the offset shrinks; smooth curvature whose
contrast collapses is left ambiguous. This is an empirical local procedure,
not a proof of a mathematically sharp curve.

Candidate mesh edges must be within the original 0.02 mm feature budget, have
two incident faces, match the two reference-side normals up to permutation, and
retain at least half the measured normal contrast. The angular allowance is
empirical: the larger of two degrees and half the local reference contrast.
The retained-contrast condition is separate; equal face normals cannot pass
merely because both fit that allowance. Face normals are recomputed from
triangle **positions**, never taken from the display normal buffer. Additional
comparison uses GPU normals at bracket-projected corresponding face centroids;
missing or over-budget centroid projections remain ambiguous. Section order is
checked through the candidate edge graph, allowing several small mesh edges
between successive sections. Geometry, connectivity and stored feature-label
coverage are reported separately.

Remaining ambiguities and concrete failed sections stay visible. A sampled
regional pass never promotes the overall mesh to accepted or cancels existing
SFCC refinement/feature obligations.

## Corruptions and reproducible regression evidence

Every applicable live acceptance run performs deliberately destructive *copies*
of the captured geometry while keeping the GPU reference fixed:

- Delete the bracket's junction patch; GPU root-to-triangle distances must
  detect its loss without relying on topology diagnostics.
- Add a triangle bridging the housing's internal branch passage; GPU samples at
  that triangle's edges and interior detect field disagreement.
- Remove feature labels while retaining geometry; only the metadata obligation
  should change.
- Flatten the housing crease by moving actual mesh vertex positions to a common
  plane while retaining labels and the old normal buffer. The recomputed
  incident-face normal contrast must detect the damage.

The corruption receipt stores the exact deleted triangle IDs, moved vertices,
added triangle and numerical checks. It is not a repaired or exported mesh.
A failed corruption stage cannot erase an already completed reference receipt.
Sampling errors are harness errors and retain the successful original mesh,
export statistics and any prior evidence.

The checked-in [bracket GPU counterexample](../../test/acceptance/sdf-meshing/bracket-gpu-counterexample.json)
contains an authentic strict GPU sign bracket and compact old/repaired triangle
neighborhoods. Provenance includes full source and mesh-buffer hashes. The full
original closed mesh misses this GPU witness by **0.0428168267 mm**; the repaired
mesh is **0.0000686730 mm** away. Both full-mesh distances were measured before
cropping; every omitted triangle AABB is at least 0.15 mm from that witness.
This nearby GPU witness independently detects the old omission; it is distinct
from the original analytically located corner's 0.057258117 mm miss. Tests do
not require ignored historical run directories or another CPU scene evaluator.

## Validation and remaining failures

The bracket development capture measured 326 strict-bracket roots and 210
vertex/edge/interior samples. Its largest sampled surface-to-mesh distance was
0.00102973 mm. Deleting the local junction patch raised the measured miss to
0.08140969 mm. Several normal-line projections remain ambiguous around the
junction; surface sampling does not erase those obligations.

The housing development capture exposed a **newly measured existing** defect:
the main-bore region has a sampled surface-to-mesh miss of 0.0132767071 mm,
exceeding the unchanged 0.01 mm surface budget. The loft/chamfer region reached
0.00613768 mm, the flange region 0.00010673 mm, and the branch bore 0.00457880 mm.
The mesher is unchanged by this milestone; the main-bore failure is a diagnostic
result, not something hidden by increasing the threshold to 0.02 mm.

The final full campaign and exact final crease/ambiguity counts are recorded in
the acceptance report linked from the repair plan. Browser images are collected
by the existing harness; manual visual QA remains with the user.

### Final targeted receipt and open exit conditions

The [final targeted housing receipt](../../.testresults/sdf-meshing/2026-10-24T07-09-48-642Z/report.md)
uses the original budgets and includes 772 loft/chamfer roots, 289 flange roots,
and 170 roots in each bore region. All three housing corruption checks detected
their intended damage. The main bore has 92 root-to-mesh misses, 24 sampled
field-residual violations and 24 over-budget projection obligations. These are
sample counts, not counts of independent holes or defective faces.

The loft/chamfer crease has nine resolved GPU reference sections. Eight satisfy
the empirical geometry tests. Section 5, near
`(8.214349029, 4.772261598, 14.691963856)` mm, fails the **corresponding projected
face-centroid normal comparison**: the best available paired error is
6.4895767 degrees, above the 5.8702329 degree empirical allowance. The reference
jump is 11.7404659 degrees and is stable across shrinking offsets; direct
crease-side normal matching alone reaches 4.4789957 degrees. Thus the added
centroid check, rather than a missing numerical reference or a large positional
miss, prevents this section from passing. The full ordered edge-chain result
also remains failed because this section has no qualifying edge. This does not
by itself establish a positional tolerance violation or prove that a physical
crease was deleted. Preserve it as an independently measured normal-fidelity
obligation; investigate incident face geometry and local tessellation next.

All flange crease sections remain ambiguous. They have candidate supporting
normals and some valid strict side brackets, but the final shrinking-side check
cannot establish both sides with its fixed ±0.03 mm normal search and field
agreement gate. A likely limitation is that a long normal segment near a sharp
cap also crosses the neighboring cap, putting both endpoints outside; same
signs then hide intervening crossings. This is an inference from the local
geometry, **not** an absence proof. The current receipt reports a combined
bracket/field-agreement failure and does not retain each failed probe, so those
two causes cannot be separated conclusively from that artifact. A follow-up
should retain failed probe endpoints and use a bounded, nested normal search
before concluding anything about the flange crease. Its independently scanned
surface positions already pass.

The [checked-in housing measurement fixture](../../test/acceptance/sdf-meshing/housing-gpu-crease.json)
retains authentic GPU reference/centroid normals and a 96-face neighborhood,
including this existing failed section. Its tests require deleted labels and
flattened positions to create **additional** failures; they do not rewrite the
baseline as passing. The full harness has 23 passing tests, including source
mutation/build lifecycle, capture error propagation, report classification,
the old closed-bracket counterexample and these corruption checks. Application
build validation passed. No manual browser or image inspection was performed.

**The milestone's measurement infrastructure is implemented; the complete
repaired-crease acceptance exit remains open.** The unresolved flange reference
and failed loft/chamfer normal section are not hidden by overall image scores,
compiled curve membership success, or successful corruption detection.


### Final five-model campaign

The [final campaign](../../.testresults/sdf-meshing/2026-10-24T07-12-23-548Z/report.md)
completed with harness exit 0. The
[baseline comparison](../../.testresults/sdf-meshing/2026-10-24T07-12-23-548Z/baseline-comparison.json)
confirms that every available vertex, triangle and feature buffer is
**byte-identical to milestone 3** for bracket, housing, knob and Mess 2. The
new housing failure is additional measurement of existing geometry, not a
geometry regression introduced by this milestone. Source files used by the
campaign remained unchanged throughout it.

All four deliberately corrupted cases were detected. Bracket's regional GPU
status remains **INCOMPLETE** because 106 normal-line projections are ambiguous,
even though its independently scanned surface positions pass. Housing's GPU
status is **FAIL**, retaining the bore and crease measurements described above.
Overall bracket, housing, knob and Mess 2 are failed; Mess 1 retains its bounded
180-second export timeout. Harness success is not mesh acceptance.

Validation receipts are archived with the run:
[application build log](../../.testresults/sdf-meshing/2026-10-24T07-12-23-548Z/provenance/gpu-regional-coverage/application-build.log),
[23-test harness log](../../.testresults/sdf-meshing/2026-10-24T07-12-23-548Z/provenance/gpu-regional-coverage/harness-tests.log),
and [full campaign log](../../.testresults/sdf-meshing/2026-10-24T07-12-23-548Z/provenance/gpu-regional-coverage/full-campaign.log).
These generated artifacts remain outside source control. The compact
source-pinned regression fixtures and measurement code are checked in.
