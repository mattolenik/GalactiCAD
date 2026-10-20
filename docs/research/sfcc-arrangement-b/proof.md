# Candidate B: bounded complete aligned-box surface construction

This is an independent candidate at frozen baseline
`04d889f911ba6c89981752df02cc2ad7a67ddc0f`. The production fallback activates only when an actual prepared cell is
marked degenerate by the existing discovery/refinement criteria. Healthy fast
paths pay only a scan of these flags, without building an arrangement. The
standalone complete constructor is also tested on nondegenerate cells. It does not
increase depth, change tolerances, or claim to solve general curved CSG.

## Target and numerical scope

The target is the zero set of the **original signed hard min/max expression**,
interpreted in real arithmetic using its actual parsed binary64 coefficients.
Every occurrence is an identity-transformed aligned box with strictly positive
finite half widths. Both represented `pos-half` and `pos+half` must equal their
real sums exactly, checked using the existing arbitrary-length Dyadic predicate.
Original node ordering, all signed occurrences, and full ancestor child-index
paths are retained. The initial identity-scope walk is linear in the supplied
input tree, uses no new tree allocation, and stops at depth 128; the subsequent
stratum work budget is a separate bound. Advisory IDs do not identify geometry or occurrences.

The supported output construction additionally requires a finite coherent
lattice (depth 1..14, canonical res/span/step), canonical cell keys and indices,
and exact agreement among the lattice address, cell AABB and real affine map.
Primitive planes on actual leaf boundary coordinates are currently excluded.
This is an explicit generic-position restriction, not a perturbation argument:
stored jitter does not prove it. Primitive/primitive plane coincidences are
allowed and preserve all tied original occurrences.

An optional preflight outside the endpoint/grid/budget domain does not change a
previously successful nondegenerate fast path. If the old cell is already
degenerate, the same limitation is an explicit unresolved reason. Singular
zero strata and failures after proving the need for construction are explicit
unresolved results. The old best-effort geometry is retained on rejection.

## Complete stratification and original-tree exposure

For each axis, collect every original box lower and upper plane, canonicalize
signed zero, sort and deduplicate by exact represented numerical order. Plane
rank `j` has stratum coordinate `2j+1`. Open intervals, including the two
unbounded intervals, have even stratum coordinates. A leaf sign is exactly
positive outside any one coordinate interval, zero on a boundary while inside
all other closed intervals, and negative strictly inside. Multiply by the
original occurrence sign and fold through every original min/max node.

No midpoint is evaluated. Adjacent binary64 plane coordinates therefore remain
distinct even if no represented binary64 lies between them. The expression
sign is constant on every open product stratum because each primitive's
inside/boundary/outside relation is constant there. Exhaustively enumerating
these strata is a completeness argument, unlike testing a finite set of
arbitrary samples.

A two-dimensional zero stratum is exposed exactly when the adjacent open
three-dimensional signs are opposite. Its outward orientation is from the
negative region to the positive region. A zero face whose two sides have equal
sign is rejected as a zero-only sheet. Each lower-dimensional zero stratum must
belong to the closure of an exposed face; otherwise an isolated zero edge or
point is rejected. The complete emitted complex must additionally have two
oppositely oriented uses of every edge and a single circular link at every
vertex. Thus edge/point contacts between otherwise regular components are
rejected as nonmanifold rather than welded or silently removed.

At every exposed face, a bottom-up sign-and-owner fold retains every active
zero occurrence tied through the original expression. For a numerical smooth
patch owner, choose an active occurrence whose signed plane normal agrees with
the independently derived outward orientation. Other active occurrences and
paths remain in the arrangement and expression signature; choosing one patch
normal does not deduplicate them semantically.

All zero set points have at least one primitive boundary plane. Outside the
finite bounding coordinate range all primitive signs are strict, so min/max
cannot produce zero. Every two-dimensional face is enumerated. Every edge and
point is separately checked for face closure. These observations establish
that the constructed regular complex equals the full zero set, including
closed internal components, cavities and disconnected pieces with no cell-face
trace. There is no occupancy-only regularization of A-minus-A.

## Cell construction, holes, and shared faces

Once a production degenerate cell triggers fallback, the complete constructor
clips **every expected exposed primitive-plane rectangle** to every actual leaf
and also tests whether the complete target is an indexed disk or empty. A closed internal component, several disks, or a patch with holes
fails this predicate. A degenerate prepared cell always keeps the construction active: a disk target
alone does not imply that the old mesher successfully filled it. Nondegenerate
legacy failures do not yet trigger this fallback; broadening that activation is
outside this milestone. No stronger coverage claim is attached to those legacy
results.

For a required fallback, take the union of all primitive coordinates and every
actual prepared leaf-boundary coordinate on each axis. Subdivide every exposed
rectangle by these shared global coordinate sets. For each resulting rectangle,
require exactly one actual leaf whose open normal interval contains its plane
and whose tangential closed intervals contain the rectangle. A missing leaf or
overlapping ownership is a failure. The whole replacement surface is closed;
there are no interfaces to old approximate triangles in this path.

Adjacent cells, including 2:1 neighbors and all worker groups, see the same
rank-coordinate vertices and edge subdivision. A coarse cell cannot omit a
fine neighbor's cut because the cuts come from the complete prepared leaf set.
A face's complete traces are the intersection of this common rectilinear
complex with the actual face extent. Several roots on a lattice edge have
separate rank-coordinate identities; there is no single-root numeric key or
proximity merge. Grid contacts are rejected, so geometric ownership is unique
and no zero face has to be counted as the interior of two closed cells.

Each rectangle is split into two strictly oriented triangles along a fixed
diagonal. All such rectangles are retained. There is no boundary-loop filling
that could cap a hole, omit an interior component, or join separate sheets.
The initial per-cell complex equals the complete target clipped to that cell.
Its shared-face restriction is identical for both incident cells. This is a
cell-relative construction and proof, even though the fallback replaces the
entire eligible export to close all old/new interfaces.

## Features and postprocessing

Construct the complete crease graph from adjacent exposed rectangles with
different carrier axes. Each elementary straight crease interval gets a stable
curve ID and its two true original carrier strata. All original tied ownership
remains in the target facets. Coincident coplanar ownership changes are not
invented as geometric creases. Every endpoint is a canonical grid-coordinate
vertex, and segment subtraction and re-addition must reproduce the declared
endpoints exactly. The feature-chain audit checks every derived curve and
interval. The graph is not borrowed from the old, potentially incomplete
feature tracer and is not replaced by an empty graph.

Initial construction installs snapshots of every cell's oriented triangles,
point keys and complete binary64 payloads, plus complete edge membership sets.
The existing assembly pipeline remains enabled, including component/debris
handling and every requested quality stage. Existing debris handling already
retains closed manifold components; no exemption was added.

Existing checked planar sliver flips transport the cell map through their
private journal and common refinement. Both f64 and exported f32 quadrilaterals
must preserve exact oriented coplanar geometry, so the old cell cuts continue
as virtual curves in the new triangles. Other edits withdraw affected local
proofs under the existing exact snapshot checks. A changed quality result may
therefore remain useful geometry while reporting incomplete coverage; quality
stages are not disabled to obtain successful certificates. Withdrawal alone
does not trigger serial recovery.

## Exported precision

Every exposed primitive plane must survive f32 conversion exactly. Every
coordinate in each shared cut list must cast to a finite f32 and retain its
strict order. The coordinate-wise piecewise-linear map from f64 cuts to their
f32 images is consequently an increasing homeomorphism fixing all supporting
primitive planes. It maps every rectangle to the same target facet and gives an
embedded f32 triangulation of that target. Distinct sheets cannot silently
collapse. This is stronger than the prior abstract-cell theorem but applies
only to this checked initial arrangement and any proved planar-flip transport.
Arbitrary later quality changes withdraw this proof.

## Workers and lifecycle

Worker preparation retains its ordinary octree, lattice and original feature
fingerprint. An arrangement partial contains that complete prepared manifest,
its group index/count (checked u64-to-usize conversion on wasm32), and an
ordinary point/triangle/interval payload holding
only the group's actual leaves. All original expression words and occurrence
paths are included in the proof signature. Point keys are global coordinate
ranks; all six binary64 payload fields must agree on merge.

The receiver rebuilds the target from the original scene and common manifest,
checks the lattice and original feature fingerprint, checks the inherited
prepared leaf count by checked conversion and exact remaining 48-byte row length
before allocation, checks all group indices
are present exactly once, independently regenerates each group's complete
expected canonical payload, and compares it to the **received** bytes. Only
then are received triangles merged and postprocessed. It does not substitute
regenerated serial geometry for received worker triangles. A mutated payload,
curve interval, ownership entry, omitted rectangle, extra rectangle or duplicate
group is rejected. This deterministic verifier is supported by a separate
rational facet oracle, rather than treating shared constructor code as an
independent mathematical oracle.

The new per-cell certificates bypass the old sphere/positive-intersection
rechecker only after this receiver verification, through a private PointTable
state. Old worker certificate checks and corruption tests remain in place.
Normal prepared-partition premises still apply to the upstream octree; the new
construction independently requires complete ownership of every target facet,
so it cannot succeed after removing a required surface leaf.

Derived feature sets use the existing unique run-ID allocator, retaining the
axis-plane query cache lifetime contract. All construction state is stack-owned
per export/worker. No static cache or
cross-export mutable state was introduced. Rejection uses legacy geometry and
an explicit local unresolved reason; existing recovery, cancellation guards
and final cancellation discard remain active.

## Bounds and costs

Limits are checked before the corresponding large allocations: 4096 primitive
occurrences, recursion depth 128,128 distinct primitive coordinates per axis,
262144 product strata,16777216 stratum-times-expression-word work units,
32768 leaves,1024 total cuts per axis,262144 final rectangles, and 32000000
rectangle-times-leaf ownership comparisons. Signatures contain node tags,
arities, primitive bits and full paths, so the work bound includes internal
nodes and ancestor-path costs. The active-owner fold visits each node once rather than recursively rescanning
its sign expression at every ancestor. Moving tied-owner vectors up nested
nodes still costs the sum of their ancestor-path lengths, bounded by depth 128
and 4096 occurrences and accounted for by the full-path signature-word work
bound. The preliminary identity-scope walk independently enforces depth 128.

Candidate B deliberately favors a simple reproducible global subdivision over
minimal tessellation or wire size. Every worker and the receiver repeat bounded
construction; this is a correctness milestone, not a speed claim. The global
cut grid can add unrelated cuts, and rejection may occur before a more locally
optimized arrangement would exhaust its budget. Those are explicit current
limits.

## Evidence

The coarse mandatory object at the unchanged cube[-128,128]^3 and default depth
produces 106 actual prepared leaves,424 rectangles,848 triangles, 2 components,
152 complete elementary crease curves, and 106 certified cells. The root's
independent Fraction oracle checks all12 exact cuboid facets, nonoverlap,
orientation, total area 400, and volume 288. It also rejects omission,
equal-area duplicate overlap, and reversal adversaries. Native serial,
resumable, in-process partitioned and raw worker 1/2/4/8 modes are checked with
all8 exported vertex fields, oriented triangles and complete validation.
Final validation and source/artifact hashes are recorded separately.

## Diagnostic accounting

Prepared octree tags and first-decision events are unchanged. A prepared cell
may remain degenerate under the old one-piece criteria while its new complete
arrangement is proved. New witnesses clear that historical flag for final
construction accounting. The original flags remain in the prepared manifest.
When bounded capture has payload space, the pipeline's early arrangement
return emits a preassembly Mesh event for each constructed cell and a terminal
snapshot of resolved cells; any later proof
withdrawals are marked failed in that snapshot. Thus diagnosis can distinguish
failed old criteria from the successfully reconstructed final filling. Raw
worker entrypoints retain their existing separate diagnostic export scopes.
