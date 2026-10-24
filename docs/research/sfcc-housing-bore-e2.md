# E2: housing main-bore accuracy

Status: **E2 implemented and its bounded bore-repair exit validated**. The first
candidate was rejected for new intersections; the guarded follow-up passes the
declared original, transformed and fresh GPU gates. Overall mesh acceptance
remains failed. E3–E6 remain open.
Baseline commit: `4e9ec72a1ff0ec06923d9782b4c524a91770f406`.

## Failure and first responsible stage

The complete transformed Manim housing misses 92 of 170 retained GPU bore
witnesses. The worst observed surface-to-mesh distance is 0.0132767071 mm,
before its approximately 0.0000035753 mm bracket/position allowance, against
the unchanged 0.01 mm surface budget. Vertex field residuals do not expose the
failure: the failing observations include 16 edge midpoints and eight triangle
interiors.

All three independent investigations identify inadequate interior approximation.
The baseline native trace has no dropped records. Cell `(6,39,19,31)` takes
`smooth_pass` and ordinary `cell-loops` triangulation. Its two working triangles
already have a transverse cylindrical chord deviation of 0.0132959432 mm.
Rounding those triangles reproduces captured WASM triangles 92223/92224;
the largest vertex displacement during rounding is 2.0710654e-7 mm. This is a
local geometry/provenance match, not a claim that the complete native and WASM
meshes agree. It locates this defect before late assembly edits and serialization.

The cell's angular criterion does not establish an absolute distance budget:
at fixed subtended angle, circular chord sagitta grows with radius. The later
surface-refinement pass receives the **0.02 mm feature budget**, and its 0.75
trigger is consequently 0.015. The demonstrated error escapes despite the
separate requested **0.01 mm surface budget**.

## Three candidates and fourth-party decision

The candidates used isolated checkouts of the same baseline and received the
same original scene, raw mesh, strict GPU roots and native provenance trace.
The coordinator scheduled all validation jobs sequentially. After all three
handoffs completed, the coordinator acted as reviewer D; the platform could
not allocate a fresh thread, and the coordinator authored no competing patch.

- A separated the two budgets, using their minimum for sampled surface
  refinement to preserve historically stricter chord settings. It retained the
  original feature tolerance for protected-curve compatibility and supplied a
  full-scene construction regression plus all 170 GPU witnesses.
- B independently found the same miswiring and used the surface budget alone.
  Its useful adversarial control protects edges without inventing a curve:
  failed refinement must retain the patch and report unresolved obligations.
- C independently found the same miswiring and supplied a finite-cuboid Round
  blend where a small field residual coexists with a geometric miss exceeding
  0.01 mm. This prevents a false general distance guarantee.

The selected runtime change is A's compatibility-preserving separation, with
B's negative control and C's mathematical calibration. Pure surface-budget
selection was rejected because it could weaken configurations whose feature
budget was already tighter. Duplicate expensive full-housing exports were
avoided by extending the existing original/rotated/worker regression.

Candidate evidence and frozen patches are retained in
[the E2 packet](../../.testresults/sfcc-critical-repairs/e2-housing-bore/).
Two early synthetic controls in B/C incorrectly treated Round of duplicate
negative cylinder fields as the original distance; Round scales that field by
sqrt(2). They were corrected with an inactive far operand before adoption.
An initial C test run reused a stale B executable through a shared Cargo target;
it is explicitly invalid evidence. Isolated candidate targets subsequently ran
the matching test binaries. The integrated candidate uses a separate target.

## Initial bounded change and obligations

The first candidate made both assembly routes pass surface and feature
tolerances separately. Its sampled surface triggers, projection stopping and
final unresolved residual counts used the smaller tolerance. Curve compatibility,
adjacent-stratum domains and coincident membership checks retained the feature
tolerance. The later guarded follow-up below supersedes this unsafe first
refinement policy. Global octree depth, sources, export cubes and quality
settings remain unchanged.

The existing refiner remains bounded by eight rounds and its geometry budget.
It still operates only on trees containing blends. Its field samples are an
internal consistency heuristic, not independent evidence or a surface-distance
certificate. The Round calibration establishes an empty radius-0.011 ball
around a point whose field magnitude is below 0.002; its finite-box premises and
algebra are checked using ordinary f64 arithmetic with a 1e-4 margin. It is not
an outward-rounded runtime enclosure. No new CPU scene reference is introduced.

The retained GPU fixture includes the complete scene, original strict brackets,
numerical allowances, source hash and selected failing patch. The actual YAML's
trimmed source hash must match. All 170 roots are checked against actual final
WASM geometry in the original and reversed-worker outputs, and transferred by
the existing exact rigid rotation `[-y,x,z]` for the rotated model. The rotated
check transfers a geometric witness; it is not a fresh transformed GPU capture.
Receipts preserve every distance and allowance before validation assertions.

A fresh, predeclared GPU grid tests between original bore samples:
`center=[5.5,0.0125,0.0125]`, `half=0.3`, `spacing=0.025` mm. All four original
housing regions remain. Every original and new witness must meet 0.01 mm
including its allowance. The bracket junction, housing memberships, zero exact
invalid bracket/housing faces, topology, feature constraints and collateral
model defects remain independent release gates.

## First integrated candidate: bore improvement, rejected construction

The candidate passed 250 native kernel tests, 38 acceptance-harness tests and
`make build`. Release WASM SHA-256:
`40336da3394ad903d97d9bf3cb6b782ec9dfb645fd60329a314043f6aab12c1e`.
All three existing full-housing WASM regressions passed their explicit gates:

| Output | Triangles | Exact invalid faces | Worst retained bore distance including allowance | Other obligations |
| --- | ---: | ---: | ---: | --- |
| Original | 149,984 | 0 | 0.0032780012 mm | All compiled chains pass; eleven repaired spans preserved |
| Reversed worker merge | 149,984 | 0 | 0.0032780012 mm | Three buffers identical to serial; **serial recovery still used** |
| Existing rigid axis rotation | 151,256 | 0 | 0.0032872599 mm | Eleven spans preserved; known rotated chain failures remain |

Every row checks all 170 retained roots; topology remains one component with
Euler characteristic -8. These results alone were insufficient. The affected
neighborhood audit checks new/removed geometric triangles, surviving incident
faces and multiply labeled feature edges against the complete final mesh. It
found **49 intersecting pairs**, versus **four** in the corresponding baseline
neighborhood. Comparing oriented geometric pair identities reveals **47 new
pairs and two removed old pairs**. The candidate therefore fails the release
gate despite better bore accuracy and valid connectivity.

Both initial audit inputs are final f32 meshes; their `working` column cannot
establish the construction stage. A subsequent native trace retained working
coordinates with no dropped records. All 47 new WASM pairs match rounded native
triangle geometry. The native audit finds **12 of those pairs intersecting in
working f64**, while **35 intersect only after f32 conversion**. C independently
confirmed strict edge-interior penetration using rational arithmetic for 12
pairs. The first penetrated face is unchanged from the baseline; its crossing
partner consists entirely of newly generated vertices. This directly implicates
projected refinement geometry rather than just a change of triangle IDs.
The baseline's four f32 intersections remain recorded limitations; they are
not cleared by rejecting this candidate.

The failed candidate, full meshes, reversed baseline audit and pair identities
are retained in the E2 packet. Fresh GPU and collateral release work is paused
while A/B/C independently investigate safe construction for the additional
refinement. A new consensus and integrated release validation are required.
E3–E6 remain open; this work establishes no general multi-sheet guarantee.

## Additional transformed baselines

Before obtaining results, the coordinator declared a rotation about axis
`[1,2,3]`, represented by quaternion `(100,1,2,3)/sqrt(10014)` about the original
cube center, and a translation `[0.0625,-0.03125,0.015625]` mm while keeping the
sampling cube fixed. Both use the complete original housing. The rotated saved
padded bounds exceed the nominal 44.9 mm cube but remain within the unchanged
48.9 mm padded and jittered kernel domain; the runner checks this explicitly.

The pinned pre-repair source was rebuilt in an isolated checkout. Its original
control reproduces all three E1 mesh buffers exactly before any transformed
comparison is admitted. The fresh baseline binary is
`bacb9807932a21afeaaa3c0fd3129035fa4f8c92cf923a6c0b212e5f7b1ce51e`;
this is a separately recorded rebuild, not the original E1 binary.

| Pre-repair full housing | Triangles | Invalid faces | Failing transferred bore witnesses | Whole-mesh intersecting pairs |
| --- | ---: | ---: | ---: | ---: |
| Original control | 125,954 | 0 | 92 | 7 |
| Rotation about `[1,2,3]` | 137,196 | 0 | 0 | 166 |
| Fixed-grid translation | 124,384 | 0 | 78 | 70 |

All have one component and Euler characteristic -8. Both new transformed cases
also have existing feature-chain failures. The intersection figures test every
valid triangle, unlike the earlier affected-neighborhood figures of four and
49. These different audit scopes must not be conflated. Transferred original
GPU witnesses test rigid-transform behavior; they are not fresh transformed GPU
observations or certificates of GPU/native transform equivalence. Full receipts
and coordinate allowances are in `transform-baseline/` within the E2 packet.

## Follow-up consensus: guard additional refinement

Three independent follow-ups completed before the coordinator's second decision.
A proposed whole-round provisional subdivision with conforming rollback of
unsafe shared-edge proposals. B retained the exact earlier feature-budget pass,
then proposed tighter surface refinement as checked, atomic edge-star edits.
C supplied independent penetration evidence, a full-original-housing regression
and the transaction requirements; it did not claim an untested runtime repair.

| Preliminary native result | A: round rollback | B: guarded additional edge stars |
| --- | ---: | ---: |
| Focused tests passed | 21 | 19 |
| Full housing triangles | 150,016 | 141,930 |
| Retained bore failures, out of 170 | 0 | 0 |
| Worst bound including allowance | 0.0032780012 mm | 0.0032780012 mm |
| Exact invalid faces | 0 | 0 |
| New intersection pairs versus native baseline, f64/f32 | 0 / 0 | 0 / 0 |

Both retain the exact seven baseline pair identities and valid indexed topology.
These are native comparisons, not release-WASM results. B was selected because
it preserves the earlier construction policy, allocates vertices only after
acceptance and uses fewer triangles at the same measured bore error. This is
not a speed claim. C's full-housing regression was run on the rejected candidate
and failed with all 45 new negative-base pairs; that failure is retained as the
negative control. Its two regressions are added to the selected implementation.

For each additional split, B validates every incident triangle's replacement
children in f64 and f32, including orientation and exact intersection predicates.
Checks include siblings, all retained nearby faces and children accepted earlier
in the same sweep. Only then are the shared vertex, curve intervals and patch
ownership committed. A rejected proposal leaves the old star intact. A nearby
invalid old face is unsupported, not silently ignored. The original geometry
cap is shared by the legacy and additional passes; the latter has at most eight
sweeps. Unsafe or unfinished approximation remains explicitly unresolved.

This establishes a conditional no-new-intersection rule for the **additional
edits**, under the existing predicates. The legacy pass remains unchanged and
can retain existing malformed or intersecting geometry. No assertion of global
embedding, sheet ownership or distance certification follows. Full release-WASM,
fresh shifted GPU coverage, transformed cases and collateral gates remain pending.

The follow-up read-only reviews found no missed retained-face or same-sweep
intersection path. They identified an ownership limitation: children inherit a
parent's analytical patch ID, although full-field midpoint projection does not
by itself establish continued membership of that carrier and its trimmed domain.
The existing later analytical-edit validators check their proposed geometry
against the carrier, but inherited metadata is not a newly established ownership
certificate. No captured housing ownership counterexample has been demonstrated.
This remains explicit for the incident-patch/feature work; embedding safety must
not be reported as proof of carrier identity. Arbitrary open boundary stars also
have no fixed geometric-boundary guarantee from this edge-split operation.

## Guarded release validation

The integrated follow-up passed **254 native tests** and `make build`. Its
release WASM SHA-256 is
`8d4fedfb7a49a767954f93200108cdbff2350f0f355755de50d988b4e8db555e`.
The actual-WASM fixture sweep discovered both `.mts` and `.mjs` tests: 50 of
51 passed initially. The remaining failure was an obsolete depth-10 hard-CSG
lens expectation, independently reproduced on the pinned pre-E2 binary. Both
binaries have byte-identical vertex, triangle and feature buffers: two components,
zero invalid triangles and the same 1,017 unresolved cells. Correcting the old
four-component/twelve-invalid-face expectations passed the targeted rerun.
The 168-cell near-tangent warning and unresolved discovery remain asserted.
This test correction changes no runtime code or geometric acceptance threshold.

| Original full model | Before triangles | Guarded WASM triangles | Invalid faces, before / after | New affected-region intersection pairs |
| --- | ---: | ---: | ---: | ---: |
| Bracket | 108,530 | 130,820 | 0 / 0 | 0 |
| Housing | 125,954 | 141,922 | 0 / 0 | 0 |
| Knob | 185,928 | 249,246 | 4,582 / 4,582 | 0 |
| Mess 2 | 283,524 | 341,864 | 17,953 / 17,953 | 0 |

Malformed-face comparisons retain exact geometric identities and multiplicity;
no new or removed malformed faces are hidden behind those equal totals. The
affected-region intersection pairs are 168→168 for bracket, 4→4 for housing,
27,624→27,624 for knob and 39,336→39,162 for Mess 2. All 174 changed Mess 2
pairs are removals. Invalid faces are excluded from intersection predicates and
remain failures in their separate gate. Existing indexed topology and every
feature-chain issue identity are unchanged, including the two nonmanifold knob
vertices and Mess 2's five nonmanifold edges and 41 nonmanifold vertices.

Original/rotated bracket junction checks and all eleven housing overlap spans
pass. Reversed-worker bracket and housing results are byte-identical to their
serial outputs and still report serial recovery. The transformed matrix uses
fresh pre-repair baselines and actual candidate WASM:

| Housing variant | Guarded triangles | Bore failures, before / after | Worst candidate bound | Whole-mesh pairs, before / after |
| --- | ---: | ---: | ---: | ---: |
| Existing axis rotation | 143,390 | 78 / 0 | 0.003287260 mm | 19 / 19 |
| Rotation about `[1,2,3]` | 150,934 | 0 / 0 | 0.003450887 mm | 166 / 160 |
| Fixed-grid translation | 140,030 | 78 / 0 | 0.003329020 mm | 70 / 70 |

All transformed cases retain zero invalid faces and their original indexed
topology. There are no new geometric intersection-pair identities or feature
issues; the oblique case removes six old pairs. The rotated bracket similarly
retains its 813 pre-existing whole-mesh pairs, with zero new pairs and no lost
junction obligation. None of these counts describes globally accepted geometry.

The [fresh targeted GPU report](../../.testresults/sdf-meshing/2026-10-24T11-11-04-157Z/report.md)
uses the same three mesh buffers as the focused housing WASM test. All four
original GPU reference sets are exactly unchanged. Replaying the fresh references
against both old and new meshes gives:

| Independent bore grid | GPU roots | Old failures | Guarded failures | Worst guarded distance plus allowance |
| --- | ---: | ---: | ---: | ---: |
| Original | 170 | 92 | 0 | 0.003278001 mm |
| Predeclared shifted, denser grid | 626 | 351 | 0 | 0.003317265 mm |

The original bore's 24 mesh-to-GPU field failures and 24 unresolved projection
budgets fall to zero; the shifted grid also has none. Both budgets remain
0.01 mm. All three housing corruption controls are detected. The existing
loft/chamfer station-5 normal failure, incomplete ordered crease path checks and
ambiguous flange references remain unchanged: **housing still fails overall**.
The fresh grid is a bounded empirical check, not a global approximation bound.

The [final five-model production campaign](../../.testresults/sdf-meshing/2026-10-24T11-16-12-570Z/report.md)
completed successfully through `make acceptance-tests`. All four available
meshes' vertex, triangle and feature buffers are byte-identical to the focused
WASM receipts used for the geometry audits. All four deliberate corruption
checks are detected and every requested image/compare operation completed.
Bracket, housing, knob and Mess 2 remain **FAIL**; Mess 1 remains **TIMEOUT** at
180 seconds. No missing mesh is assigned zero defects.

After capture, one report sentence was clarified to avoid saying the entire
discovery grid was unchanged when E2 adds a region. Both original reports are
preserved beside their updated versions. Wording receipts verify an exact
sentence-only replacement; manifests, results, images, metrics and statuses are
unchanged. All 38 acceptance-harness tests pass after that prose correction.

Timing samples are retained but support no performance claim; increased triangle
counts are the cost of applying the previously omitted surface-accuracy request.
The next package is E3's incident-crease/reference work. Existing intersections,
feature failures, unsupported coverage and raw-worker recovery remain separate
open obligations, not successes inferred from the bore measurements.
