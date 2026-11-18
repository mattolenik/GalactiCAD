# Compatible ideal-feature adoption on the complete incident neighborhood

**The three consumed curve-49 edges now map to their ideal physical arcs under
one continuous source correspondence on the captured 44-triangle neighborhood.**
All four targets (647, 40, 1117, 1116) are interior to that neighborhood. Simultaneous
transport fixes its outer boundary and preserves every intermediate triangle's
orientation. The exported correspondence error is at most
**0.0012883081002970905 mm**, below the unchanged **0.01 mm** limit.

This is a proof about the existing mesh; its coordinates are unchanged. It closes
the local adoption constraint from [round 38](../sfcc-span-completeness/README.md).
It does not establish global cell ownership, complete outside coverage or production
acceptance. **Publication remains blocked.**

[Independent consensus](decision.md) · [Runtime preservation](runtime-review.json) ·
[Results](summary.json) · [Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## Bind the actual incident consumers

The original FaceRecords identify the two consumers of endpoint 1116's original
Z face [2, 3464534, 2]. Replaying the second consumer adds ten triangles. The complete
emitted neighborhood is:

| Original cell | Triangles | Fans |
| --- | ---: | ---: |
| [7, 25, 58, 86] | 23 | 4 |
| [7, 26, 58, 86] | 11 | 2 |
| [7, 26, 58, 87] | 10 | 2 |
| Total | 44 | 8 |

There are 31 used vertices. Exact point bits, triangle order, source identities,
original face/pin records and raw fan options bind the source proof to this runtime
capture. Shared keyed identities weld only when their point bits agree. Coordinate
coincidence does not merge unkeyed points. The working and f32 projected domains
are checked embedded disks, including vertex links, oriented boundary, adjacency,
contact exclusion and nonzero orientation. Both previously outer nodes 647/1116
are interior here; all incident emitted triangles are included.

The initial capture refused because it equated discrete face ownership with exact
closed-box containment of the retained floating point. Endpoint 1116's Z exceeds
the represented face plane by approximately 1.945e-13 mm. Its two original owners
are still exact discrete facts. The corrected capture uses original FaceRecords
and integer leaf sides/extents for ownership, then separately bounds the point's
L1 distance to the original face rectangle by **1.9451107391432748e-13 mm**, below
the original **3.796655370190979e-7 mm** allowance. Raw closed-box consumers must be
a subset of the discrete owners. No box is enlarged and exact geometric face
membership of the retained point is not asserted. The initial
[refusal](Capture/incident-refusal.json) remains preserved.

The inventory would expand the original component to 207 cells/1042 faces, within
the original 256/1536 limits. This is an inventory and separate replay, **not a
successful 207-cell transaction**. The new cell has five validated generated queries
and a separate 2117-charge observational ledger: 64 setup +2048 reserved +5 validation.
Unused reservation is not refunded.

## Make the source proof more precise without raising its limits

The existing common-X-slab argument passed all 34 triangles from the first two
cells in 122 checks. With all 44 triangles it exhausted the unchanged 128-check cap:
79 accepted pieces, 14 pending, with finite native-side restrictions still unresolved.
That [failure](Expanded-attempt/adoption-C.json) is not partial acceptance.

The selected change bounds X separately for each original triangle. If its affine
mesh height is m(q), q=(Y,Z), and the unchanged tolerance is tau=0.01, its fixed slab
is [min(vertexX)-tau, max(vertexX)+tau]. All descendants retain that original slab.
There is still **one global 128-attempt counter and depth 12 limit**, not one budget
per triangle.

The existing interval source argument proves a unique full-source root in that
slab, with displacement at most tau from m(q). Every such slab contains the
protected fiber [m(q)-tau,m(q)+tau]. On a shared edge both triangles have exactly
the same m(q), so both roots lie in this common fiber, and uniqueness identifies
them. Their continuous graphs therefore glue. This requires the independently
checked exact continuous mesh graph and triangle-bit/order binding.

The result is unique within these protected fibers; it does not claim uniqueness
in the entire union X hull, nor global single-sheet reconstruction.

| Source proof | Checks | Accepted pieces | Result |
| --- | ---: | ---: | --- |
| Common slab, 34 triangles | 122 /128 | 78 | Pass |
| Common slab, 44 triangles | 128 /128 | 79 | Refusal; unresolved coverage |
| Original-triangle slabs, 44 triangles | 108 /128 | 76 | Pass |

The uniform source displacement bound is 0.0012877874623095722 mm. The selected
composition makes exactly one fresh source call and preserves the old common-slab
API and controls. It separately reruns the existing physical/generated span proof
with the same source: 32 pieces and 13 own queries, with its own 64→77 ledger. These
are different obligations and neither resets the other's budget.

## Transport the correspondence and identify the whole consumed arcs

Let M be the unchanged working mesh graph over its projected disk D, and Phi its
continuous source-root graph. Fresh physical span certificates supply enclosed
ideal targets for 647, 40, 1117, 1116; midpoints are never substituted as exact targets.
Move their projected coordinates simultaneously and extend affinely on each
triangle, fixing all other vertices. Call this map T.

Interval determinants remain strictly positive throughout every intermediate
motion. The fixed simple boundary has winding number one inside and zero outside;
internal edge contributions cancel and every triangle contributes positive
multiplicity. Hence there are no generic overlaps or gaps. Positive closed stars
exclude skeleton collisions, yielding a disk homeomorphism at every intermediate
time. Thus T(D)=D and every straight motion path stays inside D, even though D need
not be convex. The [review](decision.md) gives the full global argument.

A bound L on the original mesh graph derivative controls its change along each
such path. If beta bounds projected motion, delta bounds source displacement, and
eta bounds same-barycentric f32 rounding, the final pointwise bound is

`|Phi(T(u)) - M_export(u)| <= delta + L*beta + eta`.

| Transport obligation | Bound/result |
| --- | ---: |
| All four targets interior | Pass |
| Outer boundary fixed | Pass |
| Minimum signed intermediate orientation | 1.4286621227476203e-8 |
| Projected motion beta | 1.0387196304615446e-12 mm |
| Mesh graph derivative L | 2.2787384136146356 |
| Additional displacement L*beta | 2.3669703229083213e-12 mm |
| Uniform f32 rounding eta | 5.206356205475152e-7 mm |
| Final exported correspondence bound | 0.0012883081002970905 mm |
| Unchanged limit | 0.01 mm |

Every ideal target is proved inside its protected fiber. This alone would not
identify whole arcs. For each consumed edge the prior pointwise physical arc bound,
plus L*beta, places the entire ideal arc inside the transported protected fibers.
The targets share the same exact ideal Y and the arc uses affine endpoint Z, so
its YZ projection equals the transported mesh edge. Full-source membership and
unique protected roots then identify the whole source image with that ideal arc.

The composition binds fresh source fingerprints, exact original point bits,
canonical target constraints, actual consumed edge IDs, triangle order, original
parameters and recorded own-query contracts. Matching interval enclosures alone
are not used as identity evidence.

The covered chain remains 1116→1117→40→647, with original parameter labels over
[31.867718621208247, 33]. This does not establish continuity or totality of the raw
numerical chart evaluator. The third cell contains a further feature edge beyond
1116 that is **not** included in this consumed-arc certificate.

## Execution, review and restoration

A captured incident consumers; B supplied the disk/transport argument and controls;
C supplied source-domain improvement and fresh composition. Fourth reviewer D
reviewed their mathematical claims, source, identities, refusals and final receipts.
The coordinator alone ran builds, tests and geometry, serially. The pinned compiler
and ten audited library hashes match the parent; Cargo remained locked/offline.

| Selected validation | Result |
| --- | --- |
| Frozen source | 229 manifested inputs |
| Focused tests | 83 distinct passes, 33.661 seconds under 60-second cap |
| Non-test library check | Pass, 3.009 seconds |
| Fresh original-scene diagnostic | Pass, 31.169 seconds under 120-second cap |
| Parent geometry, topology, intervals, query records/costs, metadata | Unchanged |
| Fresh complete incident capture vs proof fixture | Equal after documented normalization |
| Live state | Preserved |

The original candidate remains 1775 triangles, 1929 generated queries and 8413
charges. The first outside replay remains 11 triangles, nine queries and 2121
separate charges. Process-local pointer addresses and unordered membership rows
are normalized only for comparisons. The compact fixture splits the cylinder's
numeric ID from its full identity, changes scope prose and adds parent provenance;
all other captured data match the final runtime.

| Evidence | Purpose |
| --- | --- |
| [Composition](Integrated/adoption-composition.json) | Fresh source, targets, simultaneous transport and whole-arc identification |
| [Runtime](Integrated/component-attempt.json) | Complete incident replay and preserved original component |
| [Summary](summary.json), [independent runtime review](runtime-review.json) | Exact preservation checks and limits |
| [Consensus](decision.md) | Mathematical argument and independent final decision |
| [Incident](incident-handoff.md), [transport](transport-handoff.md), [source](local-source-handoff.md), [composition](composition-handoff.md) handoffs | Authors' methods and limitations |
| [Restoration](preservation.json), [receipt index](receipt-index.json), [runner](run.py) | Source/binary identities, omitted raw output hashes and commands |

Restore the 222-input [round38 selected source](../sfcc-span-completeness/README.md),
then apply [Integrated-packet/candidate.patch](Integrated-packet/candidate.patch).
All four archived patches target that same base; do not stack them. Every patch
was restored and all manifested input hashes verified. Expanded-attempt reuses
the Capture-reviewed source and binary with its separately archived, hash-bound
[input fixture](Expanded-attempt/input-fixture.json); it is not another source
candidate. The [combined focused work](shared-focused-budget.json) remains below the original
60-second allowance across both runner invocations.
Raw binaries and omitted repeated receipts remain in
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round39-adoption/`.

## Next correctness obligations

1. Bind the captured polyline on original face [0, 3464532, 2] to the complete ideal
   face contour proved in round 38. Its two branches and feature join must agree
   with this newly adopted correspondence; source completeness alone does not
   establish the captured polyline's coverage or ordering.
2. Extend that agreement to all remaining affected interfaces and cell interiors.
   Prove source-patch ownership and exclude missing/duplicate coverage before
   admitting further cells. Keep local observational ledgers separate until a
   genuine bounded expanded transaction is validated.
3. Complete whole affected-component checks, allocation accounting and current
   native/WASM/GPU/full-model acceptance before production integration. General
   curve49 coverage and multi-sheet reconstruction remain separate open problems.

No production code changed. No browser, visual QA, WASM or GPU parity run was
performed; the proofs concern continuous geometry over represented source inputs.
