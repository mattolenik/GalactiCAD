# Round 40 consensus: complete face-polyline correspondence and the limit of affine adoption

## Decision

**Accept the standalone one-dimensional milestone.** A's checker proves that the captured chain 39→40→38 maps homeomorphically onto the entire ideal contour of original face [0,3464532,2], with exported pointwise error at most **0.000020955268988113107 mm**, below the unchanged **0.01 mm** limit. B independently proves that this map is not the restriction of round39's fixed-outer-boundary map, and that even ideal endpoint relocation with affine edge extension cannot remove the curved-branch obstruction. C's final six-control provenance checker passes on the fresh runtime. The final review appended below supersedes intermediate pending-execution statements.

There is no contradiction between these results. Existence of a good one-dimensional contour correspondence does not imply existence of a compatible surface correspondence using the same map. The production mesh, tolerances and query limits are unchanged; whole-face compatible 2D adoption and publication are not established.

The reviewer ran no builds, tests, source evaluations or geometry computations. This review reads source, manifests, saved executions and receipts and performs only static data/hash comparisons.

## A: coverage, order and error

The captured working chain has strictly increasing Y at 39,40,38; the same strict order survives f32 rounding. Thus each straight segment is embedded and their interiors are disjoint, in both representations. Original endpoints 39/38 have the exact represented face X and exact lower/upper face Y. The original pin at40 binds chart49 and strata31/15, and all three point bit patterns bind the incident fixture. The complete face theorem supplies a unique root for every closed Y fiber, one connected contour and one branch join at Y* strictly inside the Y interval.

Define the ideal Y parameter affinely on each mesh segment, mapping 39→40 to Ymin→Y* and 40→38 to Y*→Ymax. Both maps are strictly increasing; the two closed branch images share only the exact join. The source root is continuous, so this gives a continuous bijection from the compact mesh chain onto the complete source contour, hence a homeomorphism. This proves every point is covered exactly once, rather than inferring coverage from sampled values or the fixture's segment count alone.

The interpolation bound is valid. On the chamfer branch, rho(Y)=aY+b with a=ny/(1−nr)>0, and the positive-Z graph obeys

`Z''(Y) = −a²(faceX−centerX)² / (rho(Y)²−(faceX−centerX)²)^(3/2)`.

The denominator increases along this branch, so the outward lower-end positive Z bound gives an upper bound on the derivative magnitude throughout the closed branch. A uses that bound times ΔY²/8 for deviation from the chord through the exact ideal endpoints. The endpoint enclosures remain enclosures: no midpoint is substituted for an exact target. The maximum L1 endpoint-association bound controls the difference between ideal and working chords at the same affine parameter. Maximum L1 endpoint f32 displacement then controls the same-barycentric export difference. Summing these bounds controls Euclidean distance pointwise and, through the bijection, in both directions. The cylinder branch is exactly straight and has zero interpolation remainder.

Executed Combined results:

| Branch | Ideal chord remainder upper | Exported pointwise bound |
| --- | ---: | ---: |
| Chamfer, 39→40 | 1.0173171334551778e-7 mm | 2.0955268988113107e-5 mm |
| Cylinder, 40→38 | 0 mm | 7.923986452773597e-6 mm |

The limit is min(original surface tolerance, original chord tolerance/2)=0.01 mm. Exact captured tolerance bits are required, and enlarged surface/chord limits are rejected. Missing segment and altered endpoint-payload controls also reject before additional source work. The fresh exhaustive face call uses10 checks under its existing128-check/depth16 contract. It does not invoke or reset the separate44-triangle source graph's128-check/depth12 budget.

## The ideal join is the same event as round39's adopted point40

This identity is justified by shared defining constraints, not by intersecting or equal enclosures.

`span49_a::Arc::bind` selects the physical level equal to the source chamfer radius r. For the shared point40 it calls `Source::feature` with fixed axis X and the original face coordinate. That construction enforces rho=R and the finite groove branch equation `nr*R+ny*Y+offset=r`, selects positive Z and proves the point lies strictly inside the same original face. Its source binding verifies the physical cylinder/compound source, finite groove branch and surrounding source restrictions.

The exhaustive face theorem uses that same bound physical source. It covers the whole face's relevant rho≤R region with one admitted finite groove branch, and its unique branch transition is exactly `Y*=(r−nr*R−offset)/ny`. At this transition rho=R; positive Z on the fixed X face uniquely gives the cylinder root. Therefore the physical feature/face point used by the span proof is precisely the unique join in A's contour. The final adoption composition derives point40's target from that fresh physical span proof.

The Combined receipts have matching source fingerprints, original face constraints and the same join bounds. These comparisons corroborate the constraint argument; equality of bound arrays alone is not offered as proof. The fresh round39 adoption receipt is byte-identical to the archived round39 receipt, including its positive three-feature-arc conclusion and explicit limits.

## B: two distinct obstructions are proved

B freshly audits the entire supplied44-triangle projected disk and verifies that38/39 remain boundary vertices while40 is interior. The exhaustive face roots at the exact lower/upper endpoint Y coordinates have disjoint Z enclosures from the retained points. Outward lower bounds on the retained-minus-ideal Z difference are:

- Point38: **7.689286773526758e-6 mm**.
- Point39: **2.048585621228227e-5 mm**.

Round39 fixes these boundary projections, and its source lift preserves YZ. It therefore cannot map either endpoint to the exact original-face source root. This proves incompatibility of that specific map; it does not prove a tolerance violation or invalidate the already adopted feature arcs.

Separately, B encloses the chamfer second derivative on the entire nondegenerate branch in **[−0.1559264965917958,−0.15571720411240936]**. The branch is strictly concave. An affine projected image of a nondegenerate mesh edge is a line segment and cannot equal this graph. Reparameterization does not change the point set. Moving all endpoints to their exact targets, or using a finite piecewise-linear subdivision, therefore cannot make the entire projected chamfer image exact. A curved correspondence is necessary if exact face-contour identification is the requirement.

Controls correctly refuse to infer nonidentity from touching/overlapping intervals and refuse strict curvature claims for flat or singular cases. The fixed-endpoint and curvature obstructions are separate: solving the first does not solve the second.

## C: the complete discrete inventory is bound

The final script hash is `06f9d4dc1a73552f4ad523a46b95e71e6fbb5fb54063ef1c8028dcb0f04318b0`. It requires one original face row, no interior cycle and exactly the two original segments4072→4074 and4074→4073. It binds the original pin, opposite consumers, global→local→joined maps, keyed point identities and point bits. Each of the four actual emitted fans must match the fixture and its unique incident source identity, with the shared edge occurring once and with opposite directions across the face. The entire incident cells/points/fans must match the mathematical fixture after removing only process-local source addresses.

The Rust provenance path supports these fields: `paired_target` enumerates all original FaceRecord segments and original leaves, verifies exact same-key/point associations, and requires two opposite consumers. `other_contour_segment` requires exactly two original segments and binds the unique second one. `bind_second_segment` verifies both emitted fan geometries, source identities, original sides and reversed shared-edge directions. This is enough to establish that A's two-segment chain is the whole captured discrete face contour, not an arbitrary selected subset.

The script supplies six adversarial controls: duplicate face, extra segment, wrong remap, one-bit point mutation, reversed triangle and wrong source identity. It does not supply continuous source completeness; that comes from the independent fresh face theorem. Its six-control final version must not be conflated with the earlier five-control parent-receipt run.

## Executed evidence reviewed so far

All231 Combined manifested input hashes and the recorded binary hash match. A-check and B-check compile/focused runs exited0. The selected Combined campaign contains **86 distinct passing tests** in **42.73031754093245 seconds** under60 seconds. The non-test library check passed in **2.9135047079762444 seconds**. No tests were rerun by the reviewer.

- Combined manifest SHA256: `b52b03fd5398a88a1fe50ee0f63963dc1ba92705f51bf41df65200e1996402d8`.
- A receipt SHA256: `e76d3e538601d078beb7e583b66515cc3747b3e44754ff4075bc3c906de12d8e`.
- B receipt SHA256: `eace8220cd99e8ed3c84cebdf67cf01a1fee5021693c7a3deb104dbcd6c2e89d`.
- Fresh prior-adoption receipt SHA256: `fa570bd54209bf5385af74cddfc1293c979f64e3a53736b705a5f9cb614745b9`.

Fresh full runtime preservation and execution of the final six-control C script are pending at this point. Their final review should be appended rather than replacing failed or intermediate evidence.

## Next smallest discriminator

Do not expand the neighborhood merely to force every endpoint interior. First bind every original minimal-edge consumer of38/39 and classify their exact ideal target location relative to the current disk. Point38 may slide along the existing collinear boundary run if order is proved. Point39's adjacent boundary has a one-ULP Y kink: if its ideal target is strictly interior, a self-homeomorphism of this disk cannot send that boundary vertex there. That requires a changed admissible neighborhood/domain or a different chart, rather than disabling a boundary check.

Then construct a bounded curved correction of the face trace. A vertical shear after the existing transport is a plausible minimal candidate: `F(Y,Z)=(Y,Z+u(Y,Z))`, with the prescribed discrepancy on the face trace, vanishing at Y* to preserve the already adopted feature arc. A strict global bound `|∂u/∂Z|<1` gives fiberwise injectivity when the shear is defined consistently across the whole relevant domain. Local disconnected-fiber checks are not enough. One must also prove continuity across collar joins, image containment in the certified source domain (or recertify an explicitly changed domain), compatible endpoint consumers, protected-fiber membership of the entire curved image, and a new uniform error bound. If the image is a proper subset of D, do not reuse the old onto-D coverage claim.

No production, native/WASM/GPU, visual or full-model acceptance is established by this milestone. The source family remains the specific admitted transformed knob neighborhood; general multi-sheet reconstruction and global cell ownership remain open.


## Final runtime and provenance decision

The Combined original-stage diagnostic passed in **36.9832816250273 seconds** under its120-second cap. The final six-control C execution binds the complete original face record, both actual emitted consumers, all three endpoint keys/bits and the entire44-triangle incident geometry to the manifested fixtures. All six corruptions reject with the expected relevant failure categories, including the final wrong-source-identity control. The recorded script hash matches the statically reviewed final source, and all three recorded input hashes match their actual files.

The reviewer independently compared the complete fresh runtime receipt to round39. They are equal after removing only process-local source addresses and sorting the named unordered metadata arrays `intervals`, `curveMemberships`, and `candidateMembershipsAtSharedPoints`. Geometry, point payloads, source options, face-consumption records, query records/costs, retained metadata and live-state outcomes remain unchanged. The original candidate remains1775 triangles,1929 generated queries and8413 charges; neither new face certificate introduces geometry-query charges. The fresh prior-adoption proof receipt is byte-identical to round39, and all231 manifested source inputs still match after execution.

- Fresh runtime receipt SHA256: `6036ac3cd6bce25dad97e487528657ecff650f0bcae9dba4ba9f2923751d5dac`.
- Parent runtime receipt SHA256: `93ce7a09a8b091d2333c270603c40925372b191a142db47ff9392bf87e4b7a93`.
- Final provenance receipt SHA256: `23f1c517156af62d7f0e0a1d24cb093c7aa809311e3a1ef6e2ca8d7ed1a248ff`.
- Independent static comparison record: `/tmp/sfcc-face-polyline-runtime-review.json`.

**Final acceptance is for full captured-face 1D coverage/order/error, actual provenance, and the two proved 2D incompatibility discriminators.** It is not acceptance of a new compatible surface map. The next work must bind the endpoint consumers and prove a curved extension with admissible domain, global injectivity and error bounds. No tests or geometry were rerun by this reviewer.
