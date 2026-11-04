# A: local source obligation beyond the captured endpoint

This is a proof argument for the **real field of the represented source
coefficients**, conditional on the interval/source checks in the authored focused
test passing. It is not an assertion that the test has executed, an independent
GPU reference, a floating-evaluator parity theorem, or a constructed mesh.

## The endpoint is not the outer-round activation point

The captured corner is approximately
`(-6.721694817707532, 2.6909777686167193, -8.453331815184598)`.
Exact rational arithmetic on its binary64 coordinates gives:

- `x²+z² - 10.8² = 8.401608207427055e-12` approximately;
- `x²+(y+8)²+z² - (16-0.8)² = -0.10299435093465448` approximately.

Thus the saved numerical point is close to the cylinder and strictly **before**
the sphere's round activation threshold. This alone does not prove the full
surface obligation: the other source operators must also be accounted for.
The exact rational values and input bit strings are recorded separately.

## Supporting branch and source binding

Reuse the existing `HelixBranch::identify` and `BranchCertificate::bind` from the
reviewed correlated source layer. They derive a fixed-sign intrinsic coordinate
`u = sign*sqrt(R²-v²)` from the actual cylinder radius and selected horizontal
polygon side. The supporting branch is

`H(y) = (u*cos(theta(y)) - v*sin(theta(y)), y,
         u*sin(theta(y)) + v*cos(theta(y)))`

with the actual source translations included by the existing implementation.
The old branch certificate already checks the finite-cylinder caps, extrusion
caps, strict selected polygon edge/profile restrictions, nonzero fixed-sign u,
coaxial identity frames and the inner round-union competitor margin. It encloses
trigonometry with the existing Taylor-remainder interval implementation; this
new test does not introduce a new curve oracle or rely on sampled points for
continuous coverage.

The test obtains the whole immutable source from the selected native stratum's
plain domain. It checks the complete binary ancestor structure and that the
native extrusion, inner lathe and cylinder are **pointer-identical occurrences**
to those bound by the existing certificate. Equal coefficients from an unrelated
root are not substituted. All new root-access helpers are test-only.

## The full ancestor path

Write E for the selected extrusion-side field, C for the finite cylinder, L for
the inner lathe, G for the negated groove lathe, K for the negated cap extrusion,
and S for the outer sphere. The actual ancestor expression is

```
U = roundMin(L,E,1.4)
A = max(U,C)
B = chamferMax(A,G,0.7)
D = max(B,K)
F = roundMax(D,S,0.8)
```

On H(y), E=C=0. The following strict inequalities make every other operand
inactive:

1. The existing correlated certificate gives L>1.4, so U=E in a neighborhood of
   the branch.
2. The groove's closed meridian profile lies below its greatest vertex height.
   Above that height winding is outside and distance to every finite segment is
   at least axial separation. With the actual negative leaf sign this yields
   G<-0.7. Since chamferMax(A,G,r)=max(A,G,(A+G+r)/sqrt(2)), B=A near A=0.
3. The cap extrusion's lower cap is above the interval. Its unsigned field is at
   least the positive axial gap, so its negated field K<0 and D=B near B=0.
4. The exact helix preserves cylindrical radius R. The outward interval test
   `R²+(y-sphere_y)² < (sphere_radius-round_radius)²` proves S<-0.8.
   Therefore the outer roundMax reduces to D near D=0.

All inequalities are strict and the functions are continuous, so at every point
of the interval they hold in an open spatial neighborhood. There the complete
source reduces to `max(E,C)`; there is no blending transition or cutter boundary
on this witness.

The transverse determinant of the radial-squared equation and twisted-side
field is `2*u*nz2`. Its interval excludes zero. Thus these two regular surfaces
meet transversely. Both are active sides of the local max, producing a genuine
crease rather than a vanishing normal jump. H(y) continues smoothly in both
height directions; a degree-one representation is not a legitimate geometric
termination on this neighborhood.

## Captured numerical point versus ideal branch

The chosen interval is the outward-rounded
`[captured_y - 1e-4, captured_y + 1e-4]` mm. A separate positive interval is
`[captured_y + 5e-5, captured_y + 1e-4]`. The entire enclosed branch image must lie
strictly within the actual failed cell box.

The captured corner itself is not assumed to be the exact real zero. The focused
test encloses the ideal branch point at the same height and computes an outward
upper bound on their distance. It must be below the unchanged `curve_eps` and
the existing association allowance. The existing final-piece endpoint consumer
also associates the recorded numerical endpoint with that source branch.

The original curve approaches this endpoint from lower height and its original
incident endpoints are only charts20/33, both at end1; those charts represent the
same physical branch. After legitimate alias removal only chart20 remains. The
source proof requires physical continuation beyond the recorded endpoint. It
**does not locate which tracing, trimming, branch propagation or wiring stage
lost that continuation**, and does not prove that no other unconnected compiled
trace happens to cover some of it.

## Controls and limits

The authored test rejects this native-only certificate on a height interval near
y=3 where the outer sphere round is active, and rejects a corrupted fixed-branch
sign. It verifies the original source fingerprint/occurrences, actual captured
corner bits, incoming curve endpoint and cell containment before making the
bounded claim. The positive and negative results must be established by root's
execution; this document records the derivation, not invented margins.

No theorem beyond the stated height intervals follows. In particular, the
behavior through the later outer-round transition, its lifted seam, full feature
compilation completeness, mesh embedding, output rounding, native/WASM agreement
and GPU scene agreement remain separate obligations. Accepting the fallback fan
or deleting the endpoint constraint would not satisfy this source obligation.
