# Upper source candidate A: full-scalar rounded continuation theorem

Frozen source: `/tmp/sfcc-upper-a-controls`, parent `/tmp/sfcc-stage4-c`, common flat-patch
baseline `/tmp/sfcc-stage3-base`. No main runtime changes. The new theorem and
its tests are test-only. Author performed source inspection and rustfmt parsing;
root owns every build, geometry evaluation and acceptance decision.

## Mathematical contract

The same immutable native/parent-field/cylinder source occurrences and the actual
ordered binary ancestor class are bound through existing source helpers. At the
outer round intersection, write R for cylinder radius, Rs for sphere radius,
ys for sphere axial center, and r for the round radius. The proposed outgoing
curve is parameterized by angle phi:

- a = r (cos(phi) - 1)
- b = r (sin(phi) - 1)
- rho = R + a, q = Rs + b
- y = ys + sqrt(q^2 - rho^2)
- v = v0z + a/nz, u = sign sqrt(rho^2 - v^2)
- Rotate (u,v) by the actual extrusion twist at y, then add its source position.

The requested angle interval is bounded inside [0,0.5]. This is a deliberately
restricted initial continuation, not a claim about its eventual terminal point.
Every interval inequality is checked with the retained outward arithmetic and
Taylor trig enclosure. The source field is not reimplemented as a CPU oracle.

The proof establishes FULL SCALAR operand equality, not merely equal zero sets:

1. The selected horizontal polygon edge has an interior projection and is strictly
   nearer than every other finite edge over the full intrinsic box. The selected
   signed distance is a, including a<0. The native cap field remains strictly
   below a, so the full finite extrusion E equals a.
2. The finite cylinder cap remains strictly below a, so C=rho-R=a.
3. The inner lathe is strictly beyond its round-union radius. Since E=a<=0,
   the complete round-union parent is exactly E on this source interval.
4. Above all closed groove-profile vertices, the negative groove field has a
   conservative upper bound. Both that operand and the actual represented-weight
   chamfer diagonal remain strictly below a. This checks nonzero-level dominance,
   rather than reusing a zero-level inactivity statement.
5. The negative cap cutter is strictly below a. The outer sphere field is b by
   the correlated radial/axial construction.

Thus the full source locally reduces to RoundMax(max(E,C),S). On this ideal curve,
(r+a)^2+(r+b)^2=r^2, so the root vanishes. Both lifted branch fields are regular:
the cylinder branch has radial derivative at least cos(phi)>0, while the extrusion
branch has angular magnitude at least cos(phi)*|u|/rho. A projected transverse
minor is bounded below by cos(phi)^2*|u|/rho>0. Because RoundMax is locally strictly
increasing in its hard operand, max of the two lifted fields describes two exposed
flanks meeting in a genuine continuing crease.

Height derivative is
r*(q*cos(phi)+rho*sin(phi))/sqrt(q^2-rho^2), strictly positive. Hence the ideal
curve is ordered and injective in height on the admitted interval. At phi=0 it
meets the incoming fixed-radius native helix; its radius/v derivatives vanish,
so the outgoing tangent is the incoming helix tangent scaled by positive y'.
This is a geometric source handoff, not an attachment operation on numerical
curves or proof that existing raw query parameterizations agree.

## Root validation to execute

Run `upper_a_` (two tests) with `SFCC_UPPER_A_RECEIPT` set to a fresh JSON path,
using the existing pinned Rust1.99.0 no-LTO/codegen16 profile, offline/locked,
serde/sfcc-profile, fresh kernel cache, nonzero discovery, build120s/focused60s.

The main test compiles the exact original pipeline context and uses C's source
selector. It requires the interval phi=[0,0.01] to be proved, ordered and long
enough to cross both CURRENT numerical upper cutoffs. It bounds the final-source
residual on the ideal native zero extension at those heights strictly positive,
showing that extending the original E=C=0 carriers is not the required outgoing
zero set. Four source-derived sample points are checked using the EXISTING root
field evaluator; those samples corroborate the theorem but do not supply it.

The receipt includes source identities, transition-height enclosure, complete
source margins, height/transversality lower bounds, source-derived samples and
current cutoff positions. Optional phi=[0,0.5] admission is recorded separately:
if it succeeds and its end height exceeds3, the theorem covers a unique ideal
outgoing point at y=3. Refusal is retained, never remedied by weaker inequalities.
No numerical association of a separately proposed y=3 point is claimed.

Controls reject empty/unsupported angle scope, wrong root coefficients, wrong
branch sign, mixed equal-but-distinct source occurrences, and finite native or
cylinder caps that dominate during the requested outgoing interval. These controls
use freshly compiled mutated source trees, not a CPU duplicate scene evaluator.

## Limits

There is no runtime repair, outgoing FeatureCurve registration, numerical trace
trimming, corner creation, parameter transport or complete private admission.
The Stage4 mandatory admission gate must remain unchanged and is still expected
to fail until an independent implementation establishes those obligations.
The finite caps, profile nearest-edge domains or other ancestors may change later;
this theorem does not claim a nominal sphere-only terminal is the actual terminal.
No component, f64/f32 mesh, native/WASM, GPU or visual acceptance follows.

## Compile-only correction

The original frozen A failed to derive Debug for Image because Interval does not implement Debug. This revision changes exactly that derive to Clone,Copy; no shared Interval type, proof equation, test or runtime behavior is changed. Root must rebuild and rerun. No author build/evaluation was performed.

## Finite-cap control correction

The first mutated-cap control changed CsgNode::Leaf.shape directly but retained the old immutable Leaf.strata descriptors. The existing source-binding guard correctly rejected that incoherent source before the intended cap predicate. This test-only correction rebuilds each mutated scene through the real scene bridge, derives the branch proposal from its new twist/height coefficients, and first requires the zero-level activation to remain inside both caps. It then requires the full outgoing interval to reject. The actual source theorem and normal receipt are unchanged. No author build or geometry execution.
