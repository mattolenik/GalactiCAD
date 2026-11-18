# Consumed feature spans and complete source intersection of the checked face

**The three consumed curve-49 edges now have a source-exposed ideal-arc certificate
and a whole-edge exported error bound of 0.00031441763691510014 mm**, under the
unchanged 0.01 mm limit. Separately, a source-level argument proves that the entire
original face contains **one connected contour with exactly two source-role
branches**. Additional source crossings on that face are excluded.

The composition passes **72 focused tests** and a non-test library check. A fresh
runtime preserves all existing candidate geometry, metadata and query evidence.

An independent exact predicate also establishes an adoption constraint: the prior
correspondence cannot keep outer nodes **647 and 1116** fixed and map them exactly
to the ideal physical feature. This is not a tolerance violation or a mesh defect.
Compatible two-dimensional boundary transport is still required; production and
publication remain blocked.

[Fourth-agent review](decision.md) · [Previous endpoint correspondence](../sfcc-face-endpoint/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## The actual consumed curve spans

The certificate covers the three recorded edges
1116→1117→40→647, with original parameters increasing over
**[31.867718621208247, 33]**. It does not cover the entire original chart range
[0,33]. There are 15 recorded query events at 13 distinct parameters in this
consumed interval.

The four canonical targets retain their actual provenance:

- **647:** the correlated native-side/cylinder/groove terminal event at original
  corner 13 and curve parameter t_max=33.
- **40:** the same physical X-face feature root established in round37.
- **1116:** the feature root on its original Z face [2,3464534,2], with its original
  pin parameter and original global/local point binding.
- **1117:** the ideal feature point at its retained Z coordinate.

The physical feature has rho=R and positive groove distance equal to the physical
chamfer radius. Its height is fixed by the admitted finite meridian branch. On the
negative-X branch, Z provides an ordered canonical coordinate. The ideal arc
includes the real correlated terminal, not a floating midpoint of its enclosure.

At the terminal the native field is zero by construction. Its derivative with
respect to Z is strictly negative on the admitted closed arc, establishing native
exposure through the endpoint without assuming a strictly inactive epsilon halo.
Finite-profile, cap, other-lathe and ancestor restrictions remain checked.

Physical and generated-carrier coefficient families are handled separately in
16 closed pieces each, **32 total under the existing 128-piece cap**. The physical
arc is exposed on the full continuous source. The generated-carrier arc has its
own restrictions and associations; exact physical identity is explicitly not
claimed.

## Numerical association and whole-edge approximation

All 13 unique own queries reproduce their recorded points and pass the original
source contract. Each point associates directly to both canonical image families,
remains in its original projection tube, and respects finite parameter/range/order
checks. Duplicate events are checked for consistent point bits. No continuity or
totality of the raw numerical query map is inferred from these finite observations.

| Numerical obligation | Result |
| --- | ---: |
| Recorded events / unique new own queries | 15 / 13 |
| Separate observation ledger | 64→77 |
| Largest direct physical/generated association upper bound | 1.199762047962197e-12 mm |
| Original association allowance | 3.796655370190979e-7 mm |
| Original chord tolerance / retained half-chord limit | 0.02 / 0.01 mm |
| Original surface tolerance | 0.01 mm |
| Effective edge error limit | 0.01 mm, unchanged |

For the ideal graph X(Z), an interval bound on its second derivative gives a
whole-chord interpolation error `M * (ΔZ)² / 8`. Adding the endpoint association
bound and the same-barycentric f32 rounding bound covers every point of the edge
in both directions. This is not a quarter-point sampling acceptance argument.

| Consumed edge | Exported edge-to-physical-arc upper bound, rounded up |
| --- | ---: |
| 1116→1117 | 0.000097622 mm |
| 1117→40 | 0.000314418 mm |
| 40→647 | 0.000032051 mm |

The original numerical parameters remain provenance labels with checked finite
order and associations. Exact ideal parameterization of every raw t, unqueried
Newton behavior, the rest of curve 49 and neighboring 2D transport remain outside
this certificate.

## Complete source intersection of the original face

B analyzes the entire actual face [0,3464532,2], independently of the recorded
segment count or the four-fan projected domain:

| Coordinate | Original represented rectangle |
| --- | --- |
| X | -9.334576470564954 |
| Y | [-2.4943226517164696, -2.249010151716469] |
| Z | [5.3896361967837, 5.634948696783697] |

Let C=rho-R be the cylinder's radial field. Where C>0, the actual cylinder and all
its relevant max/intersection ancestors remain positive, excluding source zeros.
That exclusion does not borrow inactive-source assumptions from the other region.

On C<=0, bounded Y strips cover the entire conditional region. Convex-profile
interior bounds exclude the native and native-chamfer contributions; finite groove
and other-lathe branches, cylinder caps and remaining ancestors are checked. The
full source then has the same zero set and sign as the reduced function

`H = max(rho-R, w*((1-nr)*rho - R - ny*Y - offset + r))`.

Its extension outside C<=0 is synthetic: actual groove equality is not asserted
there. Both the extension and the actual source are positive where C>0, so the
zero-set argument still covers the whole rectangle.

With positive ny and 1-nr, the unique positive-Z root is

`rho_*(Y) = min(R, (R + ny*Y + offset - r)/(1-nr))`

`Z_*(Y) = centerZ + sqrt(rho_*(Y)² - (faceX-centerX)²)`.

Strict lower/upper edge signs and a positive reduced Z derivative establish one
root for **every closed Y fiber**. Endpoint and branch-order bounds keep it inside
the face and establish one interior feature join.

| Completeness result | Bound/count |
| --- | ---: |
| Source checks, including branch anchor | 10 / 128 |
| Accepted Y strips | 5 |
| Reduced positive-Z derivative | ≥0.49430195878705174 |
| Lower face-edge sign upper bound | -0.02120154105727678 |
| Upper face-edge sign lower bound | +0.10352991926050768 |
| Connected source contours | 1 |
| Source-role branches | 2: chamfer, then cylinder |
| Feature-join Y | [-2.492038035725099, -2.492038035725039] |
| Cylinder branch Z | [5.4319133015149506, 5.431913301514966] |
| Chamfer root at lower Y boundary | [5.4294818831714915, 5.429481883171608] |

Thus additional contour components, unrepresented crossings and boundary tangencies
are excluded on this face in the admitted continuous source model. Four coarse
native-interior refusals were resolved by subdivision; no unresolved strip is
accepted. The argument covers the cylinder-root uncertainty band conservatively
and leaves no sliver between its two sign cases.

The ideal arc's point-40 target and this contour's branch join use the same bound
source and constraints; their enclosures match. Overlapping enclosures alone are
not used to establish identity. This result does not yet supply a new correspondence
for the entire captured face polyline or establish whole-cell interior coverage.

## Exact compatibility finding at the old outer boundary

C binds the actual finite exterior meridian branch and evaluates an exact dyadic
predicate, without rounded intermediate differences or products. It determines
the sign of squared line distance minus the physical chamfer level squared at
rho=R and the retained Y coordinate.

The result is **negative, not zero**. Therefore the retained height is not exactly
the ideal physical feature height. All four consumed feature vertices share that
retained height. In the previous endpoint construction, nodes 647 and 1116 lie on
the outer neighborhood boundary and their projected coordinates were fixed.
Their source lifts consequently retain that height and cannot be exact ideal
feature endpoints under the old map.

This does not refute the previously moved point 40, which was explicitly sent to
the correlated ideal root. It also does not show that any numerical allowance,
mesh approximation limit or visual-quality requirement failed. The exact predicate
establishes non-membership, not a displacement magnitude. The independent arc
associations and whole-edge bounds above still pass.

The practical consequence is precise: adopting the ideal arc requires a compatible
boundary transport at 647/1116 and their incident patches. The old outer-boundary-fixed
correspondence cannot simply be relabeled as whole-curve transport. No mesh point
was edited in this milestone.

## Execution, review and preservation

A developed the arc/span certificate, B the exhaustive face argument, and C the
exact compatibility discriminator. D independently reviewed source, fixture
provenance, mathematical claims and saved executions. Root ran builds, tests and
geometry serially with the pinned Rust 1.99.1 compiler, verified library hashes,
locked/offline Cargo and the unchanged diagnostic profile.

| Frozen execution | Result |
| --- | --- |
| B-check | Two completeness controls pass |
| C-check | Two exact-predicate/compatibility controls pass |
| A-check | Two controls pass; positive test rejects a fixture parser key mismatch before reaching geometry |
| Combined, selected | 72 focused tests pass in 37.747 seconds |
| Selected non-test library check | Pass, 3.064 seconds |
| Fresh original-scene diagnostic | Pass, 37.041 seconds |

The parser correction explicitly reads `positionBits` for vertex rows and
`pointBits` for query-event rows; it does not accept an ambiguous fallback schema.
No proof logic, tolerance or budget changed. Selected controls also bind the exact
recorded tolerance bits and reject larger caller tolerances. Counts overlap across
packets and are not additive. Build/focused/component limits remain 120/60/120 seconds.

Fresh runtime verification shows identical parent candidate points, triangles,
topology, sorted intervals, generated query records/costs and retained metadata.
All four span payloads and all 15 consumed query records match the fresh runtime.
Outside evidence differs only in process-local addresses and unordered membership
row order. Live state is preserved.

The main candidate remains 1,775 triangles, 1,929 validated generated queries and
8,413 charges. The outside cell remains 11 triangles, nine validated generated
queries and its separate 2,121-charge observational ledger. The arc observation's
64→77 charges are separate and are not presented as a production cost.

| Evidence | Purpose |
| --- | --- |
| [Consensus](decision.md) | Independent mathematical and execution review |
| [Arc/span receipt](Combined/span49-A.json) | Closed source arc, canonical targets, 13 associations and whole-edge bounds |
| [Complete face receipt](Combined/complete-B.json) | Exhaustive source-level face exclusion and root argument |
| [Exact compatibility receipt](Combined/spancomplete-C.json) | Retained-height sign and affected outer nodes |
| [Fresh runtime](Combined/component-attempt.json) / [summary](summary.json) | Actual record bindings and unchanged construction |
| [Arc](arc-handoff.md), [face](face-handoff.md), [compatibility](compatibility-handoff.md) handoffs | Independent proof arguments and limitations |
| [Restoration checks](preservation.json) / [receipt index](receipt-index.json) / [runner](run.py) | Source/binary identities and bounded commands |

Restore the 218-input [round37 selected source](../sfcc-face-endpoint/README.md),
then apply [Combined-packet/candidate.patch](Combined-packet/candidate.patch).
The selected source has 222 inputs. All four executed patches target that same
base and must not be stacked. Every patch was restored and every input hash checked.
Repeated raw outputs and binaries remain under
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round38-spans/`, with
hashes and archive status in the receipt index.

## Next correctness obligations

1. Bind every incident patch/consumer at outer feature nodes 647 and 1116. Determine
   the smallest neighborhood in which the new ideal targets can be adopted with
   compatible shared boundaries; retain the exact old-map incompatibility evidence.
2. Prove the resulting two-dimensional transport, domain coverage and approximation
   bound. Reuse certified source facts only with explicit source/domain/slab binding;
   do not silently reset work limits or assume a tiny target displacement guarantees
   topological compatibility.
3. Bind the captured face polyline to the now-complete ideal face contour and extend
   to further cells only after these adoption checks pass. Whole original curve-49
   coverage, remaining cell ownership/outside coverage, allocation accounting and
   native/WASM/GPU/full-model acceptance remain later gates.

The proofs concern continuous real geometry over represented inputs, not bitwise
CPU/WGSL evaluation. No browser or visual QA was performed. Production remains
unchanged, and publication remains blocked.
