# SFCC invalid construction: E4 investigation

Status: **in progress; no E4 production repair is selected or validated yet**.
Baseline is `3abea38c93679fff5e6e7c600b23d8a0f46974a6`, after the bounded
[E3 housing crease repair](sfcc-housing-creases-e3.md). Work follows
[E4 in the execution plan](../plans/sfcc-critical-repairs.md#execution-and-review):
knob first, then Mess 2, with three independent competitors and a fourth reviewer.
Complete original models remain mandatory; local probes supplement them.

## Saved release geometry

Independent exact-coordinate audits reproduce every knob defect identity and
classification. No minimum-area epsilon is involved.

| Original model | Triangles | Coincident-corner faces | Three-point collinear faces | Total invalid f32 faces |
| --- | ---: | ---: | ---: | ---: |
| Knob | 249,246 | 4,484 | 98 | 4,582 |
| Mess 2 | 341,864 | 17,916 | 37 | 17,953 |

The coincident corners have distinct vertex indices. Every collapsed edge
occurrence lacks an exported curve-membership record, but that does **not**
establish that the separate construction protection set excludes it. Nor does
it make its endpoints free: the first knob pair terminates two different
curve charts with distinct parameters. The diagnostic `featureCurves` list is
a union of incident vertex labels, not ownership of the collapsed edge.

Counts retain multiplicity. Knob has 2,243 distinct collapsed vertex pairs and
Mess 2 has 8,958; a pair can occur in multiple invalid faces. Neither proximity
nor equal f32 coordinates authorizes identifying their source geometry.

## Native trace and backend limits

One unchanged full knob native diagnostic finished its export and saved the
geometry, cell records and source matches. Its later annotation stage failed
with `native feature ID missing`, because the old helper attempted to index
native curves using saved WASM IDs. The 93.074-second invocation did not time
out. The useful trace has 662,981 records and zero dropped records; the failed
annotation and unexecuted probe stage remain explicit.

The native mesh has 245,932 triangles and 3,953 invalid final f32 faces. It is
not the WASM mesh above. Exact dyadic-coordinate checks of its corresponding
working and exported rows give:

| Native final triangle class | Count |
| --- | ---: |
| Valid working f64, invalid exported f32 | 3,694 |
| Invalid in both representations | 259 |
| Invalid working f64, valid exported f32 | 7 |

Thus rounding can hide working degeneracy as well as introduce it. Final f32
validity cannot stand in for working-coordinate validity.

Oriented geometry/multiplicity joins account for 3,883 native invalid final
faces and 2,495 WASM invalid faces in retained preassembly records. The 3,898
and 2,501 source-event rows are not counts of distinct final faces. Seventy
native final invalid occurrences lack a retained preassembly geometry match;
their first defective stage remains unresolved. The native/WASM invalid-face
multiset intersection contains 2,537 occurrences. Backend-specific and unmatched
cases must not disappear from the inventory.

## First construction family under investigation

The largest matched native group contains 1,693 working-valid triangles that
collapse to two f32 positions in nonfallback feature-graph construction. Another
1,572 matched cases occur in fallback cell-loop construction. These are broad
stage groups, not proof that one repair fixes every member.

The first native face matches cell `(8,40,131,127)` uniquely; its neighbor matches
`(8,40,131,128)`. Both use two distinct boundary pins on their common face,
approximately `4.2458259e-11` mm apart. The free fan center is not the collapsing
pair, so moving only that center cannot repair this fixed boundary segment.

A bounded feature-only probe, using exact integer companions for all input
floating-point coordinates, found exactly two native curve crossings in the
witnessed f32 pin bin:

| Native curve | Supporting carriers | Sampled face-restricted determinant |
| --- | --- | ---: |
| 301 | TwistedSide 10 and Cylinder 15 | approximately −1.9898936012 |
| 468 | Field 30 and Cylinder 15 | approximately −1.9898936012 |

These IDs are local to this native compilation; they are not substituted for
WASM curve IDs. Field 30 is the round-union operand containing the lathe body
and twisted extrusion, with radius 1.4. TwistedSide 10 is a particular finite
profile edge of that extrusion. Outside the blend transition, the full operand
field can reduce to the native side equation. This identifies a plausible
overlap of carrier descriptions, not a proven common root.

The competing proposals must distinguish two obligations. First, branch
reduction needs bounds for the inactive blend operand, extrusion cap, twist
regime and actual nearest finite profile edge throughout the sharing domain.
Second, the reduced equations need a common-root existence/uniqueness argument
on the exact canonical face. A sampled determinant, small residual or matching
rounded positions supplies neither. Identifying whole arcs additionally needs
coverage of their domain and transport of both original parameter charts;
a proof restricted to one pin bin does not authorize whole-arc merging.

Negatives include distinct nearby source occurrences, two roots in one f32 bin,
blend/cap/profile branch ambiguity and a neighboring bin with no root. Stored
affine matrices are represented coefficients, not assumed exactly orthogonal.
No blanket welding, post-hoc face deletion, jitter, tolerance increase or new
CPU scene-reference evaluator is introduced.

## Complete construction lineage and falsified alternatives

A second full-context diagnostic records only the two selected cells while
executing the unchanged complete model. All five native working/output buffers
match the baseline exactly. It completed in 84.026 seconds with 54 retained
events, zero drops and no limited metadata; the unverified one-leaf prototype
was never used as a substitute.

Cell 127 constructs a 12-entry patch walk with repeated vertices and traverses
both source arcs in both directions. Its fan emits two opposite-oriented
triangle pairs. Assembly removes those four faces, leaving the observed
eight-face star. Cell 128 constructs three patches and 13 triangles, including
a narrow patch between the two independently sampled curve descriptions.
Curve 301 contributes an interior sample that curve 468 does not share.
The graph's successful/nonfallback status does not establish a simple disk.

The three observed cross-pin connectors are actually unprotected and have no
own-edge membership. Their endpoints remain separately source constrained.
For each connector, its two exported endpoint coordinates are exactly equal.
Every triangle retaining that edge therefore has zero cross product regardless
of its third vertex. Moving a fan center, changing diagonals or adding interior
vertices cannot repair it while preserving that edge. Sharing only the pins
also leaves the differently sampled interior arcs. The candidate must resolve
the complete shared physical constraint and retain both parameter charts before
ordinary graph construction; it cannot patch the narrow strip afterward.

## Exact local proof and its limits

An independently replayed exact-rational interval calculation establishes a
common root for the recorded horizontal profile edge and identity-transform
source pair on the fixed z-face/bin. Under its explicit structural premises,
the body-distance lower bound is approximately 2.69022, above the 1.4 blend
radius. The untwisted x coordinate stays positive and the twisted equation's
y derivative lies between approximately −1.989894149 and −1.989893852.
Strict endpoint signs establish existence, while this uniform monotonicity
and the cylinder's negative-x branch establish uniqueness in that bin.

This is a supporting-equation proof for one recorded pin, not a runtime
implementation, whole-arc identity or proof of evaluator equivalence. The
source-description binding remains an explicit premise that production code
must replace with typed structural checks.

Three executable counterexamples pass: separate exposed roots can share one
f32 bin even with equal normals and nonsingular sampled Jacobians; a stored
oblique profile normal need not be exactly perpendicular to its source edge;
and f32 rounding can hide exact working degeneracy. In the actual oblique
profile example the represented dot product is exactly `−7 / 2^54`, not zero.
Treating a rounded normalization or rotation as exact would invalidate a proof.
An additional abstract curve control shows why agreement at finitely many
parameter samples alone does not certify an entire arc; it is not asserted to
be a compiled SFCC carrier.

## First implementation boundary

The isolated candidate adds typed source recognition, bounded real-equation
enclosures, face-root existence/uniqueness checks and shared-arc transport. Its
selected source edge must have an exact axis normal; oblique selected edges and
unsupported branches reject. World transformations use their actual represented
coefficients. A coordinate containment postcondition also applies to returned
traced projections, so this part of the change is broader than the two knob
carriers and requires all-model collateral validation.

The first focused run passed its pin check but rejected the larger region
enclosing both retained parameter intervals. Three of four proof tests passed;
both separate projection-containment tests passed. Premise localization found
that the profile-edge enclosure failed while the inactive-competitor bound and
global transverse contraction passed. That rejected candidate and the initial
diagnostic logging compile error remain recorded.

The next version subdivides the **same** box for source restrictions only,
requiring every child to satisfy the original conditions. Its fixed maximum is
depth six, 64 leaves and 127 visited boxes. The global Jacobian/contraction check
still uses the unsplit box. All four focused tests now pass; each actual cell's
arc restriction needs only three visited boxes. The negative extending past a
real profile endpoint still rejects. No geometric tolerance or output-region
budget was enlarged.

The fourth reviewer permits a bounded full-original-knob diagnostic experiment,
not integration or release. A pin-pass/arc-reject graph control is still required:
face pinning can identify vertices before a neighboring cell's wider arc proof
fails. The existing one-loop fan path does not independently establish a simple
disk. The candidate must show no new working/f32 defects or intersections and
preserve source intervals under that ordering and on the complete models.

The tube bounds successful numerical chart outputs. It does not prove numerical
convergence for every real parameter, existence on every transverse slice or
uniform Hausdorff fidelity. Existing sampled half-chord checks retain that
explicit empirical scope.

## Full native candidate: rejected for integration

The freeze2 full original knob diagnostic completed in 75.924 seconds under the
180-second watchdog. This is a single native observation, not a performance claim
or a WASM acceptance result. The original scene, tolerances and export domain
remain fixed. The two originally witnessed cells now emit zero malformed faces
in both coordinate representations and retain both own-chart memberships.

Whole-model checks nevertheless reject this candidate for integration:

| Measurement | Unchanged native baseline | Freeze2 candidate |
| --- | ---: | ---: |
| Triangles | 245,932 | 244,984 |
| Working-f64 invalid faces | 266 | 262 |
| Exported-f32 invalid faces | 3,953 | 2,425 |
| Working-invalid faces hidden by rounding | 7 | 7 |
| Nonmanifold edges / vertices | 1 / 7 | 1 / 7 |
| Open / misoriented edges | 0 / 0 | 0 / 0 |
| Working intersection pairs | 3,779 | 3,628 |
| Exported intersection pairs | 27,540 | 14,403 |
| Reported off-curve memberships | 160 | 169 |

Two independent exact malformed-face comparisons agree: the candidate removes
1,535 old oriented f32 malformed-face occurrences but **adds seven new ones**.
Working geometry removes four malformed occurrences and adds none; all seven
working-invalid faces concealed by conversion survive exactly. Coordinate keys
preserve cyclic orientation and multiplicity. All seven new f32 identities lie
at previously observed collapsed pin bins; six have exact preassembly joins and
one retains incomplete final-stage lineage. Changed face identity alone does not
prove a newly created physical failure, but shared bin location alone cannot
establish preserved source and incident-patch obligations either. These changes
remain unresolved acceptance gates and cannot be cleared by the net decrease.

The geometry auditor selects every triangle in each complete mesh and tests
nondegenerate faces against the complete retained mesh. Malformed faces are
counted separately and excluded from the intersection predicate. Oriented
coordinate-pair multiset comparison finds **53 new working and 157 new f32
intersection identities**, despite removing 204 and 13,294 respectively. These
are measured geometric pair identities, not yet a causal classification of new
crossings versus changed tessellation of existing bad regions. They remain
blocking observations pending exact construction attribution and repair.

The requested pin-pass/arc-reject control also reaches the actual construction
path and fails its explicit-unresolved assertion. Over one deliberately coarse
3 mm cell of the unchanged complete source, both real contour endpoints are
shared; the wider source certificate and actual arc transport reject sharing.
`mesh_cells_subset` nevertheless emits 40 triangles with zero failed or fallback
cells. These 40 faces have no exact f64/f32 degeneracy. The test stops at the
missing unresolved state, so its later endpoint-preservation assertions did not
execute in that first run. A second diagnostic keeps the failing assertion and
computes all observations before it: all four own-chart endpoint obligations
survive, zero parameter intervals collapse, but the 40-face patch contains
**53 intersecting triangle pairs in each coordinate representation**. Eighteen
vertex links fail the local path/cycle check, which explicitly allows a boundary
path with two endpoints. This is a concrete construction/embedding failure,
not merely a missing status flag. The coarse control still does not establish
production-octree equivalence or attribute the full-model intersection changes.

A bounded replay of all five existing checker sites on each of the nine new
`offCurve` records confirms the same native feature fingerprint and reproduces
all nine flags. Every direct chart query succeeds. Each record has one failed
restricted reverse projection and four passing sites; the largest forward
sample-to-edge distance is about 4.004e-7 mm. These are unresolved numerical
projection checks, not demonstrated over-budget sampled distances. The flags
remain visible; they are not exempted or converted to acceptance passes. The
existing `project_interval` aborts when its interior projected parameter fails,
even when an interval endpoint was successfully evaluated; any future bounded
reference repair must retain valid witness semantics and adverse controls. That
separate checker issue does not justify accepting the geometric regressions.

Freeze2 remains isolated. The next revision must address construction admission
and preserve obligations when wider arc sharing fails, then pass exact malformed,
intersection and membership preservation checks before any release evaluation.
E4 remains open; no candidate runtime has been integrated into the main checkout.

## Selected next construction boundary

The independent fourth review rejects eager shared-pin publication and selects
one bounded **postconstruction complete-patch transaction** as the next
experiment. Baseline construction remains intact until the complete source
component, all own charts and retained outside geometry have been checked.
This is a diagnostic implementation milestone, not a newly accepted production
repair. The [full decision](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-outcome-consensus/decision.md)
records its limits and distinguishes changed geometric identities from proved
new physical defects.

The first read-only measurement of the three original pin pairs finds 29 final
working faces, 25 vertices and 53 edges. Its external frontier has 19 edges
incident to 14 outside faces. Existing selected-cell evidence supplies original
construction ownership for only 16 of those 29 faces; five vertices lack point
keys, nine lack complete point metadata, and seven frontier edges have unknown
protection. Unknown protection is not an unprotected-edge assertion. A bounded
observation-only full export must close this lineage gap and reproduce all five
baseline buffers exactly before private reconstruction begins.

The first discriminator is limited to one component, eight leaf cells,
24 canonical minimal faces, 16 pin classes, 256 own-chart intervals, 512 affected
and separately 512 replacement faces/vertices, 65,536 exact candidate-pair checks,
and a 32 MiB receipt with no truncation. Existing geometric and sampling budgets
remain fixed. Exceeding a cap refuses the proposal and records its frontier;
these are experiment limits, not production defaults or evidence that a
four-cell lower bound is sufficient. A later justified milestone may select
another bound; this run will not silently widen its limits.

### Observational closure gate passed

The unchanged complete native knob capture completed in 75.677 seconds, with
all five baseline working/exported/feature buffers byte-identical, zero dropped
records and no metadata truncation. It observes four actual leaf consumers
`(8,40,131,126..129)`, 21 minimal faces, 32 points, twelve own-chart intervals
and 49 preassembly faces. The expected feature fingerprint and original point
identities match. Every face in the proposed 31-face window, and all 43 faces
in the larger observation area, has an exact preassembly source join.

The initial 29-face star has a nonsimple frontier. Adding original faces 80 and
625 yields a connected manifold disk with a fixed seventeen-edge oriented
boundary. A formal identity quotient alone omits the central modeled crease,
so it is not a repair. The next private prototype reconstructs that crease from
its source-side patches and retains the independent parameterization of both
aliases along the shared interior sample. Its proposed 23-face replacement is
currently a combinatorial construction sketch; source, geometry, interval,
retained-outside intersection and atomic-refusal checks still must pass.

[Full closure/provenance receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-original-pin-star-provenance/pin-star-provenance.json),
[bounded execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-pin-star-job/execution.json),
and [independent boundary/quotient analysis](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-closure-measurement/pin-quotient-topology.json)
retain the exact geometry, source obligations and limits. This closes an
observational prerequisite, not E4's repair or release exit.

### Conditional geometry feasibility check

A separate geometry-only hypothesis substitutes the proposed 23 faces using
the existing primary pin coordinates, without publishing any source or metadata
change. The complete native mesh then has 245,924 triangles and 3,947 invalid
f32 faces (six fewer), with unchanged working invalid count and topology counts.
The complete oriented intersection-pair comparison finds zero new working or
rounded identities and removes 49 old rounded pairs.

This is **not** an accepted replacement. Twenty pre-existing rounded contact
pairs still touch faces in the proposed window, including geometrically
unchanged boundary faces; no working contact touches that window. The frozen
private-replacement contract requires the entire replacement to be embedded,
so those retained contacts remain a refusal/closure gate. Source identity,
parameter transport and metadata application are also separate unfinished
checks. Preserving an old defect identity does not turn it into valid geometry.

[Geometry-only inputs and exact proposed faces](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-conditional-geometry/manifest.json)
and [complete intersection identity comparison](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-conditional-geometry/intersection-comparison.json)
retain this hypothesis separately from the forthcoming source-aware prototype.

### Private source-aware prototype refused correctly

The private prototype compiled and its diagnostic test completed in 8.236
seconds. All three pin identities, both complete central arc regions and the
independent parameter transport pass. The proposed triangle buffer is exactly
the geometry-only hypothesis above. The proposal nevertheless refuses with
43 recorded observations: twenty contact pairs, eighteen malformed retained
neighbors, two sampled orientation failures, one rounded orientation failure,
one unidentified source-support observation and one missing protected interval.
These counts are observations, not forty-three distinct newly introduced defects;
unchanged baseline omissions and incomplete diagnostic source matching must be
classified separately. The test's pass means safe refusal, not mesh acceptance.

The wider-arc control also refuses before publication. Cancellation/exhaustion
labels in this first diagnostic are injected returns after one private pin
certificate; they establish input immutability on those exits, **not** execution
of a production cancellation or work-budget mechanism. All five original
buffers and the source receipt remain byte-identical after every attempt.

Independent analysis gives a stronger geometric obstruction: distinct fixed
frontier vertices 34004 and 34005 have identical emitted coordinates, and the
boundary subchain through 74118 traverses the same emitted segment out and back.
An embedded float32 disk cannot preserve that fixed indexed boundary, regardless
of its interior triangulation. Another frontier vertex, 33986, coincides with
fixed exterior vertex 33987. Fourteen retained contacts involve the first pair
and six the second. All twenty rounded face-pair geometries occur unchanged in
the original audit. Their source keys and chart incidences are recorded; equal
coordinates alone still do not prove that either pair may be identified.

Changing those boundary identities would require at least fifteen additional
original incident faces, with further closure still unmeasured. The frozen
experiment was not enlarged. Its negative result establishes the required next
construction boundary; it is not a completed geometry repair.

A separate unchanged full-model metadata capture completed in 86.320 seconds
and preserved all five buffers. Actual patch-owner records are absent globally,
so all old/proposed ownership remains unknown. None of the 141 existing
`constrained_fan_unresolved` coverage witnesses refers to this patch; all must
remain intact. No new ownership or coverage certificate is assigned.

[Private execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-private-proposal-job/execution.json),
[complete proposal/refusal receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-private-proposal/receipt.json),
[fixed-boundary impossibility and source evidence](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-boundary-refusal/conditional-contact-refusal.md),
and [actual ownership/coverage capture](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-owner-coverage-provenance/owner-coverage-provenance.json)
retain the results and their limits. No E4 runtime change has been integrated.

## Source-complete closure experiment

The [independent round-two consensus](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round2-consensus/decision.md)
accepts the experiment as a correct refusal and rejects its geometry. The next
three-agent comparison measures the complete typed 301/468 component through
its genuine shared endpoints, rather than repeatedly changing the failed
interior triangulation. The unchanged inventory already contains 37 leaves
tagged to either curve and 444 preassembly triangles; these tags are only a
lower bound on actual consumers.

The new measurement alone is bounded by 64 leaf consumers, 384 minimal-face
records, 128 candidate pin classes, 512 original chart intervals, 2,048 affected
preassembly/final faces each, 2,048 vertices and a 32 MiB receipt with no dropped
required records. It must reproduce all five baseline buffers and capture
actual pin/corner/interval incidence, full stars, source and metadata, including
emission gaps and fallback/boundary-apex paths. The earlier experiment and its
limits remain frozen; no geometric tolerance, solver budget or depth is raised.

Before another replacement is constructed, its full fixed frontier must be
potentially representable in both coordinate formats and its retained outside
obligations must be known. Equal coordinates can expose an obstruction but never
authorize source identification. A bounded refusal remains a measurement result,
not a repaired mesh. E4, E5 and E6 remain open.

### Complete-source capture: unchanged execution, incomplete lineage

After independent review corrected four observer defects, all four focused
capture controls passed. The unchanged full native run completed in 77.364
seconds and reproduced all five baseline buffers exactly, with zero dropped
records and no exceeded capture limits. Its 17.5 MB receipt nevertheless reports
`CAPTURE_GAP`, correctly refusing source-closure completeness.

It observes 39 source-consuming cells, 196 minimal faces, 461 preassembly faces,
421 selected final faces, 339 metadata vertices and 94 relevant interval records.
Twenty-three final face occurrences lack exact initial-cell provenance. Their
later producer and complete descendant ancestry remain unproved; point-ID size
alone cannot establish an allocation stage. The selected region is connected
but is not a disk: it has 113 boundary edges and two degree-four boundary
vertices. This describes the measured subset, not a proved complete ancestry
closure or the topology of the intended surface.

Three separate failures must remain distinct:

- All 88 target interval identities and endpoint payloads survive assembly
  unchanged, but 23 of their physical edges disappear: twelve on curve 301 and
  eleven on 468. All 88 were actual preassembly edges; only 65 are final edges.
  Persistent metadata is not geometric constraint preservation. These 23 edges
  are different objects from the 23 unmatched final faces above.
- Both compiled corner points exist, yet have zero preassembly/final face
  incidence and no target endpoint intervals. Four endpoint gaps already exist
  before assembly. Three endpoint arcs were sampled/staged without installation;
  the fourth remains a raw planned path after an earlier graph abort. A staged
  target request does not identify which later chart caused the whole graph to
  refuse. Compiled corner IDs do not prove geometric corners.
- The larger frontier still has an exact f32-zero edge, 34402–34403, whose
  endpoints carry other charts 299/466. Boundary point 34033 also coincides in
  f32 with retained exterior point 34032, on charts 472/305. Interior repair
  cannot preserve this frontier and produce an embedded replacement.

Independent checks confirm the actual face-consumer scan, all source-point stars
and recorded metadata scope. They do not fill missing later-operation ancestry.
The endpoint records also expose whole-scene Field32 paired with one of its own
primitive surfaces; a bounded source-regularity discriminator is being tested
before treating those pairings as independent curves or geometric corners.

[Capture receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/source-component-a-original/source-component-provenance.json),
[execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round3-source-capture-job/execution.json),
[focused controls](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round3-source-capture-job/focused-controls-execution.json),
and [independent outcome decision](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round3-component-review/decision.md)
retain the facts and the next discriminator. No E4 production repair is integrated.

### Endpoint equations: local independence assumption disproved

The bounded source proof now passes at both compiled endpoints, 223 and 220.
Within each fixed world box of half-width 0.0001 mm, it proves the raw source
relations `Field30 = A` and `Field32 = max(A, B)`, where A is the selected twisted
extrusion branch and B the finite cylinder branch. Strict bounds establish that
the other blend, subtraction and cap branches are inactive throughout each box.
A Krawczyk inclusion establishes an interior A=B crease root, and the smooth
map `(A, B)` has rank two throughout the checked neighborhood.

However, `A = Field32 = 0` also contains an explicit open two-dimensional patch
where A=0 and B<0. These equations therefore do not supply an independent
one-dimensional carrier intersection or certify an isolated corner. This is a
counterexample to the construction assumption, not merely a failed Newton solve.
The conclusion concerns real equations with the actual represented source
coefficients, not bitwise equality of native and GPU field evaluations.

The initial test failed because its world-axis interval box lost correlation
between the coordinates of the rotated witness. Its positive cylinder upper
bound made one witness inconclusive. The amended test preserves that failure,
the exact witness, both boxes and all tolerances; guarded exact source alignment
permits the identity `x² + z² = u² + 64` on the same parameterized patch. Both
patches then have a strict cylinder interior margin of at least 0.0000146954 mm.
Actual helper controls reject mismatched centers, nonidentity represented
transforms and tilted axes. No rounded matrix is assumed exactly orthogonal.

The amended test passed in 9.401 seconds, after a 50.331-second build. This
authorizes investigation of source-aware carrier-pair eligibility, not deletion
of entire curves, global chart identification, or a mesh acceptance claim.
Actual endpoint graph-abort lineage and preservation of legitimate external cuts
and inherited seams remain necessary before integrating a construction change.

[Original inconclusive proof](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round3-endpoint-proof-job/result.json),
[passing bounded proof](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round3-endpoint-invariant-job/result.json),
and [execution receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round3-endpoint-invariant-job/test-execution.json)
retain both results and their source/binary provenance.

The next independent comparison rejects a blanket ancestor-pair filter. For
Stairs with radius 1 and two steps, local operand equations a=x and b=y produce
`F=min(x,y-1/2)` near `(0,1/2)`. Although `a=F=0` contains a surface patch, its
boundary is a real right-angle attachment that `a=b=0` misses. Four operator
controls, plus seven existing included tests, pass. Generated chamfer carriers
also have legitimate intersections with their descendants. A restricted
Round/Soft enumeration candidate therefore preserves those routes, source
registry slots and external occurrences; every unverified omission explicitly
keeps aggregate validation incomplete. This is an isolated experiment, not an
integrated repair.

[Competing source-selection handoffs](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-source-review/B/handoff.md),
[independent counterexample analysis](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-source-review/C/handoff.md),
and [executed operator controls](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-source-eligibility-controls/execution.json)
record the narrowed experiment and its limits.

The candidate's seven structural controls passed. Its feature-only original-knob
run produced 81 curves and 77 corners after 46 syntactic pair omissions, with
29 unresolved trims still reported. The 74-stratum count is unchanged; exact
descriptor assertions cover only strata 10, 15, 30 and 32, despite the receipt's
broad `sourceRegistryDescriptorsMatchRetainedPacket` label. The retained old
packet covers only twelve curves, so longer local continuations do not establish
preservation of the complete original 924-curve graph. A pair number after
canonicalization can also denote an external source alias; it cannot identify a
pre-canonical omitted occurrence by itself.

The separate unchanged full-model endpoint observer completed in 100.494 seconds,
preserved all five buffers exactly, and captured both endpoints without dropped
or capped metadata. Both actual graph refusals are
`edge_already_present_without_admissible_overlap`: curve 469 tries to use edge
74135–74134 in cell `[8,40,132,126]`, and curve 467 tries edge 74340–74339 in
`[8,43,123,152]`. Each edge already has supports 10/15; each new curve has the
alternative Field30/cylinder source description. These are shared-edge admission
failures, not direct projection failures of curves 690/693. Removing redundant
ancestor traces therefore does not by itself establish the necessary alias
handling or an embedded graph.

[Candidate focused and feature-only execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-structural-candidate-job/features-execution.json),
[complete candidate feature receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-structural-candidate-job/features.json),
[unchanged endpoint execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-endpoint-graph-job/execution.json),
and [actual graph-refusal provenance](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-endpoint-graph-aborts/endpoint-graph-provenance.json)
keep enumeration changes separate from demonstrated construction failures.

### Full structural-candidate construction: substantial change, still rejected

The fourth reviewer selected one frozen full native export as a negative
construction discriminator before investing in a complete feature-preservation
ledger. It reused the already executed diagnostic helper, original source,
settings and cube. The build passed in 35.776 seconds and the export completed
in 57.774 seconds with all five buffers and zero dropped trace records. These
single observations are not a performance comparison.

| Native geometry measure | Original | Structural candidate |
| --- | ---: | ---: |
| Triangles | 245,932 | 228,162 |
| Exact working-f64 degenerate faces | 266 | 0 |
| Exact emitted-f32 degenerate faces | 3,953 | 1,876 |
| Working contact/intersection pairs | 3,779 | 622 |
| Rounded contact/intersection pairs | 27,540 | 16,890 |

The candidate has one indexed component with Euler characteristic 2 and zero
open, misoriented or nonmanifold edges or nonmanifold vertices. This establishes
indexed manifold checks, not an embedded surface or correct topology relative
to the source. Exact first-reference compaction and coordinate rounding were
verified against the actual emitted buffers, so the working/rounded audit is
applicable to that output. Malformed faces remain separately counted when
excluded from intersection predicates.

All 1,876 remaining invalid faces are valid in f64 before conversion: 1,872
collapse to two distinct f32 positions, and four become collinear with three
distinct positions. Oriented geometric multisets retain 1,613 old invalid faces,
remove 2,340 and introduce 263 new invalid identities. Contact comparison finds
381 new working and 2,443 new rounded pair identities despite lower totals.
Retessellation can change identities of existing physical defects; these are
unresolved change witnesses, not automatically new physical failures. Neither
their old-location proximity nor the favorable totals discharge preservation.

The source gate alone therefore remains an incomplete, unintegrated candidate.
Its downstream failures do not disprove the local source-independence result,
but they do disprove treating that filter as the finished construction repair.
The next comparison localizes the residual conversion/alias families and the
changed contact witnesses. The complete source-occurrence, alias and trim ledger
remains necessary before any favorable preservation or integration decision.

[Independent execution decision](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-outcome-review/decision.md),
[full export receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-structural-full-knob-job/execution.json),
[exact malformed-face and output-compaction comparison](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-structural-geometry-audit/malformed-comparison.json),
[whole-mesh geometry audit](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-structural-geometry-audit/audit.json),
and [contact-identity comparison](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-structural-geometry-audit/intersection-identity-comparison.json)
retain the complete failed construction result.

An independent exact witness now strengthens the rejection beyond changed
identity counts. Candidate faces 19879 and 20415 share no vertex and intersect
strictly inside both triangles, with independent plane normals, in both working
and rounded coordinates. The working intersection midpoint is approximately
`(-8.6694060, -3.9828992, -4.6242210)` mm. In the fixed cube of radius 1/1024 mm
around that point, every one of the 3,779 baseline working-contact overlap boxes
and all 3,960 baseline faces invalid in either representation are excluded.
Independent exact checks of all 28 baseline face AABBs meeting the cube test
378 pairs without a strict interior crossing; four coplanar pairs are legal
shared-edge neighbors. The rounded candidate witness also lies inside this cube.
Root replayed both checks successfully. This proves a new local working-mesh
obstruction; it does not establish source-surface correspondence or claim absence
of every class of baseline rounded contact.

The [fixed crossing certificate and replay](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round4-crossing-witness-replay/execution.json)
therefore block integration even though degeneracy and topology totals improve.
The next causal question is which initial construction or later pass produced
these two faces. Their point numbers and spatially overlapping cell labels alone
cannot establish producer ancestry. The protected edge on face 20415 belongs to
a generated chamfer/cutter source pair, so repairing the original native/plain
Field alias family alone cannot be assumed to repair this separate crossing.

### Crossing localized to legacy surface refinement

The reviewed observer captured twelve fixed phase boundaries on the unchanged
structural candidate. Its four helper controls passed; the export completed in
64.736 seconds with all five buffer hashes exactly equal to the frozen candidate.
The 333,012-byte receipt contains every selected working-or-rounded AABB match,
with no cap, omission, missing phase or validation-counter mismatch.

Exact offline intersection geometry was clipped to the original rational cube.
The initial parser refused the receipt's redundant explicit bounds; a reviewed
schema-only amendment verifies those bounds against the unchanged center/radius.
Its 26 controls passed, and replay of the original capture then succeeded. No
native rebuild, export, cube movement or geometry-predicate change was involved.

| Observed phase | Local faces | Working strict crossings | Rounded strict crossings |
| --- | ---: | ---: | ---: |
| Cell output through coplanar/sliver flips | 4 | 0 | 0 |
| After legacy surface refinement | 6 | 1 | 1 |
| After guarded refinement, normal repair and final emission | 6 | 1 | 1 |

There are no malformed selected faces or earlier illegal boundary/coplanar
contacts obscuring the result in either representation. The first local crossing
is introduced during legacy refinement. The later guarded refinement receives
that already intersecting geometry; the sampled normal repair is not the first
producer. The exact internal edge split or iteration has not been identified.

This isolates the next implementation question: prevent unguarded projected
subdivisions from creating an invalid embedded patch before tighter refinement
starts. A repair must transact the complete incident edge star and its metadata;
independently rejecting one child triangle would risk nonconforming neighbors.
Distance-residual improvement alone does not supply that embedding guarantee.

[Observer source review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round5-phase-review/decision.md),
[actual phase capture](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round5-crossing-stages-a/phase-capture.json),
[independent five-buffer verification](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round5-crossing-stages-job/independent-identity.json),
[preserved initial parser refusal](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round5-crossing-stages-job/phase-classification.json),
and [successful exact phase classification](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round5-crossing-stages-job/phase-classification-amended.json)
retain both the causal phase evidence and its limits. No geometry repair has yet
been integrated from this experiment.

### Guarded-prefix candidate: controls pass, full execution times out

The next isolated runtime candidate removes the unchecked legacy routine. It
uses the existing guarded edge-star refiner first at feature tolerance, then at
the minimum surface/feature tolerance when needed. Both stages share the cap
computed from the original input; the eight-plus-eight sweep ceilings, no-blend
bypass and guard/projection bodies remain unchanged. Final sampled failures are
counted at the minimum tolerance, including cancellation and budget exhaustion.

All twelve refinement tests passed, including eight new actual lifecycle and
metadata controls. Five focused surface-budget tests also passed. A fresh
feature-only probe reproduced the entire frozen structural feature receipt
byte-for-byte. This verifies that receipt, not a separately measured complete
mesh/PointTable state at refinement entry. The latter remains an unchanged-code
premise for this routing-only change.

The full-knob falsifier nevertheless timed out at 180.016 seconds before saving
any mesh buffers. Its geometry, fidelity and intersection outcome are unknown.
An existing full-housing export embedded in the surface-budget test group also
hit that group's 60-second watchdog; it remains incomplete. Separating the five
short controls did not convert the full-housing timeout into a pass. No timeout,
solver tolerance or geometry budget was raised, and this candidate is not
accepted or integrated.

Before execution, independent review also corrected an unjustified positive
gate: the tiny cube around the bad crossing is not a proved source-surface
region. With true SDF `f=z`, an erroneous crossing centered at z=0.005 mm can lie
inside that cube while a perfect repair on z=0 misses it and improves fidelity
within the 0.01 mm budget. The fixed cube remains a negative contact witness.
No-loss obligations instead concern the complete affected patch, its boundary,
corners, physical feature paths and own-chart interval unions. Historical owner
labels alone are not new domain certificates.

At this freeze, an actual-route test against previously accepted children in the
same sweep was still unexecuted; helper-level tests were not relabeled as that
test. The later isolated index validation below executes that control. The
complete source-preservation ledger, E2/E3 collateral checks and remaining
conversion/alias families stay open.

[Frozen runtime patch and handoff](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round6-guarded-prefix-job/handoff.md),
[focused refinement execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round6-guarded-prefix-job/focused-execution.json),
[separated surface-budget controls](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round6-guarded-prefix-job/surface-budget-focused-execution.json),
[feature receipt identity](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round6-guarded-prefix-job/feature-identity.json),
[full-housing test timeout](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round6-guarded-prefix-job/surface-budget-execution.json),
and [full-knob timeout](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round6-guarded-prefix-job/execution.json)
retain the results without inferred output counts.

The next cost investigation distinguishes field/projection work from collision
index construction and queries. One source-level mechanism is already clear:
`GrowingIndex` rebuilds its entire accepted-triangle BVH after each 256 appends.
For N triangles arriving in full batches of B=256, rebuilding prefixes submits
exactly `N(N/B+1)/2` triangle records, before sorting costs. The recursively
sorting BVH builder has an `O(n log² n)` worst-case build bound. Bounding the
unindexed tail therefore does not eliminate quadratic cumulative rebuild work.
This is a structural cost defect, not yet proof that it caused the timeout.
The proposed alternatives must preserve every working/rounded collision check;
profiling and equivalent indexing are being compared without weakening guards.

The isolated indexing candidate keeps the append-only triangle records and
existing flush boundary, but replaces repeated full-prefix rebuilds with a
binary-carry forest of immutable BVHs. Local leaf offsets are mapped back to
global records; topological vertex IDs and working/rounded predicates remain
unchanged. Each item participates in logarithmically many carry builds, giving
`O(N log F)` construction-input records for F flushes. This is not a logarithmic
query-time theorem: overlapping bounds can still require linear traversal.

Four frozen index controls passed against the old implementation/exhaustive
queries, including carry/tail boundaries, irregular batches, duplicate identities,
rounded-only contacts and malformed-input compatibility. The actual same-sweep
control also passed: two initially disjoint sphere-constrained edge stars propose
bit-identical new points with different IDs; the first complete star commits,
and the second is rejected against its newly accepted children. A real
cancellation hook then stops the next sweep. This exercises the short unindexed
tail; indexed-run equivalence is tested separately. All thirteen refinement tests
pass with the isolated forest. No full optimized model has yet completed, and
the index remains unintegrated.

[Index source review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round7-forest-controls/decision.md),
[four equivalence/work controls](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round7-forest-controls/forest-execution.json),
[actual same-sweep execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round7-forest-controls/actual-sweep-execution.json),
and [refinement controls with the forest](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round7-forest-controls/refinement-execution.json)
establish these bounded results, without claiming a measured speedup or resolved
full-model timeout.

### Original-index cost observation

The reviewed observation-only profiler passed three lifecycle/accounting controls
and repeated the unchanged original-knob guarded-prefix export under the same
180-second watchdog. It timed out at 180.025 seconds without mesh buffers. The
last complete row, at 179.158 seconds in the tighter pass's fifth sweep, records
103.426 seconds in embedding checks, 22.981 seconds in growing-index rebuilding,
27.834 seconds in all index builds, 4.353 seconds in index queries, 5.399 seconds
in queue/field/order work and 0.444 seconds in split projection. These are
**inclusive buckets**: growing rebuilds contain index builds, and embedding
contains index queries. They must not be summed as disjoint phase durations.

The stream retained 2,272 complete rows without hitting its row/byte cap. It
records 61,828,794 exact fallbacks and 560,514,267 exact-zero shortcuts, with zero
limb heap allocations and maximum five limbs. Existing counters do not divide
those predicates between retained triangles and the appended-index tail, or
between 2D and 3D predicates. Rebuilding is material, but the claim that it alone
dominates the timeout is contradicted by this run. Per-call reuse of repeated
coplanar orientation signs is a further candidate, not yet an executed repair.

The owned child consumed 145.875 user CPU seconds and 2.146 system CPU seconds;
host load rose from 31.57 to 45.12. This is a bounded cost observation under
contention, not a controlled speed comparison. No complete same-routing mesh
exists to compare with a prospective forest output. The missing output provides
no geometry result and does not close the source or conversion failures.

[Profiler review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round7-guard-cost-profile-job/consensus.md),
[frozen source/input manifest](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round7-guard-cost-profile-job/manifest.json),
[execution and resource receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round7-guard-cost-profile-job/execution.json),
and [retained partial stream](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round7-guard-cost-profile-job/export.log)
preserve the result.

### Exact coplanar-work reuse candidate

Three independent handoffs compared two bounded optimizations. Direct reuse
passes the four signs already computed for each edge pair into the corresponding
contact checks, reducing a complete traversal from 90 to 54 orientation calls.
The selected alternative retains two local directed 3-by-3 sign tables and
computes each entry only when requested, bounding the traversal at 18 calls.
Both retain the original four-call first-crossing exit. The tables are discarded
between calls; working and rounded geometry never share cached state.

The independent algebra review passed 756 permutation/identity/projection
controls. Frozen old coplanar and complete intersection functions provide the
Rust differential oracle: the existing live reference function alone would be
circular because it calls the changed helper. The selected candidate's five new
controls include 21 actual saved knob contact pairs, both coordinate formats,
short-circuit/work counts and extreme finite scales. All twelve collision/index
and thirteen refinement tests also pass, including the real same-sweep control.
The competing smaller candidate passes its four new and eleven collision/index
controls, but leaves more duplicate work; it remains an unselected alternative.

The first selected-candidate release-LTO test build timed out at 120 seconds
without a compiler error. Its orphan compiler was identified and stopped after
a brief recorded overlap with the next owned build. A separately labelled
48.593-second test build with LTO disabled and 16 codegen units produced the
passing test binary. Those results are not default-release timing evidence.
Subsequent watchdogs create and terminate only the owned process group. The
normal release example was built separately in 88.885 seconds, with SHA-256
`538897f570393db636e4883dcbce1f362067163b2662c6eaa4a893f65f6cb531`.
The combined full-model experiment also timed out at 180.015 seconds, without
mesh buffers. Its child consumed 119.352 user CPU seconds and 1.475 system CPU
seconds while host load fell from 57.48 to 36.54. This is still no geometry result
or controlled speed comparison. The 180-second failure remains recorded; a
separately bounded diagnostic execution is being considered to unblock the
construction investigation without relabeling that resource failure.

The review also falsifies an overly broad claim about the inherited contact
predicate: exact orientation signs do not make floating normal-based projection
safe at every finite scale. Explicit disjoint triangles at scales `1e-200` and
`1e200` produce underflow/overflow in the normal and a degenerate projection,
yielding legacy false positives. Both optimizations preserve that existing
behavior; neither silently repairs axis selection while claiming unchanged
admissions. These are independent counterexamples, not demonstrated causes of
the original knob failures.

[Fourth-reviewer selection](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round8-sign-review/decision.md),
[independent algebra and limitations](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round8-sign-review/C/handoff.md),
[selected candidate](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round8-sign-review/A/handoff.md),
[test-profile recovery](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round8-sign-controls/A-no-lto/execution.json),
and [normal release experiment](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round8-combined-full-knob-job/execution.json)
retain the separate evidence boundaries.

### Completed longer diagnostic and remaining failures

After three independent recommendations and fourth review, one separately named
360-second diagnostic used the exact already-built combined executable, original
scene, settings and cube. It completed in **288.351 seconds** with zero dropped
construction records. The earlier 180.015-second timeout remains a failed resource
gate; this longer run is not a replacement acceptance row or a speed comparison.
No automatic further timeout extension is planned.

| Native result | Unsafe structural candidate | Guarded/forest/reuse diagnostic |
| --- | ---: | ---: |
| Triangles | 228,162 | 334,740 |
| Exactly invalid working f64 faces | 0 | 0 |
| Exactly invalid emitted f32 faces | 1,876 | 1,876 |
| Two-position / three-position-collinear f32 failures | 1,872 / 4 | 1,872 / 4 |
| Indexed edges whose distinct working endpoints round together | 936 | 936 |
| Emitted feature records / physically present indexed edges | 6,036 / 6,036 | 8,788 / 8,788 |
| Native chord-budget failures | 10,908 | 73,920 |

The new triangle count exactly exhausts the shared cap of twice the 167,370-face
pre-refinement input. The native chord count is an internal sampled diagnostic,
not an independent Euclidean error bound; increasing triangle count also changes
the number of tested faces. It provides no basis for claiming improved fidelity.
Native indexed incidence and vertex-link checks pass, with one component and
Euler characteristic two; none establishes embedded geometry or source coverage.

Exact full-buffer compaction and f64-to-f32 position conversion are verified.
Compared with the unsafe structural mesh, 1,857 malformed oriented f32 triangle
identities remain, nineteen disappear and nineteen appear. Equal totals are not
identity preservation or proof of new physical failure regions. All final feature
records describe actual nonzero indexed edges with incidence two and nonzero
parameter spans. This does **not** discharge the native validator's 618 missing
original feature-edge obligations: an emitted-record inventory cannot account for
obligations that were lost before emission. No runtime compiled-feature fingerprint
is present in these buffers, so cross-run numeric chart IDs are not independently
joined merely because the configurations match.

The original exact-cube adapter refuses: 2,961 working-or-rounded AABB candidates
and 2,958 points exceed its fixed 256/512 payload caps. The whole-mesh contact audit
also times out at its 60-second limit. Both unresolved outcomes are retained; no
clean global embedding is claimed. A separate reviewed selector amendment
excludes only triangles proved empty in the exact same cube in both coordinate
formats, before applying the unchanged caps. Its full-model replay completes in
2.780 seconds: 2,949 occurrences are proved empty, leaving twelve faces and
thirteen points. All 66 pairs in each representation classify as sixteen legal
shared-index contacts and fifty no-contact pairs, with no malformed selected face
or prohibited contact. All twelve triangles have area intersections with the
cube. This closes the **specific previously demonstrated crossing witness**;
it neither supplies source fidelity nor resolves the global audit timeout.
The original broad-selection refusal remains preserved separately.

Three next-family handoffs identify a specific construction direction. In the
previously audited structural mesh, 724 collapsed indexed pairs (1,448 faces)
associate horizontal twisted-side constraints 7/10 with field constraint 30,
sharing cylinder 15. That is a source association, not an equivalence theorem.
A current three-pin complete incident-star counterexample still has a noninjective
f32 boundary, ruling out an interior-only repair with that frontier fixed. The
proposed next milestone must certify a common source branch over the actual
construction footprint, transport both ordered charts and construct their shared
physical path before graph insertion. It must retain any genuinely divergent
parts and every affected shared-face consumer. Equal coordinates alone remain
insufficient authority to merge vertices.

[Diagnostic review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-diagnostic-review/decision.md),
[execution/buffer hashes](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-combined-diagnostic-job/execution.json),
[exact malformed comparison](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-combined-geometry-audit/malformed-comparison.json),
[physical-feature accounting](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-combined-geometry-audit/physical-features.json),
[audit limits and completed checks](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-combined-geometry-audit/execution.json),
[exact fixed-cube result](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-combined-geometry-audit/local-cube-exact-clipped.json),
and [construction counterexample](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-construction-review/B/handoff.md),
[fourth construction decision](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-construction-review/decision.md)
and [coordinator scope clarification](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round9-construction-review/coordinator-scope.md)
record the result. The next private one-arc prototype distinguishes interior branch
identity from endpoint/third-constraint incidence, and either stages complete
shared-face construction or refuses without mutation. No E4 runtime repair is
ready for integration.

### Three executable shared-arc prototypes: focused results

The next competition produced actual isolated Rust prototypes, with all ordinary
production meshing hooks left unchanged. Their focused controls rebuild the
complete original knob feature graph and reproduce fingerprint
`9875508341830920921`; the small empty-consumer fixtures are negative API controls,
not replacement acceptance models.

| Candidate | Implemented scope | Executed result |
| --- | --- | --- |
| A | Fixed-sign helical-branch planner and private point/face staging plus cell reconstruction entry | Three focused controls pass after documented compile/fixture corrections; the actual full-arc plan refuses chart 20's first interval `[0,1]`, so private cell reconstruction is not reached. |
| B | Whole-footprint carrier proof and immutable discovery of actual pregraph consumers | Two focused controls pass; the whole source restriction remains unproved and missing consumer context refuses. No triangles proposed. |
| C | Independent source/chart inspection and nonpublishing refusal entry | Three focused controls pass; local source restrictions pass, while the whole envelope, transport guard and missing continuation/junction evidence retain explicit refusals. |

A's author stopped at an agent usage limit before a completed handoff. The
coordinator preserved its as-found source, corrected one borrowed integer
argument, and then diagnosed a failed fixture assertion with independent review.
The fixture used lattice face `gz=127` for the unchanged saved pair 34177/34176,
although exact-bit joins place both points in the final cells on either side of
`gz=128`. The recorded lattice establishes the correct face coordinate
`-0.007238803216301548`; no fitted coordinate or tolerance adjustment was used.
After this fixture-only correction, the actual pin certificate passes. Both
original failures remain preserved. None of these results establishes successful
shared-arc reconstruction, endpoint validity or publication readiness.

The conservative whole-box refusal does not prove the actual arcs diverge.
Conversely, successful pointwise checks cannot authorize the complete component.
The fourth review selects a small discriminator for A's first failed interval,
separating source-branch geometry, conservative numerical-projection bounds and
checked transport of consumed events. It does not add a requirement to prove
Newton convergence for every real parameter or solve universal feature discovery.
All current tolerances, source obligations, endpoint constraints and refusal
behavior remain unchanged.

[Fourth review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round10-shared-arc-controls/decision.md),
[A's corrected execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round10-shared-arc-controls/A-fixture-fix-run/execution.json),
[authoritative face-coordinate derivation](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round10-shared-arc-controls/A-face-coordinate-provenance.json),
[B's proof/refusal receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round10-shared-arc-controls/B/proof-receipt.json),
and [C's independent inspection](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round10-shared-arc-controls/C/proof-receipt.json)
retain the results. Tests use the separately labelled non-LTO/codegen16 diagnostic
profile; no new release-WASM or full-mesh result is inferred.

### First-interval discriminator: loss of correlation

The observation-only discriminator passes and reproduces A's unchanged refusal.
For chart 20's first interval `[0,1]`, the existing restriction traversal stops
after twenty boxes at depth six. The terminal box passes the competitor test
(lower bound 1.86609 mm against radius 1.4 mm), but fails the profile restriction.
It encloses untwisted coordinates `u=[7.07248,7.68065]`,
`v=[7.86150,8.54984]`, which include points unrelated to the selected source curve.

The checked helical branch instead has
`u=[7.255342858886819,7.255342858886825]`, `v=8`, with fixed positive sign.
Its intrinsic profile restriction and the reported transverse inverse check pass.
Under explicitly checked same-axis, identity-frame, positive-lathe/radius guards,
rotational symmetry lets the existing lathe bound evaluate the fixed cylinder
radius over the entire recorded tube-height interval. That branch-only lower
bound is 1.7299592761499476 mm, more than 0.329959 mm beyond the blend radius.
It is **not** a bound for every point in the numerical projection box.

This identifies loss of profile correlation in the current proof strategy;
it does not demonstrate source-curve divergence. Ten existing native chart queries
also produce consistent local values, but those observations are not a continuous
proof or independent SDF reference. The source subdivision budget remains
127 boxes per invocation, and no certificate or meshing admission was changed.

The reviewed next implementation separates a correlated source-branch certificate
from consumed-event validation. Each used numerical point must still pass its
original containment and typed source/domain checks, a conservative distance bound
to that same helix at its height, and strict own-chart transport under the existing
numerical allowance. Unsupported pieces, endpoints or transport retain named
refusals; arbitrary off-curve bounding-box points gain no authority.

[Executed discriminator](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round11-first-piece/execution/proof-receipt.json),
[build/test receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round11-first-piece/execution/execution.json),
[frozen source review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round11-first-piece/decision.md),
and [outcome review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round11-first-piece/outcome.md)
record the scope and limitations. No full export or production integration follows
from this discriminator.

### Correlated source/event checks and the inverse-parameter failure

The three isolated candidates pass their focused native controls. Fourth review
selects C's separate supporting-branch and consumed-event layer, with B's narrow
same-immutable-root cylinder check and exact rederivation of the fixed-sign
intrinsic coordinate. The combined source passes its fresh focused controls.
All 62 original chart pieces certify; all 64 original knot/endpoint events pass
their actual query, container, source/domain and branch-distance checks. This is
supporting-branch and listed-event evidence, not full-scene exposure or a
reconstructed mesh. The old whole-box proof and private construction remain
unchanged, and these new certificate types cannot authorize that construction.

Complete two-chart transport still refuses. The first failed correspondence
requests chart 20's point at parameter `1` on chart 33. The existing inverse
returns parameter approximately `0.37416436048850976`, producing a separation of
`1.2537468633902062e-5` mm against the unchanged `3.796655370190979e-7` mm allowance.
An independent exact-dyadic replay of the saved binary64 point bits confirms a
strictly positive squared excess: the squared-distance ratio is about 1090.48.
Both own-chart outputs pass their source and consumed-event gates. The existing
inverse estimates the parameter from a sampled endpoint chord and queries that
parameter once; it does not refine the inverse to the requested spatial accuracy.
This observed failure therefore identifies inaccurate parameter transport, rather
than demonstrating different supporting branches.

The reviewed next milestone compares three bounded inverse helpers scoped to
these immutable certified charts. Each may use height to guide its local search,
but final acceptance needs a conservative full 3D distance check, unchanged
allowance, every consumed-event gate, strict ordering in both directions and
retained exact endpoint parameters. Limits are 64 new checked queries per mapping,
16,384 total helper evaluations including cache fill/rechecks, and 64 iterations
per request, retaining the existing 128-piece/2048-event/64 MiB ceilings. Query
failure, exhausted budget, cancellation, ambiguity and stagnation refuse. No
sampled monotonicity, ideal-helix point substitution or tolerance increase can
stand in for the actual chart output. The general inverse and production mesher
remain unchanged. Private construction awaits the fourth review of executed
transport results.

[Fourth source/event review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round12-correlated-controls/decision.md),
[selected build/test execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round12-correlated-controls/selected/execution.json),
[complete inventory and failed correspondence](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round12-correlated-controls/selected/proof-receipt.json),
[exact distance replay](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round12-correlated-controls/selected/exact-transport-replay.json),
and [bounded transport contract](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round12-correlated-controls/transport-milestone.md)
retain the evidence. These are diagnostic-profile feature tests; no production
runtime, release-WASM or full-mesh acceptance result changes.

### Bounded inverse transport: all three alternatives pass

Three independent helpers now pass complete transport of the original 62-piece,
64-event inventory. All use actual checked chart queries and the unchanged
`3.796655370190979e-7` mm allowance. Exact-dyadic replay validates every retained
point-pair comparison and outward distance bound. Both directions preserve strict
parameter order and exact endpoint parameter bits. The old chord-inverse witness
still fails and remains a regression control.

| Candidate | Search | Complete original events | Checked helper work | Maximum new queries per mapping |
| --- | --- | ---: | ---: | ---: |
| A, selected | Height-guided bisection | 64/64 | 1,162 | 20 |
| B | Safeguarded interpolation/midpoint | 64/64 | 1,037 including 128 fresh output rechecks | 18 |
| C | Local 3D-distance search | 64/64 | 1,628 plus 14 reserved endpoint queries | 28 |

These work counts have different admission/recheck scopes and are not timing
rankings. Each full inventory has 192 final triplet comparisons; the archived
replay counts also include candidate-specific mapping and repaired-witness pairs.
All builds and focused tests pass within their declared diagnostic 120/60-second
caps. A executes actual exhaustion of the fixed 64-query request and 16,384-query
total limits. B/C exercise real lower-limit exhaustion and label that narrower
scope. Actual failed queries, cancellation, wrong-source/off-branch points,
non-strict ordering, ambiguous guidance and stagnation retain refusals.

Fourth review selects A as the smallest sufficient helper. Its executed test
pairs it with the selected full source/endpoint inspector; the helper alone does
not establish connected-height coverage or all retained-corner/outgoing-source
conditions. Before private reconstruction, an explicit successful admission stage
must reuse those checks on the same immutable source and charge their query work.
The old inspector's eventual transport refusal is not an admission token. The
adapter must enforce both physical and alias output sequences, and validate every
existing face pin and newly generated event, including direct point-to-own-query
and all original/physical/alias distance obligations. No tolerance accumulation,
refusal-string bypass or fabricated old plan is allowed.

The next isolated experiment uses the original full knob at the actual named
pipeline barrier after face contouring and before cell triangulation. It must
retain live immutable octree/face/point provenance, exact typed face roots, both
actual shared-face consumers, endpoint/frontier/interval metadata, and matching
working/rounded geometry evidence. It stops before costly postassembly refinement
under a separate 120-second preparation-and-private-construction watchdog. Existing
component ceilings remain unchanged. Missing retained-outside contact or metadata
evidence remains a publication block. This transport milestone does not alter
production code or repair the remaining malformed emitted faces.

[Fourth decision and private-experiment contract](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round13-transport-controls/decision.md),
[executed comparison](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round13-transport-controls/executed-summary.json),
[selected A handoff](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round13-transport-controls/A-packet/handoff.md),
[A's complete receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round13-transport-controls/A/proof-receipt.json),
and [independent exact replay](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round13-transport-controls/A/root-exact-replay.json)
retain the selected implementation and its limits. E4 acceptance, source
preservation, global contacts and the full-export resource exit remain open.

### First complete-consumer experiments: construction still refuses

The three independent implementations now reach the original full knob's actual
native Serial attempt-0, round-0 barrier after face contouring and before live cell
triangulation. Their complete inventories agree exactly: **199 affected leaves,
198 affected canonical faces, 1,001 required faces and 396 target typed pins**.
Each affected face has two distinct opposite-side consumers. All final focused
campaigns and diagnostic harnesses pass; **none constructs a private mesh**.

| Candidate | Original-scene diagnostic | Actual outcome before private meshing |
| --- | ---: | --- |
| A, retained only as the next experimental base | 19.245 s | Face-root guard refuses unequal float32 coordinate bins before attempting its geometric proof. |
| B after syntax-only fix | 19.188 s | Direct actual-point association exceeds the unchanged allowance; the saved failure needs mapped-output evidence to distinguish round-trip error. |
| C after type/comparison-only fixes | 18.829 s | Prototype refuses a retained third-chart pin, chart 42 at point 4082. This is its limited admission scope, not a geometric disproof. |

The recorded times are individual diagnostic observations, not speed comparisons.
B's original JSON-macro compile error, C's array-type compile error, and C's
pre-pipeline comparison of JSON `2.0` against `2` are retained separately. Their
fixes do not change scene options or construction algorithms. Native-only controls
such as the absent TS retry wrapper are explicitly distinguished: requested
`jitterRetries=3` and `failurePolicy=partial` remain recorded but unconsumed.

A now performs explicit successful source/endpoint admission and both output-list
checks, retains the original alias witness when available, and includes a bounded
observer for failed/discarded curve queries inside the private mesher. Removing
that diagnostic wrapper restores the base query file byte-for-byte; the numerical
query body and inverse/projector algorithms are unchanged. The observer and later
geometry audits were not reached in the full-input run. Its saved 1,240-query count
covers admission, not later pin validation. A's live state digest is unchanged
before and after refusal. Complete consumer enumeration is established; complete
mesh consumption, closure, contacts and metadata preservation are not.

A's exact failed face is `[0,2875935,1]`. Its two numerical pin positions differ by
approximately `1.968750763e-9` mm, yet their y coordinates round to adjacent float32
values. Exact arithmetic places the rounding boundary `24100469/67108864` strictly
between them. The old `quantized_face_root` returns immediately on unequal float32
triples, before invoking `certify` or its existence/uniqueness test. Its reported
`face_root_not_unique` reason therefore does **not** establish non-uniqueness.
No different-root conclusion follows from this refusal.

Fourth review rejects all three as construction repairs and retains A only for a
local correction. The next bounded feature-only discriminator must attempt a
source-bound enclosure of both rounding-cell face boxes on the exact typed face
plane, verify its relation to the actual minimal-face rectangle, and separately
report source, branch, axis-inverse and root-inclusion outcomes. Both original
points/parameters, direct query checks and numerical allowance stay unchanged.
An enclosure merely containing the points is insufficient; deleting the guard,
welding nearby positions or perturbing coordinates is not authorized by this
result. A successful ideal-root proof would still leave representative selection
and complete geometry/frontier/contact audits to perform.

[Fourth decision](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round14-private-controls/decision.md),
[execution comparison](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round14-private-controls/executed-summary.json),
[A's actual context/refusal](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round14-private-controls/A/private-receipt.json),
[exact rounding-boundary replay](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round14-private-controls/A/exact-f32-refusal-replay.json),
[B's direct-association refusal](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round14-private-controls/B-fix1/private-receipt.json),
and [C's retained-constraint refusal](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round14-private-controls/C-fix2/private-receipt.json)
retain the complete evidence. No live or production geometry changes, and no
private/full export follows from a harness PASS alone.

### Adjacent rounding cells: local existence and uniqueness pass

All three independent saved-face experiments pass the previously skipped
mathematical gates. The literal hull of the two rounding-cell face domains fits
inside the original minimal face. The unchanged source restriction succeeds in
one box, the uniform inverse bound succeeds for the **actual face axis**, and
strict root inclusion succeeds. The old same-bin helper still refuses. Neither
saved point, parameter, source coefficient nor numerical allowance changes.

This establishes one unique ideal root in that local hull. For the represented
radial and twisted-side equations, one fixed numerical preconditioner bounds
`I-CJ` below one in the infinity norm throughout the convex planar domain.
The resulting contraction gives at most one root; strict Krawczyk-image inclusion
gives existence and encloses that root. An inverse for another axis, pointwise
regularity, or an enclosure merely containing the numerical pins would not suffice.
The wrong-plane/shifted-domain controls retain invertibility but fail existence;
separately scoped multiple-root controls reject uniform inversion.

An exact rational replay bounds each unchanged numerical pin to **every point**
of the recorded root enclosure: at most approximately `5.026533242e-13` mm for
the physical pin and `1.969250151e-9` mm for the alias pin, both below the unchanged
`3.79665537e-7` mm allowance. Both pins remain slightly off the exact face plane,
and their float32 bins remain different. This is a source-bound root association,
not equality of their numerical representations or permission to publish a weld.

Fourth review selects one narrow private-A integration: reuse the original
root-image calculation, bind the live typed face and admitted source/branch,
validate the literal hull and actual-axis proof, and require both direct
pin-to-root-image bounds. Keep the old helper as a negative reference and retain
all downstream component checks. The integrated helper must pass fresh focused
controls before one bounded original-scene private run; a local proof pass is not
a constructed mesh.

The integration also preserves the actual face-contour rectangle convention:
mapped minimum plus `len*step`. Directly mapping the far grid corner gives slightly
different binary64 upper bounds (38/3 ULPs on this witness). Both tested hulls fit
inside both rectangles, so this does not change the observed local result.

[Fourth mathematical review and integration contract](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round15-face-root-controls/decision.md),
[three executed checks](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round15-face-root-controls/executed-summary.json),
[recorded source/inverse/root stages](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round15-face-root-controls/A/proof-receipt.json),
[exact point-to-root-enclosure bounds](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round15-face-root-controls/A/root-image-replay.json),
and [independent domain/pair replay](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round15-face-root-controls/B/root-domain-replay.json)
retain the evidence. These are feature-only diagnostic tests of one saved face;
no octree, private mesh or full export was rerun in this discriminator.

### Integrated face-root gate: all 198 affected faces pass

The selected private integration passes all four focused control tests and the
fresh original-scene diagnostic. It now certifies **all 198 affected faces and
396 retained pin-to-root associations**, across axes 0/1/2 as 43/42/113. The
complete inventory exactly matches the previous 199-leaf component. Independent
exact rational replay validates every recorded point-to-root-image bound; the
largest reported bound is about 0.02104 of the unchanged allowance.

The new gate uses the actual minimum-plus-extent face rectangle, literal hull,
same successful admission identity and immutable source, admitted branch,
unchanged source restrictions, actual-axis inverse and strict root enclosure.
It also retains the old stricter `min(curve_eps)` domain/residual checks. The
original boolean root test and same-bin helper retain their behavior; the inverse,
projector and source equations remain unchanged. This replaces the private face
admission condition with a source-bound geometric certificate, while retaining
the physical pin coordinates and all subsequent component guards.

The constructor advances through face-pair checks, required-pin checks and private
boundary staging, then refuses **`private_source_view_byte_cap` before cloning the
source view or meshing private cells**. Final charged queries are 7,801, below
16,384, and the live digest remains `5f3600b1ef212fb0` before and after. No triangle,
generated-event, contact or complete-link audit has run. The 22.853-second full
job is a successful diagnostic capture, not a successful replacement mesh.

The remaining reservation streams Debug output for the feature data and charges
64 times each text fragment's size, plus existing staging and index allowances.
Shared immutable source graphs expand repeatedly in that text even when their
clone shares storage. The refusal is therefore a conservative accounting result,
not an allocation failure or demonstrated memory requirement. Its receipt lacks
the original staging contribution and the separate source terms, so actual fit
within 64 MiB cannot yet be claimed. The next bounded resource check must account
for every owned clone allocation while distinguishing shared immutable payload;
it must retain the same combined cap and expose the full ledger on refusal.

[Integrated fourth review](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round16-face-root-integration/decision.md),
[execution and outcome summary](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round16-face-root-integration/summary.json),
[integrated source handoff](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round16-face-root-integration/A-packet/handoff.md),
[focused integrated controls](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round16-face-root-integration/A/integrated-face-receipt.json),
and [all face certificates and new refusal](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round16-face-root-integration/A/private-receipt.json)
retain the evidence. The mathematical face gate is validated in this original
native context; complete mesh construction and production acceptance remain open.


### Owned-storage audit and integrated private construction

Round 17 compares three independent approaches under the unchanged 64 MiB cap.
A walks clone-owned storage and retains ordinary `Clone`; B rebuilds the private
index to make its capacity explicit; C measures the original clone and challenges
the proposed bounds. All focused controls pass. C's original-clone observation is
271,936 requested allocation bytes, not process RSS. A separate tombstone control
shows that an empty hash table reporting capacity zero can still clone 147,464
bytes: public capacity alone cannot bound arbitrary hash-table clone storage.

Fourth review selects A with an explicit insertion-only history premise and
refusal after removals. Shared immutable source payloads remain shared; owned
vectors, boxes, paths, domains and index backing are counted. This is tied to the
audited Rust 1.99.0/hashbrown 0.17.1 representation. The selected integration
adds checked actual staging terms and bounded typed ledger retention, deferring
JSON expansion until after the constructor. The previous Debug-text estimate
is replaced without increasing the cap or changing geometry tolerances.

The integrated build and six focused tests pass. One preparation-inclusive
original-scene diagnostic completes in 23.604 seconds and records:

| Gate or observation | Result |
| --- | --- |
| Typed-face certificates / retained pin bounds | 198 / 396; identical to Round 16 |
| Selected leaves / required faces | 199 / 1,001; unchanged inventory |
| Actual staged reservation | 18,918,636 bytes |
| Source-owned / inline / native ledger reservation | 930,359 / 344 / 16,384 bytes |
| Combined reservation | **19,865,723 bytes**, below 67,108,864 |
| Generated query attempts | 46, all successful and validated before refusal |
| Final charged queries | 9,950 of 16,384 |
| Private outcome | **`private_graph_refused`**, cell `[7,36,79,29]` |
| Live digest before and after | `5f3600b1ef212fb0` |

The staging inputs are 1,421 segment-plus-pin entries, 824 required points and
11,451 key bytes. The unchanged formula is `items*512 + points*1024 + keys*4 +
16384*1024 + 128*4096`. This is a new actual reservation measurement; the missing
Round 16 staging value remains unknown. The ledger's explicit native layout bound
is 9,455 bytes within its 16,384-byte allowance. Broader diagnostic JSON and allocator
RSS are separate costs, not covered by that native layout claim.

The constructor reaches the second selected cell. Its feature graph fails; a
corner fan returns eight triangles but retains the feature-fallback flag. The
private caller rejects the whole component before accepting those triangles.
The captured local state has ten staged faces, eight boundary segments, one
physical-chart-20 pin and no truncation. It is **post-return**, not a complete
pre-call replay fixture. The 46 query attempts are cumulative across the private
run, not all attributable to this cell.

Terminal corner 27 originally lists charts 20/33; removing duplicate chart 33
leaves only 20. A path ending at an interior degree-one vertex would violate the
feature graph's adjacency requirement. This is a concrete hypothesis, **not the
recorded executed rejection**: the receipt lacks the exact failed branch and
complete internal adjacency. The next bounded discriminator must identify that
predicate and its source/endpoint incidence before changing construction. Keep
face certificates, storage policy, original constraints and first-failure handling
fixed. No fallback fan, invented continuation or relaxed geometry is authorized
by this result.

[Archived prototype and reproduction instructions](sfcc-e4-prototype/README.md),
[three-agent comparison and fourth decision](sfcc-e4-prototype/round17-storage-controls/decision.md),
[independent integration review](sfcc-e4-prototype/round18-storage-integration/decision.md),
[execution summary](sfcc-e4-prototype/round18-storage-integration/summary.json), and
[full original-scene receipt](sfcc-e4-prototype/round18-storage-integration/executed/private-receipt.json)
preserve the selected source and evidence in the repository. The flat patch
reproduces all 36 changed files against E3 byte-for-byte. It is an isolated native
prototype; production runtime remains E3. Complete component geometry, contacts,
links, metadata and final export closure remain downstream and unvalidated.

### Exact private graph rejection captured

The next three-agent investigation and fourth review selected bounded pre-call
instrumentation. All 13 focused controls and the serde-only compile check pass.
One original-scene capture confirms the actual `vertex_degree_lt_two` guard at
cell `[7,36,79,29]`: newly inserted point 633 (`corner:27`) has only neighbor 620,
the boundary pin on chart 20. The graph contains the eight-edge boundary and one
interior feature edge. Its six graph-local queries are run-wide indices `[40,46)`.

All 35 compared historical receipt fields remain exactly equal, including all
198 face certificates, the inventory, complete query log, storage reservation and
live-state digest. No replacement is accepted. The pre-call state is now saved,
but exact local replay and the source's continuation/termination obligation are
not yet proved. Degree one identifies the executed implementation assumption;
it does not alone establish invalid surface geometry.

The [capture implementation and reviewed evidence](sfcc-graph-rejection-capture/README.md)
retain the alternatives, selected patch, commands, full receipt and precision
limitations. Production runtime remains unchanged by this isolated diagnostic.

### Endpoint source obligation and exact local replay

Three independent test-only candidates now pass their focused runs. The actual
failed graph replays exactly from the original source, all 633 pre-call points
and keys, and the private alias edit, including the new corner and six curve
queries. A separate interval argument binds every source ancestor and proves a
regular exposed native crease over the captured endpoint height ±0.0001 mm,
inside the failed cell. The numerical endpoint's ideal-branch association is
below the unchanged curve epsilon. This rules out a legitimate source termination
at this recorded endpoint; it is not a global feature-completeness theorem.

A third discriminator finds continued supporting-pair samples that the default
finite flank-probe schedule calls dead while a smaller diagnostic schedule calls
alive, with small full-field residuals and valid carrier domains. It separately
exposes an intermediate chamfer branch-propagation gap. Neither result yet records
which actual raw-trace/trim/refinement/wiring event created corner 27. The next
experiment is therefore bounded feature-compilation provenance, not a degree-guard
relaxation or a blind probe-factor reduction.

[Endpoint proof, replay and discriminator evidence](sfcc-endpoint-obligation/README.md)
retain the executed results and limitations. No replacement geometry has been
accepted and no production meshing logic changed.

### Actual first loss localized to finite-flank trimming

The next three-agent investigation and fourth review captured the actual
feature-compilation lineage. Raw curve 103 becomes final curve 20; raw curve
131 becomes pre-dedup curve 39 and final curve 33. The final parameter 31 is a
remade indexing parameter, not the raw parameter.

For raw 103, sample 987 at y=2.6909800203269927 lies in the source-checked
neighborhood. Its native-side flank succeeds, but all ten cylinder-side probes
are domain-rejected. The finite search returns `Ok(false)`, not uncertainty.
Fourteen bisection classifications retain the preceding alive point at
y=2.6909777686167193. Endpoint refinement retains that seed, candidate 27 is
created there, and the alias endpoint later merges into it. Remaking and final
corner compaction preserve the cutoff. This establishes trimming as the first
loss for the witnessed continuation, rather than raw tracing or later wiring.

The observation preserves all compiled output. An initial byte-cap refusal is
retained; a reviewed lossless source-reference representation fits under the same
512 KiB cap and expands to the exact 765-event old prefix. The final 766-event
capture has complete target lineage joins. This is a diagnostic result, not a
meshing repair. It does not show the domain predicate itself is wrong or identify
each rejected probe's inner ancestor.

[Complete lineage and stage-3 repair contract](sfcc-endpoint-lineage/README.md)
require a source-level continuation/exposure repair with unresolved outcomes where
proof is unavailable. A global probe-factor reduction, duplicate edge or relaxed
degree guard does not close the obligation. Later blend continuation, complete
component reconstruction and production acceptance remain open.

### Stage 3 repair candidates rejected by preservation checks

The first three-agent repair round and fourth review produced no accepted patch.
A adds source-bound positive exposure for a restricted parametric ancestor class;
B adds numerically bounded adaptive probing. Both propagate uncertain ends through
splitting, snapping and wiring, and both restore the required upper compiled
interval. Both also lose required source incidence at the existing lower joint:
A loses three source-pair memberships and B loses `[10,31]`. The joint position is
unchanged, so renumbering or a wider matching tolerance cannot explain the failure.
Some memberships may describe equivalent geometry; no candidate supplies the
source/interval transport proof needed to retire or rebind them.

C's executed counterfactual proves reporting uncertainty alone leaves the compiled
geometry unchanged, while unresolved trims increase from 29 to 89. A separate
baseline regression fails the upper interval as expected. A's source-selection
and orientation measurement errors were corrected without runtime changes; the
lower preservation failure remains. An initial stale-cache zero-test run is
explicitly excluded and subsequent builds require cache cleanup and test discovery.

[Reviewed candidates, actual results and next contract](sfcc-stage3-exposure-repairs/README.md)
require justified junction/attachment resolution for unresolved parameter frontiers.
Ordinary nearest snapping, forced alive status or weaker preservation checks would
undo the correction. Stage 3 remains open; production meshing logic is unchanged.

### Stage 3 junction premises and connection-container correction

The next three-agent revision and fourth review establish bounded premises rather
than an accepted runtime repair. A derives a genuine source junction within
`1.9033e-13` mm of the old lower corner; B proves conditional local equality of
the native and parent-field zero sets with the same compound carrier. Neither
proves incoming-arc connectivity or grants attachment authority.

C's lossless causal capture shows why preserving only the final bisection bracket
is insufficient: the missing raw trace starts near the junction at parameter zero,
but its final positive/unknown bracket excludes zero. A was corrected to retain
the original classification interval and its status separately from the final
numerical cutoff, with bidirectional and wrap controls. The compound flank exhausts
its finite probes while the native flank succeeds. The retained alias itself had
been snapped from a raw start farther away, so its endpoint is not independent
connection evidence.

Final focused campaigns pass A's eight, B's six and C's seven controls, then each
fails the unchanged original-source lower-incidence gate. Upper continuation
remains represented. No candidate enters component integration or production.
[Executed revision, bounded claims and next connection contract](sfcc-stage3-junction-revision/README.md)
preserve the patches, all unsuccessful captures and the fourth review.

### Stage 3 local incoming-connection repair selected

The [incoming-connection implementation and fourth review](sfcc-stage3-incoming-connection/README.md)
select A-rollback for the bounded local witness. The source-derived parameterized
prefix restores the missing lower `[10,31]` attachment while retaining upper
continuation. Compared with the same-binary adaptive parent, all non-target source
families remain unchanged; counts remain 76 curves, 40 corners and 83 unresolved
trims, with unwired ends reduced from 77 to 76. The unchanged original-source gate
and all 12 focused tests pass, including exact rollback after a forced late remake
refusal. Production meshing is unchanged.

Both first runtime alternatives exposed a legacy-dedup interaction that could
discard a new certificate. Conservative refusal before mutation now preserves
already represented families. B-final's 13 focused passes still did not establish
acceptance: connected-code review and an injected refusal demonstrate silent
whole-run deletion on a failed remake. B remains rejected; its continuous chord
bound remains useful evidence. No duplicate edge or sampled certificate transfer
was accepted.

Stage 3's local witness exit is satisfied. Stage 4 must regenerate the affected
source/face/pin/query/storage obligations and validate the complete component and
its interfaces; the old private graph guard has not been rerun on this selection.
Current-HEAD/native-WASM integration, full torture cases and E4 overall remain open.

### Stage 4 attempt refuses before component construction

The [fresh component-validation attempt](sfcc-stage4-component-validation/README.md)
uses exact pipeline-context preparation and source-based selection, not the old
fingerprint or chart IDs. The current fingerprint matches the selected Stage 3
result. Physical/alias charts 20 and 38 both have lower corner 13, upper corner
`-1`, and range `[0,31]`; their numerical upper endpoints differ by approximately
0.0023014 mm. The unchanged private admission gate refuses `endpoint_missing`
before complete source transport, octree, faces, staging or private construction.
The required admission assertion fails; a separately bounded conditional attempt
captures the same refusal and does not publish geometry.

The twelve selected repair controls still pass. Source reidentification, clone
metadata and source-only storage controls pass with a 944,540-byte reservation,
explicitly excluding actual component staging. Historical component/face/pin
counts are not reused. No current component triangles, f64/f32 validity, topology,
frontier or outside contacts were evaluated. The round0 barrier also lacks
same-stage outside triangles, a separate future prerequisite for contact closure.

The fourth review retains Stage 3's local result while leaving Stage 4 open.
Next establish the current upper composed-field transition and ordered source
handoff, checking actual scalar blend behavior and active domains. Do not weld the
two numerical ends or fabricate a corner to satisfy endpoint presence. Production
runtime remains unchanged and E4 overall remains open.

### Upper continuation proved; intermediate-chamfer correction remains partial

The [upper-handoff investigation](sfcc-upper-handoff/README.md) establishes a
regular ordered source crease through both current numerical cutoffs. Its bounded
full-scalar theorem checks finite profile/cap and ancestor conditions, locating
round activation near `y=2.695793565696748` mm. The incoming native-zero extension
is not the exact outgoing zero set after that event. No terminal or complete raw
trace correspondence is inferred from finite samples.

The implementation audit confirms that `sample_override` incorrectly forced an
intermediate chamfer's supporting diagonal even in child-dominant regions. The
minimal correction uses existing full operator recomposition while retaining
explicit selected-diagonal semantics. On the original source it recovers a checked
outgoing lifted-curve point within about `5.85e-9` mm of the height-3 witness; the
legacy matching source family was about 5.503 mm away. The lower twelve controls
pass. The broader 76→101 curve, 40→55 corner and 83→95 unresolved inventory changes
are recorded, not globally accepted.

An independent counterexample shows the discovery ownership band excludes an
initial interval of the outgoing regular source crease. Global removal or zeroing
is not sufficient: it also permits overlap with incoming native ownership and
does not provide exact source closure at activation. All final complete-admission
gates still refuse `endpoint_missing`.

Fourth review retains the operator correction as a partial isolated base and
accepts the bounded source premise, while leaving the handoff and Stage 4 open.
Next establish source-bound activation/closure and ordered native-to-outgoing
transport with ambiguity, query and transaction refusals preserved. Production
runtime and component geometry remain unchanged/unvalidated respectively.

### Upper handoff admitted; fresh component reaches lower and budget refusals

The [upper closure implementation and fourth review](sfcc-upper-closure/README.md)
select A-cell for the bounded upper handoff and sampler integration. Canonical
incoming/outgoing spans meet at the proved event, actual boundary queries are
associated, and positive closure remains separate from discovery ownership. A
synthetic counterexample shows the old private admission could accept an incoming-
only event despite a proved successor; the new source-event inventory guard
rejects that omission. All 26 focused checks and the non-test library build pass.

The first real component attempt passed source admission and fresh face/pin/storage
gates but refused in the original upper cell because its arc sampler ignored the
qualified closure. Exact local replay establishes old-None/new-Some behavior with
all query, box, chord and resource checks retained. Updating those three sampler
uses permits reconstruction to progress beyond the upper event.

The next attempt records 199 leaf consumers, 1,000 required faces, 198 successful
typed-face certificates, 396 pin bounds and a 20,243,822-byte combined reservation.
It first records `path_nodes_lt_two` at lower cell `[8,51,116,172]` for lifted
chart 75, unwired at corner 13. Subsequent validation of 838 successful generated
queries reaches the unchanged 16,384 cap and returns `TotalCap`, masking that
earlier graph refusal in the top-level reason. Both are retained in chronology.
The complete candidate is discarded; live digest `aa6ab69dfb79125d` is unchanged.

Next establish the lower event's required lifted continuation and independently
audit query reservation/spend, inverse/cache cost and failure precedence. No
reuse of the upper closure by source IDs alone, gate relaxation or cap increase
is justified. Full-component geometry, interfaces, source-patch ownership and
production acceptance remain open.

## Lower lifted source and query-cost audit

The [next bounded investigation](sfcc-lower-lifted-connection/README.md) proves
the lower source's four physical crease rays and a canonical lifted connection
from the actual chart75 parameter12 join to the existing source event. Whole-interval
source margins and ordered parameterization pass; the 3D join association is bounded
by 2.992e-9 mm under the unchanged 3.797e-7 mm allowance. This is a source/association
proof, not an installed runtime handoff or a proof of old Newton-map continuity.

Independent observational instrumentation reproduces the same component refusal
with unchanged geometry and limits. Typed-face checks use 6,557 fresh queries;
generated-event validation uses another 6,527 before TotalCap. Only 744 of 838
generated events finish validation. The ledger retains all 2,048 reserved generated
slots despite only 838 being used; no refund is implemented. Repeated identical
inverse searches already consume zero fresh queries, so correspondence caching
chiefly targets CPU work. A better checked proposal for new inverses is the next
query-budget experiment.

Rust 1.99.0 was removed from the host. Root pinned 1.99.1, reran all 26 baseline
controls and the original component, and verified unchanged audited std/hashbrown
sources and identical receipts except process-local addresses. The source/association
packet passes 31 controls and the separate query packet 29, with non-test library
checks passing. Production remains unchanged. Next install the bounded lower
transaction, preserve complete incidence and rollback, improve inverse proposals
under the same checks, and revalidate the complete affected component.

## Lower runtime attachment and newly reached orientation refusal

The [runtime milestone](sfcc-lower-runtime/README.md) installs the source-bound
last span of chart 75 at existing corner 13, preserves the old join and incident
branches, and enforces all four required source roles. A-reviewed passes 37 checks.
Its fresh component meshes all 199 selected cells but reaches the old query cap
after validating 787 of 1,167 generated events.

The independently reviewed inverse proposal change uses at most two checked
height-interpolation proposals before bounded bisection, with the same acceptance
tests and caps. Combined validation passes 41 focused checks and completes all
1,167 generated events at 5,568 charges. No reservation is refunded. Fresh inventory
has 1,001 required faces and 198 typed-face certificates/396 pin bounds; combined
reservation is 20,251,702 bytes. Live state remains unchanged.

The component then refuses `private_invalid_f64_or_f32`. An observational capture
passes 16 checks and reproduces every prior receipt field. It preserves all 1,064
private points and 1,700 triangles with cell ranges. Triangle 11, IDs [636,455,633],
belongs to cell [7,25,58,86] and has an edge on curve 66 but no recorded patch owner.
Its area is nonzero in both precisions, while its normal opposes the already
computed centroid-gradient reference. Exact arithmetic on the captured binary
coordinates confirms both negative dot signs. This is not f32 collapse, and no
claim is made that the new connection introduced the previously unreachable failure.

Next reconstruct the loop/patch attribution and source-consistent orientation;
do not blindly reverse one triangle. Later triangle checks, post-graph transport,
topology, outside contacts, source-patch coverage and production acceptance remain
open. Full receipts, restoration patches and the fourth-agent decision are linked
from the runtime report.

## Orientation cause: repeated patch walk and locally equivalent curves

The [orientation investigation](sfcc-orientation/README.md) captures the actual
successful graph and stratum-38 fan. Its 20-entry boundary revisits eight vertices
and traverses seven feature edges twice. The first cell accounts for all seven
opposite duplicate-face groups and eight nonmanifold edges in the saved component.
Its corner rotation swaps ports 454/455 relative to boundary order, yielding an
Euler-zero combinatorial rotation system. This is not a claim that the CAD surface
has genus one. A topology-only reordering leaves an unjustified fifth represented
ray and is not selected as a repair.

Finite-source interval checks prove that the working and exported triangle normals
oppose every possible local active facet normal. Native and inactive inner-round
supporting fields coincide locally; charts 46/66 share the other compiled carrier.
Their actual face-port queries associate directly with a unique physical source
crossing within unchanged tolerance. The rounded generated-carrier offset is bounded
separately; exact physical/generated root identity is not asserted. Whole consumed
interval transport and the exact adaptive FaceRecord/container binding remain open.

The selected five-line guard rejects a repeated patch vertex before fan construction.
It passes 52 focused checks and a non-test build. A fresh component returns
`private_graph_refused` at `non_simple_patch_boundary`, validates all 50 generated
queries at 3,534 charges, discards ten fallback triangles, and preserves live state.
It prevents false local acceptance but does not reconstruct a usable component.

Next establish ordered 46/66 interval correspondence and shared adaptive-face
consumer closure before merging their physical representation. Preserve the new
guard, all source identities, numerical checks, limits and rollback requirements.
The evidence includes two independently executed exact topology checkers, three
offset-aware source tests, failed initial diagnostic-build evidence and a fourth
reviewer's explicit limits. Production remains unchanged.

## Secondary alias: validated local reconstruction and bounded full scope

The [next alias milestone](sfcc-alias-connection/README.md) reconstructs the captured
first-cell graph using a typed adaptive Y-face certificate and source-qualified
46/66 prefix sharing. The scoped replay retains both chart identities, exact target
endpoint parameters, direct canonical-point checks and the repeated-vertex guard.
It produces 23 triangles with no duplicate faces, invalid links, directed-incidence
errors or detected f64/f32 orientation/contact conflict. All 182 generated events
pass the post-query contract at 2,495 charges. The combined source passes 65 focused
checks and a non-test library build.

The interval authority is conditional on every accepted query lying in both its
original projection tube and the certified source-image neighbourhood. The initial
attempt to qualify the entire broad raw tube failed and is preserved; no old Newton
continuity or totality is inferred. The first actual adaptive FaceRecord and both
opposite consumers are checked under the unchanged ledger, but no whole-component
contour transaction is performed.

Fresh scope enumeration finds six paired faces and 155 additional curve-66-only
faces. Merging the entire family would exceed existing caps, whereas the paired-face
prospective closure fits: 205 cells and 1,031 required faces. Its final cell has a
single-66 frontier. At native curve46's t=16 endpoint, the inner-round field differs
from the native field because the competitor is below the blend radius. Whole-curve
alias equality is therefore false. A conservative proof-helper refusal elsewhere
must not be mistaken for that physical activation.

Next certify the activation event, extend only supported interval correspondence,
bind the remaining adaptive faces and prepare an atomic consumer-closed transaction.
The successful local mechanism does not authorize publication or inherit the earlier
199-cell completion. Production remains unchanged; full-component geometry, topology,
contacts and source-patch ownership remain open.

## Round 32: source activation, six face roots and frontier handoff

The [inner-activation milestone](sfcc-inner-activation/README.md) certifies where
native/composite equivalence ends. The event is the competing lathe level 1.4,
not its zero carrier. Finite source branches give one activation, bounded regular
C1 continuation on the composite crease and a physical native ghost family on a
smooth chamfer facet. Physical/generated coefficient differences are retained;
the actual native endpoint gets an independent strict physical-facet check.
There is no blanket continuity or pruning claim for the old raw native tail.

Bounded incoming authority and analytic X/Y inverses admit all six actual paired
adaptive faces, retaining exact record/container/provenance and direct own-query
checks. Their 12 own queries and both opposite consumers are recorded. The measured
prospective closure remains 205 cells and 1,031 required faces.

A refined bounded inverse prepares an interior activation on native46 at
15.970530466239364 and composite66 at 5.051414792727411. An initial pairwise
association failure is preserved; the search target was tightened to epsilon/4
without changing the final allowance or query/iteration caps. Original curve-range
finite/order guards and original incoming/outgoing tubes remain mandatory.

The actual frontier cell [8,55,114,172] originally lacks a second native node and
rejects before own curve queries. A scoped graph-entry replay now merges its proved
entrance port, inserts the interior event, ends the native local path there and
retains the composite continuation to the unchanged original frontier. It produces
12 triangles with valid local topology/incidence and no detected f64/f32 orientation
or contact conflict. All 96 generated events postvalidate, at 2,451 ledger charges
including the unchanged 2,048-slot reservation. No global curve is deleted.

An initial fixture-lattice reconstruction differed by one ULP and was rejected
before geometry. The fix uses the fresh original pipeline lattice and preserves
exact captured cell-box equality. The final source/binary passes 47 distinct tests
in 53.142 seconds of its existing 60-second campaign, plus a non-test library check.
Ten executed candidate patches were restored and input hashes verified; failed
controls and builds remain archived. A fourth agent reviewed the final scope.

Next prepare the complete atomic transaction and reconstruct every affected
consumer, then run full coverage/order, interfaces, topology, patch ownership,
f64/f32 outside-contact and rollback checks. The fresh ordinary component still
refuses the preceding graph; the frontier result is a separate local test, not a
205-cell acceptance. Production, native/WASM/GPU parity and full-model acceptance
remain unchanged and unestablished by this milestone.

## Round 33: complete affected component reconstructs; ownership remains open

The [complete transaction milestone](sfcc-component-transaction/README.md) prepares
all six paired adaptive faces and the source-bound activation inside one private
request. It computes the complete 205-cell / 1,031-face closure and requires all
seven secondary consumers to finish, including opposite consumers. Exact indexed
window checks retain both incoming chart identities and the composite-only outgoing
edge; no global native tail is deleted. Primary full-range obligations remain.

The reviewed original-scene run produces 1,775 triangles, with 1,109 used vertices
and 441 boundary edges. Indexed topology, source-reference winding and working/
exported self-contact checks pass. All 827 frontier face records preserve original
bindings and their oriented boundary segments match. All 1,929 generated queries
postvalidate at 8,413 ledger charges, with the original 2,048-slot reservation
retained and 119 slots unused. Live state is unchanged. The selected 43-test campaign
passes in 33.674 seconds of its 60-second budget; the complete diagnostic takes
32.193 seconds of its 120-second budget. Non-test library validation passes.

Fourth-agent review found that a top-level observer refusal could be ignored if
its successful row prefix was retained. The selected revision rejects that case,
independently enumerates all-axis paired inventory, refuses unsupported Z pairs
and requires exact intended/certified/installed set equality. Negative controls
cover incomplete/duplicate proof inventories and ambiguous pins. The fresh reviewed
run has identical points, triangles, intervals and generated-query evidence.

Full acceptance remains false. All 1,775 triangles lack certified patch-owner labels;
the fallback fan path deliberately does not assign such authority. Simply copying
graph stratum IDs would not establish continuous surface exposure or coverage.
The pre-cell-meshing barrier also lacks matching-stage outside triangles. Retained-
outside contacts/topology, complete metadata transport and new checker workspace
accounting remain open; measured retained layouts are not a total-RSS bound.

Next establish positive two-dimensional source ownership for the first unsupported
fan and matching-stage outside compatibility, retaining all existing limits. The
complete reconstruction is a substantial new result but does not authorize
publication or establish production/native-WASM/GPU or full-model acceptance.

## Round 34: source-region proof, exact supplied metadata and one outside join

The [ownership/outside milestone](sfcc-patch-ownership/README.md) preserves the
complete component's points, triangles, interval memberships and generated query
records exactly. It records all 414 fan calls and their 1,775 triangles. The frozen
fixture has quality triangulation disabled: the first cylinder carrier and 823
triangles are supported by the older local-edit gate but never enter it. Missing
labels are therefore not evidence that every fan is geometrically unsupported.

For the first actual six-triangle cylinder fan, a source-bound interval argument
establishes full composed-field exposure on 35 small graph regions, including six
open rectangles strictly inside the triangle charts. One lifted edge midpoint has
a positive field lower bound of about 1.404e-10. This refutes that exact lift's
universal ownership, not the approximate mesh; it is a field value, not a proved
displacement. Twelve other probes are inconclusive or uncertified, and the full fan
area/boundary transport remain unproved. Review corrected outward derivative-bound
rounding and added an explicit clamp-inactive height guard before twist evaluation.

The allocation-free, query-free supplied-metadata audit passes for 851 original
points, 647 canonical points, 1,031 faces and 414 pins. It checks normal/key/position
bits and directed segment/pin transport. Actual pregraph protected-edge and interval
counts are zero, so those preservation exits are vacuous in this fixture; controls
cover nonempty cases. Unsupplied metadata and emitted-edge realization stay outside
this check's claim.

The same-stage outside inventory has 88,835 leaves, 375 face-adjacent cells and 277
with nonempty shared frontier faces. The deterministic first neighbor [7,20,62,71]
produces one triangle, with valid orientation/consumption, no detected contact with
the candidate and valid partial joined topology. It makes zero generated curve
queries. Its separate ledger retains 64 setup charges and the full 2,048 reservation;
this does not alter the candidate's 8,413 charges. The ring exceeds the existing
256-cell cap; no full-outside acceptance or unproved cell-box exclusion is claimed.

The selected source passes 50 distinct tests in 38.826 seconds, a non-test library
check and a complete diagnostic in 38.112 seconds, all within existing bounds.
Seven executed source patches are restorable and failed compiler attempts preserved.
Next prove a tolerance-aware root graph for the full composed field over the first
fan, including boundary transport/error, and design complete bounded outside
coverage. Full surface ownership, outside compatibility, replacement-stage metadata,
allocator accounting and production/native-WASM/GPU/full-model acceptance remain open.

## Round 35: whole first-fan root graph and exported approximation bound

The [whole-fan milestone](sfcc-full-fan/README.md) replaces selected source-region
probes with a complete local theorem over all six closed triangle domains. A
source-bound reduced max function has strict opposite signs across one common X
slab and decrease rate at least 0.8610098527465292. Its zeros agree with the full
composed source under the admitted finite-branch/ancestor restrictions. Fifteen
accepted pieces, reached in 24 globally bounded checks, cover the input domains;
shared roots agree by common-slab uniqueness. No global scalar-field monotonicity
or remote-sheet exclusion is claimed.

Interval Hessian bounds and a whole-triangle interpolation remainder establish
working-mesh displacement at most 0.0005052995078438982 mm. Independent exact YZ
fan checks prove embedded disks in f64 and f32, with preserved projected orientation.
The explicit same-input composition adds at most 5.206356205475152e-7 mm of export
rounding, giving 0.0005058201434644458 mm under the original 0.01 mm tolerance.
No owner labels or geometry are changed; active source facets may switch.

The boundary witness identifies the same source root at an actual X-face edge
midpoint, about 2.23725e-6 mm off the original plane. Its initial fixture had the
wrong face length; review binds the actual [0,3464532,2] record, segment, extents
and both consumers and rejects shortened records. A separate source-binder guard
now explicitly matches the cylinder primitive's 1e-6 size floor. Neither correction
changes the source/error bounds on the actual witness.

The final source passes 48 distinct tests in 28.698 seconds and a non-test library
check. A fresh 36.856-second diagnostic preserves the complete component's points,
triangles, topology, intervals, generated queries/costs and retained metadata exactly.
It still has 1,775 triangles, 1,929 validated generated events and 8,413 charges.
The proof data bind to the actual first fan and corrected actual frontier record.

Next reconstruct the retained opposite consumer [7,26,58,86] and prove compatible
shared-boundary transport and a joined source-patch cover. A graph over the current
projected fan is not automatically the intended cell-trimmed source patch. Exact
face-plane preservation is not the only possible strategy, but a common transported
boundary needs independent proof. Other fan ownership, complete outside coverage,
replacement metadata, allocator accounting and production/parity acceptance remain
open. The theorem concerns continuous real geometry over represented parameters,
not bitwise CPU or WGSL field evaluation.

## Round 36: actual opposite patch and a common source trace

The [paired-boundary milestone](sfcc-paired-boundary/README.md) reconstructs the
actual original-stage outside consumer [7,26,58,86] across [0,3464532,2]. It emits
11 triangles in two fans: five for cylinder hypothesis 15 and six for stratum 31.
The selected cylinder fan is bound by its reversed shared edge, emitted triangle
triples and final point bits, not by capture order. All nine generated curve-49
queries validate at 2,121 charges in a separate observational ledger. Orientation,
original face consumption, candidate/outside contacts and partial joined topology
pass; the discrete partial join contains 1,786 triangles.

The first candidate fan's six triangles and the selected outside fan's five form
one exact projected disk in working and f32 coordinates. Thirty cross-patch triangle
pairs per precision exclude improper contacts and overlap. One source certificate
covers their exact concatenation in a common X slab: 55 accepted pieces, 99 total
checks under the unchanged global 128 cap, and decrease rate at least
0.8417986595496135. Its same-barycentric export composition bounds error by
0.0010241185705941118 mm under tolerance 0.01. Shared-root uniqueness and the
projected union establish identical source traces along the entire shared edge
without requiring that trace to remain on the original cell plane.

The result covers one face-contour segment, not the ideal feature curve that meets
it. Curve49 has strata [31,15], and its shared endpoint parameter/point bits remain
in the validated numerical query log; ideal feature-parameter transport is still
unproved. The face's other segment and the outside stratum-31 fan also remain
outside this paired theorem. Outside-local membership IDs are explicitly mapped
before comparison with joined patch IDs.

The selected source passes 57 focused tests in 24.993 seconds, a non-test library
check and a 32.309-second fresh diagnostic. Parent candidate geometry, topology,
intervals, generated records/costs and retained metadata are unchanged. The new
outside replay matches the capture after removing process-local addresses and
sorting only unordered membership rows. Two initial compile failures are preserved;
no source-family extension, tolerance change or limit increase was needed.

Next check curve49 at the actual shared endpoint, then certify the second face
segment and compatibility of its incident patch. Full-component ownership, complete
outside coverage, replacement metadata, allocation accounting and production/parity
acceptance remain open. This is a local continuous represented-source result, not
bitwise CPU/WGSL field parity or a published mesh repair.

## Round 37: both captured traces and an ideal feature-endpoint correspondence

The [captured-face/endpoint milestone](sfcc-face-endpoint/README.md) binds the
second original segment to a four-triangle candidate fan with hypothesis 39 and a
six-triangle outside fan with hypothesis 31. Existing bounded orientation evidence
already contained the candidate fan, so no new main observer was needed. Together
with the previous 6+5 pair, all 21 triangles form an embedded projected disk in both
precisions, with point 40 interior. One source call covers 65 pieces in 109 checks
under the unchanged 128 cap; its base export bound is 0.0010243074924721758 mm.

A direct feature 49 discriminator constructs physical/generated ideal feature roots
and checks the original parameter independently. The original point/own query is
within 1.20e-12 mm of the physical feature-and-X-face root, far below the existing
3.796655e-7 mm allowance. No appreciable endpoint defect is inferred from the older
midpoint witness. Exact membership of the unmodified common-X lift remains
unresolved; physical and generated ideal roots are not assumed identical.

A strictly admitted interior-star homeomorphism maps point 40 to the projected
coordinates of that exact ideal root, fixes the star/outer boundary and maps the
same domain onto itself. Composing with the existing unique source graph gives
an endpoint-compatible correspondence without moving any mesh vertex. Interval
mesh-Jacobian bounds add at most 1.3678429079251375e-12 mm of working error; global
source/export bounds give 0.0010243948722129135 mm under tolerance 0.01. The same
source/point/face/parameter, direct own-query association and original tube are
checked, with one separate charged query and no additional source-certificate call.

The selected source passes 65 tests in 28.618 seconds, a non-test library check and
a 32.368-second fresh diagnostic. Parent geometry, topology, intervals, generated
records/costs and retained metadata are unchanged. All four fresh fans and 17 point
bits match the proof fixture; source point, parameter and face bindings agree.
The main candidate remains 1775 triangles/1929 generated events/8413 charges, and
the outside cell 11 triangles/9 generated events/2121 separate charges.

This is an existence theorem for a compatible correspondence on the captured
neighborhood, not a mesh edit, complete feature-curve parameterization or proof
that the two recorded segments exhaust the actual source/face intersection. Next
certify the consumed curve 49 spans and source-level face completeness before
expanding to other cells. Global ownership, outside coverage, allocator accounting
and production/native-WASM/GPU/full-model acceptance remain open.

## Round 38: consumed feature spans, exhaustive face contour and an adoption constraint

The [span/completeness milestone](sfcc-span-completeness/README.md) certifies three
actual curve-49 edges over [31.867718621208247,33], not the complete original chart.
A correlated native/cylinder/groove terminal and a negative native derivative give
closed physical arc exposure through corner 13. Physical/generated families remain
separate. All 13 unique own queries reproduce 15 recorded events and pass direct
image/tube/source/order checks under the original allowance. Whole-chord interpolation,
endpoint association and export rounding bound arc error by 0.00031441763691510014 mm
under the unchanged 0.01 mm limit, with 32 source pieces and separate 64→77 charges.

The face proof is independent of the captured segments. Cylinder positivity excludes
one region; five admitted Y strips cover the complete conditional C<=0 region and
exclude native/native-chamfer/cap/ancestor contributions there. A zero/sign-equivalent
synthetic H has strictly positive Z derivative and opposite edge signs. Ten checks
prove exactly one source root per closed Y fiber on [0,3464532,2]: one connected
contour with chamfer and cylinder branches meeting at the ideal feature root.
Additional crossings and boundary tangencies on this face are excluded in the
continuous represented-source model. A new captured-polyline transport is not implied.

An exact dyadic meridian predicate separately returns a negative nonzero level
comparison at the retained Y coordinate. Thus the old outer-fixed source lifts at
647/1116 cannot exactly belong to the ideal physical feature. This does not refute
the moved endpoint 40, prove a tolerance failure or establish a mesh defect. It does
require additional compatible 2D boundary transport before adopting the ideal arc.

The selected source passes 72 tests in 37.747 seconds, a non-test library check and
a 37.041-second fresh diagnostic. Parent geometry, topology, intervals, generated
records/costs and metadata remain identical; all four span payloads and all 15 query
records bind to that fresh runtime. An initial vertex/event bit-key parsing mismatch
was corrected explicitly and its failed execution preserved; no numerical limit
or proof rule was loosened.

Next identify the incident consumers at 647/1116 and prove compatible boundary/domain
transport with error bounds, then bind the captured polyline to the now-complete
ideal face contour. Full original curve 49 coverage, raw query continuity, broader
ownership, outside coverage, allocation accounting and production/native-WASM/GPU
acceptance remain open. No geometry was mutated or published.

## Evidence

- [Frozen E4 baseline](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/baseline.json)
- [Baseline five-model report](../../.testresults/sdf-meshing/2026-10-24T16-17-21-370Z/report.md)
- [Native invocation and late annotation failure](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/baseline-native-knob/execution.json)
- [Native construction trace summary](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/baseline-native-knob/native-diagnosis.json)
- [Bounded feature-only probe](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-pin-sources/execution.json)
- [Complete pin/carrier observations](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-pin-sources/pin-sources.json)
- [A: exact working/exported stage classification](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-inventories/A-knob-stage-classification.json)
- [B: independent invalid-face inventory](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-inventories/B-knob-invalid-inventory.json)
- [C: independent native stage and multiplicity audit](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-inventories/C-knob-native-stage-audit.json)
- [Full-context two-cell execution](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-full-cell-provenance-job/execution.json)
- [Complete graph, pin and protection lineage](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-full-cell-provenance/selected-cell-provenance.json)
- [Independent boundary-obstruction replay](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-a-obstruction-replay/execution.json)
- [Exact local supporting-equation proof](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-exact-pin-proof/positive.json)
- [Executed counterexample controls](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-counterexamples/execution.json)
- [Rejected first implementation boundary](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-b-proof-freeze1/status.json)
- [Passing focused source/proof boundary](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-b-proof-freeze2/status.json)
- [Complete freeze2 native export receipt](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-b-full-knob/execution.json)
- [Independent exact malformed-face comparison](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-c-candidate-audit/malformed-summary.json)
- [Exact new-malformed source joins](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-c-candidate-audit/new-malformed-source-joins.json)
- [Whole-mesh intersection identity comparison](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-full-geometry-audit/intersection-identity-comparison.json)
- [Pin-pass/arc-reject execution and failure](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-pin-arc-rejection/execution.json)
- [Complete rejected-arc geometry and endpoint observations](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-pin-arc-observations/pin-arc-rejection-observations.json)
- [Nine off-curve failures separated into numerical subreasons](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-offcurve-replay/offcurve-replay.json)
- [Fourth-reviewer decision and required remaining gates](../../.testresults/sfcc-critical-repairs/e4-invalid-construction/round1-consensus/decision.md)

E4 remains open until both complete models emit zero invalid faces and the
required preservation gates pass. A successful first-family repair will be
partial progress, not completion of E4 or overall SFCC acceptance.
