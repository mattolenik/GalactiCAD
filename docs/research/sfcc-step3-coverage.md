# SFCC Step 3: bounded local coverage consensus


Baseline: `e0288346de2dddd2edd1fc90e331a9054b04e3e8`. The selected runtime is B's rework, with consensus fixes for direct record identity, failed worker rechecks and complete post-recheck snapshots. The final focused gate and the coordinator's application/full-workspace/all-fixture gate passed. This is the accepted input to Step 4.

The first three research-only proposals were rejected. The exact counterexample remains historical evidence, not a current expected success: in the coarse three-sheet scene, nine formerly accepted responsible regions omitted sheets or bridged different sheets. The rework leaves their responsible descendants explicitly unresolved while retaining useful successful local certificates.

## Selection and claim ledger

| Claim | Evidence and conclusion |
| --- | --- |
| Complete target-to-filling correspondence in the declared classes | Independent exact edge/atomic-face and target-subpatch enumeration, indexed disk verification, matching boundary/crease maps, and lifecycle argument below. These premises, not manifold counts, support the bounded theorem. |
| Mandatory sphere and two-input crease remain useful | 2,763/2,763 sphere cells and 132/132 clipped-box cells are certified; outputs retain 6,776 and 656 triangles, one component, zero unresolved and `ok=true`. Both original operands own exposed parts of the box and all four cut creases are checked. |
| Responsible multisheet uncertainty is fixed | Coarse output changes 88→106 leaves, 678→700 triangles and 30→72 unresolved; all 25 final strict-interior sheet-spanning cells and each old responsible region or descendant are unresolved. The geometry is still incomplete, with one component and nine fallbacks. |
| Fine multisheet output remains useful | 4,372 leaves, 11,608 triangles, two components, zero unresolved. It is outside the full theorem; the necessary edge guard alone is not a certificate. |
| Default planar cleanup preserves local proof | The inherited half-3 box keeps all 386 certificates and 1,308 triangles; 220 certificates transport through checked flips. 165 added triangles cross original cell boundaries. Exact independent f64/f32 diagonal-intersection evidence supports the common-refinement argument. |
| General quality edits preserve this proof | Not claimed. Geometry can remain unchanged from baseline while affected local proofs are withdrawn. Existing raw-worker no-recovery assertions and quality operations remain intact. |
| Whole-root radial/planar checks replace local certificates | Rejected. Independent output oracles remain supplemental; sphere radial projection does not preserve planar cell faces. |
| Arbitrary represented transforms have identical analytic carriers | False. Captured rounded rotations and a tiny translated box provide exact counterexamples. The full theorem validates actual identity transforms and exact endpoints. Step 2's broader numerical exclusion is unchanged. |
| Complete intended worker partition is verified | Not claimed by this selected per-represented-cell contract. No prepared-leaf manifest is inferred from the feature fingerprint. |
| Timing or speedup | Not measured in this step. Added proof, wire and revalidation costs are explicit. |

A and C provide compatible independent approaches, rather than failed runtime designs being dismissed by test count. A also checks spatial overlap/interface ownership but transports larger redundant per-cell records (one-part sphere 5,017,122 bytes versus baseline 689,314). C carries the complete prepared-leaf manifest and claims that stronger partition boundary, while limiting full positive-box scope to 64 leaves. Its measured one-part sphere overhead is 938,145 bytes. Those additional contracts are not needed for this milestone's per-represented-cell theorem. B's private execution-bound planar-flip capability supplies the simplest selected lifecycle argument. Independent carrier, box-overlap and sphere-cone oracles from A/C are preserved alongside B's checks; three overlapping runtime frameworks are not imported.

Consensus found four finite integration gaps; their fixes are covered by focused regressions. A direct face record must match its requested axis, key and length even when the target face is zero-free; a cell key must match its coordinates. Every failed worker recheck now retains a noncertified reason, including an exact-grid failure, without converting outside-grid scope into a mesher failure. Finally, successful worker rechecks rebuild the complete used-vertex/key/payload and owned-edge membership snapshot from actual merged data: omitted serialized entries cannot hide subsequent cleanup mutations. The mandatory sphere and box regressions erase these snapshots, verify exact reconstruction, then mutate a captured normal and require withdrawal. The full box check also rejects duplicate memberships for one curve on an edge and validates every distinct membership, rather than stopping after a valid first interval. The reduced mutation appends the same curve/start with `end.next_up()` on a genuine clipped-box crease. The jitter comment now correctly describes stored rational binary64 offsets rather than claiming irrational offsets prevent all contacts.

This rework supersedes the first proposal's obstruction-only verdict, without
changing its historical evidence. The runtime claim is deliberately **per
represented certified cell**: a homeomorphism of the actual indexed filling to
the represented zero set clipped to that cell, agreeing on canonical atomic
faces and the full internal box crease graph. It is not a new f32 embedding,
Hausdorff, all-CSG, or intended worker-partition completeness theorem.

The target is the continuous real expression induced by the actual parsed/baked
binary64 coefficients. Identity matrix, scale one and zero transform translation
are checked. The single positive sphere and positive nested box intersections
are the only full-certificate families. Other coherent trees retain their
existing runtime paths and an explicit outsideScope report. A separate necessary
signed-box guard applies more broadly; its success never creates a certificate.

## Arithmetic and grid

The existing exact Dyadic implementation supplies squared sphere signs and
exact affine equality, rather than comparing rounded formulas. It represents
binary64 operands exactly and adds/subtracts/multiplies arbitrary limb values;
no fixed-width shift-overflow premise is introduced. Zero addition/subtraction
uses the exact additive identity before exponent alignment, avoiding expansion
to exponent -1074 for ordinary zero operands. Nonfinite inputs are inconclusive.

The verifier checks depth 1..14, res=2^depth, span=res+1, positive finite world
size/step, exact step=size/res, finite origin and valid integer cell indices.
Direct records must match their canonical cell and atomic-face identities, including empty faces. Every queried lattice address must equal origin+integer*step in real arithmetic;
cell_aabb and start+extent must agree with those exact endpoints. All queried
face/subedge addresses are checked. Coherent grids outside these arithmetic
premises are explicitly outside the narrow full theorem, not certified empty.

Each atomic face is the actual full face or four quarter faces selected by the
same neighbor-is-internal rule as contouring. Minimal subedges use actual sample
keys and collect_edge_interior_offsets. Face identity includes (axis,key,len),
root identity includes axis/start/length, so a same-key coarser face cannot stand
in for a finer face. The actual mandatory lattices retain the production jitter.

## Sphere target independent of output

For q(p)=sum((p-center)^2)-r^2, every minimal subedge endpoint has a strict exact
sign. Opposite signs yield exactly one simple quadratic root: a convex quadratic
with one endpoint inside and one outside cannot cross twice inside that segment.
Two negative endpoints imply strict negativity throughout by convexity. For two
positive endpoints, the exact nearest point on the segment must still have
positive q. Thus a same-sign two-root detour and tangent contact are rejected.

A face with no boundary roots must have either all corners strictly inside, or
a strictly outside nearest point on its rectangle. These are exact convex
maximum/minimum exclusions and reject a hidden circle. A mixed face must have
exactly two independently identified roots. Its intersection with a sphere is
one circle; the checked edge restrictions leave one complete arc in the face,
with no additional closed circle component. The directed arc is fixed by exact
inside-to-outside transitions around the oriented rectangle, independently of
the output chain's direction.

The actual FaceRecord must be one directed chain with exactly those endpoint
keys and the independently fixed orientation. Root payloads are strictly inside
the proven minimal edges. Every chain point is finite and lies in the face
rectangle; adjacent points are distinct. Interior repair vertices are mapped in
chain order to an ordered subdivision of the unique target arc. This is an
abstract boundary map, not radial projection of the emitted chord. Both cells
use the identical chain, roots, payload and face identity, so this ordered map
is canonical. Internal vertices need not already lie on the real circle.

The union of all actual atomic face arcs must be exactly the filling boundary.
The verifier rejects a whole sphere contained in the cell, and zero-boundary
cases require exact whole-cell exclusion. For a nonempty proper sphere portion,
the strict face/edge premises give a compact surface with boundary. One simple
boundary component forces one disk: a subsurface of a sphere has genus zero;
any additional component would have a boundary or be the whole sphere. Both
are excluded by the complete boundary enumeration and containment check.

## Positive box intersection and its internal crease graph

For positive boxes with exact represented endpoints, max_i D_i=0 exactly on
the boundary of [max_i lower_i,min_i upper_i]. All resulting widths must be
positive. All original extremizer paths, including ties, are retained; the
original evaluator/tree and pruning remain unchanged. DFS occurrence ordinals
are the actual feature compiler's ordinals, not advisory leaf IDs.

The six outward-oriented rectangles are clipped independently to the exact
cell. A temporary target complex verifies whether their union is a disk.
Belts, disconnected patches, wholly internal closed boxes and exact contact
cases are not silently regularized. Atomic face traces are separately formed
from the clipped line arrangement; hidden closed loops, multiple chains and
face/edge coincidences fail explicit premises.

Every emitted triangle is assigned to exactly one target facet after a bounded
candidate coordinate map. Near-coordinate selection only proposes that map;
acceptance depends on exact orient2d signs, exact rectangle boundaries, complete
interval coverage and indexed disk checks. Each facet subpatch must be a disk
whose four side chains cover the clipped rectangle once with no gaps/overlaps.
All triangles have the facet's strict orientation. An oriented planar disk with
this boundary has degree one over the rectangle; strict triangle orientations
preclude overlap or a fold. This verifies every full subpatch, rather than
inferring internal creases from the whole-cell outer loop.

Every internal rectangle-side crease must carry a compiled curve membership
with the two true carrier planes and original extremizer occurrence ownership.
Spurious noncrease memberships fail. A Segment is checked as an exact straight
chart. A Traced curve checks both plane equations, every stored knot, all fixed
coordinates, strict free-coordinate monotonicity, samples.len=3*n and finite
0<=t_min<t_max<=n-1. Orthogonal axis-plane Newton corrections have zero free
component. Thus the declared chart is monotone; clamped declared tails cannot
pass. Stored interval endpoints are in this domain and their actual evaluated
payloads match the emitted mapped endpoints. Every membership is checked, with no duplicate same-curve interval or first-success shortcut. Intervals are strictly ordered,
continuous on the same curve and cover the entire exact required crease.

Face bends require the corresponding pin and original pair ownership. Recorded
pin.t must reproduce the actual pin payload. Every crease endpoint at a cell
boundary/corner must equal the corresponding FacePin.t or compiled corner
parameter **bitwise**, not merely after coordinate snapping. The open-arc
sampler now retains literal t_b at the last sample instead of recomputing
`t_a+(t_b-t_a)`, which can differ. Regression: t_a=1,t_b=2^-54 previously became
zero. Neighboring cells therefore anchor the same strict monotone map from
canonical curve parameters to exact target boundary events. Rounded coordinates
may move under this map, but two distinct parameters cannot masquerade as one
shared canonical event. Shared mapped face chains and complete internal crease
intervals glue the facet disk maps consistently, including the four genuine
cross-operand cut creases of the mandatory two-box model.

## Actual filling, lifecycle and cleanup

The common mesh_cells_subset verifier runs on ordinary fills, planar domains,
feature graphs, failed fills and the empty-segment early exit. An accepted
indexed complex has distinct triangle indices, edge incidence one at boundary
or two with opposite direction inside, connected vertex links of path/cycle
form, global connectivity, one boundary cycle and Euler characteristic one.
These conditions establish an orientable triangulated disk. Global connectivity
is essential: a disk plus a disjoint torus otherwise has Euler one. The target
is independently a disk and the exact ordered boundaries agree. A disk boundary
homeomorphism extends over its interior. Box subpatch checks strengthen that
extension to preserve its entire internal crease graph.

Witnesses snapshot triangle/index ownership, point key and all six binary64
position/normal components, ordered face maps and curve intervals. The final
assembly check compares empty curve-membership sets too: adding metadata to a
previously unmarked edge cannot escape the audit. New triangles involving only
boundary vertices also invalidate owners. No outside-scope per-cell empty
witnesses are retained.

Ordinary sliver cleanup has a stronger proved transport. The existing operator
requires exact coplanarity and a strictly convex identical oriented quadrilateral
in both f64 and f32, refuses protected edges and existing new diagonals, and
checks adjacency. The added internal journal is appended only after those checks
while executing that operator. Each 2-2 flip has a common refinement obtained by
intersecting the two diagonals. The identity on this quadrilateral, fixed on its
outer boundary, transports all old cell pieces/interfaces as virtual curves.
Composition transports them through the actual checked sequence, including
cross-cell flips. It does not require a new f32 theorem for the original mesh.

The transport capability has private fields and is created only with actual
execution. It binds pre/post oriented triangle bags, every used point key/full
payload, the entire curve-membership map and protected-edge set. Final output
must equal the recorded post-state. A cell's complete original triangle bag must
still occur once in the pre-flip state, so initial deletion passes cannot acquire
a proof from later flips. Unproved refinements, collapses, relocations or any
post-journal change withdraw affected certificates. Full-certificate trees have
no blends, so baseline surface_refine returns the same triangles immediately.
Quality edits remain enabled and their geometric assertions are unchanged.

A reduced actual flip crosses (5,12,13,20)/(5,12,13,19) through atomic face
(axis2,key6367592,len8), on x=-3. Exact Fraction replay finds both diagonal
intersection parameters strictly between zero and one and identical oriented
old/new area. This is a finite witness to the general operator proof, not a
whole-root box replacement for cell/interface correspondence.

Pre-assembly failed premises use existing local failed_cells/refinement paths.
Post-assembly withdrawals count once in unresolved validation, separately from
failedCells. They do not trigger an automatic serial recovery that would simply
repeat the same quality edit. PointTable::build_mesh is an injective first-use
index remap followed by f32 payload casts, with an explicit used-count<=u32::MAX
and checked allocation premise; it does not weld vertices or drop triangles.
The abstract incidence correspondence survives that final compaction.

## Necessary signed-box rejection

The separate original-tree sign algebra retains all signed occurrences and
nested min/max structure. Candidate plane events are filtered to the actual
edge and exactly deduplicated during insertion into a bounded 128-event set.
An event budget is not a total leaf cap. Each open interval is classified by
exact endpoint comparisons against every box, without rounded midpoint samples;
zero/inside/outside signs fold through all original signed paths. Endpoint roots,
ties, zero intervals and isolated same-sign tangent zeros remain visible.
More than one zero or a zero interval rejects the single-root representation.
Budget/arithmetic uncertainty is Indeterminate, not success or proved uniqueness.

The guard runs before discovery/smooth/corner exemptions and in shared/resumable
classification. The common cell mesher additionally checks every actual atomic
face edge and minimal segmentation subedge, including 2:1 face-interior edges.
Only actual failed cells have a ledger; a 4096 distinct-subedge budget is explicit
uncertainty. At depth ceiling these responsible cells remain unresolved. The
three-sheet control therefore fixes local responsibility without pretending to
implement a general multisheet mesher. Fine three-sheet output remains useful
legacy success outside the full certificate family.

## Workers and trust boundary

SFP5 carries lattice, original full-scope signature, f64 keyed payloads, actual
face-use records, owned cells/triangles, curve intervals and bounded failures.
Keyed merge requires complete payload equality. Duplicate certified cell IDs
and conflicting atomic face maps are rejected. After remapping, master rebuilds
the represented octree and FaceRecords, checks that actual merged triangles have
exactly the reported cell ownership, and reruns the independent target/filling
verifier. A serialized success flag or caller-fabricated target is not a premise. Every failed recheck records its noncertified result; after a successful recheck the complete lifecycle snapshot is rebuilt from actual merged vertices, keys, payloads and owned edge memberships rather than trusting the completeness of incoming snapshot arrays.
Final master assembly applies the same snapshot/checked-flip lifecycle.

The API has no original prepared leaf manifest, so it does not claim complete
intended-export ownership from a fingerprint. The claim remains per represented
cell. Hostile overlap between different-level supplied cells is not advertised
as a verified complete partition. Normal partition modes use the prepared leaf
list and are checked at 1/2/4/8 workers in both arrival orders. Signed-box failure
records outside the full theorem are negative evidence only; they cannot create
a positive certificate. Public coarse recovery is tested separately from raw
native merge.

## Cost and limits

There is no wall-clock speed claim. With N original box nodes and event budget
B=128, one edge's sign obligation is O(N*B) time and O(N+B) storage; duplicate
occurrences remain O(N), while event storage never grows with duplicate count.
The inherited n=256 primitive-work/scratch counters are unmodified. Atomic edge
work additionally has an explicit distinct-subedge cap. Unsupported blends
store no local witnesses and do not invoke the sphere/box filling verifier.

For supported cells, indexed checks and snapshots scale with represented
triangles/vertices/face subdivisions; ordered maps add logarithmic factors.
The current box canonical-parameter lookup scans the available face records,
so its worst-case cost is O(number of checked crease endpoints * face records),
not an asserted global linear bound. Worker proof payload and exact revalidation
are additional costs. Checked-flip transport temporarily stores global bags,
point payloads and an operation journal. None is an implementation of a new
scene-distance backend.

Unsupported transforms, curved CSG, general blends, exact degeneracies/contact,
multiple local disks and unproved quality rewrites retain explicit limits.
Step 2 checked bounds, original occurrence retention, quality rejection,
tolerances, depth ceilings and declaration behavior are preserved. No Step 4
claim is made.


## Consensus validation and provenance

The selected native toolchain is Homebrew Rust/Cargo 1.99; the matching WASM uses Rustup 1.96, `+simd128`, release opt3/LTO/codegen1 and wasm-pack 0.15. Node is 26.11.1. Commands are offline with one Cargo job. The final full-source logical digest is `c29db04aa3a0c6e49d05ff54dd3d27b20951cc9d6389135ca708cd2ea63dbad9`; [the source manifest](sfcc-step3/source-manifest.json) defines the path/hash serialization. Matching focused WASM SHA-256 is `64c7839cf14ce38f7e48a2274f198fed203701db22f16bd354888b8facd95c8d` (1,486,223 bytes). The app-built package is separately hashed `4c93e38f925d91cc303c18b05eba8822e4f65526283504054df8928d6415cf2e` (1,486,232 bytes). Its exported version is `v0.0.0-e028834-dirty`, whereas the unstamped focused package exports `0.1.0`: Makefile exports `VERSION` and `kernel/build.rs` bakes it as `GCAD_VERSION`. A controlled isolated rebuild with the app’s `VERSION` produced exactly the app hash and size. [The byte-identical comparison](sfcc-step3/version-provenance.json) closes this provenance difference without assuming equivalence from passing fixtures. Package and native executables are preserved under `/tmp/sfcc-step3-focused/`; the earlier `7328f7...` package and source manifest remain under its `pre-membership-fix/` directory.

Final native checks pass 176 default library tests and 197 serde/profile library tests, plus six coverage and six discovery integration tests, with zero failed or ignored assertions. An earlier integrated run additionally passed diagnosis 11, numerical 13, pruning parity 3, transforms 3 and worker partition 9; it preceded the final snapshot/membership validation fixes and is labeled earlier evidence. The coordinator repeated broad checks on final source; all passed. Repeated suites are not added as independent coverage.

All 23 tests in the final matching WASM focused matrix pass with zero failures, cancellations or skips. That matrix includes `sfcc-coverage-obstruction_test.mjs` as well as discovery, numerical-exclusion, scene-transform and quality `*_test.mts` files. The new controls compare oriented triangles with all eight vertex fields, curve parameters and validation through 1/2/4/8 real workers in both completion orders. Positive and fine-multisheet controls forbid recovery; coarse public recovery is explicitly separate from native raw coarse merges. Independent exact output oracles recheck fresh final-WASM sphere cone/manifold data and all six box rectangles, including 638 nonoverlap pair checks. The original signed-tree obstruction and actual-coefficient carrier counterexamples remain replayable independently.

Exact artifacts, commands and log hashes are recorded in [the validation manifest](sfcc-step3/manifest.json), with final logs preserved in its sibling `validation/` directory. Intermediate failures are preserved: the first snapshot assertion compared unordered curve memberships as a sequence (corrected to exact sorted tuples); the appended `end.next_up()` interval was genuinely accepted before the final fix; an out-dir flag placed after wasm-pack's Cargo argument boundary failed before compilation; and the isolated WASM checkout initially lacked three immutable Step 2 data files. These do not become passing runtime claims. The final focused runs and the coordinator broad gate are listed separately.

Useful replays:

```sh
python3 docs/research/sfcc-step3/check_flip.py
python3 docs/research/sfcc-step3/check_independent_mesh.py --witness docs/research/sfcc-step3/historical-coarse-witness.json
python3 docs/research/sfcc-step3/check_carriers.py docs/research/sfcc-step3/native-carriers.json docs/research/sfcc-step3/wasm-carriers.json
CARGO_TARGET_DIR=/tmp/sfcc-step3-consensus-native CARGO_BUILD_JOBS=1 RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --offline --release --jobs 1 --manifest-path gcad-wasm/Cargo.toml -p gcad-kernel --features serde,sfcc-profile --lib --test coverage_obstruction --test discovery_contract -- --test-threads=1
SFCC_COVERAGE_B_DIR=/tmp/sfcc-step3-evidence /opt/homebrew/bin/node --import tsx --test --test-concurrency=1 gcad-wasm/fixtures/sfcc-coverage-obstruction_test.mjs gcad-wasm/fixtures/sfcc-discovery_test.mts gcad-wasm/fixtures/sfcc-numerical-exclusion_test.mts gcad-wasm/fixtures/sfcc-scene-transforms_test.mts gcad-wasm/fixtures/sfcc-quality_test.mts
```

The historical-obstruction replay's successful exit proves the old defect, not a current successful reconstruction. Fresh positive-output scripts remain supplemental to the local runtime proof.

## Measured storage and accepted handoff

[Wire measurements](sfcc-step3/wire-bytes.json) use the same scene/tuning and record package hashes. For one worker, sphere partials grow from 689,314 to 4,036,022 bytes (+3,346,708); the clipped box grows from 61,368 to 279,400 (+218,032). Across eight workers totals are 4,094,014 and 294,567 bytes. The opaque round-plus-box control adds only 68 bytes per partial (544 across eight), with no outside-scope cell witnesses. Prepared-leaf buffers are unchanged. The final WASM adds 244,463 bytes over the 1,241,760-byte baseline.

This is substantial overhead. C's manifest-bearing alternative had lower positive wire cost, despite its stronger partition contract. B is selected for the narrowly scoped, execution-bound lifecycle argument and the reviewed integration, not because it wins byte counts. No wall-clock performance conclusion follows; reducing repeated work and serialization remains Step 4 after the correctness milestone is accepted.

No visual QA, browser work, generated `dist` inspection, expensive timing campaign, commits or pushes occurred during consensus. No tolerance, default depth, operator, transform or quality-operation switch was altered. The coordinator completed independent review and exact flip, historical-obstruction and carrier replays; all 62 frozen source hashes match. The final application build, 362 native workspace tests, all 36 WASM fixtures (both extensions), and 197 profiling library plus 23 integration tests passed, with no failures or ignored tests. Final broad logs and hashes are in the validation manifest. Native tests whose external TypeScript binary-oracle inputs are absent do not establish those missing comparisons. Earlier broad runs before the final membership fix remain labeled precursor evidence. Step 4 is authorized from this accepted milestone.

All consensus and coordinator validation processes have completed.
