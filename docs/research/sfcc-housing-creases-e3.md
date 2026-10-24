# Housing crease fidelity: E3 investigation and implementation

Status: **bounded E3 crease repair implemented and target validated; overall
mesh acceptance remains NOT PASSED**. Baseline is
`5ac0813a9ae7a056fae068b209e8f08e9455ce6c`, after the guarded
[E2 bore repair](sfcc-housing-bore-e2.md). The unchanged surface and feature
budgets are 0.01 and 0.02 mm. Display normals and tolerance increases cannot
repair geometric face normals.

## What the original housing actually fails

The physical loft/chamfer edge near station 5 exists. In the retained release
mesh it joins vertices 57784/57785 and carries both source-pinned WASM curve
memberships 75/106. Its distance to the GPU crease reference is approximately
0.001476913 mm; its geometric dihedral is 7.178198 degrees. These observations
pass neither incident-face fidelity nor ordered feature coverage by themselves.

| Obligation | Retained measurement | Interpretation |
| --- | --- | --- |
| First incident face, 110164 | 6.488312 degrees from its projected-centroid GPU normal | Fails the 5.869687-degree empirical allowance |
| Second incident face, 110236 | 13.055455 degrees | Fails the same allowance |
| Centroid projection displacement bounds | Approximately 0.002133 / 0.003900 mm | Within the surface budget; does not imply normal fidelity |
| Reference normal contrast | 11.739374 degrees | Half the contrast supplies the existing angular rule |
| Memberships | 75 and 106 on the same indexed edge | Presence is separate from parameter coverage and source identity |

The previous aggregate 6.4883-degree diagnostic could select a nearby unlabeled
edge. Its separately reported best side-normal error could come from yet another
edge. Combining favorable minima from different edges cannot establish one
acceptable physical crease. Diagnostics therefore need to retain each edge,
both incident faces, both corresponding reference errors and all memberships.

The first defective stage is native cell `(7,85,51,101)`, in the nonfallback
feature-graph projected-center fans. The two working triangles match the actual
WASM faces after float32 conversion. The error predates assembly, the additional
E2 refinement and serialization. This is a local provenance match, not an
assertion that complete native and WASM meshes are identical.

The triangles are strongly obtuse, with maximum angles approximately 152.37 and
154.49 degrees and minimum altitudes 0.02510 and 0.02289 mm. Small normal
displacements can cause large slope changes when those altitudes shrink.
For a fixed edge, rotating its incident plane by moving the opposite point
scales as `atan2(normal displacement, in-plane altitude)`. A positional budget
alone does not control that ratio.

## Independent check of the local normal reference

The loft shader uses an approximate profile derivative, so its supplied normals
were checked against its GPU scalar field before attributing the whole error to
triangulation. A bounded capture retained 258 actual GPU samples: 154 for
triangle interiors/apices and 104 for repeated scalar-gradient calibration.
The declared maximum was 2,546 samples; unused refinement capacity was not spent.

Four projected centroids were sampled on all three axes at steps `2^-10` and
`2^-11` mm. The complete 52-point batch was repeated exactly. The normalized
central-difference directions differ from the reported GPU normals by at most
0.0167 degrees; the two steps differ by at most 0.0230 degrees. Repeated results
are numerically identical. The observed gradient magnitudes differ from one,
which also cautions against treating the raw field residual as distance.

Four interior positions on each actual triangle independently retain errors
of 6.07–7.23 and 12.88–13.85 degrees, respectively. The opposing apices already
have field residuals below `4.3e-7`. Moving those vertices merely to reduce their
field residual is not supported by this evidence.

These are local empirical checks. Two finite-difference steps do not certify
derivatives, bound all WGSL arithmetic error, establish branch uniqueness or
prove scene-wide CPU/GPU equivalence. The calibration nevertheless makes a
multi-degree reference-normal error implausible at these measured locations.

The capture first reproduced all three E2 mesh buffers exactly. It used the
retained E2 release binary
`8d4fedfb7a49a767954f93200108cdbff2350f0f355755de50d988b4e8db555e`.
Sampling uses the prepared export scene; restoring a preview scene after a
render is not sufficient evidence that the sampling buffers still match.

## Rejected construction and checker corrections

Three independent competitors used separate worktrees pinned to the same E2
commit. After all three first-round handoffs, the coordinator acted explicitly
as the fourth reviewer; it authored no competing runtime candidate.

The first runtime attempt inserted projected interior vertices while retaining
feature boundaries. It improved one crease-adjacent child from approximately
13.06 to 3.08 degrees, but another child worsened to 37.17 degrees. The other
parent produced a 20.37-degree child. Repeated fixed-boundary fans eventually
reached 41.59 degrees. This candidate was rejected and its runtime edits were
restored. Checking only the child touching the feature would conceal the damage.

Two independently reproduced checker problems are also retained:

1. The flange's broad normal search crosses both faces of its convex rim. The
   intended local bracket lies well inside the existing 0.01 mm projection
   budget; the other observed bracket is about 0.025 mm away. Contextual
   association can use the local bracket while retaining the entire broad
   search. Multiple nearby brackets, budget-boundary uncertainty and invalid
   normals must still remain unresolved. This is empirical local association,
   not complete root discovery or a unique-sheet theorem.
2. The graph called “complete” only contains station-near candidate edges. An
   exactly connected folded-strip control fails because intervening edges are
   omitted. Failure to find a path in that subgraph cannot prove physical
   disconnection. Conversely, finding such a path does not establish all
   required source memberships, parameter direction or endpoints.

Replaying the bounded association correction on both E1 and E2 receipts resolves
the flange's local geometric check without changing the mesh. The loft normal
failure remains. The old metadata pass only checks nearby label presence and
must not be presented as a complete source-consistent ordered path.

The second round compares constrained retriangulation, feature-edge subdivision
and coordinated subdivision of incident triangles and their neighbors. Every
replacement face must be examined, including final float32 geometry, feature
intervals and intersections against retained geometry. A local improvement
cannot bypass the E2 full-model preservation gates.

The six predeclared native subdivision trials produced no complete repair.
Splitting one side's longest interior edge improved every replacement face and
preserved the measured embedding and chains. Splitting the other side improved
its target face but worsened a neighboring parent's sampled maximum from
5.231 to 13.734 degrees. Splitting both sides inherits that regression. The
identified feature edge and the coordinated five-edge closure could not be
projected while satisfying the existing source-membership compatibility checks;
those trials remained unsupported rather than bypassing the checks.

Existing-vertex diagonal flips were more promising but also incomplete. The
first quad's replacement faces both improve, with a four-point sampled maximum
of 1.846 degrees. On the other side, the crease-adjacent replacement improves to
2.146 degrees, but its companion reaches 7.016 degrees. The whole-patch test
therefore correctly fails the unchanged 5.869687-degree rule. These are internal
native full-scene checks, not new independent GPU measurements. A prepared GPU
follow-up has not been launched for these rejected two-quad proposals.

The existing planar sliver pass is not defective for rejecting these edits:
their quads are nonplanar and the original triangle qualities exceed its 0.02
threshold. The optional quality pass also requires recorded carrier ownership;
default feature fans do not supply those tags. Neither restriction may be
silently removed to make this particular housing pass. A further candidate must
give the larger connected replacement patch an explicit validation contract.

## Diagnostic integration before the production repair

The selected checker changes are now integrated: bounded-window association,
per-physical-edge incident errors, source-pinned memberships and their own
parameter charts/endpoints, and explicit scope for the station-only graph.
Incident centroid normals must also favor different reference sides; a bisector
tie stays ambiguous. This remains normal-pair evidence, not source identity.

At this intermediate stage, all 56 harness tests passed. `make build` passed
using the retained E2 version stamp, and the actual WASM hash remained exactly
the E2 hash above. Replaying the
integrated checker on both E1 and E2 meshes finds complete source-pinned parameter
paths, memberships and endpoints for both housing regions. The flange's sampled
geometry passes; the loft/chamfer station-5 geometry still fails. All four
intentional corruptions remain detected on each historical baseline; bridge
sample requests match the retained GPU coordinates exactly. These are saved-data
replays, not fresh exports or new GPU measurements.

The release campaign was deferred until a production repair existed. Passing
these harness and replay checks alone did not complete E3 geometry acceptance.
The third independent round compared fixed-boundary fan retriangulation, bounded neighboring flip
transactions and relocation of the existing free interior fan point.

## Third-round geometric evidence and a correspondence counterexample

The actual construction trace identifies a 12-face Compound fan (stratum 84)
and an 11-face LoftSide fan (stratum 6). Adding bounded observation events leaves
all five native working/final buffers unchanged. Exact integer bit records were
needed for the diagnostic join: the default JSON decimal parser changed five
recorded coordinates by one ULP. Production parsing and tolerances were not
changed to accommodate this diagnostic issue.

| Candidate | Result on its declared finite experiment | Remaining limitation |
| --- | --- | --- |
| A: fixed-boundary constrained triangulation | 23 faces become 19; sampled working/f32 geometry, topology and changed-versus-full-mesh intersection checks pass | Existing strict carrier validation rejects trim-chord samples; correct common-point chart association still exceeds the unchanged compatibility guard |
| B: coordinated fixed-vertex flips | Three flips change five triangle rows; two six-face neighborhoods pass their native normal/position checks; no new invalid faces, topology defects or affected-neighborhood intersections in actual working f64 or WASM f32 | Counterfactual experiment, not yet an implemented production selection policy |
| C: relocate existing fan centers | 66 bounded proposals; none satisfies the complete fan contract | Compound can improve compatible-site normals while retaining unsupported sites; LoftSide's best compatible-site error remains 10.2359 degrees |

The B source-derived experimental gate is 5.845111 degrees: half the smallest
of six compatible source-chart normal jumps, with the existing two-degree floor.
It is slightly stricter than the retained 5.869687-degree GPU section allowance.
Those finite chart samples are not a continuous normal-cone bound.

One shared GPU capture then evaluated 23 original faces, 19 A faces and five
changed B faces at ten interior positions each. It used 9,401 samples, below the
declared 143,350 maximum, and first reproduced the E2 export buffers exactly.
The three classes of barycentric probes remain separate: four core positions,
three additional interior positions and three positions near triangle edges.
Every line supplies a bracket eligible under the bounded empirical association
rule. The changed B faces' 50 raw GPU-normal angles are at most 3.349355 degrees,
with displacement upper bounds at most 0.00228836 mm. A's core/interior angles
are at most 3.331072 degrees, but one near-boundary raw angle is 10.858260 degrees.

That A observation exposes a reference-association limitation. At the actual
zero-offset sample the GPU normal agrees with Compound 84; at the retained
root it agrees with LoftSide 6/21. Native attribution differs by only 0.00532
and 0.01250 degrees from the respective GPU normals. Projecting that root onto
the Compound carrier leaves its exposed domain, whereas the LoftSide projection
moves only approximately `5.11e-7` mm to a zero of the full field. The normal
line has crossed surface support. A unique nearby forward crossing therefore
does **not** establish the corresponding smooth side for the mesh facet.

This matters mathematically near a sharp feature. A straight feature chord can
be within the positional budget while leaving a thin strip on the opposite
side of the true crease. Across that strip, the nearest full-field normal can
jump even when each one-sided patch is well approximated. The raw 10.858-degree
angle is retained as an unsupported side correspondence, neither an established
Compound facet-angle defect nor a successful normal check. A's additional
source-interval validation also remains unsupported: mapping a common geometric
reference through the other bounded chart projection differs by approximately
0.000129 and 0.000169 mm, above the unchanged `1e-5` compatibility guard. Those
projection discrepancies do not prove that the underlying curves are distinct.

The integrated checker consequently treats incompatible centroid support pairs
as incomplete, retains raw angles separately, and still lets direct failures
of geometric contrast or the identified physical edge fail acceptance. An
unrelated ambiguous nearby edge cannot hide the original source-identified
housing failure. All 56 harness tests pass after this correction.

With fresh GPU centroid references, both counterfactual meshes pass all nine
supported loft sections and the flange sections, including the existing
membership/path/endpoint and corruption checks. The original loft section
still fails. This demonstrates a bounded repair mechanism; it does not select
or validate a production implementation, solve the remaining chart-association
problem, or establish uniform normal accuracy inside every feature-error strip.

## Selected implementation and atomic transaction scope

The fresh fourth reviewer selected B's fixed-vertex mechanism for implementation,
subject to actual generic discovery/descent and the full production gates. Its
fixture search established existence, not the behavior of a greedy runtime.
The source-gate prototype also omitted full-tree exposure checks; the production
implementation adds them without selecting a favorable alias or changing budgets.

A further actual-mesh check showed why the two sides must publish together.
The original protected-edge dihedral is 7.178198 degrees. Repairing only the
first side reduces it to 1.040194 degrees; only the second gives 4.991643 degrees.
Both violate the retained-contrast requirement. Repairing both gives 11.129647
degrees. Fixed feature coordinates and individually improved faces do not by
themselves preserve a sharp crease.

The independently reviewed amendment therefore defines one transaction over
both incident-side neighborhoods. Each keeps its original cap of eight faces,
ten existing vertices, three flips and 192 cached scores. The union caps are
sixteen faces/eighteen vertices and six flips/384 scores. Side contracts remain
separate; their descents may progress privately while the combined maximum
temporarily stays unchanged. Every final face, affected protected pair,
exterior incident partner, topology check and working/f32 intersection check
must pass before either side publishes. Failure or cancellation of the second
side discards both drafts. These derived caps were fixed before the generic
paired-function regression.

## Integrated implementation and release validation

The selected implementation now runs in shared final assembly on serial and
worker paths. It preserves vertices and feature records, stages both sides
privately, and publishes only after the complete paired transaction passes its
guards. Source aliases remain mandatory on their own physical edges. Smooth
supports covering the entire original window are frozen before candidate
scoring; requiring every edge-local alias to extend across unrelated faces was
disproved by the retained loft companion. This is a sampled compatibility rule,
not a proof of unique carrier ownership or uniform normal accuracy.

The `normalRepair` validation record separates accepted, unsupported, rejected,
exhausted and cancelled work, with score/flip limits and observation counts.
Unresolved normal work keeps validation incomplete independently of positional
budgets and triangle validity.

All 275 native kernel tests passed on the reviewed nine-file production
candidate. The complete native housing export finished in 53.756 seconds with
141,930 triangles. Eight paired transactions made 15 flips, changing 25 triangle
rows. All working vertex bytes, referenced vertex records and own-chart feature
records are preserved, accounting for final first-use vertex compaction. The
affected-region audit found zero new invalid faces, topology defects or
intersection-pair identities in working and rounded coordinates. The target
crease's two final faces match the independently GPU-tested candidate faces;
its geometric dihedral is 11.129647 degrees. These native observations do not
substitute for the actual release-WASM/GPU checks.

The integrated application/WASM build passed. The initial full WASM suite passed
50 of 51 tests. The fine-hidden raw-worker control failed because
`normalRepair.chartObservations` was 1,320 versus the serial count of 1,308;
all other reported validation fields matched. That assertion precedes geometry
comparison, so the initial run alone does **not** establish geometry parity.
An independent follow-up established byte-identical vertex, triangle and
feature buffers across 1/2/4/8 workers and both merge orders; canonical geometry,
feature intervals and cell decisions also match. Only chart-observation work
counts vary. A separate arithmetic check found that reversing interval endpoints
can change sampled parameters by one or two ULPs. The reviewed correction now
samples each own-chart interval in ascending numeric order, preserves stored
endpoint bits exactly and keeps their physical vertex association. Same-curve
aliases also have stable observation order. The unchanged worker test passes
after rebuilding, including its exact validation comparison: no counter
exception was added. The bracket junction and housing bore/overlap controls passed,
including their axis rotations and recovered reverse-worker outputs. Recovery
does not establish raw-worker reconstruction.

The current integrated checker/report suite passes 57 tests. The separate new
full-source WASM housing crease regression passes in 56.750 seconds. Replaying
its exact geometric assertions on saved E2/E3 meshes fails the original loft
crease and passes the candidate; both preserve the flange control. These
assertions use retained GPU section references, not newly sampled candidate
centroid normals. The final campaign and transformed/collateral checks below
provide the remaining release evidence.

The corrected release freeze passes all 277 native tests and `make build`.
Its WASM SHA-256 is
`d86a0d92cdd046633deeb81b8f3923d58564a1fea3f25253162d51f379f17925`.
The full 52-test WASM suite passes against this binary; it includes the new
housing crease fixture as well as both `.mts` and `.mjs` fixture families.
Earlier full-model results above remain explicitly pre-amendment; the following
fresh output comparisons establish which geometry evidence applies.

Fresh corrected-binary snapshots now match all three pre-amendment buffers
byte-for-byte for all four original available models, both axis-rotated controls
and both recovered reverse-worker controls. The exact-identity receipt therefore
transfers their saved f32 geometry/feature audits to this release binary. It does
not transfer timings or establish new native working-f64 results. Only chart
observation counts change for knob and Mess 2; their semantic normal-repair
outcomes are unchanged.

All five changed faces at the target crease also match the retained independent
GPU experiment in exact oriented f32 coordinates. Their 50 ten-site observations
therefore apply to the actual production faces. The full scene is identical;
all recorded application/build sources match except the reviewed addition of
diagnostic type declarations in the export interface. This is explicit reuse
of measured evidence, not a newly executed GPU batch. Fresh campaign centroid
and regional checks are recorded below as a separate requirement.

Pre-amendment shipped-f32 collateral checks preserve full vertex-record and
feature-interval multisets on all four available original models. Exact
parameter bits and multiplicities are retained; edge reversal swaps its two
parameters together. Housing's unique full vertex records establish a complete
compaction bijection. Duplicate records in bracket, knob and Mess 2 prevent
that stronger identity conclusion from these raw buffers alone; the audit does
not weld them or silently treat coincident vertices as identical.

Bidirectional affected-neighborhood audits find zero new malformed-face or
intersection identities on all four models. Knob retains 4,582 invalid f32
faces and two nonmanifold vertices; Mess 2 retains 17,953 invalid faces, five
nonmanifold edges and 41 nonmanifold vertices. These existing failures remain
open. These collateral audits concern shipped f32 coordinates; only housing
also has a separate full native working-f64 comparison.

The final binary also completes the full housing's predeclared non-axis rotation
and fixed-grid translation. Their 170 transferred bore witnesses have zero
failures, with worst displacement bounds of 0.003450887 and 0.003329020 mm,
respectively. These are affine-transferred original GPU observations, not fresh
transformed GPU samples. The non-axis and shifted outputs contain 150,934 and
140,030 triangles. Both preserve full vertex and own-chart feature-record
multisets against their corresponding E2 outputs.

Full shipped-coordinate intersection audits of the two axis controls and these
two additional variants find zero new intersection identities, zero invalid
faces and no indexed topology defects. Existing full-model contact counts remain
813 for rotated bracket, 19 for rotated housing, 160 for non-axis housing and
70 for shifted housing. None is asserted to be globally intersection-free.

## Final five-model campaign and bounded exit

`make acceptance-tests` completed with the frozen release binary. All four
produced browser meshes match the final WASM fixtures byte-for-byte, including
feature records; their complete `normalRepair` records also agree. The report
retains all images, diagnostic dimensions, uncertainty and failures.

| Original model | Result | Triangles | Invalid f32 faces | Browser export seconds |
| --- | --- | ---: | ---: | ---: |
| Bracket | FAIL | 130,820 | 0 | 38.139 |
| Housing | INCOMPLETE | 141,922 | 0 | 53.621 |
| Knob | FAIL | 249,246 | 4,582 | 128.689 |
| Mess 1 | TIMEOUT | Unavailable | Unavailable | 180-second limit |
| Mess 2 | FAIL | 341,864 | 17,953 | 54.937 |

All nine loft/chamfer and nine flange sections resolve and pass their separate
position, face-normal, retained contrast, membership, ordered-path and endpoint
checks. The 24 station-edge observations cover eight distinct physical edges
(six loft and two flange); every identified observation has a passing centroid
normal and support-pair check. Regional triangle sampling remains stride 1.
At the original failed loft station, the two centroid-normal errors fall from
6.488312/13.055455 degrees to 0.231305/1.417859 degrees under the unchanged
5.869687-degree allowance. The physical dihedral is 11.129647 degrees.

All 170 original and 626 shifted main-bore witnesses remain within 0.01 mm;
worst upper bounds are 0.003278001 and 0.003317265 mm. All 170 branch-bore
witnesses also pass. Both bracket and housing corruption checks detect the
intended damage. No mesh or zero defect count is inferred from Mess 1's timeout.

This closes the bounded E3 crease exit. Housing remains incomplete because
other regional projection/reference and construction obligations are unresolved;
the finite checks do not establish global reconstruction or continuous normal
accuracy. Bracket, knob and Mess 2 retain their prior failures. Export times
above are single observations, not a performance comparison. E4 construction,
E5 feature/raw-worker and E6 resource/performance exits remain open.

## Evidence and execution limits

- [E2 five-model acceptance report](../../.testresults/sdf-meshing/2026-10-24T11-16-12-570Z/report.md)
- [Final E3 five-model acceptance report](../../.testresults/sdf-meshing/2026-10-24T16-17-21-370Z/report.md)
- [Fresh GPU target exit, with observation counts distinguished from unique edges](../../.testresults/sfcc-critical-repairs/e3-housing-creases/live-gpu-target-exit-freeze3-v2.json)
- [Final browser/WASM output and diagnostic identity](../../.testresults/sfcc-critical-repairs/e3-housing-creases/final-campaign-identity-freeze3.json)
- [E3 frozen baseline](../../.testresults/sfcc-critical-repairs/e3-housing-creases/baseline.json)
- [First-round consensus](../../.testresults/sfcc-critical-repairs/e3-housing-creases/round1-consensus/decision.json)
- [Independent third-round consensus](../../.testresults/sfcc-critical-repairs/e3-housing-creases/round3-consensus/decision.md)
- [Atomic paired-neighborhood amendment](../../.testresults/sfcc-critical-repairs/e3-housing-creases/round3-consensus/atomic-pair-amendment.md)
- [Production implementation review](../../.testresults/sfcc-critical-repairs/e3-housing-creases/production-integration/consensus.md)
- [Canonical chart sampling review](../../.testresults/sfcc-critical-repairs/e3-housing-creases/production-freeze3/sfcc-e3-chart-amendment-consensus.md)
- [Fourth-agent final release consensus](../../.testresults/sfcc-critical-repairs/e3-housing-creases/production-freeze3/release-consensus.md)
- [Corrected release binary and fixture inventory](../../.testresults/sfcc-critical-repairs/e3-housing-creases/release-wasm-freeze3/manifest.json)
- [Exact output identity across the chart correction](../../.testresults/sfcc-critical-repairs/e3-housing-creases/release-freeze2-to-freeze3-identity.json)
- [Exact production correspondence to the ten-site GPU stencil](../../.testresults/sfcc-critical-repairs/e3-housing-creases/production-gpu-stencil-correspondence-freeze3.json)
- [Initial worker failure and independent buffer comparison](../../.testresults/sfcc-critical-repairs/e3-housing-creases/release-wasm-worker-diagnostic/manifest.json)
- [Pre-amendment shipped-geometry audits](../../.testresults/sfcc-critical-repairs/e3-housing-creases/release-wasm-audits-freeze2/manifest.json)
- [Pre-amendment exact vertex and feature preservation](../../.testresults/sfcc-critical-repairs/e3-housing-creases/release-wasm-feature-preservation-freeze2.json)
- [Final transformed exports](../../.testresults/sfcc-critical-repairs/e3-housing-creases/transform-freeze3/manifest.json)
- [Final transformed geometry and feature audits](../../.testresults/sfcc-critical-repairs/e3-housing-creases/transform-audits-freeze3/manifest.json)
- [Old-fails/new-passes standalone geometry replay](../../.testresults/sfcc-critical-repairs/e3-housing-creases/release-saved-normal-repair-replay.json)
- [Live GPU capture manifest](../../.testresults/sfcc-critical-repairs/e3-housing-creases/gpu-stencil-ready-job/manifest.json)
- [Actual face comparisons](../../.testresults/sfcc-critical-repairs/e3-housing-creases/gpu-stencil-ready-job/face-comparisons.json)
- [Integrated checker replay](../../.testresults/sfcc-critical-repairs/e3-housing-creases/integrated-checker-replay-v2.json)
- [Integrated corruption replay](../../.testresults/sfcc-critical-repairs/e3-housing-creases/integrated-corruption-replay-v2.json)
- [Third-round GPU comparison, with correspondence limits](../../.testresults/sfcc-critical-repairs/e3-housing-creases/round3-gpu-comparison-summary.json)
- [Counterfactual supported-crease replay](../../.testresults/sfcc-critical-repairs/e3-housing-creases/round3-counterfactual-crease-replay-v2.json)
- [Saved-data checker replay](../../.testresults/sfcc-critical-repairs/e3-housing-creases/candidate-c-replay-v2.json)
- [Omitted-connector counterexample](../../.testresults/sfcc-critical-repairs/e3-housing-creases/candidate-c-graph-gap.json)

Three unsuccessful GPU startup attempts produced zero samples and are preserved
as infrastructure failures. The successful owned job waited for the agent
browser's readiness handshake. A native trace retry corrected a coordinator
probe-input serialization error; all five working/final mesh buffers matched
the first trace exactly. Neither event is evidence of a geometry defect.

One standalone competitor calibration export initially decoded raw WASM vertices
with the wrong stride. Raw WASM vertices use eight float32 values per record;
native working positions use three float64 values. The erroneous export is
retained with an erratum. Root's live face comparison and the independent
MeshQuery attribution used the correct 32-byte stride. Scalar-gradient versus
GPU-normal calibration does not depend on mesh decoding.

The bounded E3 repair and release gates above are complete. Overall mesh
acceptance is not passed. E4–E6 remain pending in the ordered
[execution plan](../plans/sfcc-critical-repairs.md#execution-and-review).
