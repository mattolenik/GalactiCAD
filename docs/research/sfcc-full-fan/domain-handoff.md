# Round35 B: exact fan domain and conditional source-to-export transport

Selected frozen source: `/tmp/sfcc-fullfan-b-reviewed`, based on `/tmp/sfcc-ownership-clamp` (207 parent inputs).
Changed files and SHA-256 values are in `/tmp/sfcc-fullfan-b-reviewed-changes.json`:

- `gcad-wasm/kernel/src/sfcc/cell_mesh.rs`: test/serde module declaration only.
- `gcad-wasm/kernel/src/sfcc/fullfan_geometry_b.rs`: independent domain/rounding checker and three tests.
- `gcad-wasm/kernel/fixtures/fullfan-boundary-b.json`: compact original cell-box and boundary-interval evidence extracted from the saved round34 complete receipt.

B ran no build, tests, source evaluation or geometry. Root reports all three `fullfan_b_` controls compile and pass for the initial `/tmp/sfcc-fullfan-b` source. The selected revision adds only explicit working/export winding equality and its receipt flag; it requires the combined execution. Root owns authoritative executions and artifacts.

## Exact entire-domain argument

The checker accepts only a bounded cyclic fan: one distinct apex, 3–64 distinct boundary vertices, and exactly the triangles `(apex, boundary[i], boundary[i+1])` in that order. Every used coordinate must be finite. It uses the existing exact `orient2d` predicate, not an epsilon.

For YZ projection it verifies:

1. Boundary projected points are distinct and nonadjacent boundary edges neither cross nor touch.
2. The apex is strictly on the same inward side of every directed boundary edge.
3. Every triangle is exactly the corresponding cyclic fan triangle, so its projected orientation is nonzero and agrees with the polygon orientation.

The simple polygon and strict kernel condition imply that its fan triangles tile the entire closed polygon once, with disjoint interiors. This is an entire-domain geometric theorem, not a sample-based normal test. Adjacent boundary backtracking would contradict the strict common half-plane signs. The same source-coordinate vertex is used on both incident triangles, so the affine X values agree along every shared edge. The original mesh is therefore an embedded piecewise-affine X graph over one projected disk.

The same checks run independently after each coordinate is represented as f32 and converted back to f64. Both projected domains are embedded disks. The selected revision additionally requires the working and exported winding signs to agree, so the barycentric correspondence preserves projected orientation; a global rounding-induced reversal refuses. The parent construction retains its independent source-normal orientation checks.

## Source and exported-mesh approximation

`audit(boundary, triangles, points)` returns a `FanDomain` with private fields, so error composition cannot manufacture a geometry token from arbitrary JSON. `report()` exposes the explicit geometric receipt.

For each triangle, interval subtraction/squaring/summation and outward square root bound the norm of each original-to-f32 vertex displacement. Its maximum is a uniform displacement bound η for the whole triangle under equal barycentric coordinates, by convexity of the norm. `combine_error(&domain, per_triangle_source_bounds, tolerance)` combines each independently supplied source bound δ with η using outward interval addition and refuses a result above the original tolerance.

If A proves a continuous unique source root X=g(Y,Z) over the whole original projected disk, then the lift is a homeomorphism from the original fan to that root-graph disk. A common uniqueness slab makes adjacent pieces agree on shared edges. If A also proves `|g(Y,Z)-Xmesh(Y,Z)| <= δ` throughout each closed triangle, then this gives a two-sided Hausdorff bound and boundary displacement bound to that source graph. The f32 bound is δ+η by mapping the SAME original barycentric point to its rounded triangle. This does not assume the f64 and f32 YZ domains coincide and does not assert that source roots exist over every point in the changed f32 YZ domain.

The caller must bind each δ to the exact triangle/order/point bits in the geometry receipt. `combine_error` is explicitly conditional on that source certificate; its scalar argument is not new source authority.

## Boundary constraints are a distinct obligation

The actual first fan has boundary IDs `[40,38,41,464,465,647]` and common apex653. Its compact evidence records:

- point40: X-face pin `F0:3464532:49:32.757331135496`;
- point465: Z-face pin `F2:3398483:20:0.001004350170`;
- point647: corner13;
- edge465–647 carries primary chart20 and alias39 memberships;
- edge40–647 carries chart49 membership.

X-directed graph transport keeps Y/Z but generally moves X-face points off the original plane. It therefore does not establish exact retained-face or feature-curve incidence, nor that this root graph is exactly the intended cell-trimmed patch. The existing primary typed root evidence can supply a different face-constrained endpoint association, but gluing that endpoint into a whole boundary transport requires additional source/parameter-domain work. C independently owns the actual X-face discriminator; B avoids duplicating it.

The code sets `intendedTrimBoundaryCorrespondenceProved`, `sourceFacePlaneIncidencePreservedByXLift`, and publication authority false. This is not permission to relabel mesh triangles with source owners or publish a replacement.

## Controls and limits

`fullfan_b_` selects three tests:

- Actual six-triangle fan: exact YZ disk in working and f32 coordinates, bounded rounding receipt.
- Wrong triangle inventory, apex outside the kernel, and f32 vertex collision must refuse.
- Conditional error composition retains the original tolerance and rejects NaN/wrong-length bounds.

No limits are increased, no source queries are performed, and no production path is changed. The checker is bounded by 64 boundary nodes / 128 input point records and uses the existing exact predicates and interval helpers. Its small vectors/maps are not a whole-program allocator/RSS certificate. Source root existence, fullfield exposure, boundary conformity, outside compatibility and publication remain separate gates.
