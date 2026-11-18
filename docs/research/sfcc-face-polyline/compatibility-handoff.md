# B: the old correspondence cannot adopt the whole face contour

## Status and frozen input

Static implementation complete in `/tmp/sfcc-face-polyline-b`, based on all229 input hashes of the round39 Integrated manifest. No build, test, source evaluation or geometric diagnostic was run by B. Root owns execution. Only two files differ:

- `gcad-wasm/kernel/src/sfcc/feature49_a.rs`: append the test/serde child module hook. SHA256 `9537a75fdb3d42a7f43eff45c4743ed2bfd8f11e5464bb606c8fc4e5ddf32c38`.
- `gcad-wasm/kernel/src/sfcc/face_polyline_b.rs`: new discriminator/checker. SHA256 `1324099b305ab18441ef0d989dee138e75a2888daf2ab0786775f2a1427b51de`.

Filter `face_polyline_b_` selects two tests. `SFCC_POLYLINE_B_RECEIPT` writes the actual positive-discriminator report before asserting its expected conclusions. It freshly invokes the existing complete-face proof and projected-disk audit. The face proof retains its existing128-check/depth16 limits; no surface-graph128/depth12 call is made or reset. No production source changes, new geometry queries or mesh mutation occur.

## First obstruction: outer endpoints are fixed in YZ

Round39 uses a source graph Phi(Y,Z) over the captured projected disk and composes it with a PL map T that fixes all outer-boundary vertices. Its44-triangle boundary includes nodes38 and39. The current test freshly audits that exact supplied triangle union and rebinds every earlier face-fixture point bit to the incident fixture.

Both retained endpoints have exactly the original face X. Node38 has exactly Ymax; node39 exactly Ymin. The freshly proved complete face has one ideal root at every closed Y fiber. The saved values already expose the expected disjointness:

| Endpoint | Retained Z | Certified ideal root Z |
| --- | ---: | --- |
|38 at Ymax|5.431920990801739|[5.4319133015149506,5.431913301514966]|
|39 at Ymin|5.42950236902782|[5.4294818831714915,5.429481883171608]|

The implementation obtains new intervals from the fresh certificate and computes outward separation intervals. It refuses to infer nonidentity from overlapping/touching intervals. Because T fixes these endpoint projections and Phi preserves YZ, Phi(T(endpoint)) cannot equal the unique source/face root at the same Y. This disproves reusing that correspondence unchanged as an exact full-face-contour correspondence. It does not prove an error-limit violation or refute the separately adopted three feature arcs.

## Second obstruction: ideal endpoint moves alone cannot work

On the finite chamfer branch the complete-face argument gives

`rho(Y)=aY+b`, `a=ny/(1-nr)>0`,

`Z(Y)=centerZ+sqrt(rho(Y)^2-c^2)`, `c=faceX-centerX != 0`.

Therefore

`Z''(Y)=-a^2*c^2/(rho(Y)^2-c^2)^(3/2)<0`.

The test binds c to the same fresh source, takes coefficient enclosures from the complete-face result, derives the entire chamfer radial range, and checks a strict negative interval for this derivative. The branch has positive Y length. Every affine projected image of one original mesh edge is a line segment; this strictly concave arc is not a line segment. Consequently **even ideal moves of38/39/40, followed by the existing affine extension, cannot identify the full chamfer edge with its ideal face contour**. Reparameterizing a straight segment does not change this point-set obstruction. This also follows for any finite piecewise-linear image: every nondegenerate subinterval remains strictly concave.

Controls cover interval overlap/touching, nonfinite retained values, zero axial slope, zero face offset, and a radial interval that reaches the square-root singularity. A nondegenerate synthetic branch must have a strict negative derivative interval.

## Minimum viable next construction

Do not expand cells merely to force every endpoint interior. Node38's boundary neighbors41/1114 have exactly the same Ymax, so moving38 along that collinear boundary may preserve the boundary set if exact ordering is retained. Node39 is subtler: neighbor460 is one represented Y step below Ymin, while478 shares Ymin. Its ideal point may lie just inside D rather than on its old boundary. That is a hypothesis to check with exact/interval triangle containment, not a proved result here. Neither possibility discharges the original minimal-edge consumers outside this captured neighborhood.

A candidate construction is a **curved vertical correction after the round39 transport**. On its image face-polyline define the discrepancy `h(Y)=Z_ideal(Y)-Z_polyline(Y)`, with the ideal feature join already at Y*. Then h(Y*)=0. Extend the correction as a vertical shear

`F(Y,Z)=(Y,Z+u(Y,Z))`, with `u(Y,Z)=h(Y)*w(Y,Z)`

where w=1 on the captured polyline and support is chosen using the actual captured domain. Require a global strict bound `|partial_Z u|<1`. For every fixed Y this makes Z→Z+u(Y,Z) strictly increasing; because Y is unchanged, the global shear is injective. Continuity and compactness give an embedding on the disk. Since h(Y*)=0, the already-adopted ideal feature arc at that height remains pointwise fixed.

This is a design, not a certificate. Its remaining obligations are concrete:

1. Bind all endpoint minimal-edge consumers and their source conventions.
2. Bind the full ideal contour and all its endpoints to the same physical source used by Phi.
3. Construct w with explicit interval bounds, including thin/corner boundary regions; show `F(T(D))` lies in the source graph's certified domain D, or recertify an explicitly changed domain under the same budgets.
4. Establish the global injectivity condition without assuming convexity or a single interval per Y section of D. A shear defined on the whole surrounding plane can provide global fiber ordering; local componentwise checks alone are insufficient.
5. Bound paths inside D (or provide new source bounds), approximation error, and complete incident interface compatibility. If F(D) is only a strict subset of D, do not claim the old onto-D theorem or whole-source coverage.
6. Use protected-fiber uniqueness to identify the entire moved contour after its projection matches the ideal curved graph; separate existence of a1D correspondence from this2D extension.

The current generic fixed-boundary affine checker cannot validate this construction by changing a flag. Its theorem must be extended or a separate narrowly scoped shear certificate supplied. A coarse boundary expansion alone does not remove the curvature obstruction.

## Scope and risk

This packet establishes a discriminator, not a repair. The old44-triangle source correspondence remains valid for its stated feature-arc scope. A separately proved ordered1D polyline-to-contour correspondence may also be valid with a small error bound; neither implies it is the restriction of the old2D map.

No native/WASM/GPU/full-model production parity or visual QA was performed by B. Fresh runtime bindings beyond the existing incident fixture remain root/C obligations.
