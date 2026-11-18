# Complete face-polyline correspondence and the remaining curved transport

**The captured chain 39→40→38 covers the complete ideal source contour on original
face [0,3464532,2], exactly once and in order, under a standalone one-dimensional
correspondence.** Its whole exported error is at most **0.000020955268988113107 mm**,
below the unchanged **0.01 mm** limit. This binds the actual complete original
FaceRecord and both emitted consumers, not just a selected pair of fixture edges.

That correspondence agrees with the adopted ideal feature at point 40, but **it is
not the restriction of round39's current two-dimensional map**. Two independently
checked obstructions explain why: that map fixes the wrong outer endpoint Z
coordinates, and an affine projected chamfer edge cannot equal the curved ideal
branch. These are limitations of the proposed correspondence, not a demonstrated
mesh tolerance failure. Round39's three feature-arc adoption result remains valid.

All **86 focused Rust tests**, six provenance corruption controls, library validation
and fresh runtime preservation pass. Production code and mesh coordinates are
unchanged; publication remains blocked.

[Independent review](decision.md) · [Numerical results](summary.json) ·
[Previous boundary adoption](../sfcc-boundary-adoption/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## Complete discrete provenance

The original face has exactly two segments and one feature pin. Its recorded
segments 4072→4074 and 4074→4073 map to joined nodes 38→40 and 40→39. Reversing their
orientation gives the increasing-Y chain39→40→38.

| Original point | Outside-local point | Joined point | Role |
| --- | ---: | ---: | --- |
| 4073 | 1 | 39 | Lower-Y face boundary |
| 4074 | 2 | 40 | Curve49 feature join, strata 31/15 |
| 4072 | 0 | 38 | Upper-Y face boundary |

The fresh runtime binds exactly one original FaceRecord, its entire segment/pin
inventory, absence of an interior cycle, and its original zero consumption state.
Both opposite consumers are bound: selected cell [7,25,58,86], side 1, and outside
cell [7,26,58,86], side 0. Their original-stage replay validates actual consumption.
Each emitted shared edge occurs once in each relevant fan, with opposite directions.
Exact triangle order, keyed point identity, position bits and fan source identities
match the fixtures used by the source theorem. The entire 44-triangle incident
capture also matches.

The [provenance checker](provenance.py) rejects six corruptions: duplicate original
face, an additional segment, incorrect joined mapping, a one-bit point change,
reversed emitted triangle and incorrect source identity. Its [receipt](provenance-C.json)
records all input hashes. It compares discrete data only; continuous source geometry
comes from the separate proof below.

## A whole-contour homeomorphism and error bound

The existing exhaustive face theorem is rerun against the original represented
source and face. It proves exactly one source root for every closed Y fiber, with
one chamfer branch followed by one cylinder branch and a unique shared feature join.
There are no additional contour components. This uses **10 of 128 source checks**,
five accepted strips, and the existing face-checker depth 16 cap. This is separate
from the 44-triangle source-graph checker with its 128/depth12 limits; neither budget
is reset or enlarged.

Both working and f32-exported chain vertices have strictly increasing Y. Point 39
has exactly the represented face's lower Y; point 38 has exactly its upper Y. Map
each mesh edge's affine parameter to the corresponding ideal Y interval: lower
boundary→ideal join, then ideal join→upper boundary. Strict order and the unique
root graph make this a continuous bijection onto the entire closed contour. Its
inverse is continuous because both curves are compact. This establishes whole
coverage without assuming finite samples prove the unsampled parts.

On the chamfer branch, write

`rho(Y) = aY+b`, `a = ny/(1-nr) > 0`,

`Z(Y) = centerZ + sqrt(rho(Y)^2-c^2)`, `c = faceX-centerX`.

Then

`Z''(Y) = -a^2*c^2 / (rho(Y)^2-c^2)^(3/2)`.

The interval lower bound on the positive denominator gives a uniform second-
derivative magnitude bound. The chord remainder is at most `M*(deltaY)^2/8` on
the entire branch. Add the enclosed endpoint-association error and same-barycentric
f32 rounding error. The cylinder branch is straight, so its curvature remainder is
zero. L1 endpoint/rounding bounds conservatively bound Euclidean error.

| Captured edge | Ideal branch | Curvature remainder upper bound | Exported pointwise error upper bound |
| --- | --- | ---: | ---: |
| 39→40 | Chamfer | 0.000000101732 mm | 0.000020955269 mm |
| 40→38 | Cylinder | 0 mm | 0.000007923987 mm |

Displayed table bounds are rounded upward. The exact receipt maximum is
2.0955268988113107e-5 mm. It is checked against the smaller of the original surface
tolerance 0.01 mm and half the original chord tolerance 0.02 mm. Larger supplied
surface/chord limits, a missing segment and changed point bits are rejected.

The map has the same ideal point 40 as round39's adopted feature arc. Identity follows
from the same admitted physical source, original X-face, rho=R and groove=r
constraints, and the unique face branch join. Equal interval enclosures are a
consistency check; they are not treated as an identity theorem.

## Why the existing two-dimensional map cannot adopt this contour

Round39's 44-triangle projected disk still has nodes 38/39 on its outer boundary.
Its transport fixes them, and its source lift preserves their YZ coordinates.
The exhaustive face theorem gives a unique ideal face root at each endpoint Y:

| Node | Retained Z | Ideal face-root Z enclosure | Strict positive retained-minus-ideal gap lower bound |
| --- | ---: | --- | ---: |
| 38 | 5.431920990801739 | [5.4319133015149506,5.431913301514966] | 0.000007689286773526758 mm |
| 39 | 5.42950236902782 | [5.4294818831714915,5.429481883171608] | 0.00002048585621228227 mm |

The intervals are disjoint, so a fixed-YZ lift cannot send either endpoint to the
ideal face root. This is exact nonidentity established by positive interval
separation, not a tolerance-based guess. It does not invalidate the already adopted
feature arcs or prove a geometric error-limit failure.

Endpoint motion alone is also insufficient. The independently bounded chamfer
second derivative lies in

`[-0.1559264965917958, -0.15571720411240936]`.

It is strictly negative over a nondegenerate branch. Therefore the ideal projected
chamfer is not a straight segment; an affine projected edge with even ideal endpoints
cannot equal it. Finite piecewise-linear refinement can approximate it but does not
supply exact identification. The existing mesh can remain polygonal: the required
curvature belongs to its mathematical correspondence with the source.

The [independent discriminator](Combined/polyline-B.json) checks both facts using
a fresh exhaustive face proof and a fresh audit of the 44-triangle projected disk.
Controls refuse to infer strict nonidentity from touching/overlapping intervals,
or curvature from flat/degenerate inputs.

## Execution and preservation

A implemented the standalone contour/error certificate. B independently checked
boundary incompatibility and curvature. C audited original-record provenance and
implemented the discrete validator. A fourth agent reviewed their arguments,
source bindings and saved executions. The coordinator ran builds/tests/geometry
serially with the pinned Rust compiler, verified library hashes, locked/offline
Cargo and unchanged diagnostic profile.

| Validation | Result |
| --- | --- |
| A-check | One focused test passes, including four fail-closed controls |
| B-check | Two focused tests pass, including overlap/flatness controls |
| Combined source | 231 manifested inputs; all hashes unchanged after execution |
| Combined focused campaign | 86 distinct tests pass in 42.730 seconds, within 60-second cap |
| Final provenance checker | Six corruptions rejected |
| Non-test library validation | Pass, 2.914 seconds |
| Original-scene component replay | Pass, 36.983 seconds, within 120-second cap |

The entire parent runtime receipt is unchanged after excluding process-local source
addresses and sorting only unordered interval/membership metadata. The round39
adoption proof receipt is exactly unchanged. The candidate remains 1775 triangles,
1929 validated generated queries and 8413 charges; live state is preserved. New
face certificates add no geometry-query charges or mesh mutations. Source interval
work remains explicitly counted.

The selected result is the composition of the fresh contour proof, original-record
binding and explicit compatibility discriminators. It is not a repaired 2D map.

| Evidence | Purpose |
| --- | --- |
| [Polyline certificate](Combined/polyline-A.json) | Complete ordered contour and whole-edge error bounds |
| [Compatibility discriminators](Combined/polyline-B.json) | Fixed endpoint and curved-branch obstructions |
| [Provenance](provenance-C.json) | Complete original inventory, consumers, source identities and six controls |
| [Fresh runtime](Combined/component-attempt.json) / [summary](summary.json) | Preserved geometry/costs and final proof bindings |
| [Consensus](decision.md) | Independent mathematical and execution review |
| [A](polyline-handoff.md), [B](compatibility-handoff.md), [C](provenance-handoff.md) handoffs | Independent approaches and limitations |
| [Restoration](preservation.json) / [receipt index](receipt-index.json) / [runner](run.py) | Source/binary provenance and bounded execution |

Restore the 229-input [round39 selected source](../sfcc-boundary-adoption/README.md),
then apply [Combined-packet/candidate.patch](Combined-packet/candidate.patch).
A-check, B-check and Combined patches all target that same parent; do not stack them.
Every patch was restored and all its manifested input hashes verified. The Python
provenance checker is separately hash-bound in [provenance-checker.json](provenance-checker.json).
The earlier five-control parent comparison is retained as intermediate evidence;
only the final six-control version supports the selected result. Raw binaries and
omitted repeated logs remain under
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round40-face-polyline/`.

## Next: endpoint feasibility, then a curved extension

1. **Bind actual consumers of endpoints 38/39 and test target feasibility.** These
   are minimal-edge crossings, not the feature-pin consumer class used for 1116.
   Use their original keys and integer incidence; do not infer ownership from exact
   floating-point containment. Reuse already captured triangles and replay only
   missing consumers. Node 38 may slide along its straight upper boundary run without
   enlarging the neighborhood. At 39, an adjacent vertex differs from Ymin by one ULP;
   prove whether the ideal target is on the current boundary or in the disk interior.
   A disk self-homeomorphism cannot move a boundary point to the interior.
2. **Prove a curved extension on the smallest adequate domain.** After admissible
   endpoint transport, compare the canonical endpoint chord l(Y) with ideal z(Y).
   Their deviation d(Y)=z(Y)-l(Y) vanishes at the endpoints. A local map
   `F(Y,Z)=(Y,Z+psi(Y,Z)*d(Y))` is a candidate, not a certificate. Check a continuous
   taper, `1+d(Y)*partial_Z psi>0`, global injectivity, domain/source-fiber containment,
   compatible boundaries and preservation of the adopted feature arc. The join 40
   needs a sector-compatible taper. Refuse if clearance or bounds cannot be proved.
3. **Compose before expanding scope.** Bind that map to all affected consumers,
   the same continuous source graph and a fresh uniform exported error bound.
   Then proceed to remaining interface/interior ownership, outside coverage,
   allocation accounting and native/WASM/GPU/full-model acceptance.

No production changes or visual QA were performed. The result concerns continuous
geometry over represented inputs; general SFCC correctness, GPU parity and
publication readiness remain open.
