# C: secondary consumer coverage and complete-candidate validation

The implementation adds exact indexed coverage checks for each supplied source-certified consumer window, plus a whole-candidate topology/self-contact check. It does not weaken any existing source, query, triangle-orientation, original primary-interval, or publication gate.

## Frozen source

Base: `/tmp/sfcc-activation-c-frontier-fixed` (round32 selected199-input source).
Candidate: `/tmp/sfcc-component-c`.

Only two files differ:

- `gcad-wasm/kernel/src/sfcc/secondary_component_validation_c.rs`: SHA256 `cd1de14d4caf38c244ae2a63cd2d11126195fef3becb01c7a8ba94ee77608fb2`.
- `gcad-wasm/kernel/src/sfcc/private_arc_a.rs`: SHA256 `9089f3a5c73898ece9c24f6327daab69cbe94754d824f87424e3a476b3f81196`; appends only a test+serde module declaration.

No build, test, geometry evaluation, or scene query was run by C. Root runs all execution serially. The `component_c_` filter selects five cheap synthetic controls. Root's initial snapshot may retain the previous first-contact refusal label `secondary_component_f64_contact`; the frozen final file calls it `secondary_component_contact_working_or_exported` because the existing GrowingIndex tests both working and rounded predicates. This is a diagnostic-label correction, not a predicate change.

## Integration API

`private_arc_a::secondary_component_validation_c::validate_consumer(points, triangles, charts, cuts, incoming, activation, event_point)` returns `Result<serde_json::Value, &'static str>`.

- `points: &PointTable` is the actual private table after this consumer is meshed.
- `triangles: &[usize]` is exactly this consumer's emitted triangle range, not the whole accumulating mesh.
- `charts: [usize;2]` is ordered native46/composite66 from the source-bound plan.
- `cuts: [f64;2]` are the original numeric event parameters.
- `incoming: &[Vec<(f64,usize)>;2]` is B's prepared original `(parameter,private point ID)` per chart. Ordinary cells have2/2; the activation cell has1/2 before event insertion.
- `activation: bool` and `event_point: [f64;3]` come from the actual source/cell-bound plan.

A calls it after successful meshing of each B consumer, while its emitted triangle range and original prepared input windows are available. Retain the per-consumer result. B separately requires every prepared consumer to be visited/completed; C does not infer complete consumer inventory from a subset of triangles.

`validate_mesh(points, triangles)` validates the entire accumulated candidate at the later constructor gate. It uses the existing topology and GrowingIndex helpers, not a new predicate engine. It preserves the constructor's separate source-normal orientation check.

## Exact consumer contract

For each chart, emitted triangle edges carrying that chart must form one parameter-ordered indexed path between the exact original endpoint `(parameter bits, point ID)` pairs. Sorting interval spans cannot hide a disconnected equal-parameter vertex: adjacent spans require both identical parameter bits and the same point ID. Gaps, overlaps, duplicate chart memberships, repeated path vertices and omitted endpoints refuse.

In ordinary incoming cells, the geometric edge sets of46 and66 must be identical and their endpoints must be the same private vertices. Each chart retains its own parameter values.

In the activation cell, native46 ends at its exact cut; the uniquely identified cut vertex must have the exact canonical event-position bits. Composite66 has that same vertex at its exact cut and continues to its original outgoing endpoint. The incoming66 edge set must equal the native46 set. No composite edge may straddle activation without the event vertex. There is exactly one native incident edge and two composite incident edges at the event. A native continuation beyond the cut refuses rather than being silently ignored.

This is combinatorial/parameter coverage conditional on A/B source authority and actual caller binding. It makes no statement about continuum SDF patch coverage, old Newton continuity/totality, global raw-tail classification, geometric approximation, or permitted publication.

## Complete mesh gate

The wholecandidate check rejects duplicate triangles, nonmanifold edges, inconsistent directed internal incidence and invalid vertex links through the existing topology helper. It rejects zero-area/export-collapsed or flipped triangles relative to their working face normal, and checks every candidate triangle against earlier candidate triangles through separate working and rounded spatial indexes. The existing GrowingIndex predicate itself checks both working and rounded coordinates; the second index additionally uses rounded broadphase geometry.

The returned receipt counts missing patch labels and explicitly leaves `continuousSourcePatchOwnershipProved`, `sameStageOutsideContactsChecked`, and `publicationReady` false. A patch label is not a continuous ownership proof. The existing `local_coverage` sphere/box scope does not certify this complex transformed knob's2D surface patches.

The current stage4 barrier runs before `mesh_all_cells`. Its existing `candidate_inventory` truthfully reports that no matching-stage retained-outside triangles are available. Passing complete-candidate self-contact does not settle contacts with the untouched outside mesh; this needs a later matching-stage outside capture/construction step.

## Original obligations retained

`shared_arc_plan::construct_private` checks complete original parameter intervals only for the primary pair20/33. Those full-range checks must remain unchanged. The new secondary46/66 consumed-window checks are additional obligations, not replacements. Extending the old full-curve alias rule to46/66 would be incorrect: their activity differs after the proved activation.

The source theorem only establishes bounded physical/generated families and actual queried associations. C's absence of native46 edges after the prepared cut is a statement about the chosen local path, not authority to delete the unsupported raw native tail throughout the global model.

Rollback remains structural: input live PointTable and FaceRecords are borrowed immutably and no commit API exists. A's staged-equivalence conflicts and B's scope/unwind controls remain required. A later publication path must independently validate actual outside interfaces and state replacement.

## Resource audit

C's inputs enforce existing4096point/4096triangle and2048membership caps; all secondary spans/maps derive from those bounds. B's plan enforces at most256consumers with at most four initial nodes each. Root/source Arc handles remain shared. B currently clones the bounded whole consumer plan temporarily when entering a graph; it does not clone the whole source for every consumer.

These count bounds do not, by themselves, extend the old allocator-layout proof. The existing64MiB staging/source ledger separately measures required face/point/source-view terms, including a fixed16MiB helper allowance. It does not explicitly itemize new diagnostic JSON, the C checker BTree maps, or its two GrowingIndex workspaces. No cap was increased. Do not call this a measured RSS limit or claim that the old ledger proves every newly introduced diagnostic allocation. Diagnostic serialization remains subject to its existing separate receipt cap; allocator-complete accounting of new workspace remains an explicit limitation unless root adds a bounded, audited charge under the unchanged cap.

## Controls delivered

- Exact ordinary and activation paths retain both incoming identities.
- Missing dual geometric membership and an outgoing native tail refuse.
- Equal-parameter disconnected vertices, gaps and overlaps refuse.
- Wrong event position and duplicate chart membership refuse.
- Cross-cell triangle contacts and f32 export collapse refuse; a simple triangle succeeds.

Execution results are pending root's serial checks. No native/WASM/GPU or full-model checks were run by C.
