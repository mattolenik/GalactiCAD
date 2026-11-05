# Stage 4 A: geometry readiness and refusal boundary

## Disposition

No new runtime geometry checker is proposed before the source-admission preflight.
The selected source was copied unchanged to `/tmp/sfcc-stage4-a`; all 164 inputs
match the executed Stage 3 A-rollback manifest. `candidate.patch` is empty.
No build, test, geometry query, mesh capture or visual validation was executed by
this author. Root owns execution. This packet is a connected-code audit, not a
claim that component geometry is valid.

The source agent is independently reidentifying the physical/alias charts and
executing the unchanged admission gate. Static inspection shows that
`private_arc_a::admit` invokes `admission_query_reservation` before transport,
face reconstruction or candidate meshing. The selected feature compilation now
has unresolved upper endpoints; any resulting `endpoint_missing` is a genuine
prerequisite refusal, not permission to remove the endpoint condition. If it
occurs, all candidate-geometry, winding, f32, internal-contact and outside-contact
obligations are **not reached**. An empty candidate must never make them pass.

## What the existing constructor actually checks

`shared_arc_plan::construct_private` privately constructs all selected cells. A
failed cell or feature fallback rejects the complete candidate. It subsequently
checks affected face-consumption counts and retained frontier coordinate identity.
For every emitted triangle it calls `triangle_quality::valid_orientation`, using
the root gradient at the f64 centroid as reference. That routine rejects nonfinite
coordinates, zero/nonfinite cross-product norm and nonpositive normal dot product
in both working f64 and coordinates rounded through f32.

These are useful necessary checks, but not a complete geometry certificate:

- The orientation reference is a numerical sampled field gradient, not a proof
  of complete source ownership or global winding. Singular/ambiguous source
  gradients and seams need explicit unresolved treatment; topology alone cannot
  manufacture the missing orientation premise.
- The constructor does not retain per-triangle failure identities in its generic
  `private_invalid_f64_or_f32` refusal. A later successful candidate audit should
  record triangle IDs, original indices and exact coordinate bits separately for
  f64 and rounded geometry.
- No complete candidate self-contact audit is invoked by this constructor.
- Its final receipt explicitly blocks publication for retained-outside contacts,
  complete affected links/frontier and source completeness. A returned candidate
  is therefore not an acceptance result.

## Reuse the existing predicates once a complete candidate exists

No new intersection or exact-arithmetic implementation is needed. Existing source
already supplies:

| Obligation | Existing helper | Necessary input discipline |
| --- | --- | --- |
| Exact represented zero-area test | `diagnosis::triangle_exactly_degenerate` | Validate finite coordinates first; call separately on f64 and f32-rounded coordinates |
| Geometric orientation | `triangle_quality::valid_orientation` | Preserve the source of the reference normal; numerical agreement is not global source proof |
| Sliver/minimum-angle statistics | `triangle_quality::measure` | Diagnostic distribution, not a reason to delete triangles or widen thresholds |
| Internal and selected-to-outside contacts | `diagnosis::mesh_intersections` / `mesh_edit::TriangleIndex` + `intersects` | Complete index-valid input and one verified point-ID space; every relevant outside triangle must be supplied |
| Rounded-only contact broad phase | `mesh_edit::TriangleIndex::broad_bounds` | Bounds explicitly union the working and rounded triangle boxes |

The intersection primitive uses existing exact orientation signs and distinguishes
legal shared vertices/edges by topological point identity. Equal coordinates with
different point IDs are not silently welded. Shared point IDs cannot be invented
by concatenating private and outside arrays: their local integer IDs can collide.
The merge must use the verified live/private typed bindings and equivalences, with
fresh unique IDs for unrelated outside points. Otherwise contact classification
can incorrectly exempt a real intersection as adjacency.

Before passing data to `mesh_intersections`, validate triangle-index bounds,
triplet completeness, finite f64/f32 coordinates and degeneracy. Its interface
assumes valid indices and does not establish geometry availability. Bound the
contact candidate work and output; budget exhaustion must leave audit incomplete.
The private geometry caps remain 4,096 vertices/triangles. The initial complete
contact audit limit is 60 seconds, separately from the 120-second component
construction limit. Do not hide incomplete pairs behind a capped example list.

Existing relevant controls include f32-only collapse, legal adjacency versus
same-coordinate distinct vertices, shared-vertex penetration, rounded-only
intersections and broad-phase agreement with exhaustive finite fixtures. They
should be reused when their code/inputs change; rerunning unrelated controls now
would not overcome missing source admission or absent candidate geometry.

## Why retained-outside closure is currently unavailable

The diagnostic hook is at
`SERIAL_ROUND0_AFTER_CONTOUR_ALL_FACES_BEFORE_MESH_ALL_CELLS`. It has all live face
records and points, but ordinary outside cells have not yet produced triangles.
Their cell boxes, face point sets and boundary segments are not an outside mesh.
Constructing only the replacement and declaring its internal contact audit clean
would leave the interface obligation open.

A later admitted experiment must either capture all relevant same-stage retained
outside geometry or establish a conservative exclusion bound for every omitted
outside cell/triangle. Bare cell-box disjointness is not such a proof: projected
interior vertices can be accepted within an expanded cell margin, and feature
sampling has its own projection envelope. The complete actual construction-stage
bounds and identities must be checked. Comparing against post-assembly/simplified
output would compare a different stage and is not a substitute.

Topology agent B and I agreed that a successful private-candidate capture must
retain complete positions/triangle indices, component leaf identity and required
face/consumer records, while explicitly reporting
`sameStageOutsideGeometryAvailable=false` until genuine outside geometry exists.
No point, face or cell inventory count can turn that flag into a theorem.

## Smallest next experiment

1. Execute C's source-bound feature identification and unchanged admission gate,
   plus selected-source storage/clone preflight. Do not reuse old chart IDs or
   the old 198/396 certificates.
2. If admission refuses, preserve the exact first refusal and endpoint/source
   evidence. Stop component geometry work; report the geometric exits not reached.
3. If it admits, execute B's bounded regenerated component capture, stop on its
   first refusal, and retain all partial failure evidence without publishing it.
4. Only a complete returned component can be handed to the geometry helpers above.
   Record internal f64/f32 validity separately from missing outside contact and
   interface obligations. A further outside-geometry experiment needs its own
   bounded complete-input contract.

No normal, triangulation, tolerance, graph guard or source admission was changed.
Full component validity, emitted f32 validity, retained-outside contacts and
production acceptance remain unestablished by this read-only packet.
