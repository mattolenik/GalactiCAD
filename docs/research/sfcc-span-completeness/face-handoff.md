# B: completeness of the actual face intersection

Selected initial source: `/tmp/sfcc-completeness-b`, copied from the 218-input round37 source `/tmp/sfcc-face-endpoint`.

Two changed files only:

- `gcad-wasm/kernel/src/sfcc/feature49_a.rs`: child-module declaration for `face_complete_b`.
- `gcad-wasm/kernel/src/sfcc/face_complete_b.rs`: whole-rectangle source certificate and two controls.

Hashes are in `/tmp/sfcc-completeness-b-changes.json`. A independently adds its span child to the same parent; root should merge the two small declaration blocks instead of replacing either parent's body. No public Source fields or broad helper refactor is needed.

## API and execution

`feature49_a::face_complete_b::certify_face(features, chart, lattice, [axis,key,length]) -> Result<Value,String>`.

The API derives the full represented rectangle from the original lattice face; it does not use the captured contour segments to decide completeness. Its caller must bind that face ID to the actual record, as the existing component receipts do.

Root test filter: `complete_b_` (two tests).
Receipt environment: `SFCC_COMPLETE_B_RECEIPT`.
The actual test rebuilds the original source and lattice, binds source fingerprint and actual face/curve pin, writes its result before asserting success, and retains unsupported-axis/extent/source/hemisphere controls. A conservative proof refusal is not a geometric counterexample.

B did **not** run cargo, tests, field/curve evaluations, or geometry. Static rustfmt parsing/formatting succeeded. No source or geometry result is claimed until root executes the frozen candidate.

## Mathematical route

Use the actual negative-X, positive-relative-Z face. With cylinder field C=rho-R, C>0 excludes source zero because the cylinder's real finite SDF is at least C there, and the admitted hard intersection/chamfer/cap/outer-round chain preserves a strictly positive value. This exclusion does not assume native or other branches are inactive.

On C<=0, rho<=R and positive Z imply Z is at most the unique positive cylinder intersection with that X plane. An outward cover of this conditional half-rectangle is checked across the **entire** closed Y range. Each admitted strip proves:

- Unclamped original twist height.
- Convex native polygon containment by a positive ball inside all actual oriented support halfplanes; no nearest-native-side assumption. The native cap is included in the negative field upper bound.
- Other lathe distance above the inner-round radius, so the inner field equals that negative native field.
- The native field and its chamfer contribution are strictly negative.
- A positive exterior groove distance on one actual finite meridian branch, with identical oriented branch coefficients throughout every strip.
- Cylinder side/cap validity, negative cap-cut field and outer sphere below its inactive round threshold.

Therefore the full source has the same zeros and signs as

`H(Y,Z) = max(rho-R, w*((1-nr)*rho-R-ny*Y-offset+r))`.

The coefficients are derived from the source finite segment. Outside C<=0 the same analytic H is merely a positive-sign continuation, since H>=C>0; actual groove equality is not asserted there.

Checked ny>0 and 1-nr>0 make each H branch strictly increasing in positive Z. Strict signs on the two Z edges and the explicit formula

`rho_*(Y)=min(R,(R+ny*Y+offset-r)/(1-nr))`

`Z_*(Y)=centerZ+sqrt(rho_*(Y)^2-(faceX-centerX)^2)`

establish exactly one zero for every **closed** Y fiber. The transition height is strictly inside the Y interval. The lower chamfer root and upper cylinder root are strictly inside the face's Z interval. Thus the complete source intersection is one connected arc with two source-role pieces (chamfer below the transition, cylinder above), meeting at one ideal feature/face point. There are no additional loops, crossings or isolated zero components in this entire rectangle.

This is a zero/sign-equivalent reduced-function argument. It does not assert that the original complete scalar field is globally monotone.

## Bounds and fail-closed behavior

The source branch anchor counts as one check. Adaptive Y-strip checks share a **global128-check cap**, including rejected coarse strips; all accepted strips must cover the full original closed Y interval. Each split reuses the same represented split coordinate for both children, so their axis-aligned intervals cover without gaps. Depth16 and no-progress guards refuse unsupported cases. This is no128-per-strip or per-branch allowance.

A wrong source, nonfinite/invalid rectangle, non-positive-Z hemisphere, noninterior cylinder root, missing positive meridian branch, unproved native/chamfer exclusion, nonpositive derivative or missing strict edge brackets refuses. Cylinder primitive floors are inherited from the existing guarded Source binder. No numerical tolerance was introduced or changed.

No SDF/curve point queries are added by the certificate: it uses source geometry interval algebra. Mesh geometry, original records and source features remain immutable. Diagnostic/checker total-RSS accounting remains outside this certificate's claim.

## Limits

The source theorem applies only when every gate succeeds for this admitted source family. It is not a generic face solver. It does not certify the existing polygonal contour's approximation/correspondence, raw curve49 parameter continuity, other faces, cell-interior completeness, global topology or CPU/WASM/WGSL numerical parity. The result's `originalCapturedPolylineCorrespondenceProved` and publication flags remain false.

If the initial inverse-twist box overestimates native support enough to refuse, a checked derivative-sign corner bound can tighten u/v extrema; that extension is intentionally deferred until the actual saved refusal justifies it.
