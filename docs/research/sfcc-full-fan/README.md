# Whole first-fan source graph and approximation bound

**All six triangles of the first actual fan now have a complete local source-graph
certificate, with an exported-mesh error bound of 0.0005058201434644458 mm under
the unchanged 0.01 mm surface tolerance.** This covers the entire closed projected
fan domain, including triangle edges, rather than selected interior probes.

The selected source passes **48 focused tests** and a non-test library check.
The fresh 205-cell reconstruction preserves its points, triangles, topology,
intervals, generated queries and metadata exactly. No geometry or owner labels
were changed.

The theorem is local: it establishes a graph of the full composed source within
one bounded X slab over this fan's projected domain. It does not establish the
intended cell-trimmed source patch, conforming transport to neighboring patches,
other source sheets outside that slab or full-component ownership. **Publication
and production acceptance remain blocked.**

[Fourth-agent review](decision.md) · [Previous ownership investigation](../sfcc-patch-ownership/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## Measured certificate

| Quantity | Reviewed result |
| --- | ---: |
| Triangles covered | All 6 in the captured first fan |
| Accepted closed subdomains / attempted checks | 15 / 24 |
| Global piece-check cap | 128, across the entire input |
| Common world-X slab | [-9.3690502954966, -9.324576470564953] |
| Minimum reduced-function decrease rate | 0.8610098527465292 |
| Minimum left-end field lower bound | +0.00834290774814789 |
| Maximum right-end field upper bound | -0.008314016729317255 |
| Working-mesh to source-graph bound, δ | 0.0005052995078438982 mm |
| Working-to-f32 mesh bound, η | 0.0000005206356205475152 mm |
| Source-to-exported-mesh bound | 0.0005058201434644458 mm |
| Surface tolerance | 0.01 mm, unchanged |
| Projected disks in working / exported coordinates | Embedded / embedded |
| Projected orientation under export | Preserved |

Nine coarse checks could not establish the finite native side and were subdivided.
No inconclusive leaf is treated as accepted. The final 15 pieces cover all six
closed triangle domains. The 128 limit counts work globally, including refinement
attempts; it is not multiplied by the number of triangles.

## Source theorem: one root even when the active facet changes

The checker binds the actual registered cylinder, twisted extrusion and source
operator ancestry. It checks finite primitive branches, signs, frames, the twist's
unclamped height range, cylinder-cap restrictions and ancestor activity. Accepted
active native sides use exact cardinal normals verified from their actual polygon
edges. The other admitted case proves the native contribution strictly negative
using a convex-polygon interior-distance bound and the extrusion cap.

Write C for the cylinder field, E for an admitted native side, d for the positive
groove distance, r for the chamfer radius and w for its represented positive
coefficient. Where the native side can matter, the reduced function is

`K = max(C, E, w(C - d + r), w(E - d + r))`.

Where the native contributions are proved strictly negative throughout the slab,
those two terms can be omitted. The other lathe is outside the inner-round active
range. Negative groove/cap operands and the inactive outer-round sphere preserve
zero-set and sign equivalence between K and the full composed field.

This is **not a claim that the full scalar field is globally monotone**. Each
retained smooth branch of K has X derivative at most -μ, with μ>0. Therefore its
maximum satisfies the same strong-decrease inequality, including at facet switches.
Strict opposite signs at the two slab ends establish exactly one source root for
every point of each projected subdomain.

Every piece uses the same world-X slab. Roots on overlaps and shared edges must
therefore agree by uniqueness. Continuity and finite closed-domain coverage give
one continuous source graph over the entire fan domain. This is a graph of the
composed source, not a blanket assertion that the cylinder alone owns it.

## Whole-triangle error, not sampling acceptance

For each admitted smooth branch, interval bounds enclose its Hessian operator norm.
The native side uses a Frobenius-norm bound; the radial term uses 1/rho, and the
chamfer terms use the corresponding weighted bounds. If M bounds that norm and
D is a triangle's diameter, the linear-interpolation remainder is bounded by

`M D² / 6`.

Vertex enclosures plus this remainder bound the branch over the whole triangle.
Taking the maximum bounds K there. A uniform residual bound ε and decrease rate μ
give a same-YZ root displacement no larger than `ε / μ`. Both the triangle point
and its unique root are within the admitted common slab.

Subdivision uses interval images enclosing exact dyadic edge midpoints. The
conceptual children partition the original triangle; outward enclosures avoid
leaving gaps through rounded midpoint coordinates. The accepted pieces include
their boundaries. No dense sampling is substituted for these bounds.

The result concerns continuous real geometry defined by the represented source
parameters and admitted primitive formulas. It is not a bitwise theorem about
CPU libm, numerical Newton maps or WGSL SDF evaluation. Existing query validation
remains separate; CPU/WASM/GPU arithmetic parity is still open.

## Exact domain and f32 composition

B independently checks the actual indexed fan: a simple projected YZ boundary,
a strictly interior kernel apex, the exact cyclic triangle inventory and consistent
orientation. These facts establish that its triangles tile one embedded closed
disk without overlaps or gaps. Shared IDs make the affine X coordinate agree on
shared edges. The checks also pass on the represented f32 coordinates, with the
same projected orientation.

Combining that domain with A's unique continuous root gives a homeomorphic lifted
disk and a uniform source correspondence. It says nothing about remote source
sheets outside the admitted slab.

For export, equal barycentric coordinates express the working-to-rounded change
as a convex combination of vertex displacements. Thus the largest outward-bounded
vertex displacement bounds every point of each triangle. The composed bound is
`δ + η`, evaluated per triangle and then maximized.

The f64 and f32 projected domains are **not assumed equal**. Their same indexed
triangulation supplies the barycentric correspondence; both are independently
embedded disks. The resulting error bound applies in both directions between the
selected source graph and the exported mesh. The composition test verifies exact
triangle coordinate bits and order before combining A's bounds with B's geometry.

This proof does not authorize assigning all six triangles the cylinder's stratum
ID: the active source facet may switch. A future ownership representation must
bind the admitted source/branch set or establish a stricter single-carrier partition.

## The actual interface limitation is also checked

The fixed-YZ root lift does not preserve every original cell face. At the exact
dyadic midpoint of boundary edge 40→38, its source root is separated from the
original X plane by

`[2.2372495038780467e-6, 2.237249521641616e-6] mm`.

That root is source-exposed and inside A's common slab, so uniqueness identifies
it with the same local root graph. It is well within the surface tolerance, and
is not a mesh-invalidity or error-budget counterexample. It does show that this
particular lift does not preserve the original face plane exactly.

| Actual boundary binding | Value |
| --- | --- |
| Face [axis,key,length] | [0,3464532,2] |
| Candidate-side consumer | [7,25,58,86], side 1 |
| Retained opposite consumer | [7,26,58,86], side 0 |
| Original segment used | 4072→4074, mapped to private 38→40 |
| Fan traversal | 40→38, with the corresponding orientation |

The initial C fixture incorrectly recorded length 1. Review corrected it to the
actual length-2 record and added checks for the original segment, point bindings,
both oriented consumers and lattice rectangle. Negative controls reject both a
mismatched length and a coherently shortened record whose extent excludes the edge.
The final fixture matches the fresh component's actual frontier record exactly.
The plane and numerical gap are unchanged by that provenance correction.

Exact cell-plane preservation is sufficient for some interface strategies, but
is not necessary for every valid mesh correspondence. Neighboring patches could
share the same transported source boundary even when it moves off the original
partition plane. That common transport, its face/feature incidences and joined
coverage still need proof; the one-fan theorem does not supply it automatically.

## Review, controls and preservation

The other review correction restricts the source binder to finite raw cylinder
radius and half-height at least 1e-6, matching the primitive's size floor. The
actual witness is unaffected. Controls reject clamped/invalid parameters, foreign
or missing cylinders, invalid or degenerate projected domains, nonfinite inputs,
tighter unproved tolerances, folds, export collapse and invalid error composition.
A repeated 126-triangle input confirms that the 128-check budget is global.

| Frozen execution | Result |
| --- | --- |
| A-check | Initial whole-fan certificate passes: 15 pieces, 24 attempts |
| B-check | Three projected-domain/export controls pass |
| C-check | Two initial boundary controls pass; incorrect length metadata subsequently corrected |
| Combined | 47 independent proof and retained controls pass |
| Composed | 47 tests pass with explicit A/B input binding and combined error; fresh component preserved |
| Reviewed, selected | 48 tests pass in 28.698 seconds; library check passes in 2.924 seconds |
| Selected original-scene diagnostic | 36.856 seconds, within the existing 120-second limit |

The initial composition script caught a changed fixture-helper API before adding
the joint assertion. Its Combined packet contains independent tests only. The
Composed and Reviewed packets explicitly bind and combine the proofs; independent
passes are not used as a substitute for that step. Counts overlap and are not additive.

Root executed builds and geometry serially, using the same pinned Rust 1.99.1,
verified compiler/library hashes, locked/offline Cargo and diagnostic profile.
Build/focused/component limits remain 120/60/120 seconds. No tolerance, resource
limit, option or production geometry changed.

The selected run preserves parent points, triangles, topology, sorted intervals,
generated query records/costs and retained metadata exactly. The component remains
205 cells / 1,031 faces / 1,775 triangles, with 1,929 validated generated events and
8,413 candidate ledger charges. The previous single outside-neighbor observation
also remains separate and incomplete. Live input digests match.

| Evidence | Purpose |
| --- | --- |
| [Consensus](decision.md) | Independent mathematical and execution review |
| [Composed proof](Reviewed/fullfan-combined.json) | Source pieces, exact domain and final error composition |
| [Source proof](Reviewed/fullfan-A.json) | All accepted pieces, strict bounds and refinement refusals |
| [Boundary witness](Reviewed/fullfan-C.json) | Corrected actual record and source-root displacement |
| [Complete runtime receipt](Reviewed/component-attempt.json) | Unchanged candidate, fan, metadata and outside observation |
| [Summary](summary.json) | Parent preservation, actual-fan binding and proof bounds |
| [Source](source-handoff.md), [domain](domain-handoff.md), [boundary](boundary-reviewed-handoff.md) handoffs | Independent arguments and limitations |
| [Restoration checks](preservation.json) / [receipt index](receipt-index.json) / [runner](run.py) | Exact inputs, binaries and bounded execution |

Restore the 207-input [round34 selected source](../sfcc-patch-ownership/README.md),
then apply [Reviewed-packet/candidate.patch](Reviewed-packet/candidate.patch).
The final source has 212 inputs. All six executed patches target that same base;
do not stack alternatives. Each was restored and all input hashes verified.
Repeated large receipts, raw logs and binaries remain under
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round35-fullfan/`, with
hashes and archive status in the receipt index.

## Next: prove the shared source boundary with the actual opposite consumer

1. Reconstruct retained cell [7,26,58,86] at the same original stage and bind its
   use of face [0,3464532,2], including source-feature memberships. This is the
   relevant neighbor for the demonstrated boundary movement, unlike the earlier
   lexicographically selected one-triangle outside witness.
2. Attempt a common source-root certificate across the two incident patches and
   check their projected union. Shared input coordinates and uniqueness in one
   common slab may establish identical source-boundary lifts; they do not alone
   prove that patch interiors meet without overlap or leave no gap. Check those
   obligations explicitly, including feature-curve correspondence and tolerances.
3. If a common transport fails, retain the counterexample and test a bounded
   face-constrained alternative. Only then extend ownership to the other fans.
   The rest of the component, complete outside coverage, replacement-stage metadata,
   checker allocation accounting and native/WASM/GPU/full-model acceptance remain open.

Use the same three independent agents and fourth consensus review. This milestone
certifies one six-triangle local graph, not all 1,775 component triangles. No browser
or visual QA was performed, and production remains unchanged.
