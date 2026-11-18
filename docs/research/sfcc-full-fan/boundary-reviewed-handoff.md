# C: full-fan root graph and actual boundary-interface challenge

Selected corrected source: `/tmp/sfcc-fullfan-c-reviewed`, copied from round34 `/tmp/sfcc-ownership-clamp`.
Only three inputs differ: the new `fullfan_boundary_c.rs`, compact captured fixture
`fullfan-boundary-c.json`, and a four-line child-module declaration in `exposure_a.rs`.
Selected hashes are in `/tmp/sfcc-fullfan-c-reviewed-changes.json`. The initial executed source remains frozen at `/tmp/sfcc-fullfan-c`. A also edits the module parent;
merge the declaration rather than replacing A's complete parent file.

No cargo, tests, scene evaluation, curve query or geometric computation was run by
C. Work was static source inspection, extraction of recorded fixture fields, code
writing and hashing. Root must execute the candidate.

## Review correction: actual adaptive record length and extent

Root's initial C execution compiled and passed both tests, with a strict lift-to-X-
plane gap approximately [2.2372495038780467e-6, 2.237249521641616e-6]. Root then found
that C's initial fixture had copied the correct axis/key but invented length 1.
The actual parent frontier record is **[0,3464532,2]**. The plane theorem itself
does not depend on length, but claiming the actual adaptive face without checking
its true extent was incorrect.

The selected revision copies the complete actual parent frontier record: selected
consumer [7,25,58,86] on side 1, outside consumer [7,26,58,86] on side 0, original
segments [4072,4074] and [4074,4073], and original-to-private bindings 4072→38,
4074→40, 4073→39. `bound_record` requires the supplied face triple equal the
captured record; checks the integer face rectangle fits both actual lattice-cell
extents on opposite sides; and binds directed edge 40→38 to the first original
segment with orientation determined by the selected consumer's side.

Both endpoints must fit the actual world face rectangle expanded by the unchanged
original traced pin 49 allowance, 8*curve_eps, with outward interval arithmetic.
This allowance is reported and required below 1% of the original surface tolerance.
It accommodates represented pin/lattice rounding; it does not grant source-root
or face ownership. The exact original plane is still used in the gap theorem.

Two new assertions reject length 1: first an identity mismatch against the captured
record, then a coherently shortened record with the same supplied endpoints, whose
actual rectangle no longer contains endpoint 38. Thus the correction is not merely
a rewritten metadata number. No source positions, source graph expression or
numerical allowance were changed. The static rustfmt parser reports only format
differences; C has still run no build, test or geometric evaluation. Root must
execute the selected corrected source and preserve the initial result separately.

## Executable discriminator

Filter: `fullfan_c_` (two tests). Set `SFCC_FULLFAN_C_RECEIPT` to retain the actual
source/plane/gap receipt.

The actual first fan contains boundary edge 40→38. The recorded original cell loop
contains the same directed edge. Point 40 carries the original pin provenance
`F0:3464532:49:...`; point 38 has the positive-X cell-plane coordinate. The fixture
retains the original preGraph cell-box bits, pin chart/parameter and point payloads
from the round34 selected receipt. Its parent receipt SHA is recorded. It is not a
new manufactured CAD geometry.

The test rebuilds the original pipeline lattice from the original scene/cube,
checks its cell-box bits, derives the X-face plane from the actual packed face key,
and checks that plane equals the original cell's positive-X plane. It also checks
the pin's formatted provenance key, actual loop membership and bit identity with
the existing first-fan fixture.

It encloses the exact dyadic Y/Z midpoint of that edge using outward interval
arithmetic, then invokes the existing composed-source cylinder graph certificate.
The positive premise must establish that this particular lifted point belongs to
the full composed zero set. The resulting X enclosure must strictly exclude the
original face plane. The test reports interval bounds for distance to that plane
and, separately, distance to the original edge midpoint under this same-Y/Z lift.
It requires the latter upper bound to remain below the unchanged surface tolerance.

This is an executable proposed discriminator, not a claimed successful result yet.
If root's execution refuses or finds no strict separation, preserve that result.
The second test checks strict finite separation, including equality at either
plane-container endpoint and invalid/nonfinite bounds.

The first-fan proof fixture is a hash-bound recorded witness, not an independent
fresh FaceRecord capture. Plane identity is rebuilt from the original lattice and
recorded pin provenance; the directed edge comes from the original captured cell
loop. A later actual component capture must match these fixture bits before calling
it a witness of a changed candidate.

## What it would and would not disprove

A unique composed-source root graph over the exact projected mesh domain can be a
valid homeomorphic source disk within a displacement bound. It does not follow
that its boundary remains on the original cell faces or original feature curves.
An X-directed lift automatically keeps Y/Z faces fixed but generally moves an
X-face boundary; this test targets the actual first X-face boundary rather than a
synthetic box example.

A positive gap proves that this chosen lift does not preserve that exact face
plane. It does NOT prove mesh invalidity, tolerance violation, absence of a nearby
face-compatible transport, or inability of neighboring consumers to share one
common moved source boundary. Exact cell-plane preservation is a sufficient
interface strategy, not a necessary requirement for every valid approximation.

To claim global source coverage, one must either supply face/feature-compatible
boundary transport or prove agreement of the chosen boundary maps across adjacent
patches, including no gap/overlap and correct endpoint/junction incidence. A local
root-graph certificate alone cannot inherit those facts from the mesh's matching
original boundary indices.

## Independent mathematical audit of A/B's route

1. The graph argument needs one coherent source branch across the entire domain.
   A common WORLD-X slab with a uniformly monotone reduced zero field suffices.
   Independent narrow slabs with separate unique roots would not automatically
   glue; shared Y/Z points could select different roots unless overlap/identity is
   separately proved. A has agreed to use a common slab.
2. The actual full field need not itself be globally strongly monotone on the
   slab. For this source, signed groove `G=-D` has an opposing X derivative.
   Where G stays strictly negative, it can be removed for a ZERO-SET argument,
   not silently removed from a claim that the fields are equal everywhere.
3. With the inner round inactive on the whole slab, I=E and H=max(E,C). Expanding
   the chamfer yields the reduced field
   `K=max(E,C,w*(E-D+rC),w*(C-D+rC))`, provided the negative groove, cap and outer
   terms are handled with source-bound zero-equivalence premises. Uniform negative
   X derivatives of all four K branches imply strong monotonicity even across max
   switches. The original full field and K must have equivalent zeros throughout
   the slab, not only on the old cylinder graph or at test samples.
4. For the outer round, a sphere operand below minus its radius can alter deeply
   negative values while preserving signs and zero equivalence. A should not claim
   exact ancestor inactivity/equality over the whole slab if only zero equivalence
   is established. The opposite K end signs, continuity and monotonicity then give
   existence and uniqueness of the full source root for every admitted Y/Z point.
5. Finite native-profile, cap, twist-clamp and nearest-meridian premises must hold
   throughout the actual X slab. The previous fixed-radius cylinder proof is not
   enough for an off-cylinder slab where rho changes with X.
6. B's exact projected disk and shared-edge continuity checks are independent of
   the source theorem. A coherent root graph over that disk can be homeomorphic
   to it. A uniform X-error bound controls Euclidean distance for the same-Y/Z
   correspondence, but not by itself the intended cell-trimmed or feature-trimmed
   source patch boundary.
7. Working-f64 and exported-f32 graph claims must be distinguished. A Hausdorff
   error bound can transfer through a barycentric correspondence to the rounded
   triangle with a proved rounding bound. That does not pretend the two projected
   domains coincide or prove a rounded embedding without B's separate checks.

No new general evaluator, tolerance, budget, dependency or production path is
introduced. The new test only exposes the interface limitation of the already
proposed local graph theorem. Parent should keep full ownership/publication false
unless the additional intended-boundary obligations are actually established.

## Static review of A's full source implementation

After preparing the corrected boundary discriminator, C read A's
`fullfan_source_a.rs` without running it. No additional concrete algebraic blocker
was found in that version. The convex-profile inside-ball bound is a valid upper
bound on the actual signed native extrusion field; it removes native and its
chamfer term only when both are strictly negative over the whole slab. The active
case instead proves the finite native-side expression and cap dominance. With
negative groove/cap and outer sphere below minus the round radius, the reduced
max field has the same zeros/sign as the full source even where negative values
differ. This is correctly weaker than claiming the full field itself is globally
strongly monotone.

The native Hessian Frobenius expression and the rho Hessian bound 1/rho support
the interpolation remainder. For a triangle, the barycentric variance identity
gives sum(lambda_i*|v_i-p|²) <= diameter²/3, so the second-order remainder is bounded
by M*diameter²/6. The sign of the computed E_yy expression is reversed relative to
the analytic derivative, but only its squared magnitude is used in the Frobenius
bound; that does not invalidate the norm bound. The common X slab and full binary
midpoint subdivision establish root coherence and closed-domain cover. Midpoints
are interval enclosures of exact dyadic constructions; choosing an edge by an
upper-bound length does not affect the covering property.

These static findings do not substitute for root execution, B's independent
projected-domain embedding checks or the outstanding interface transport proof.
