# Two actual patches share one certified source trace

**The first fan and its actual opposite-cell patch now form one certified local
source-graph disk.** Their 6 + 5 triangles meet along the same source trace, with
no projected gap or overlap. The uniform bound after f32 coordinate export is
**0.0010241185705941118 mm**, below the unchanged 0.01 mm surface tolerance.

The proof uses one common slab and **99 of 128 allowed checks** across both
patches. The selected source passes **57 focused tests** and a non-test library
check. The fresh runtime preserves the original component geometry, metadata and
query evidence exactly.

This closes the shared surface-trace obligation for **one contour segment**.
It does not establish ideal feature-curve transport at its endpoint, the face's
other contour segment, full-cell or full-component ownership, or publication.
Production remains unchanged.

[Fourth-agent review](decision.md) · [Previous whole-fan result](../sfcc-full-fan/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## Actual neighbor and input binding

The replay selects the unique original outside consumer of the checked face,
using the actual first fan, face record, source fingerprint, lattice extents,
original segment and point provenance. It does not select an unrelated easy cell.

| Binding | Actual value |
| --- | --- |
| Face [axis,key,length] | [0,3464532,2] |
| Candidate-side cell | [7,25,58,86], side 1 |
| Outside cell | [7,26,58,86], side 0 |
| Original segment in candidate traversal order | 4074→4072 |
| Joined point IDs in candidate traversal order | 40→38 |
| Outside traversal of the same edge | 38→40 |
| Selected candidate fan | 6 triangles, cylinder hypothesis 15 |
| Selected outside fan | 5 triangles, cylinder hypothesis 15 |
| Selected pair | 11 triangles, 11 used vertices |
| Entire outside cell | 11 triangles: selected 5 plus 6 with stratum hypothesis 31 |

A scoped observer captures the outside cell's fans separately from the main
candidate. The selected outside fan is found by its actual reversed shared edge;
it is not simply the first recorded fan. In fact, the outside stratum-31 fan is
recorded first. Captured triangle triples must occur in the returned mesh, and
captured position bits must match the final outside point table.

Failed/fallback construction, query-validation failure, invalid orientation or
face-consumption failure cannot produce a completed pair binding. Shared IDs are
reconciled through original keys **and exact position bits**, not proximity. The
compact fixture and fresh replay match the proof's triangle order and point bits.

`pairedFanBindingA.complete` means capture/provenance completion. It is not an
independent contact, source-ownership or whole-cell acceptance verdict; those
checks have their own results.

## Original-stage neighbor replay

The outside replay uses its exact original face records, source view and options,
before ordinary full cell meshing and postprocessing. It is not an assembled
production export.

| Check | Result |
| --- | --- |
| Outside failed cells / feature fallbacks | 0 / 0 |
| Original face consumption | Valid |
| Working/exported orientation failures | None |
| Candidate-versus-outside contacts, working and rounded broadphases | None detected |
| Partial joined indexed mesh | 1,786 triangles; valid topology |
| Outside generated curve queries | 9, all chart 49; all postvalidated |
| Outside observational ledger | 2,121 = 64 setup charges + 2,048 reservation + 9 validation charges |
| Main candidate ledger | Unchanged at 8,413 charges |
| Live input state | Preserved |

The separate outside ledger retains its full reservation; unused slots are not
refunded. Its total is not a count of executed geometry queries and is not folded
into a production replacement cost. The main candidate still has 1,775 triangles
and 1,929 validated generated events. Complete outside acceptance remains false.

The target neighbor replaces the earlier lexicographically selected one-triangle
observation. Its source graph is now checked, but the outside cell's other six
triangles are not part of the selected paired theorem.

## The two-patch domain proof

B independently validates both cyclic fans in working and represented f32
coordinates. It requires embedded projected disks, consistent projected orientation,
exact common vertex identities and opposite incidence along exactly one shared
boundary edge.

All **30 cross-patch triangle pairs** are checked in each precision. Exact projected
predicates reject proper crossings, interior containment, nonconforming endpoint
contacts and collinear overlaps. Only the declared shared edge and its endpoints
may meet. Removing the shared edge leaves one directed outer boundary cycle.
These conditions establish a single embedded projected disk with disjoint patch
interiors. Equal shared IDs make their affine X coordinates agree along the join.

This proof is geometric. It does not infer source exposure from normals or labels.
The source proof below is a separate obligation, bound to these exact inputs.

## One common source graph, not two unrelated certificates

C calls the existing source checker **once**, on the exact concatenation of the
six inside and five outside triangles. Thus the slab, source binding and global
128-check budget are shared. Two independent successful calls with unrelated slabs
would not have supplied the same guarantee.

| Source certificate | Result |
| --- | ---: |
| Common world-X slab | [-9.3690502954966, -9.203433300600462] |
| Accepted closed subdomains | 55 |
| Total attempted checks | 99 / 128 |
| Coarse finite-side refusals resolved by subdivision | 44 |
| Minimum reduced-function decrease rate | 0.8417986595496135 |
| Minimum left-end sign lower bound | +0.008339726120493616 |
| Maximum right-end sign upper bound | -0.00836976059189105 |
| Uniform working-mesh/source-graph bound | 0.0010236853133464587 mm |
| Candidate-fan bound after export | 0.000512471311801561 mm |
| Outside-fan bound after export | 0.0010241185705941118 mm |
| Original surface tolerance | 0.01 mm |

The source argument retains the admitted finite primitive branches, inactive
ancestor conditions and zero/sign equivalence to the full composed field. Strong
decrease of the reduced max function plus strict end signs gives exactly one
source root per projected point inside the common slab. Interval subdivision and
whole-triangle Hessian remainder bounds cover every closed input triangle.
The source family, tolerances and limits were not enlarged; no fallback extension
was needed.

For every parameter along the shared affine YZ edge, both patches therefore select
**the same unique source root**. Their opposite edge orientations reverse the edge
parameterization, not the geometric trace. The projected-union proof then ensures
that the lifted patch interiors neither overlap nor leave a gap and meet exactly
along that trace.

The common trace may move off the original cell plane, as the previous midpoint
witness showed. Both patches transport it identically. Exact cell-plane preservation
is therefore not required for this particular paired graph correspondence. This
does not automatically extend to the other boundaries or prove the intended
cell-trimmed surface cover.

The export bound uses equal barycentric coordinates to compose the source-to-working
bound with the working-to-f32 displacement. The two projected coordinate domains
are not assumed equal. Source and geometry reports are checked for exact point
bits, triangle IDs, counts and order before their bounds are combined.

The result concerns continuous represented-source geometry within the admitted
slab. It is not a bitwise CPU/WGSL field-evaluation proof, a remote-sheet exclusion
or permission to label the entire patch as one cylinder stratum.

## Surface trace versus feature curve 49

The selected shared edge has no recorded feature-curve interval. Curve 49 meets
it at point 40 and has adjacent source strata [31,15]. The inside fan has a recorded
curve-49 edge 40↔647; the outside continues through two recorded curve-49 intervals.
The exact shared pin parameter and point bits are preserved and appear in the
outside's validated query log.

Those facts preserve numerical endpoint provenance. They do **not** prove that
the common source-root lift transports the ideal feature curve with its original
parameterization. Agreement on a face-contour trace is a different theorem.
The previous midpoint displacement must not be attributed to endpoint 40 without
checking that endpoint itself.

Outside curve-membership rows explicitly use outside-local IDs. The fixture stores
the checked `outsideToJoined` mapping before those rows can be compared with the
joined patch IDs. The final replay differs from the capture only in process-local
addresses and the order of two unordered membership rows; their contents match.

## Execution, review and reproducibility

A prepared the actual neighbor and captured its emitted fan; B checked the paired
domain; C bound one source proof and export composition. D independently reviewed
all three and the saved executions. Root ran builds and geometry serially with
pinned Rust 1.99.1, verified compiler/library hashes, locked/offline Cargo and the
unchanged diagnostic profile.

| Frozen packet | Executed result |
| --- | --- |
| B-check | Compile failure from a rustfmt filename header; preserved and stripped in the selected source |
| C-check | Two source-input controls pass |
| Capture | 26 focused controls pass; intended neighbor captured in 36.753 seconds |
| Proof | Test API compile failure: source identity returned Option<Value>; preserved |
| Proof-fixed, selected | 57 tests pass in 24.993 seconds; explicit source-identity requirement fixes the API mismatch |
| Selected non-test library check | Pass, 3.444 seconds |
| Fresh original-scene diagnostic | Pass, 32.309 seconds |

No compile failure is counted as geometric evidence. Campaigns overlap and their
counts are not additive. All build/focused/component limits remain 120/60/120
seconds; the proof retains the global 128-check cap, with 29 checks remaining.

The selected run preserves the parent's candidate points, triangles, topology,
sorted intervals, generated query records/costs and retained metadata exactly.
Its fresh outside capture matches the compact proof fixture and the earlier
capture after excluding process-local addresses and sorting only the unordered
membership rows. The original main fan observer is restored after the scoped
outside capture, including on unwind.

| Evidence | Purpose |
| --- | --- |
| [Consensus](decision.md) | Independent review and final accepted scope |
| [Combined paired proof](Proof-fixed/paired-combined.json) | Exact-input source/domain/error composition |
| [Source](Proof-fixed/paired-C.json) / [domain](Proof-fixed/paired-B.json) | One common slab and exact paired union |
| [Fresh runtime receipt](Proof-fixed/component-attempt.json) | Actual face, neighbor, fans, queries, joins and preservation |
| [Summary](summary.json) | Bounds, counts and checked input identity |
| [Capture](capture-handoff.md), [domain](domain-handoff.md), [actual source](source-actual-handoff.md) handoffs | Independent implementation arguments |
| [Restoration checks](preservation.json) / [receipt index](receipt-index.json) / [runner](run.py) | Reproducible source inputs, binaries and bounded commands |

Restore the 212-input [round35 selected source](../sfcc-full-fan/README.md), then
apply [Proof-fixed-packet/candidate.patch](Proof-fixed-packet/candidate.patch).
The selected source has 215 inputs. All five executed patches target that same
base and must not be stacked. Every patch was restored and all input hashes checked.
Repeated large outputs and binaries remain under
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round36-paired/`, with
hashes and archive status in the receipt index.

## Next local correctness obligations

1. **Check feature curve 49 at the shared endpoint directly.** Bind its actual
   source constraints and original parameter, and determine whether the common
   surface lift preserves the ideal feature or requires a bounded feature-constrained
   adjustment. Retain direct own-query checks and existing allowances; do not infer
   feature identity from surface proximity or the midpoint witness.
2. **Cover the face's second contour segment and incident patch.** The original
   face has two segments. Capture the corresponding candidate-side fan and use the
   already recorded outside stratum-31 fan. Check its source graph, projected join
   and compatibility at the shared feature endpoint before claiming the whole face.
3. **Extend only after those exits pass.** Other boundaries and fans, the remaining
   outside ring, replacement-stage metadata, checker allocation accounting and
   native/WASM/GPU/full-model preservation remain open. Keep the same three-agent
   and fourth-review model and retain explicit refusals at the existing caps.

This is one certified paired surface trace, not full-component ownership. No
browser or visual QA was performed, and production code remains unchanged.
