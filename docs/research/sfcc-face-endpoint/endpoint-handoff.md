# Round 37 C endpoint-compatible correspondence

Selected authored copy: `/tmp/sfcc-face-c-endpoint`, derived from the initial C copy. Only `gcad-wasm/kernel/src/sfcc/face_join_c.rs` changed; declaration and fixture are unchanged. Hashes: `/tmp/sfcc-face-c-endpoint-changes.json`. Module SHA256: `e6ada46ec92260d1a48b65611cec5de15774347b63a1e14cb2bb34998289c738`.

C ran static source inspection, edits and `rustfmt` parsing/formatting only. No Cargo, tests, source-field or geometry evaluation was run by C. Parent reports the initial whole-face gate passed:21 triangles,65 accepted pieces,109 checks, endpoint40 interior and original combined export bound0.0010243074924721758 under0.01.

## What was added

`endpoint_transport(domain,points,source,endpoint,targetImage,tolerance)` is explicitly conditional on the caller's source and exact-feature certificates. It validates:

- Original geometry point bits still match the audited domain; the bound endpoint is interior.
- A finite ordered target enclosure lies strictly inside the common source X slab.
- Every point of the target YZ box lies on the strict interior side of every opposite edge of the endpoint's star. The original center has the same exact orientation. The already checked link cycle and projected embedding supply a simple star boundary.
- The affine mesh graph Jacobian on every original star triangle is bounded using interval coordinate differences, cross products and interval division. The graph norm is bounded by sqrt(1 + X_y² + X_z²).
- The GLOBAL source error δ and GLOBAL export error η are used. The bound is `δ + L_mesh*β + η`, with every addition/multiplication outward bounded and the original tolerance unchanged.

The map is an existence/correspondence theorem, not a mesh edit. The target is A's exact correlated source point enclosed by the box, never the midpoint. A generic helper does not claim it has independently verified that provenance: its receipt says `exactFeatureRootCertificateRequired:true`.

## Argument

The endpoint's link polygon is a simple closed star boundary, and both the original center and every possible target lie in its strict kernel. The kernel is convex. Moving the center along the straight segment to the target therefore preserves every intermediate star triangulation and fixes its boundary. Extending by identity outside the star gives a piecewise-affine homeomorphism T of the same projected domain D.

For a point u in an original star triangle, `T(u)-u` is its center barycentric weight times the center movement, so its norm is at most β. The intermediate point remains in the star. M is the original continuous piecewise-affine mesh graph, hence along this segment `|M(Tu)-M(u)| <= L_mesh*β`; the segment may cross old triangle boundaries, which is why the maximum original-star Jacobian is used.

The already proved source graph Φ satisfies its GLOBAL bound everywhere on D. Since T(D)=D,

`|Φ(Tu)-M(u)| <= |Φ(Tu)-M(Tu)| + |M(Tu)-M(u)| <= δ + L_mesh*β`.

The same-barycentric export correspondence adds η. No new source Lipschitz/gradient API or second full-face source certificate call is required.

A's exact physical face-feature point has YZ coordinates inside D and X inside the shared slab. Its full-source zero/exposure certificate and uniqueness identify it with Φ at that target. Thus Φ∘T sends the retained endpoint40 to the ideal physical feature/face root while all patches retain a common correspondence. Outer domain boundary transport stays unchanged.

## Actual positive composition

The existing actual `face_c_...source_attempt` test now also:

1. Calls A-final `feature49_a::endpoint_geometry` using the SAME freshly built features, retained endpoint and actual original face plane.
2. Binds original source fingerprint, face, chart/strata/range and stored parameter bits.
3. Uses a separate unchanged Transport ledger and charges ONE direct original own query; it must reproduce the retained point bits exactly.
4. Applies A's outward retained-point→entire physical feature-image distance to that identical own query. There is no midpoint chaining.
5. Requires the full target image and own point in the original projection tube, the physical root strictly inside the actual face rectangle, the original own-query source contract, and the unchanged min(primary allowance,8*curve_eps) association allowance.
6. Runs the star transport and only then sets the discharged `targetIsExactCorrelatedPhysicalFeatureRoot`, `fixedFaceFeatureEndpointTransportProved` and retained numerical parameter association flags.

The helper keeps ideal raw parameterization and entire-feature-curve transport false. The physical target is used; generated-carrier images are not substituted for exact physical ownership. No points, triangles, labels or stored parameters are mutated.

## Integration and checks

Overlay only C's module on the combined source already containing A-final `feature49_a`; keep both exposure declarations. `face-fans-c.json` remains the initial actual21-triangle fixture, to be checked against fresh B capture by root.

Filter `face_c_` now has four tests. The added control rejects an unbound/boundary endpoint, a target outside the star kernel, a target outside the common slab, excessive transport error, malformed source bounds and changed point payloads. The actual test writes `SFCC_FACE_C_RECEIPT`, including endpoint transport/result, before its final assertions. Generic synthetic controls validate the conditional map guard, not source-feature authority.

The new helper has bounded maps/vectors but does not close the previously open allocator-complete workspace accounting. Production, unrelated interfaces, all-feature parameterization and full outside acceptance remain unproved.
