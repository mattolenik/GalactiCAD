# Independent lower connection audit B

Status: test-only source prepared, not yet executed. No runtime changes.

## Scope

Parent is `/tmp/sfcc-closure-a-cell`, HEAD documentation `edec94a`. B owns `/tmp/sfcc-lower-b`.
Changed files: `gcad-wasm/kernel/src/sfcc/exposure_a.rs` (test module registration only), new `gcad-wasm/kernel/src/sfcc/lower_b_tests.rs`.
Root should build with the pinned existing runner, test filter `lower_b_`, and set `SFCC_LOWER_B_RECEIPT` to a fresh receipt path. No builds or geometry were run by B.

## Independent algebra

Let E be the actual finite extrusion field, C the actual finite cylinder field, G the sign-negated groove field, and g=G+r, where r is the chamfer radius. If the inner round, cap cutter and outer round ancestors are strictly inactive in a neighborhood, G<0, and the finite-source scalar branches agree with these coordinates, the local source is

`F=max(E,C,w(E+g),w(C+g))`, with w>0.

In invertible coordinates (E,C,g), this has exactly four incident physical rays: `(0,0,-q)`, `(0,-q,0)`, `(-q,0,0)`, `(-q,-q,q)` for q>0. The six possible pairwise active-facet intersections yield four nonzero feasible rays; the remaining two pairs force the origin by their other inequalities. A test enumerates all six pairs and both ray signs. This is an algebra control, not an independent proof that the actual source admits the coordinate neighborhood.

The last ray is the missing lifted continuation. The existing lower repair addresses the native/chamfer ray, not this fourth ray. Current captured corner13 contains native `[10,15]`, native/chamfer `[31,10]` and alias `[31,30]`, and cylinder/chamfer `[31,15]`; it lacks lifted `[38,39]`.

For general local coordinates the candidate physical point has `rho=R+C`, `v=v0z+E*nz`, `u=sign*sqrt(rho²-v²)`, `y=y_edge+((r-g)-nr*(rho-r_edge))/ny`, rotated by the actual twist at y. On the lifted ray E=C=-q,g=q, y decreases linearly in q. The exact source formula establishes order once the radicand and finite-source neighborhood are bounded. It does not establish continuity of the old numerical projection map.

## Tests prepared

1. `lower_b_four_facet_star_has_four_and_only_four_rays`: algebraic feasible-pair enumeration.
2. `lower_b_source_star_and_actual_lifted_frontier`: reconstructs original source and qualified lower junction, locates source roles by actual paths/descriptors, checks four-ray samples against actual finite fields and actual full source, records actual lifted final-span ownqueries, endpoint source coordinate and 3D association, and checks the known missing lower incidence. Dense IDs are recorded, not selection authority. Sampled equality does not substitute for A's interval theorem.

Next: use execution to identify the actual last-span join, then bind A's source interval at its inferred negative level and check the join against the rigorous image. This should supply a canonical replacement interval with a checked existing join, without claiming old-query continuity or installing an unproved runtime attachment.

Skipped: no runtime mutation, graph acceptance, component execution, or widened budgets. The complete affected component remains unproved.

## Executed independent diagnostic and composed association candidate

Root executed the immutable initial B source under Rust 1.99.1 after discovering the old 1.99.0 installation was unavailable. Both `lower_b_` tests passed. Receipt: `.testresults/sfcc-critical-repairs/e4-invalid-construction/round28-lower-connection/B-1991/lower-B.json`. Root owns toolchain cross-check scope.

The actual source-bound lower lifted curve is chart75 in this execution, range [0,13]. Its final query is **1.6551860684e-5 mm** from the existing source event. The query has E≈−2.6321011903e−6 and matches the independent ideal lifted point within ≈4.50e−11 mm. It has not reached a geometric terminal: it stops strictly inside the continuing negative-level source chart. At raw parameter12, the existing join has E≈−0.04456486659936143, C≈−0.04456486597724307. Thus a checked replacement must cover a much longer interval than the tiny endpoint gap; proximity alone cannot authorize it.

New immutable candidate **`/tmp/sfcc-lower-b-associated`** combines B diagnostics with A's full-scalar certificate and source-identity fix. Relative to the selected upper-closure parent it changes exactly:

- `gcad-wasm/kernel/src/sfcc/exposure_a.rs`: A module and B test registrations.
- `gcad-wasm/kernel/src/sfcc/upper_source_a.rs`: A's helper visibility only.
- New `gcad-wasm/kernel/src/sfcc/lower_source_a.rs` and `lower_source_a_tests.rs`: copied verbatim from A's reviewed prefreeze source.
- New `gcad-wasm/kernel/src/sfcc/lower_b_tests.rs`: independent two controls plus `lower_b_actual_join_has_ordered_canonical_connection`.

The third B test binds the full-source certificate at depth `−E(join)`, checks the actual stored join and existing corner against rigorous endpoint image bounds in 3D, retains the original allowance, and checks the old end lies strictly inside this interval and farther than the allowance from the source event. The canonical replacement uses a from E(join) to0; A's nonzero affine height derivative gives ideal injectivity/order, while sampled outputs check the actual finite evaluator. Wrong spatial join, wrong source pair, out-of-range interval, opposite-side interval and NaN refuse.

Root execution required: filters `lower_b_` (three tests), `lower_a_` (two), existing retained controls as appropriate. Set `SFCC_LOWER_B_RECEIPT` and **`SFCC_LOWER_B_ASSOCIATION_RECEIPT`** to separate fresh paths. The association candidate is static/unexecuted as of this handoff; root will append the actual result.

### Independent A review

The four-ray statement needs an open source-coordinate neighborhood, not just values on one curve. A's strict finite-profile, nearest-groove, caps and ancestor margins at the event persist in some open neighborhood; its nonzero coordinate Jacobian gives a local coordinate map. This justifies an existential local arrangement but gives no numerical radius for a cell-wide arrangement guarantee. Along the lifted interval, A separately bounds full scalar equality.

B caught a source-identity gap in the initial `curve_source_matches`: comparing only dense IDs and embedded carriers against a supplied registry could accept a coherent foreign source. A fixed this before freezing by retaining the actual immutable root Arc and selected lifted descriptors, and testing coherent and mixed foreign source refusals. B-associated includes that fix.

The candidate does **not** prove totality or continuity of the old Newton projection map. It proves the intended replacement's ideal source path and checks its existing raw join. It installs no chart or graph incidence, changes no budgets, and performs no rollback/publication operation. A runtime atomic transaction would still need metadata, query/image/tangent/index/clone/storage integration, all positive-closure consumers, complete event incidence, and failure rollback before any new component attempt could establish that the lower graph failure is fixed.
