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
