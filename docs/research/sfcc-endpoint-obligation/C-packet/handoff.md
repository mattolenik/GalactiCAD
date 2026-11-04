# Stage 2 C: source identity and endpoint challenge

**Do not repair this failure by restoring duplicate chart incidence or relaxing the degree guard.** The executed guard is known, but neither move establishes the source's required curve. C contributes two exact saved-data controls, a mathematical counterexample to a universal degree-two rule, and one focused existing-kernel discriminator for the real knob source.

Source: `/tmp/sfcc-graph-stage2-c`, based on executed `/tmp/sfcc-graph-stage1-b-reviewed`. Changes are one new test module and its test-only declaration in `trim.rs`. No production function is modified. The actual scene fixture and captured point are retained; no reduced sphere/box model substitutes for the knob witness.

## Established without scene evaluation

The companion `exact-captured-controls.json` uses integer-preserving JSON and rational arithmetic on the stored binary64 coordinates. At corner 27,

`x² + (y + 8)² + z² − (16 − 0.8)² < 0`

strictly; the recorded rational difference is approximately −0.10299435 square millimeters. Thus the stored point is strictly inside the sphere operand's inactive-round threshold, not exactly on its attachment circle. This statement alone does not prove the other operand branches or any surrounding neighborhood; it refutes treating the captured corner as an already-established outer-round junction. Radius literals are interpreted as their exact binary64 values.

The captured graph contains only the canonical edge `(620,633)` for the terminal feature. Adding a second label/duplicate canonical edge for chart 33 leaves point 633's distinct-neighbor set equal to `{620}`. The exact set control records this. This is conditional on the already admitted shared physical arc and canonical endpoint association: it does not claim arbitrary similarly located curves are aliases. Restoring only corner chart 33 without its boundary pin can instead hit the earlier `path_nodes_lt_two` rejection. Neither operation supplies a geometrically distinct outgoing continuation.

## Degree one is not universally invalid

Consider the surface graph

`z = (max(x,0))² |y|`.

Its crease is the half-line `x > 0, y = 0, z = 0`; the two one-sided y-slopes are `±x²`, so their jump tends to zero at the origin. At `x = 0` the surface has a well-defined horizontal tangent. Projection to `(x,y)` is a homeomorphism, so a neighborhood of the origin is a disk with no surface hole or boundary. The feature graph has a degree-one endpoint there.

This is an analytic counterexample to deriving `feature degree >= 2` from surface manifoldness alone. It is not asserted to be the knob's geometry or a currently supported SFCC input. A triangulation can retain an interior constraint ending at a vertex while the surrounding triangle complex has a complete vertex link; feature incidence and triangle incidence are different objects.

For the knob, the captured endpoint lies before the outer-round transition, so a vanishing dihedral there requires its own proof. The generic example does not excuse the missing incidence.

## Primary local hypothesis: finite flank probes truncate exposure

`trim::flank_survives` tries only scales `[1, 0.5, 0.25, 0.125, 0.0625]` and both signs. With the original default `probe_delta = 0.1`, the smallest scale is 0.00625 mm before the direction magnitude. Its probes must satisfy `domain_contains` using the much smaller `curve_eps*8`, including every source ancestor. A still-exposed strip narrower than the finite probe displacement can yield `Ok(false)` even when arbitrarily small valid flanks exist. `trim_curve` then treats that outcome as dead and bisects to the known-alive side. A failed finite search does not prove absence of a crease.

The new test compiles the exact original feature set and verifies its fingerprint and corner 27's exact position/incidence. It computes the existing pair's tangent, orients it by the actual final indexing segment, and uses the existing `project_to_carrier_pair` to find points a bounded positive distance beyond the stored endpoint. It checks full-field residuals and the original carrier domains and compares the existing `curve_point_status`/`flank_survives` at original versus 1/32 probe scale. Six predictor steps are predeclared: 0, 0.0001, 0.0005, 0.001, 0.002 and 0.004 mm.

The test does **not** call `point_at(t_max + delta)` and pretend that clamped interpolation extends the curve. It constructs a test-only supporting-pair sample curve through the predicted/projected point, using the original carriers and refinement tolerances. This is a discriminator, not admitted feature synthesis or an implemented repair.

The final assertion requests an actual positive-advance point with near-zero full-field residual that the original finite probe schedule rejects and the smaller probe schedule accepts. Its receipt is written **before** that assertion. A failure is useful contradictory evidence; do not rerun with tuned step/probe values until it passes. Even a passing assertion is a numerical counterexample to the exposure classification, not a continuous coverage theorem.

## Separate later hypothesis: incomplete propagation through an inactive chamfer

`branch_surfaces::sample_override` propagates deeper selected branches through a Chamfer node by always using the diagonal expression. In this original expression, the hard intersection at path `[0,0,0]` lies beneath the chamfer subtraction at `[0,0]`, and beneath the final round intersection. If that intermediate chamfer is in its ordinary child-dominant region, the deeper lifted branches must preserve that child alternative as well. Otherwise `override_valid` rejects their diagonal extensions near the actual branch, or both lifted fields can collapse to an unrelated common outer operand.

The test records the actual intermediate chamfer's two child values, its diagonal value and native result, then evaluates the existing deeper `Child(0)` and `Child(1)` overrides using the enumerator's partner path `[1, usize::MAX, 1]`. It asserts a positive child-vs-diagonal margin and a substantial mismatch between both override values and the full source field at the captured corner. This would demonstrate a representation gap there, **not prove that this gap caused the earlier stored endpoint**: lifted ownership deliberately excludes native-zero bands, and the captured endpoint is still in the native region. Actual outer-transition continuation is a later obligation.

No alternative scene evaluator or corrected branch-propagation implementation is introduced.

## Root execution

No build, Rust test, feature compilation, SDF/curve query, octree or export has run by C. Root should use the pinned Rust1.99.0 compiler and the current no-LTO/codegen16 diagnostic profile:

- Build kernel lib tests once under120seconds, `--offline --locked --release --features serde,sfcc-profile --lib --no-run`.
- Set fresh `SFCC_ENDPOINT_C_RECEIPT`.
- Run filter `endpoint_identity_c_native_exposure_and_lifted_branch_discriminator --nocapture --test-threads=1` under60seconds.

There is one test and one source feature compilation, with bounded local probes and no mesh construction. Root receives the original fingerprint check, exact endpoint check, native residual/domain/flank observations, intermediate-ancestor values and the separate lifted-field mismatch. No complete trace enumeration or global source completeness follows.

## Repair implications, conditional on execution and consensus

If the native continuation discriminator passes and A establishes continuous local source exposure, target trimming/classification first. Reducing the global probe factor blindly is not a proof-based repair: the implementation needs a smaller-step or enclosure strategy with explicit unresolved outcomes when local survival cannot be decided. Keep true terminal creases as an adversarial control. Do not fabricate a second graph edge from a duplicate alias.

If the current test fails, preserve its receipt and determine whether the failing premise is direction, projection, ancestor domain, flank classification or the separate chamfer hypothesis. The full-source obligation remains open. No geometry change is proposed in this packet.

Skipped: all execution and continuous source proof. Risk: the probe assertions are deliberately falsifiable hypotheses, and a later lifted-branch gap is not the same defect as the captured native endpoint.
