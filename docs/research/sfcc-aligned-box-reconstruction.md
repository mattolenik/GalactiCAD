# Complete bounded reconstruction of signed aligned boxes

Status: complete. Three independent implementations and a distinct fourth
consensus review were followed by independent coordinator review and acceptance:
application build, 381 native workspace tests, 239 profiling checks, all 39 WASM
fixtures, and exact geometry replays passed. Baseline:
`04d889f911ba6c89981752df02cc2ad7a67ddc0f`. The
[coordinator record](sfcc-aligned-box/coordinator-validation.json) pins the final
source, commands, logs and application artifact separately from focused evidence.

This milestone constructs multiple surface pieces inside an actual SFCC cell.
It replaces the earlier three-sheet rejection with a complete finite
construction for a checked class of signed aligned-box expressions. It does not
establish general curved-CSG reconstruction or guaranteed activation for every
legacy meshing failure.

## Concrete target and result

The frozen expression is `min(A, max(B, C))`, where the boxes have centers and
half widths `A=(-1.875,0,0),(2.125,4,4)`,
`B=(2.25,0,0),(1.75,4,4)`, and `C=(-1.625,0,0),(2.375,4,4)`.
Its zero set is the boundary of two disjoint cuboids:
`[-4,.25] × [-4,4]²` and `[.5,.75] × [-4,4]²`.
The world cube remains `[-128,128]³`; depth and tolerances are unchanged.

The selected construction uses the same 106 prepared leaves and produces
424 rectangles / 848 triangles, two closed components, and 152 elementary
crease intervals. The complete-facet oracle independently checks all twelve
target faces, exact outward orientation, no triangle-interior overlap, area
400, and oriented volume 288. Index topology and worker transport are separate
obligations; these numerical totals alone are insufficient.

The prepared manifest still contains 72 old degenerate flags. Its discovery
decisions have not been retroactively changed. A new construction justifies the
final fillings; its final accounting can therefore have zero unresolved cells.
The old reports remain historical evidence of the incomplete 700-triangle,
one-component output, not current desired results.

## Choice among three independent candidates

All three candidates were completed before this distinct fourth review began.
Their final handoffs and hashes are retained in [the evidence directory](sfcc-aligned-box/).

| Candidate | Useful contribution | Selection consequence |
| --- | --- | --- |
| A | Complete tensor arrangement; strict generic grid position; monotonically ordered f32 map; shared SFP6 verifier | More wire/protocol changes and a narrower production trigger requiring multiple parallel planes. Its derived carriers are per rectangle with original occurrence metadata. |
| B | Original-tree strata; exposed-facet subdivision; actual original carrier strata; SFP5 payload within a checked arrangement envelope; existing flip transport | Selected runtime: the smallest complete integration with a direct ownership argument. |
| C | Closed-cell face/edge/point incidence accounting, including exact grid contacts; compact facet payload | Wider grid-contact scope, but synthetic rectangle carriers and blanket lifecycle withdrawal add a separate integration path not needed for this bounded milestone. |

Selection was based on proof and caller integration, not majority or test count.
No three-framework merger was made. The selected B construction was tightened
by validating decoded leaf levels/indices before integer shifts and packing,
checking complete assembly metadata, and correcting the native test that had
accidentally tested reverse order twice. The independently derived A/C f32
coordinate-map argument also removes B's unnecessarily strict requirement that
every primitive carrier plane be exactly representable in f32. A positive
inexact-plane test replaces that specific restriction; collapse still rejects.

## Exact target and arithmetic premises

Let `F` be the original nonempty hard min/max tree of signed aligned boxes,
interpreted as a continuous real field of its actual binary64 coefficients.
Each stored transform must numerically equal `R=I, s=1, t=0`; half widths are
finite and strictly positive, positions finite, and signs exactly ±1.
Both endpoint sums `pos ± half` must be exactly represented, checked with the
existing exact dyadic predicate. Advisory IDs are never geometric identities.
Every original occurrence and its ancestor path remains distinct.

The lattice has depth 1..14, coherent resolution/span/step, positive finite
size, finite origin, valid cell indices and keys, and exact agreement between
the actual rounded cell AABB, integer point map, and real affine map. No original
primitive endpoint plane may coincide with any represented leaf boundary
coordinate. This conservative generic-position premise excludes all grid
face/edge/vertex contacts; jitter is not assumed to establish it.

All claims concern the represented hard field. They do not identify it with a
different GPU arithmetic path or an idealized nonidentity transform. The
existing SFCC field implementation remains unchanged; the new restricted sign
algebra is not a second general scene evaluator.

## Completeness of the construction

**Stratification.** For each axis, sort all primitive lower/upper coordinates,
deduplicating numerical +0/-0 while preserving original coefficient bits and
occurrences in the expression signature. Plane rank `j` is event `2j+1`; the
intervening and two unbounded open intervals have even ranks. Products of these
events and intervals form every open stratum of dimensions zero through three.

Each box is strictly inside, on its boundary, or outside throughout any such
stratum. Its sign is therefore exactly constant there. Folding those signs
through the original min/max tree gives `sign(F)` on the entire stratum. No
midpoint sample is used, including when adjacent f64 events have no represented
number between them. Open 3D strata cannot have zero sign: their leaf signs are
all strict, and min/max preserves this property.

**Exposed faces and singularities.** A zero 2D stratum is emitted only if its two
adjacent open 3D strata have opposite signs. Its normal points from negative to
positive. Equal-side signs mean a zero-only sheet, which is explicitly rejected.
Every zero edge and point must be in the closure of an emitted face. Otherwise
it is an isolated zero stratum and is rejected. Finally the complete indexed
complex must have opposed double edge incidence and one circular link at every
vertex. This rejects components touching only at an edge or point.

Every zero point lies on at least one primitive boundary plane. The finite
primitive coordinate ranges include every possible zero face; outside the
tangential ranges every box is strictly outside and the signed min/max cannot
be zero. Thus enumerating the faces and separately checking their lower
dimensional closure exhausts the zero set. A complement can have an unbounded
negative region while its zero surface remains bounded; a bounded occupied
interior is not an additional premise. `A-A`, internal zero-only contact sheets,
and isolated strata are never silently regularized away.

**Original ownership.** A bottom-up sign/owner fold retains every zero occurrence
that remains active through the original expression, including ties. On an
exposed face at least one such occurrence's signed facet normal agrees with
the independently established orientation. It supplies the numerical patch
carrier; the other occurrences and paths remain in the target facets and
signature. Choosing a carrier does not merge signed ownership.

**Actual cells and shared interfaces.** Add every actual prepared cell boundary
coordinate to the three common coordinate lists. Subdivide every exposed
rectangle by these global lists. Each resulting microrectangle must have
exactly one actual leaf owner: the carrier plane is strictly inside its normal
interval, and its tangential closed extent contains the rectangle. Missing or
overlapping ownership rejects construction.

The generic-position premise ensures every nonempty closed-cell target has a
positive-area piece; it cannot consist only of a face/edge/point contact.
Therefore a leaf assigned no rectangles has an empty target. The union assigned
to each leaf is its entire target restriction, including several disks, annuli,
cavities, or components wholly enclosed without a boundary trace. Each rectangle
is split along a fixed diagonal; loops are never independently capped.

Common coordinate-rank identities close all coarse/fine and worker interfaces.
Neighboring faces use restrictions of the same rectilinear complex at their
actual extents; no unrelated whole-root mesh substitutes for this cell-relative
argument. Multiple roots on one original grid edge remain distinct coordinate
events. The fallback replaces the entire eligible export, so no unproved
interface to old approximate triangles remains.

## Exported f32 geometry and metric bound

Every coordinate list must cast to finite, strictly increasing f32 values.
Let `h_a` map each original coordinate event `x` to its actual cast `fl32(x)`
and interpolate linearly between consecutive events. Extend monotonically
outside the finite range. Then `H=(h_x,h_y,h_z)` is an ambient homeomorphism.
On each elementary rectangle its restriction is affine in each tangential
coordinate and maps both chosen triangles exactly to their exported triangles.
Consequently the initial exported indexed mesh is embedded and corresponds to
the complete target surface. Distinct sheets cannot silently collapse.

For each axis define `δ_a = max_events |fl32(x)-x|`, with those differences
interpreted in real arithmetic. On every interval the displacement is a convex
combination of endpoint displacements. Hence
`||H(p)-p||₂ ≤ sqrt(δ_x² + δ_y² + δ_z²)` throughout the target, giving the same
two-sided Hausdorff upper bound between the original and exported surfaces.
This is a mathematical bound from actual cast events, not a newly exposed
runtime tolerance. When all supporting primitive planes are fixed by the cast,
the exported surface equals the original rectilinear target exactly. Otherwise
it is a nearby mapped surface, and exact target equality is not claimed.

A box with half width `1+2^-30` now passes the ordered-map proof and exports at
x=±1, with maximum coordinate displacement `2^-30`. Two sheets that cast to the
same coordinate still reject. Existing vertex/triangle and feature audits
remain additional acceptance checks, not substitutes for this proof.

## Features, cleanup, and worker trust boundaries

The complete crease graph is derived from adjacent exposed rectangles of
different axes. Its elementary straight segments retain actual original
carrier strata, complete intervals, and endpoint incidences. A fresh existing
feature-set run ID preserves cache lifetime. Every declared endpoint must be
reproduced exactly by its segment parameterization. No empty-feature-graph or
debris-removal exemption was added. Elementary subdivision can constrain
quality edits more than a future maximal-curve representation.

Initial per-cell witnesses snapshot indexed oriented triangles, point keys,
all six stored f64 fields, and all edge memberships, including empty sets.
Existing assembly and all requested quality operations execute unchanged.
Private checked planar-flip journals preserve exactly the oriented surface
union in both f64 and f32; common refinements carry original cell and patch cuts
as virtual curves. The metric bound above therefore survives these flips.
Unproved geometry edits withdraw certificates and do not themselves trigger
serial recovery.

The additional arrangement-only metadata guard checks every original patch
assignment, all protected edges, and the complete membership map around
assembly. A new final triangle created by immutable checked flips has no newly
invented patch assignment; an unexpected assignment withdraws certificates.
Original patch ownership survives virtually and is not advertised as one
verified owner on every final triangle. Metadata change conservatively
withdraws all remaining arrangement certificates.

Workers retain the original prepared manifest and Morton group ownership.
An arrangement envelope carries that manifest, checked group/count integers,
and ordinary SFP5 actual point/triangle/interval payloads. The receiver validates
the field and lattice, reconstructs the complete expected target for each
group, and compares the received payload before merging those received
triangles. It never substitutes regenerated serial geometry for worker output.
Missing/duplicate groups or changed geometry, ownership, intervals, or field
signature reject. The independent rational oracle avoids treating this shared
constructor/verifier implementation as independent evidence.

The shared SFL3 leaf count uses checked u64→usize conversion, checked row-byte
multiplication, and exact remaining-length validation before allocation.
Previously a count plus `2^32` could truncate on wasm32; the preserved candidate
failure demonstrates this. Leaf level and index ranges are now checked before
any cell-key shift or packing. Malformed cases run in isolated actual WASM
workers. These checks are bounded input validation, not a general authenticated
partition protocol: normal preparation premises still apply. Independently
requiring an owner for every target facet prevents missing surface leaves from
being silently accepted.

## Scope, activation, and bounds

Production activation requires an existing degenerate prepared leaf. Healthy
octrees only scan those flags and use their established path. The standalone
constructor supports a wider set of complete cell targets, but later
nondegenerate mesher-only failures do not yet trigger it. Unsupported rotations,
curves, blends, inexact endpoint arithmetic, or grid contacts are not newly
certified. Rejected eligible attempts retain best-effort legacy geometry and
explicit uncertainty; old depth/tolerance defaults are unchanged.

The fixed limits are 4096 occurrences, depth 128, 128 primitive coordinates per
axis, 262144 product strata, 16777216 stratum×signature-word work, 32768 leaves,
1024 final cuts per axis, 262144 rectangles, and 32000000 rectangle×leaf owner
comparisons. Signature words include internal-node arities and full paths;
owner-vector propagation through ancestors is bounded by those path lengths.
The initial scope walk allocates no new tree and stops at depth 128. Large
Cartesian products and rectangle storage are checked before allocation.
Derived features and snapshots are bounded multiples of emitted rectangles;
the inherited spatial index additionally caps individual enclosure insertion
at 4096 bins, using broad candidates above that bound. These are conservative
finite limits, not a claim of small worst-case memory or optimal complexity.

Workers and receiver repeat target construction. Global cuts can subdivide
unrelated distant facets, and the initial budget may reject models a better
local arrangement could handle. This is a correctness milestone, not a speed
claim. A future local-cut optimization must retain complete interfaces and
original owner paths.

## Validation and costs

Final source, artifact hashes, commands, exact versus precursor test results,
independent oracle outputs, wire sizes, and bounded timings are recorded in
[the validation ledger](sfcc-aligned-box/validation.md). The selected candidate's
earlier quiet WASM samples showed +0.43% ordinary-box, +1.20% 16-duplicate, and
+3.22% clipped-box median time. The final-artifact recheck measured +1.92%,
+0.31%, and +2.40% respectively, preserving exact output. Corrected coarse
construction took 26.101 ms versus 22.361 ms for the incomplete baseline in
that short sample. Those are observed costs, not general performance predictions.
No 256-duplicate or 48-blob timing campaign is repeated for this milestone.

The coordinator's final application build and full native/WASM gates passed,
including a fresh exact-facet replay against the application-built WASM output.
Manual visual QA belongs to the user. Missing optional external native
TypeScript oracle files do not establish those absent comparisons.
