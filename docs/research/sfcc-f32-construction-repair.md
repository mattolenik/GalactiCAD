# SFCC float32 construction repair

Milestone 3 of the [critical repair plan](../plans/sfcc-critical-repairs.md).
The reference is commit `64399ed`, after the corner and common-rim membership
repairs. The original production cubes and source-pinned Manim models remain
fixed. This record distinguishes checked supporting equations, sampled geometric
checks, and unresolved model obligations.

## Causes and construction changes

The six original bracket defects came from interior traced-curve samples that
rounded onto a required arc endpoint. The endpoint's parameter and junction
identity now survive; only redundant interior samples of that same ordered arc
are coalesced. Merged spans are rechecked at quarter/midpoint samples against the
original half chord budget. A whole arc whose required endpoints collapse is
unsupported, rather than silently removed. Tiny representable turns are retained.
This is a sampled traced-curve fidelity check, not a global Hausdorff theorem.

The housing had duplicate descriptions of both straight loft rims and curved
loft/cylinder-blend seams. Independent pins and samples produced degenerate fans
and incompatible projected boundary constraints. Straight rim pins now reuse the
canonical source-proven Segment chart from milestone 2; both working positions
must agree exactly. The canonical curve supplies the position and normal. Entire
loft side carriers are not equated.

Curved seams need a stronger identity argument. The new `loft_seam` module checks
a deliberately narrow source family: matching exposed domains, a rectangular
lower loft profile with an axis-aligned active edge, a convex upper profile with
a shared nearest endpoint, and a common two-term cut reducible to an active
finite cylinder offset. It verifies the actual profile edge, supporting-line
sign, cap dominance and active operand branches. Bounds use the stored inverse
affine coefficients; orthogonality is not assumed. Legacy cylinder/opaque scene
interval estimates are not certificate premises.

The two raw local equations are the loft equation and squared cylinder-radius
equation. An outward-rounded interval Jacobian and a represented constant
preconditioner establish `||I-CJ||∞ < 1`. Strict Krawczyk inclusion then proves
existence and uniqueness inside the common float32 rounding bin on the exact
canonical face plane. A nonzero sampled determinant or a small residual alone
would not suffice. Tests reject a translated near-tangent cylinder configuration
with two nearby roots in one float32 bin, and a neighboring bin with no root.
The certificate concerns real equations of represented coefficients; it does not
prove bitwise evaluator equivalence or global feature compilation/visibility.

Supported coincident traced arcs now share physical samples while preserving
each curve's own ordered endpoint parameters and intervals. Source equivalence
is checked locally, and the alternative trace's knots and quarter samples must
fit the shared polyline within the original half chord budget. These sampling
checks remain empirical. The graph retains all incident carrier candidates and
all applicable curve memberships; shared geometry is not permission to invent
additional feature labels.

## Crossing and planar-patch corrections

Recovered edge contours previously verified scene sign changes only when more
than two carrier candidates existed. Two duplicate or hidden candidates could
therefore produce a false narrow fan. The same verification now applies to two
candidates. It retains each carrier root's bisection bracket and samples only in
the gaps outside those brackets. This matters for the rotated housing's hole rim:
its first root lies about `0.00001947 mm` from an edge endpoint, while the existing
root tolerance is `0.00019102 mm`. The first rejected milestone-3 candidate
extended the old midpoint verification to two candidates without preserving
brackets. Its endpoint/approximate-root midpoint lay inside the solid and erased
this genuine pair. Curve 46 was intact in the milestone-2 baseline; this was a
candidate regression, not an older defect.
Overlapping coarse brackets receive bounded additional bisection, updated root
positions and sorting; still-unseparated brackets remain unsupported. Tests cover
this near-endpoint case, distinct float32 roots whose initial brackets touch, a
real narrow pair and false tangent/duplicate candidates.

Probe relocation is deliberately minimal: an existing midpoint outside the
adjacent root brackets is retained. A rejected experiment immediately discarded
overlapping coarse brackets. It lost narrow crossings, provoked chord-budget
failures/refinement, and produced 174 invalid final faces near a different rotated
cylinder cap despite valid preassembly faces. Logging established that the only
relocated probe was curve 46's strictly positive endpoint; cap probes had not
moved. Bounded bracket refinement addresses this separate candidate regression.
The root brackets remain numerical carrier brackets, not interval certificates
for all scene roots or robust sign classification on arbitrary zero-level edges.

A projected average is not necessarily in the visibility kernel of a concave
planar polygon. The bracket already had folded cap fans before this milestone;
the rotated housing also exposed a collinear boundary-apex fan. Invalid or folded
fans on planar carriers now use the existing constrained polygon triangulator.
Every boundary segment and required corner remains a constraint. Only the free,
unprotected fan center can disappear. Working and rounded triangles must preserve
orientation and embedding, and full-tree projection displacement is sampled at
the original `0.01 mm` surface budget in both representations. Failure propagates
to existing refinement/unresolved handling.

Curved trim chords can leave a plane's exposed domain even when their endpoints
belong to it. This route checks boundary carrier compatibility but leaves new
triangle ownership unknown; it does not loosen the general disk ownership test
or assign an unsupported carrier certificate. Projection convergence has its
own residual check. Field magnitude is not treated as Euclidean distance.

An experimental post-assembly quantized patch reconstruction was removed. The
final change uses neither global coordinate welding, blanket face deletion nor
point perturbations to satisfy an area test.

## Validation scope

The actual-WASM tests assert zero exact invalid float32 triangles on the original
production cubes, their rigid-axis rotations, and reverse-order worker merges.
Original housing gates require every compiled feature chain to pass, including
curves 75 and 106. The rotated housing retains an explicitly source-pinned
milestone-2 issue receipt: remaining issues must lie within its original curve,
kind and parameter intervals, and curve 46 must be complete. The underlying
validator's failed status is retained where older issues remain.

The bracket gate preserves its repaired three-curve junction and bounds its
existing chain failures; curves 63/64 must remain complete after planar repair.
Local geometry audits select new triangles, surviving vertices of removed
triangles, the old invalid neighborhoods, and multiply-labeled feature
neighborhoods, then test against the complete final
mesh with exact working/rounded intersection predicates. Invalid baseline faces
are counted separately rather than passed into valid-triangle predicates.
Component/Euler counts are reported as diagnostics, not proof that the baseline
topology was semantically correct.

Restoring the compiled curve-75 chain is distinct from independently verifying
the physical sharp crease. GPU-reference coverage and normal checks belong to
milestone 4. Unresolved cells and projection failures remain visible; zero invalid
faces does not make the overall SFCC result certified or acceptance-complete.

## First focused candidate

The [first focused receipts](../../.testresults/sfcc-critical-repairs/milestone3-release/)
retain all meshes, feature memberships, scene JSON, diagnostics and worker
payloads. All six original/rotated/worker full-model WASM gates pass. Native
`--lib --features serde,sfcc-profile` tests pass **234/234**, and `make build`
passes. The existing housing bore/rim test also passes: **7/7 focused WASM
tests** in total.

| Actual WASM case | Triangles | Invalid f32 faces | Components / Euler | Chain gaps / disconnected | Unresolved cells | Curve projection events |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| Original bracket | 108,530 | 0 | 1 / −10 | 46 / 4 | 59,713 | 138 |
| Rotated bracket | 107,892 | 0 | 1 / −10 | 40 / 3 | 40,374 | 191 |
| Original housing | 125,954 | 0 | 1 / −8 | 0 / 0 | 17,352 | 530 |
| Rotated housing | 127,646 | 0 | 1 / −8 | 4 / 0 | 16,368 | 530 |

The original baseline had 108,548 bracket triangles/6 invalid faces and 126,192
housing triangles/180 invalid faces. Their component/Euler values are unchanged.
The original bracket's feature issues, unresolved count and projection events
are unchanged. The original housing's 29 gaps, 8 disconnected curves and missing
curve 75 become zero; all eleven earlier membership repairs remain present.
Housing fallback cells change from 61 to 62 in WASM (native was already 62).
These counts do not erase the remaining overall `incomplete` validation status.

The source-pinned milestone-2 rotated housing receipt had 127,960 triangles,
175 invalid faces, 26 gaps and 8 disconnected curves. The four remaining gaps
are older spans on curves 71, 93, 94 and 95; none is newly allowed. Rotated
bracket feature diagnostics exactly match the earlier pre-planar milestone-3
receipt. Reverse worker merge outputs match each corresponding serial mesh's
vertex/index buffers. Both report `serialRecovery=true`; this exercises the
worker route and recovery, not a claim that every raw partition was certified.

The repaired bracket junction remains in the single component, with all three
incident curves, six incident triangles and a point-to-mesh distance of
`4.70795875e-8 mm`. Its nearest actual vertex is `1.17738872e-7 mm` away.

All [local intersection audits](../../.testresults/sfcc-critical-repairs/milestone3-release/audits/)
find zero invalid/intersecting triangles in their selected neighborhoods against
the entire final mesh. Actual-WASM selected counts are 372 (bracket), 247
(rotated bracket), 1,520 (housing) and 988 (rotated housing). Working-f64 native
audits select 546, 4,235 and 5,032 triangles for bracket, housing and rotated
housing respectively, with zero intersections in both working and rounded
coordinates. The valid-face baseline bracket audit found 38 pre-existing local
intersection pairs, with its six invalid faces counted separately. An absence
of intersections is not a complete coverage proof.

For the rotated bracket, 606 removed and 78 new geometric triangles were also
checked for an obvious omission: 1,905 distinct old vertices, edge midpoints and
centroids are within `0.01700655 mm` of the new mesh, below the `0.02 mm`
comparison budget. The [distance receipt](../../.testresults/sfcc-critical-repairs/milestone3-release/audits/rotated-bracket-removed-distance.json)
uses the existing closest-triangle helper with a conservative triangle-AABB
filter. This is sampled old-to-new mesh distance, not independent surface truth
or a Hausdorff certificate; it does not enlarge the construction's `0.01 mm`
surface budget.

Native bracket output differs from WASM: 108,532 triangles and 141 projection
events. Native housing and rotated housing have the same triangle totals as
their WASM counterparts. Their receipts remain labeled by backend.

The [build source manifest](../../.testresults/sfcc-critical-repairs/milestone3-release/provenance/source-manifest.json)
pins source snapshots and the production WASM hash. The later broadened audit
selection changes only a diagnostic example; its separate
[diagnostic change record](../../.testresults/sfcc-critical-repairs/milestone3-release/provenance/post-build-diagnostic-changes.json)
preserves both hashes. The subsequent
[five-model campaign](../../.testresults/sdf-meshing/2026-10-24T04-41-17-760Z/report.md)
found collateral crease loss on knob and Mess 2, described below. Therefore this
first focused candidate was not accepted merely because bracket/housing passed.

## Collateral constrained-filling failure

The first strict planar fallback discarded a failed constrained filling and
used an unconstrained cell loop instead. On knob this lost six additional
compiled curves and 296 previously covered parameter spans across 39 curves;
sampled old crease chords were as far as `0.0254083 mm` from the new mesh.
On Mess 2 it erased a genuine rotated-box edge even though the new surface
remained within `0.00845 mm` of sampled points on that edge. Surface proximity
alone does not preserve a sharp crease.

The older incident faces were already folded/intersecting, sometimes exactly
degenerate. That does not make the physical crease dispensable. Source inspection
also found rank-deficient synthetic traces: a scene/ancestor field together with
an exposed source-side plane can vanish on an entire surface patch, not an
isolated curve. Knob's socket floor and corners have independent two-plane
Segment constraints plus such duplicate/retraced descriptions. Native and WASM
feature numbering differ substantially on these models; diagnostics were matched
by source strata and geometry. Source ancestry and a shared float32 bin are not
a proof that two traces represent the same curve. No unproved plane/field alias
or model-specific exception was added.

The follow-up construction retains the previous constrained fan if the strict
repair cannot produce a supported filling. It marks that cell failed/fallback
while retaining the existing retry policy for independent graph/coverage failures.
Outside positive certificate scope, the new failure is report-only: repeatedly
refining an unsupported, duplicate-constrained description is not a demonstrated
repair. The final unsupported filling remains best-effort geometry. It never
reports that fan as a successful repair.
Negative `constrained_fan_unresolved` witnesses are retained even for
`outsideScope` models, with zero certified cells and no ownership/proof payload.
Worker transport preserves the failure and refuses a positive certificate in
that scope. Other structural graph failures retain their previous behavior.

The end-to-end regression exercises a quantized duplicate pin: nonempty
constrained geometry and the real box edge survive, while the cell remains
failed/unresolved and uncertified. A worker roundtrip tests the same negative
status, and rejects a forged positive outside-scope witness. Source-pinned WASM
regressions preserve 87 knob straight-crease spans with at least one valid
baseline incident face, and the lost Mess 2 box-edge span. Two additional knob
spans whose baseline incident faces were both invalid are explicitly retained
in the baseline receipt rather than claimed as valid support.

The [retained-output pilot](../../.testresults/sfcc-critical-repairs/milestone3-retained/)
restores all 296 knob spans and its feature diagnostics exactly to the baseline;
sampled old chords are within `7.88e-8 mm` of the new mesh. Its 4,588 invalid faces
and pre-existing unsupported status remain visible, alongside 145 explicit
unresolved-filling witnesses. Mess 2's independent box-edge span is restored;
the initial retained-output retry policy still introduced extra refinement and
new degenerate support near a cone/plane crease. The original bracket/housing
vertex, index and feature buffers were byte-identical to the first focused
candidate and retained zero invalid faces. This pilot was not the final policy.


## Retry-policy controls and bounded collateral result

Three isolated WASM controls separate sampling, refinement and crossing effects.
The copied Rust workspace has its own JavaScript binding and WASM byte input;
source patches, binaries and comparison hashes are retained with the
[ablation evidence](../../.testresults/sfcc-critical-repairs/milestone3-ablations/).
An unmodified copied-workspace export matches the live retained-output buffers
byte for byte. Disabling all traced-sample coalescing also produces identical
vertex/index/feature buffers. Thus coalescing did not cause the residual Mess 2
changes; two earlier ineffective source guards were removed.

Suppressing only the newly introduced retained-filling retries restores the
larger cone/plane crease spans. Prior graph-fallback retries and independent
coverage-edge failures still retry, as do failures in positive certificate
scope. Failed-cell counts and negative witnesses remain reported; validation
cannot become successful merely because a failure is not queued for refinement.
Production uses this policy without changing wire formats or adding a model
exception. Unit tests exercise coincident report-only and independent retry
causes, depth/round limits, positive scope, and worker negative-witness transport.

The isolated report-only result has 283,524 Mess 2 triangles and 17,953 exact
invalid faces, versus 283,562 and 17,959 at the milestone-2 baseline. Four small
parameter memberships remain lost on already disconnected/gapped curves 180
and 233, so missing-edge count is 342 versus 338; the total gap count remains
524 and missing-curve count remains 23. The four intervals duplicate two
physical segments with old chord lengths about 0.013881 and 0.005565 mm.
They remain explicit failures; this is not restoration of every trace interval.

A final isolated control restores only the old recovered-crossing algorithm,
keeping report-only retry behavior. It restores the baseline feature counts
and 17,959 invalid faces, attributing the four memberships and the net reduction of six
invalid faces to the corrected scene-sign verification. The old verification
is not restored in production. This is a causal code-path control, not a
certificate that every rejected old curve annotation was physically false.
The [saved residual audit](../../.testresults/sfcc-critical-repairs/milestone3-final-policy/audits/mess2-residual-sharp-coverage.json)
checks five points per residual interval: the report-only mesh has an indexed edge
with two exact-valid incident faces and at least a 45-degree dihedral within
0.00554294 mm. This is within the original geometric budget, but is only sampled
physical sharp-edge coverage: it proves neither ordered chain coverage nor
GPU-reference normal agreement or global embedding. The validator continues to
report those missing memberships.

The final production collateral exports reproduce the report-only control.
Knob has 185,928 triangles and 4,582 invalid faces (baseline 4,588), unchanged
component/Euler values `1 / 0`, and exactly the baseline compiled-feature
report with no lost raw parameter spans. Mess 2 has unchanged component/Euler
values `2 / [−91, 2]` and buffers identical to the isolated report-only control.
Its raw interval subtraction contains exactly the four recorded residuals.

Net invalid counts do not mean a pure deletion of old defects. The
[geometric defect multiset comparison](../../.testresults/sfcc-critical-repairs/milestone3-final-policy/audits/collateral-invalid-geometry-delta.json)
finds 14 added/20 removed invalid triangles for knob and 6 added/12 removed for
Mess 2. The R-only Mess 2 control has the same delta, concentrated around the
already unsupported sphere-family traces; all six additions have coincident
corners. Knob's additions are in its lower outer regions, away from the restored
socket constraints. These models remain failed: 143 and 539 explicit retained
filling witnesses, 48,615 and 30,083 unresolved cells, and 246,566 and 6,914 curve
projection events respectively. Neither model is claimed to have a valid mesh.

## Final focused validation

The [final policy receipts](../../.testresults/sfcc-critical-repairs/milestone3-final-policy/)
record **238/238 native library tests**, **9/9 actual-WASM regressions**, the
parent-run **14/14 acceptance harness tests**, and a successful `make build`.
The [source manifest](../../.testresults/sfcc-critical-repairs/milestone3-final-policy/provenance/source-manifest.json)
pins the exact production source and WASM bytes; the research record subsequently
gained these results without changing production code.

All six original/rotated/worker bracket and housing outputs have vertex, index
and feature buffers byte-identical to the first focused candidate. The
[buffer comparison](../../.testresults/sfcc-critical-repairs/milestone3-final-policy/audits/final-buffer-comparison.json)
also confirms unchanged knob feature diagnostics and the exact four Mess 2
residual intervals. Therefore the earlier exact f32 neighborhood intersection
audits apply to these same final primary-model bytes; they were not relabeled
as newly generated native-f64 audits. The original housing retains every
compiled chain and its bore/rim gate. Worker results continue to exercise serial
recovery, with the same qualification as the first focused candidate.

## Final campaign and milestone status

The parent-owned [five-model campaign](../../.testresults/sdf-meshing/2026-10-24T06-37-24-409Z/report.md)
completed successfully as a harness run; overall mesh acceptance **did not pass**.
All three raw buffers for each of the four available meshes match the final
focused exports byte for byte, as recorded in the
[focused comparison](../../.testresults/sdf-meshing/2026-10-24T06-37-24-409Z/focused-buffer-comparison.json).
The separate [milestone-2 comparison](../../.testresults/sdf-meshing/2026-10-24T06-37-24-409Z/baseline-comparison.json)
retains the baseline deltas; the report's first-inventory label does not replace
that explicit comparison.

| Case | Triangles | Exact invalid faces | Acceptance status and remaining limit |
| --- | ---: | ---: | --- |
| Bracket | 108,530 | 0 | FAIL: existing compiled-chain failures; 46 gaps |
| Housing | 125,954 | 0 | INCOMPLETE: all compiled chains pass; 17,352 unresolved cells and independent coverage pending |
| Knob | 185,928 | 4,582 | FAIL: existing malformed geometry and feature obligations remain |
| Mess 2 | 283,524 | 17,953 | FAIL: malformed geometry remains, including five nonmanifold edges and the documented four residual memberships |
| Mess 1 | unavailable | unavailable | TIMEOUT at the existing budget |

Milestone 3 is **implemented within its bounded bracket/housing contract**:
zero exact invalid output faces, preserved earlier junction/membership repairs,
valid basic topology and passing local intersection gates on those models.
The accepted collateral limits above remain explicit; this is not a general
triangulation, feature-reconstruction or whole-suite acceptance claim. No
performance improvement is claimed from the single campaign timings.
Milestone 4's independent GPU coverage/normal checks and milestone 5's
conservative exclusion/cost work remain pending.
