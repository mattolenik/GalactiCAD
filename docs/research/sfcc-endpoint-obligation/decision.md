# Stage 2 consensus: local replay and source obligation

**Accept the bounded replay/source-obligation milestone. The original cell failure
is exactly reproducible, and the represented original source has a regular exposed
crease continuing past the stored endpoint. Hold a geometry repair until one
bounded feature-only provenance discriminator identifies where the actual compiled
trace lost that continuation.**

This is not a completed component repair or overall SFCC acceptance. Preserve A,
B and C as separately executed evidence; no combined production patch is selected.
Main runtime remains unchanged by this investigation.

## Reviewed inputs and execution

Reviewed the connected source, fixtures, handoffs and A's mathematical argument:

- [A handoff](http://md.localhost/tmp/sfcc-graph-stage2-a/evidence/handoff.md) and
  [source argument](http://md.localhost/tmp/sfcc-graph-stage2-a/evidence/proof.md).
  Manifest SHA256 `326a6a16784bc70b29c72ab2ebba5426bce532e25e590021a7d4c2b49dc8fa40`.
- [B handoff](http://md.localhost/tmp/sfcc-graph-stage2-b/evidence/handoff.md).
  Manifest SHA256 `ccfc46f90f5270f14de537311ed8b8b7f6dcb4440ffab0e57156383ea39f0d2d`.
- [C handoff](http://md.localhost/tmp/sfcc-graph-stage2-c/evidence/handoff.md).
  Manifest SHA256 `05a50d932f2906cc20692d79f3425322ece7b945b02a42f55d45649158346b47`.

Root evidence lives under
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round20-endpoint-obligation/`.
I independently verified the executed source hashes (A:158, B:158, C:157 inputs)
and each recorded executable hash against the actual binary. All builds and focused
jobs exited zero under the pinned Rust 1.99.0 diagnostic profile. A/B/C source
changes are test modules, fixtures and test-only accessors/declarations; the
original production function bodies remain unchanged.

| Check | Executed result | Accepted meaning |
| --- | --- | --- |
| A continuous source discriminator | Build 13.109 s; one test 1.096 s | Local represented-source continuation, with explicit interval and source premises |
| B exact replay and identity controls | Build 13.441 s; two tests 1.106 s | Actual early mesher path reproduces the recorded guard and query sequence |
| C exposure/branch discriminator | Build 16.630 s; one test 1.045 s | Numerical false-negative exposure witness and a separately scoped branch representation mismatch |

B's duplicate-key control intentionally catches an assertion panic; the printed
panic in its log is the expected negative control, not a hidden failed test.
No octree, full private constructor or full export was run in these local jobs.
Elapsed times are execution receipts, not benchmark evidence.

## A: continuous source obligation accepted within its stated interval

The ideal helix is bound to the actual same-root native extrusion, competing
lathe and cylinder occurrences. The existing `BranchCertificate` checks the
fixed-sign radial solution, profile side, caps, frames and inner-union competitor
using correlated bounds. The added code traverses and checks the complete original
binary ancestor structure and verifies pointer-identical registered leaves.
Equal coefficients from a different source are not substituted.

For the represented real source coefficients, write the local hierarchy as:

```
U = roundMin(L, E, 1.4)
A = max(U, C)
B = chamferMax(A, G, 0.7)
D = max(B, K)
F = roundMax(D, S, 0.8)
```

Along the ideal native helix, `E=C=0`. The executed bounds have strictly positive
margins throughout the outward height interval
`[2.6908777686167187, 2.69107776861672]` mm:

| Condition | Recorded lower margin, approximately |
| --- | ---: |
| Inner lathe beyond the inner-round competitor threshold | 1.0188084717334747 mm |
| Negated groove inactive for the chamfer | 4.1908777686167165 mm |
| Negated cap cutter inactive | 2.3089222313832787 mm |
| Sphere inside the outer-round inactive threshold | 0.003317998503392871 mm |
| Nonzero transverse determinant `2*u*nz2` | 14.510685717773635 |

The groove bound is justified by the implemented closed meridian profile:
strictly above every vertex, no winding crossing occurs, and distance to each
finite segment is at least axial separation. Negation makes the groove operand
strictly less than `-0.7`. The cap bound follows the implemented extrusion
`max(polygonDistance, abs(y)-h)`: below the lower cap it is at least the positive
axial gap before negation. The outer-sphere bound uses the helix's exact constant
radius, not a loose spatial-box radius. These are appropriate bounds for this
fixed, checked source; they are not generic claims about arbitrary lofts or warps.

Strict margins and continuity give an open neighborhood of each helix point where
all other operands are inactive and the full source reduces to `max(E,C)`. The
selected profile side is a regular local surface; the positive-radius cylinder is
regular; their transverse determinant excludes tangency. Both sheets of the local
max are present, so the crease is genuine and does not terminate at this height.

A separately checked interval strictly beyond the recorded endpoint is
`[2.6910277686167188, 2.69107776861672]` mm. The full enclosed helix image lies
strictly inside the failing cell. Thus the source obligation is local physical
continuation, not merely a surface root somewhere nearby.

The captured numerical corner is not an exact real zero. Its distance to the ideal
branch at the same height is bounded above by `8.068991924865286e-9` mm, below both
`curve_eps = 4.745819212738724e-8` and the unchanged association allowance
`3.796655370190979e-7`. The retained endpoint consumer agrees with the captured
point bits. Incoming curve knots approach from lower height. The active-outer-round
and inconsistent-branch controls reject as intended.

Accepted scope: the ideal real field of the fixed represented coefficients on
these intervals, using the retained interval library's premises. This is not a
floating-evaluator equivalence theorem, a GPU check, a proof through the later
round activation, or complete feature extraction. In particular it does not prove
that no disconnected compiled trace covers some later piece.

## B: exact early-path replay accepted

B rebuilds the original complete source and feature set, checks its fingerprint
and original chart-20/33 bits, performs the admitted private alias edit, restores
all 633 pre-call point records and numeric/string/unkeyed identities, and calls the
actual unchanged `mesh_feature_graph`. It reproduces:

- the exact `vertex_degree_lt_two` rejection at point 633 with neighbor 620;
- the same new `corner:27` point position/normal/key bits;
- the complete captured pre-call data and source-sharing partition;
- the same nine graph edges and single chart-20 membership;
- all six curve-query parameters, results and order (local indices `[0,6)`,
  corresponding to original run indices `[40,46)`);
- no appended triangles, no retained-unresolved flag and no numerical failures.

The injected cell-query wrapper records zero calls before this early guard.
This does not mean the replay performs no field work: source-bound curve queries,
carrier projection and domain operations still use the reconstructed source.

The code-path dependency argument is valid for this observed prefix. It reads the
loops/pins/corners, curve/source data, point keys/positions/normals and local graph.
It reaches the degree check before patch triangulation or metadata commitment.
The actual sampler emits no interior point; only the corner is inserted. Seeded
protection, curve metadata, patch ownership and coverage state leave the result
unchanged. The mismatched-pin-chart control rejects earlier without queries;
duplicate keys refuse restoration, while equal unkeyed payloads preserve distinct
IDs. Process-local root addresses are normalized by equality partition, and the
large source sentinel is preserved as text in the replay fixture.

Accepted scope: exact replay through this guard. The outer octree classification,
whole-cell fallback, previous-cell triangles, complete private replacement and
later graph paths are not reconstructed or validated by this test.

## C: exposure counterexample accepted; causal limits retained

At the endpoint the default classifier says alive. At all five predeclared positive
advances, both carrier domains remain true, the full-field residual remains tiny,
and the default classifier returns `Ok(false)` while the 1/32-probe diagnostic
returns `Ok(true)`. The cylinder flank is the failing default flank. For example,
at about 0.002 mm positive advance the full-field residual is approximately
`3.55e-15`; both domains are true and the carrier normal gap remains about 1.155.
The smallest positive probe's height lies within A's certified neighborhood; do
not extend A's continuous theorem to all five farther probe points.

This is a real implementation counterexample to treating failure of that finite
probe search as evidence that exposure is absent. It uses an explicitly constructed
test-only continuation of the original supporting pair and existing native APIs,
not a new scene evaluator. Numerical samples do not by themselves establish the
continuous crease; A provides that separate obligation. Reducing the global probe
factor until a particular example passes would not be a justified general repair.

C also demonstrates a distinct source representation issue at the intervening
chamfer. The actual field there takes its left child, around zero, whereas the
forced diagonal is approximately `-3.16642277`. Both tested deeper lifted branch
overrides evaluate to `-0.80338835` at a point where the full root is approximately
zero. Reading `sample_override` confirms that deeper propagation through the
chamfer forces its diagonal formula. That representation cannot stand in for the
inactive-chamfer child alternative in this region.

However, the observed endpoint is still in the native region, and lifted ownership
explicitly excludes a native-zero band. This mismatch is not yet the demonstrated
cause of corner 27's position. Its effect on the later displaced continuation is a
separate obligation, not permission to blend two speculative repairs.

The symbolic terminal-crease examples in B/C correctly disprove a universal
feature-degree-at-least-two theorem from manifoldness alone. Their vanishing normal
jump distinguishes them from this source's transversely meeting sheets. Restoring
a duplicate canonical edge/label cannot add a distinct neighbor, and deleting the
guard does not turn the boundary cycle with an interior slit into the closed patch
boundaries expected by later meshing.

## What remains before choosing a geometry patch

The replay and local source-obligation exits pass. **Actual upstream loss
localization remains open.** None of these tests records the compilation lineage
that produced chart 20's terminal sample and corner 27. A numerical exposure
counterexample near that point is strong evidence, but does not distinguish an
already-short raw trace, finite-probe trim cutoff, transition refinement, corner
merging or curve remake/wiring as the first executed loss.

Approve one next bounded, feature-only provenance package, with three independent
proposals followed by fourth review. Reuse the original source/fingerprint and
existing compile path; no octree, private reconstruction, browser or full export.
Root executes only the selected observation under the existing 60-second focused
budget after its controls pass.

The minimum lineage record must join the actual final chart-20/33 endpoint to:

1. its raw traced curve and original carrier/source occurrences, including whether
   the raw indexing span extends into A's certified positive-height interval;
2. the actual trim run's parameter boundary and last-alive/first-dead decisions,
   including the already executed flank/domain/normal outcome responsible for any
   dead result;
3. the point before and after `refine_transition`, including why it terminated;
4. corner candidate merge/selection and final `remake_curve`/incidence wiring.

Follow stable source/geometry lineage rather than assuming raw/final curve IDs are
interchangeable. Record already computed values; do not reevaluate source queries
inside the observer. Bound the selected pair/endpoint events, preserve the source
fingerprint/compiled curve and corner outputs exactly, and stop on missing lineage
or truncation. If the first loss is already in raw tracing, the stop reason there
becomes the focused next predicate instead of pretending trimming caused it.

This is a continuation of the stage-2 causal discriminator, not a new whole-scene
investigation. Commit the accepted replay/proof/control evidence now, preserving
these open exits, before beginning that package.

## Precise subsequent repair contract

Once provenance locates the first loss, compete on a source-level repair satisfying:

- a known regular exposed branch may not become a declared terminal/dead trace
  inside the certified interval merely because a finite flank schedule found no
  surviving sample;
- preserve both source occurrences, branch sign, endpoint/parameter ordering and
  every genuinely distinct incident feature;
- when survival/termination cannot be established within the bounded method,
  report unresolved rather than fabricate absence or publish a fallback fan;
- demonstrate that the actual compiled source graph covers the required positive
  interval and remains consistent with the recorded boundary pin; a test that only
  accepts a manually constructed continuation is insufficient;
- keep true terminal creases, inactive/capped extensions, nearby distinct curves,
  wrong-source identities and insufficient budgets as adversarial controls;
- do not restore duplicate alias geometry, relax the degree guard, nudge the
  endpoint or silently widen tolerances.

The outer sphere's activation threshold lies within this cell's height range
on the supporting cylinder; the full-source handoff there remains to be certified.
Extending the native endpoint by this short interval alone does not close the component.
A justified handoff to the displaced continuation may still be necessary; that
source obligation must be established separately and C's chamfer issue investigated
in its actual active region. Preserve the original complete-component, f64/f32,
feature-transport, contact and current native/WASM gates before production integration.

I performed static source review, exact stored-data/hash checks and receipt review
only. No builds, geometry evaluations, runtime edits or new captures were performed.
The accepted result is a bounded source/replay milestone; the first executed
compiler loss and every meshing/publication exit remain open.
