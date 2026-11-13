# C: exact first-cell graph replay and alias-merge challenges

Frozen source: `/tmp/sfcc-alias-c`, copied from `/tmp/sfcc-alias-base`.
The agent inspected source and saved receipts, extracted a fixture, wrote tests,
and ran rustfmt for static parsing. Root alone executes builds, tests and geometry.
No passing runtime result is claimed here before root's receipts exist.

## Changed files and execution

- `gcad-wasm/kernel/src/sfcc/cell_mesh.rs`: test-only module registration.
- `gcad-wasm/kernel/src/sfcc/alias_graph_c_tests.rs`: two source-backed controls.
- `gcad-wasm/kernel/fixtures/alias-graph-replay.json`: exact captured graph inputs,
  expected guard/graph/new-point output and all 50 generated query records.

Run filter `alias_c_` with `SFCC_ALIAS_C_RECEIPT` set. The first test writes that
receipt; the second has ordinary assertions. Production/runtime source behavior,
query limits, ownership bands and the repeated-vertex guard are unchanged.

The fixture is derived from round30 A-guard's actual component receipt and carries
its SHA256 and the original scene/configuration SHA. It is 272,959 bytes. It does
not fabricate a source evaluator or infer geometry from a topology-only graph.

## Exact graph-entry replay

The first test rebuilds the complete original scene and feature set. It verifies
its fingerprint, restores all 628 captured private point coordinates, normals and
provenance keys bit-for-bit and in original index order, and reproduces the private
20/39 view edit. It checks the captured incident corner and curve metadata against
that fresh source instance.

It then invokes the actual `mesh_feature_graph` with captured loops, pins,
corner IDs, cell box and options, keeping the current guard enabled. The real
GeneratedQueries observer records every actual own query, including any failure.
The required result is the original `non_simple_patch_boundary` refusal. The
rejection operands, complete partial graph, new point data and all 50 query bits
must equal the captured execution. Pre-input metadata must match except for
process-local root addresses. No triangles may be returned from the graph.

This is a replay of the graph-entry computation through its refusal. It is not
an octree/FaceRecord consumer replay or complete-component construction. The
PointTable's position/normal/key state is reconstructed; unrelated patch-owner,
protected-edge and coverage bookkeeping is not present in the saved pre-input.
Those maps are not read on this captured guard path: feature membership edges
are accumulated locally and only committed after the rejected region. The test
must not be described as authority for an arbitrary later code path that begins
reading additional PointTable state.

The diagnostic context's cell key is not captured or read by the graph and is
set to zero; its level/coordinates and all context fields consumed by capture
are restored exactly. No lattice or typed-face identity is inferred from that
placeholder. A scope clears diagnostics even if an assertion unwinds; the
NumericalGuard restores enclosing numerical-failure state.

## Existing sharing refuses for two independent reasons

The second test reconstructs and actually samples the two consumed spans under
the captured options. They share their corner vertex but end at distinct original
ports 454 and 455. The existing `transport_shared_arc` refuses without mutation.
Even a test-only remapping of the endpoint *label* to match the other arc still
refuses because global chart endpoints are different:

| Chart | Full range | Global corner ends |
| --- | --- | --- |
| 46 | [0,16] | [13,-1] |
| 66 | [0,40] | [13,29] |

The local consumed spans end much earlier. Thus neither matching a port label nor
proving one shared source point licenses identifying the complete curve objects.
The missing authority is explicitly scoped interval correspondence and a coherent
shared-face transaction, not deletion of the existing endpoint checks.

These fixture IDs identify the captured objects; their source metadata and original
source fingerprint are checked. They are not proposed runtime selection criteria.

## Independent review of the other proposals

The source certificate must distinguish its ideal ordered radial locus from the
old numerical Newton map. Successful consumed event checks do not prove continuity,
uniqueness or totality of that old map. I asked A to check canonical radial order
for both event sequences if it intends to claim it, rather than only the origin's
radius and both raw parameter orders. Its immutable feature borrow is a suitable
source-identity boundary. The new inverse queries must remain charged against the
existing ledger; repeated endpoint/knot searches can consume substantial budget
without caching and must be measured, not waived.

The face proposal must derive its rectangle using the same lattice arithmetic and
container contract as the existing face-root checks. `lo + len*step` and a separate
`point_to_world(g+len)` can differ in rounding; silently changing the boundary
convention is not a typed identity proof. The witness appears well inside its face,
but exact identity/container claims still need the original convention or an
explicit enclosure. I sent this concern to B.

Face changes require every direct and indirect consumer of the canonicalized point
and segments. The existing primary20/39 component is not automatically closed for
this second equivalence. New source/corner metadata must preserve old supported
ends; a blanket omission of curve66 from the feature index can discard portions
outside the new interval certificate. A scoped interval view may be necessary.

No source proof, local graph success or diagram-only planar rotation grants
publication authority. The changed component still needs both-precision geometry,
post-graph transport/order, topology, frontier/contact and patch ownership checks.

## Root execution and subsequent review

Root executed both `alias_c_` tests successfully in round31 `C-replay`. The actual
first-cell guard, new points and all 50 generated query records match the captured
component. The fixture is now an executed graph-entry replay within the scope
above, not just a proposed test.

Further concrete review points sent to A/B:

- Binding must reject a curve whose stored `id` differs from its registry index;
  otherwise the actual query observer can log a different chart from Event.chart.
- GeneratedQueries records the *own-query point*, not a canonical stored vertex
  that consumes the mapped parameter. Therefore post-meshing log validation does
  not automatically validate a shared native node against the other chart. Every
  canonical stored point needs direct association to both actual queries and their
  source/container contracts, including face endpoints and the corner. B agreed.
- The rectangle formula concern was resolved at the convention level: the existing
  typed-face helper already uses minimum-plus-extent. B should preserve that original
  convention and its enclosures, rather than substituting another rounding order.
- A's order check now checks decreasing canonical radius in both event sequences,
  in addition to strict raw parameter order. Keep that check when composing the
  runtime helper.

B's fresh read-only inventory records 161 secondary-family face records: 155 have
only chart66, and six have both46/66; there are no46-only records. Selecting the
entire66 family would grow the existing199-cell/1001-face component to360 cells
and1834 faces, exceeding the unchanged256/1536 caps. This is an overbroad candidate,
not proof that every supported local equivalence must exceed the caps. The relevant
scope starts with source-qualified paired faces and all their direct/indirect users.

The target face's users are the original coarse cell[7,25,58,86] and the fine cell
[8,51,115,172]. Canonicalizing only one boundary can leave the neighboring cell's
other ports split and create an artificial alias wedge or unsupported frontier.
The transaction must close that effect under its actual consumers; the old primary
component is not automatically sufficient.

The curve direction choice also matters: native46 has a shorter unresolved range,
whereas composite66 has a continuing range and another terminal corner. Reusing
the primary20/39 policy of keeping the native representation and globally omitting
its composite alias could discard legitimate66 continuation. A canonical face
point choice does not by itself determine which full curve should survive. Any
omission must be confined to a proved complete scope, with all other intervals and
source identities retained.
