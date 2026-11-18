# Both captured contour traces and a feature-compatible endpoint correspondence

**The four captured fans incident to the two face-contour segments now have one
certified source-graph correspondence.** They contain **21 triangles**. A further
bounded correspondence sends their shared point to an ideal physical feature-and-face
intersection while fixing the neighborhood's outer boundary.

The final pointwise error bound after f32 coordinate export is
**0.0010243948722129135 mm**, below the unchanged **0.01 mm** surface tolerance.
The source graph uses **109 of 128 allowed checks**; the endpoint construction adds
no source-certificate call or mesh-coordinate mutation. **65 focused tests** and a
non-test library check pass. Fresh runtime geometry and query evidence are unchanged.

This is a theorem for the **captured four-fan neighborhood**, not proof that its
record contains every true source intersection with the entire face. Transport
along complete feature-curve spans and broader ownership remain open. Publication
and production integration are still blocked.

[Fourth-agent review](decision.md) · [Previous paired trace](../sfcc-paired-boundary/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## Actual records and four emitted fans

The original face is [0,3464532,2], between candidate cell [7,25,58,86] and retained
outside cell [7,26,58,86]. Its original two contour segments map to candidate
traversals 40→38 and 39→40, with opposite outside traversals. Point 40 is their
shared curve-49 pin.

The existing bounded orientation capture already contained all four candidate-cell
patch outputs. B reuses that evidence, checking source identities, captured point
payloads and complete emitted-patch coverage against the final candidate. No new
main observer channel was needed. The two outside fans come from the existing
actual-neighbor replay. Both segment/fan bindings are checked against the fresh
original record, final positions and emitted triangles.

| Selected incident fan | Hypothesized stratum | Triangles |
| --- | ---: | ---: |
| Candidate side of first segment | 15 | 6 |
| Outside side of first segment | 15 | 5 |
| Candidate side of second segment | 39 | 4 |
| Outside side of second segment | 31 | 6 |
| Complete supplied union | — | 21 |

The union uses 17 vertices. Different stratum IDs on the second pair are not assumed
to be equivalent. The source certificate uses the full composed field instead of
promoting those labels to ownership authority.

## Direct feature-49 endpoint result

A binds curve 49's actual compound/cylinder source constraints, its original
parameter and the actual length-2 face. On the admitted finite branches, the ideal
physical feature satisfies cylinder radius rho=R and positive groove distance
r_chamfer. The source-bound groove equation makes its height a uniquely determined
constant. Combining that feature with the original X face gives a unique root on
the admitted positive-Z branch.

Physical and generated-carrier roots are constructed separately; their exact
identity is not assumed. The source proof checks finite branches, oriented meridian
coefficients, positive levels, inactive native/ancestor terms and transversality.
The reported Jacobian is for cylinder/groove constraints, not an incorrectly scaled
compiled compound.

| Endpoint obligation | Result |
| --- | ---: |
| Original own-query result | Bit-identical to retained point 40 |
| Own query to entire physical face-feature image | ≤1.199762047962197e-12 mm |
| Existing association allowance | 3.796655370190979e-7 mm, unchanged |
| Candidate to physical/generated image bounds | Both pass directly |
| Original carrier residual/domain checks | Pass |
| Original projection tube and face rectangle | Both ideal images admitted |
| Physical/generated face-image separation | ≤6.18241724653239e-14 mm |
| Cylinder/groove/face constraint Jacobian magnitude | ≥0.41848380197621804 |
| Charged own queries for one endpoint observation | 1; ledger 64→65 |

The ideal physical face-feature root is enclosed by:

- X = -9.334576470564954, the actual represented face plane;
- Y in [-2.492038035725099, -2.492038035725039];
- Z in [5.4319133015149506, 5.431913301514966].

The original point is already extremely close. The common-X surface lift moves
that endpoint by at most 3.91e-14 mm in this enclosure; the earlier approximately
2.237e-6 mm midpoint witness does **not** describe its movement. Neither exact
membership nor exact non-membership of the original surface lift in the ideal
feature is established. No appreciable endpoint defect is inferred.

The admitted numerical candidate is a representative associated with the original
parameter. The ideal root is the uniquely defined correlated source point enclosed
by the intervals, **not the floating midpoint of the box**. Pointwise association
does not prove an exact ideal parameterization or continuity of the old raw chart.

## One source graph over both captured contour traces

C checks the complete supplied projected triangle complex: valid indexed links and
incidence, edge connectivity, one outer boundary cycle, no projected contacts or
folds, and consistent working/exported orientation. Both shared segments have
opposite incidence. Point 40 is strictly an interior mesh vertex in the resulting
disk. The 210 possible triangle pairs per precision are covered by the existing
contact index and its conservative exclusions.

One call to the existing source checker covers the exact concatenation of all
21 triangles. It retains the global work cap rather than allocating 128 checks
per fan or per segment.

| Whole-neighborhood certificate | Result |
| --- | ---: |
| Accepted closed source subdomains | 65 |
| Total source checks | 109 / 128 |
| Common world-X slab | [-9.3690502954966, -9.202000032231238] |
| Uniform working-mesh/source-graph bound, δ | 0.0010238742352245227 mm |
| Original per-triangle export composition | 0.0010243074924721758 mm |
| Both captured contour source traces | Compatible by common root uniqueness |
| Common endpoint as a surface root | Unique within the admitted slab |

The reduced max-function proof, strict slab-end signs and whole-triangle Hessian
bounds apply to the full composed source. Its graph may switch active facets;
this does not authorize assigning every triangle a single carrier label. Geometry
and source arguments remain bound to exact point bits and triangle order.

## A compatible ideal endpoint without moving the mesh

The ideal feature root's YZ image lies strictly inside the kernel of the eight
triangles incident to point 40. Moving that projected interior vertex to the ideal
YZ coordinates, while fixing its link boundary and all other vertices, defines a
piecewise-affine homeomorphism T of the same projected disk D onto itself.

Let M be the existing mesh graph and Phi the certified source graph. Then
Phi composed with T sends point 40 to the exact ideal feature/face root: A proves
that root is source-exposed, its X image lies in C's common slab, and uniqueness
identifies it with Phi at the target YZ coordinates. Both sides of each shared
segment use the same T and Phi, so their traces remain compatible.

The kernel is convex. Every intermediate center position stays in it, and each
straight motion path stays inside the original vertex star. M is continuous and
piecewise affine there. An outward interval bound L_mesh on its triangle graph
Jacobians therefore gives

`|Phi(T(u)) - M(u)| <= δ + L_mesh * β`,

where β bounds the projected vertex displacement. Adding the global export bound
η gives a pointwise correspondence bound for the f32 mesh as well.

| Endpoint-compatible correspondence | Bound/result |
| --- | ---: |
| Incident star triangles | 8 |
| Strict signed kernel-orientation margin | ≥4.346957258717958e-5 mm² |
| Projected vertex displacement β | ≤1.0387196304615446e-12 mm |
| Mesh graph Jacobian norm L_mesh | ≤1.3168547775662525 |
| Additional working error L_mesh·β | ≤1.3678429079251375e-12 mm |
| Global export rounding η | ≤5.206356205475152e-7 mm |
| Final δ + L_mesh·β + η | ≤0.0010243948722129135 mm |
| Star boundary and outer neighborhood boundary | Fixed |
| Projected domain | Maps onto itself |
| Additional full source-certificate calls | 0 |
| Mesh-coordinate mutation | None |

The small increase over the original composed bound mainly comes from combining
**global** δ and η, rather than per-triangle maxima; the endpoint-motion term is
only about 1.37e-12 mm. Since T(D)=D, the source-graph set is unchanged. This proves
existence of an endpoint-compatible source correspondence, not an applied mesh edit
or a repaired numerical defect.

The executed composition independently repeats one charged own-query association,
requires the same source, point, parameter, face, original tube and allowance, and
checks distance directly to the entire physical target image. It does not chain
two tolerances through a midpoint. This observation has its own 64→65 ledger and
is separate from the unchanged meshing ledgers.

## What is still not proved

The construction places one shared endpoint on the ideal physical feature. It does
not prove ideal transport of the adjoining curve-49 spans or an exact original
parameter map. The other feature vertices and outer boundary are not moved by T.

The four-fan union represents both **captured** contour traces. It does not establish
that there are no additional true source intersections elsewhere in the original
face rectangle, nor exclude other sheets outside the admitted slab/domain. Those
are separate source-completeness obligations.

The result concerns continuous real geometry over represented source parameters.
CPU/WASM/WGSL arithmetic parity, actual production assembly, broader ownership,
complete outside coverage and remaining allocation accounting are not established.

## Validation and reproducibility

A developed the feature-root/parameter discriminator, B bound the actual second
segment and fans, and C composed the source graph with the endpoint transport.
D reviewed the mathematical arguments and saved executions. Root alone ran builds,
tests and geometry serially using the pinned Rust 1.99.1 toolchain, verified library
hashes, locked/offline Cargo and the unchanged diagnostic profile.

| Frozen execution | Result |
| --- | --- |
| A-check | Two initial endpoint controls pass |
| Capture | 17 controls and fresh second-segment capture pass; one 21-triangle source graph succeeds |
| Endpoint, selected | 65 tests pass in 28.618 seconds |
| Selected non-test library check | Pass, 3.002 seconds |
| Fresh original-scene diagnostic | Pass, 32.368 seconds |

Final controls include positive-level/oriented-branch guards, direct image
association, strict star-kernel admission, slab containment, point-bit binding,
error limits and refusal of unsupported boundary-vertex transport. The initial
endpoint geometry did not change under those guard tightenings. Campaign counts
overlap and are not additive. Existing build/focused/component limits remain
120/60/120 seconds.

The final runtime matches the previous component's points, triangles, topology,
intervals, generated queries/costs and retained metadata exactly. All four freshly
captured fan inputs and 17 point payloads match the proof fixture. The endpoint's
parameter, query bits, physical target and actual face plane also bind to that
fresh record.

The main candidate remains 1,775 triangles with 1,929 validated generated events
and 8,413 charges. The outside cell remains 11 triangles with nine validated
generated events and its separate 2,121-charge observational ledger. Live inputs
are preserved. No source-family extension, option change or limit increase was
needed, and no browser or visual QA was performed.

| Evidence | Purpose |
| --- | --- |
| [Consensus](decision.md) | Independent mathematical and execution review |
| [Combined face/endpoint proof](Endpoint/face-C.json) | Complete domain/source/transport composition |
| [Feature discriminator](Endpoint/feature49-A.json) | Physical/generated roots and direct numerical association |
| [Fresh runtime receipt](Endpoint/component-attempt.json) | Actual second segment, four fans and unchanged construction |
| [Summary](summary.json) / [capture binding](capture-binding.json) | Bounds and exact input/preservation checks |
| [Feature](feature-handoff.md), [capture](capture-handoff.md), [endpoint](endpoint-handoff.md) handoffs | Independent arguments and limitations |
| [Restoration checks](preservation.json) / [receipt index](receipt-index.json) / [runner](run.py) | Exact source/binary identities and bounded commands |

Restore the 215-input [round36 selected source](../sfcc-paired-boundary/README.md),
then apply [Endpoint-packet/candidate.patch](Endpoint-packet/candidate.patch).
The final source has 218 inputs. All three executed patches target that same base;
do not stack alternatives. Every packet was restored and every input hash checked.
Repeated receipts, raw logs and binaries remain under
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round37-face/`, with
hashes and archive status in the index.

## Next correctness obligations

1. Certify the consumed curve-49 spans, including source exposure, interval ordering,
   original numerical query associations and a whole-edge approximation bound.
   Do not promote the single endpoint result to whole-curve transport or assume
   totality/continuity of every raw numerical query.
2. Establish completeness of the true source intersection with the original face
   rectangle. Use source-level exclusion or an equivalent bounded contour argument
   to rule out unrepresented crossings; the captured two-segment inventory alone
   cannot do that.
3. Only then extend ownership and compatible interfaces to more cells. Keep the
   existing limits, explicit refusals and three-agent/fourth-review workflow.
   Production integration and native/WASM/GPU/full-model preservation remain later
   gates.
