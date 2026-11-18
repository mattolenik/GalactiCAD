# Round39 C: protected local fiber source attempt

Frozen source tree `/tmp/sfcc-adoption-c-local`. This is subsequent to the root-preserved actual44 common-slab refusal: 128 attempts,79 accepted,14 pending, triangle32/depth3, native_finite_side refinements, slab `[-9.3690502954966,-9.079263970564954]`. That refusal is not overwritten or reclassified.

## Minimal integration

Copy these files over the current combined research source:

| File | SHA256 |
|---|---|
| `gcad-wasm/kernel/src/sfcc/fullfan_source_a.rs` | `d2c83e04a1347eff70ec523812d30294c63092f990ab9f5f241177c8f1874608` |
| `gcad-wasm/kernel/src/sfcc/adoption_source_c.rs` | `8ffc4dd00b1592a3ab782fdbfb862b437687f9cc75e3f98b35d9ba9d5112a8cf` |
| `gcad-wasm/kernel/fixtures/incident-union-c.json` | `a8c0145afa01a9cc450fbc1960e4836e0ae04c159d2b41fc3d5619edb7220cbb` |

The existing `exposure_a::adoption_source_c` registration is unchanged. Fixture is an exact copy of root's normalized `/tmp/sfcc-incident-44.json`; no schema coercion is accepted in the Rust test.

## New source mode

`fullfan_source_a::attempt_local_fibers` uses the same checker and the same single global128 loop/depth12. Its slab for every subdivided piece retains the ORIGINAL triangle index:

`slab_i = [min(vertices_i.X)-tol, max(vertices_i.X)+tol]`, outward rounded.

Every admitted piece proves a unique full-source root in its original triangle slab and distance at most `tol` from the exact affine mesh height M(q). Its protected fiber `[M(q)-tol,M(q)+tol]` lies inside that slab for every projected point of the original triangle. Thus a unique root exists inside the protected fiber. Pieces belonging to one original triangle share the same slab and agree by uniqueness.

Across original triangles, equality is conditional on exact continuity of the mesh graph: on their common projected edge, both affine heights agree. Both roots then lie inside the SAME protected fiber, which is contained in both slabs; uniqueness identifies them. B must establish the continuous embedded graph and exact point/triangle order binding before claiming the glued graph.

No budget starts over per fan, cell or original triangle. No old certificate is replayed or reused. Existing `certify` and `attempt` keep common-slab semantics and old tests.

## Report keys for B

- `slabDomain: "original_triangle"`
- `commonWorldXSlab: null`
- `perOriginalTriangleSlabs: [[lo,hi], ...]`
- `originalTrianglePointBits: [[[u64;3];3], ...]` in exact source order
- `fullClosedTriangleDomainsCovered: true`
- `uniqueRootInProtectedMeshCenteredFiber: true`
- `protectedFiberHalfWidth: tolerance`
- `sharedEdgeRootAgreementConditionalOnExactContinuousMeshGraph: true`
- `sharedEdgeRootsAgreeByCommonSlabUniqueness: false`
- unchanged `perTriangleSourceBounds`, source fingerprint, cylinder and work counts
- `idealTargetProtectedFiberContainmentProved: false`
- `idealArcProtectedFiberContainmentProved: false`

An ideal point cannot be identified with the source root merely by satisfying the source equation or lying in the old global slab. It must lie in the relevant protected fiber at its target YZ. A sufficient checked bound is point-to-ideal displacement plus mesh graph Jacobian times projected displacement, strictly below tolerance. The analogous whole-arc containment must be checked before adopting the arc.

## Root-run tests

- `adoption_source_c_actual_44_local_fiber_attempt`: default actual44 embedded fixture. `SFCC_ADOPTION_C_FIXTURE` may override with an explicitly typed fixture; `SFCC_ADOPTION_C_RECEIPT` writes the source attempt before any assertion. Refusal remains failure.
- `fullfan_c_original_triangle_slabs_protect_shared_mesh_fibers`: checks slabs for triangles sharing an exact edge but different third-vertex X ranges, endpoint bounds sufficient by affine convexity, and invalid input guards.
- `fullfan_c_local_fibers_keep_one_global_attempt_limit`:126 supplied triangles retain one global budget and explicit local-fiber nonclaims;129 is refused at the domain cap. Successful/refused outcomes are both checked against total128 accounting, so this is a budget control rather than a manufactured acceptance test.
- Retain previous source common-slab positives/negative controls and actual21/34 checks as root sees fit.

## Execution and limitations

Only Rustfmt parsing was run by C, not builds/tests/scene or geometry evaluation. There is no claim that44 triangles pass this mode until the root run. C did not alter B geometry or A runtime capture. No production files, dependencies or numerical limits changed.
