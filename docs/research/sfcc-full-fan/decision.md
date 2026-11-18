# Round35 fourth-agent review: complete first-fan source graph and approximation

**Accept the bounded first-fan graph/approximation theorem and its executed preservation evidence.** The proof concerns the real composed source geometry defined by represented input parameters. It is not production publication, whole-model correctness, exact cell-trim correspondence or CPU/WGSL numerical parity.

Root alone runs builds, tests and geometry. This reviewer inspected source, saved receipts and hashes, and performed no build, test, field evaluation, curve query or geometry reconstruction.

## Source binding and admitted real geometry

A binds the actual cylinder, native twisted extrusion, competing lathe, groove, cap cutter and outer sphere through source occurrences and operator ancestry. It requires the supported identity source frames and coaxial positions rather than assuming arbitrary transformed fields have those properties. The cylinder's sign, axis and represented radius must agree with the registered primitive. The native twisted-side parameters must agree with the actual source extrusion, including position, height and twist.

When the native side participates in the reduced root function, `finite_profile_level` invokes `profile_branch`. That helper establishes a strictly convex represented polygon, a finite interior projection on the selected edge, exact cardinal outward normal and separation from all other finite edges. Oblique selected edges reject. This avoids equating a rounded arbitrary carrier normal with an exact Euclidean segment distance. The cap margin establishes that the native side controls the extrusion field on the admitted region.

When the selected edge cannot be proved nearest, A may instead prove that the entire inverse-twisted region lies strictly inside the actual convex polygon. Interval-derived distances to every supporting line bound the radius of an inscribed ball. Together with the cap bound, this gives a negative upper bound on the actual native field. The native field and its chamfer contribution must both remain strictly negative before they are omitted from the root argument. This is not permission to choose an arbitrary supporting edge or ignore a competing positive branch.

The explicit height restriction keeps the twist clamp inactive. Trigonometric intervals use the existing fixed Taylor/remainder construction, not a guessed libm accuracy margin. The radial derivative and finite lathe normals are enclosed by interval arithmetic. The finite meridian certificate establishes exterior position, interior projection and unique nearest finite segment for both relevant lathe branches. These are whole-region restrictions over the actual X slab, not restrictions borrowed from the earlier fixed-radius cylinder curve.

The result models the real source equations over represented inputs. It does not prove bitwise identity with discrete floating-point CPU/WGSL evaluations, nor make a uniform libm-error claim for those evaluators. Existing numerical-query validation and later parity obligations remain separate.

## Zero equivalence, strong decrease and one coherent root graph

Write E for the admitted native field, C for the cylindrical side, D for positive exterior groove distance, r for the chamfer radius and w for its represented positive coefficient. With the inner competitor beyond its round radius, the native field below that radius and the cylinder cap inactive, the relevant hard intersection is `max(E,C)`.

The signed groove is `-D<0`. Therefore the chamfer has the same zeros and signs as

`K = max(E, C, w*(E-D+r), w*(C-D+r))`.

The cap cutter is strictly negative. The sphere operand lies below its outer-round cutoff. Those ancestors preserve the reduced expression's zero set and sign. They need not preserve every negative field value, and the full field need not itself be globally strongly monotone. A correctly reports that it is not claiming global monotonicity of the full field.

If the actual native field and its chamfer contribution are proved strictly negative throughout a region, they can be removed from this zero/sign argument. That region uses only C and the cylinder/chamfer term. The two reductions still describe the same full-source zeros where regions overlap.

For every retained smooth K term, A encloses the X derivative strictly below zero. If all terms decrease by at least mu, their maximum does too, even when the active facet changes. Strict opposite signs at both ends of the common world-X slab then give exactly one full-source root for every admitted YZ point.

All accepted pieces use the identical world-X slab. Consequently, shared-edge and overlapping-piece roots agree by uniqueness in that same interval. Separate unique roots in unrelated slabs would not suffice; this implementation avoids that gap. Continuity follows from the continuous strongly decreasing reduced functions and strict brackets, with agreement on the finite closed piece cover. The theorem excludes additional roots only within the admitted slab, not remote surface sheets elsewhere.

## Entire closed-domain coverage and error bound

A does not infer coverage from the 48 probes used in round34. It starts from every supplied closed triangle and subdivides by formal exact dyadic midpoints. Interval midpoint coordinates enclose those exact affine points; the proof does not pretend rounded midpoint coordinates exactly partition the parent. Whichever edge is selected, its formal two-child split covers the complete closed parent. A successful empty work stack therefore leaves no unproved area or boundary suffix.

There is one global cap of 128 attempted region checks, including failed/refined attempts, and a depth refusal at 12. The reviewed guard refuses before a 129th region evaluation. The negative control with 126 repeated triangles checks the aggregate cap rather than allowing 128 attempts per input triangle. No tolerance or budget is increased.

For each retained C2 term g, the interpolation remainder obeys

`|g(p) - sum(lambda_i*g(v_i))| <= M*diameter²/6`.

Taylor expansion about p cancels the first-order term. The remaining quadratic sum is bounded using `sum(lambda_i*|v_i-p|²) = sum(i<j)(lambda_i*lambda_j*|v_i-v_j|²) <= diameter²/3`. A spectral Hessian bound M suffices; A uses a Frobenius bound for the twisted side and the exact radial Hessian norm bound `1/rho` for the cylinder. Chamfer bounds use the triangle inequality and interval-derived finite meridian coefficients.

The derivative/Hessian bounds hold over the convex hull of the actual slab region. Vertex values, interpolation diameter and arithmetic are outward enclosed. The resulting per-term bounds enclose K over every point of the affine mesh subtriangle. Strong decrease turns a residual bound epsilon into a same-YZ X-displacement bound `epsilon/mu` to the unique root. This controls both directions between the affine triangle and the source graph over that triangle's projected domain.

The source argument is conditional on the supplied projected triangles describing the desired geometric disk. That condition is supplied independently by B, not inferred from source residuals.

## Exact projected disk and export composition

B accepts only the bounded indexed cyclic fan with one distinct apex and a simple projected boundary. Exact orientation predicates require the apex to lie strictly in the same inward half-plane of every boundary edge. Nonadjacent boundary edges may neither cross nor touch; projected vertices must be distinct; every triangle must be exactly the corresponding cyclic fan triangle. The simple boundary and strict kernel condition imply that the entire projected polygon is tiled once, with disjoint triangle interiors. Adjacent backtracking would contradict the common strict half-plane condition.

The same source-coordinate vertex is used on both incident triangles, so their affine X values agree along shared edges. The working mesh is an embedded graph over one YZ disk. B repeats the checks after coordinate rounding to f32 and requires matching projected winding. It does not assume that the f64 and f32 projected domains are equal.

For each triangle, the maximum outward-enclosed vertex rounding displacement bounds the displacement at every equal-barycentric point, by convexity of the Euclidean norm. An independently proved source-to-working bound delta then combines with that rounding bound eta as delta+eta. This gives a two-sided distance bound to the same source-graph disk through the barycentric correspondence. It does not assert that source roots have been proved over every point in the changed f32 YZ domain.

Root's selected Composed test explicitly checks that A's triangles and B's fixture-derived triangles have identical coordinate bits in identical order. It calls B's geometry audit and error composition with A's returned per-triangle bounds and the unchanged original tolerance. This closes the otherwise conditional scalar-bound/input-binding obligation. An arbitrary vector of small scalar bounds passed to `combine_error` would not be source authority.

## The actual boundary counterexample does not refute mesh validity

C binds the recorded first-fan edge 40→38, original pin provenance and original cell loop. It rebuilds the original pipeline lattice, checks exact cell-box bits, derives the packed face's X plane and matches the first-fan coordinate bits. The fixture is a recorded witness; fresh component preservation is still needed before applying it to a changed candidate.

At the exact dyadic YZ midpoint of that edge, the existing source-region certificate proves the cylinder lift is exposed in the full composed field. The lifted X interval lies strictly off the original face plane, by approximately 2.23725e-6. The same-YZ distance to the original edge midpoint is also bounded below and above, and stays below the original 0.01 surface tolerance.

This proves that this chosen lift does not preserve that exact face plane. It does not prove tolerance violation, mesh invalidity, failure of the full-fan graph theorem or absence of another boundary transport. Exact cell-plane preservation is one sufficient interface strategy, not a universal necessity. Neighboring patches could potentially share a common moved source boundary, but that agreement and its no-gap/no-overlap and endpoint/junction obligations are not inherited from one fan's graph certificate.

The source graph may also change active max facets. It does not authorize assigning all six triangles the single cylinder stratum ID. A future ownership token must bind the admitted source/branch set or a more restrictive certified subdivision. No patch labels or production geometry are changed here.

## Review findings closed in the selected revision

Two source/provenance details were corrected before selection, without changing the successful witness geometry:

1. The capped-cylinder primitive evaluates radius and half-height after a 1e-6 floor. The new source binder initially checked only a positive finite radius and used raw radius/height. The selected full-source binder now rejects parameters outside the unclamped range: finite radius and half-height at least 1e-6, with a focused guard control. The actual radius/height are safely above the floor, so this does not refute the recorded first-fan bound. A smaller raw half-height would give a stricter cap restriction, but explicitly matching both parameters avoids an implicit source-model exception.
2. Root discovered that C's captured face label used length 1, whereas the actual parent record is `[0,3464532,2]`. The key-derived plane and geometric gap are unchanged, but an exact actual-FaceRecord claim must retain its real length, extent, consumer pair and original segment-to-private-point mapping. The actual consumers are `[7,25,58,86]` and `[7,26,58,86]`. The selected fixture and checks now bind the real length-2 record, its extent, both oriented consumers and original segment mapping; even a coherently shortened record is rejected. A plane counterexample alone did not validate the old length metadata.

For cylinder cap handling, `cap_margin` by itself would not imply a purely radial capped-cylinder field if both radial and cap distances were positive. In an accepted certificate the strict right bracket includes a negative C upper bound. Since the cap bound lies below the global lower bound of C, it then necessarily lies below zero over the entire region. Thus the accepted source reduction is sound; this is a logical consequence of the complete accepted predicates, not a separate unclosed failure.

## Saved execution evidence verified

I verified source-input hashes and saved test-binary hashes for:

- A-check: 208 inputs, one passing source test; binary `96958204adec350c5433e09b488eb7484c5b175ec5792425a955cf31617e82c5`.
- B-check: 209 inputs, three passing geometry/rounding controls; binary `e5601b496b5ffd8cd6f7b1cf4bc98ca6d96f74fcbcf43683965bc53676c557a5`.
- C-check: 209 inputs, two passing boundary controls; binary `b30807be9a5882e56acdce0f01ae20e705ab41565d1b48ed6f698f51b3b0dc6a`.
- Combined: 212 inputs, 47 distinct passing focused tests; binary `1e46ced18d0bf7971d4bc880ff3612e96037c76afac7fcf64dfe9222b308fd47`.
- Composed: 212 inputs, 47 distinct passing focused tests; binary `6e565953e7cd69c3191df808e12792f27adb5ccd6ba7b2ce107c9a508417a2a0`.

Combined contains separately executed source/domain tests. Composed adds the explicit exact-input A/B composition and its saved receipt. The Composed focused campaign finishes in 23.956 seconds within the unchanged 60-second cap. Counts overlap and are not additive.

The selected proof uses 15 accepted pieces from 24 attempted checks, all within the single 128-check cap. The common slab is `[-9.3690502954966,-9.324576470564953]`. The minimum recorded decreasing-rate lower bound is `0.8610098527465292`; the weakest recorded left sign is positive `0.00834290774814789` and the weakest right sign is negative `-0.008314016729317255`.

The source-to-working bound is `0.0005052995078438982`. The uniform vertex/triangle export bound is `5.206356205475152e-7`. The exact-input combined source-to-export bound is `0.0005058201434644458`, below the unchanged tolerance `0.01`. The result leaves intended cell-trim coverage, conforming neighbor transport and publication false.

The selected revision and its fresh preservation execution are recorded below; earlier campaign counts are historical evidence, not additional independent coverage.


## Selected revised proof execution

The final selected source is `/tmp/sfcc-fullfan-reviewed`. I verified all 212 input hashes and test-binary SHA-256 `38729ffe1fb63814ef00e0590f0442cce557122a668a6596036afe46bb6b864e`. Saved logs contain 48 distinct passing focused tests in 28.698 seconds under the unchanged 60-second limit. The non-test library check passes in 2.924 seconds.

The source receipt now explicitly records the inactive primitive cylinder clamp. All 15 accepted piece certificates, their 24-attempt cover, common slab, per-triangle bounds and uniform source bound are unchanged from Composed. Geometry and export-composition receipts are also unchanged. The revised C receipt identifies `[0,3464532,2]`, records its actual original face/consumer/segment data and confirms the length/extent binding. Its proved off-plane gap is numerically unchanged.

No additional blocker was found in the admitted source-graph, exact projected-disk and export-approximation arguments. Full-source real geometry is certified locally over the complete supplied disk in the common slab; exact cell/feature trimming, adjacent-patch source-map agreement, remote-sheet exclusion, whole-component source ownership, full outside compatibility, complete allocation accounting and production/native-WASM/GPU parity remain unproved. A single cylinder patch-owner label is not authorized for the composed graph.


## Final runtime preservation and disposition

The final Reviewed complete diagnostic exits successfully in 36.856 seconds under the unchanged 120-second cap. I compared it directly with the round34 selected receipt. Candidate point payloads, triangles, indexed topology, frontier rows, sorted curve intervals, generated query records/costs, per-cell triangle ranges and retained metadata are identical. The fan inventory and separate outside probe are identical after excluding only explicitly process-local root addresses. Both live-state digests remain unchanged.

The first fan's boundary, triangles and all position bits match the exact fixture used by A/B. The corrected C `originalFaceRecord` equals the fresh candidate frontier record `[0,3464532,2]`, including both actual consumers, original segments and point bindings. This closes the fixture-to-current-witness link; the plane distance remains the previously established approximately 2.23725e-6.

The private component remains 205 cells / 1,031 required faces / 1,775 triangles, with all 1,929 generated events validated at 8,413 ledger charges. The earlier single outside-neighbor witness is preserved; the opposite consumer of C's specific X face has not thereby been reconstructed or source-transport certified. Publication remains explicitly blocked.

The selected result is stronger than the earlier small-region proof: all six closed projected triangle domains form an embedded disk, their full-source roots agree in one common slab, and the source disk is within 0.0005058201434644458 of the f32 exported fan through the proved correspondence, below the unchanged 0.01 tolerance. This does not claim a common boundary map across neighboring patches or that the lifted disk equals the intended cell-/feature-trimmed source patch.

The next precise discriminator is the actual opposite consumer `[7,26,58,86]` across `[0,3464532,2]`: establish a common source-bound boundary transport and compatible lifted-domain coverage across that interface, or retain the first concrete refusal. Exact cell-plane preservation is optional if a different common transport is proved; agreement, no gaps/overlap and correct endpoint/junction incidence are not optional. Full-component ownership, all relevant outside geometry, remaining workspace/metadata obligations and production/native-WASM/GPU/full-model preservation remain later gates.

Both review findings are closed in the selected source. No additional blocker was found for archiving this bounded experimental milestone. No source-owner labels or production changes are authorized by this review.
