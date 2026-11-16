# B: request-scoped consumers for the secondary alias and activation

Candidate: `/tmp/sfcc-component-b-bounded`, based on the immutable 199-input
round32 selected source `/tmp/sfcc-activation-c-frontier-fixed`.
Initial candidate `/tmp/sfcc-component-b` is frozen separately; root executes it.
B has not run cargo, tests, geometry or browser validation.

## Scope and implementation

Only three source files change:

- `gcad-wasm/kernel/src/sfcc/cell_mesh.rs`: force planned actual consumer boxes
  through the feature graph; bind planned original path nodes before graph edits;
  record graph completion. All hooks remain `cfg(all(test,feature="serde"))`.
- `gcad-wasm/kernel/src/sfcc/activation_frontier_replay_c_tests.rs`: make its
  existing plan and checked source/sharing/activation helpers accessible to a
  sibling request adapter. Source algebra, inverse/chord/source/tube checks and
  caps are reused, not duplicated. Existing local scopes still take precedence;
  nested request scopes are rejected.
- New `gcad-wasm/kernel/src/sfcc/component_consumers_b.rs`: actual consumer
  preparation, request lifecycle, exact original-node matching and compact receipts.

The adapter binds every planned graph to exact cell-box bits, immutable meshing-view
fingerprint and source-root Arc identity. `prepare_consumer` gathers original
segment-connected pins and indexed corners using the same lattice and corner
key construction as `mesh_feature_graph`; it does not drop the first cell's
common t=0 corner. Each ordinary incoming consumer requires two nodes on both
charts; the activation consumer requires one native and two composite nodes.
Both incoming chart endpoints must already use the same canonical private point
IDs. Parameters remain original and are compared by bits at graph entry.

Only the activation consumer inserts the already-certified interior event.
Every other consumer uses the same closed incoming-image transport with its own
local parameter windows. Each planned graph must complete exactly one incoming
sharing; missing required sharing still rejects. Native windows remain before the
cut and the composite outgoing window is unchanged. Neither global curve range is
edited. This adapter grants no blanket raw-native-tail pruning authority.

The request completion receipt requires every planned consumer to be visited and
successfully reconstructed without unresolved geometry. A consumer that bypasses
the graph remains incomplete; repeated graph entry invalidates its completion.
The scope restores its thread-local source and sharing state on unwind. Publication
remains the constructor's responsibility after its independent checks.

## Concrete API for A

`cell_mesh::component_consumers_b` is `pub(crate)` and supplies:

- `Consumer { cell: SfccCell, cell_box: [f64;6], incoming: [Vec<(f64,usize)>;2], activation: bool }`
- `Plan { root: Arc<CsgNode>, fingerprint:u64, source:[usize;4], charts:[usize;2], cuts:[f64;2], point:[f64;3], epsilon:f64, consumers:Vec<Consumer> }`
- `prepare_consumer(oct, faces, cell, &mut private_points, features, charts, activation) -> Result<Consumer,&'static str>`
- `with_scope(plan, closure) -> Result<(closure_result,serde_json::Value),&'static str>`

Plan and Consumer derive Clone. `incoming` tuples are (original parameter, canonical
private point ID). `prepare_consumer` may create the canonical corner point in the
private PointTable, exactly as the graph would. It does not mutate faces or source.
A must bind these to actual selected consumers, ensure all changed face consumers
are included, verify the original-to-derived meshing-view relation, and require the
receipt's `complete` field after meshing. `with_scope` configuration validation is
not independent authority to mutate original records.

C can validate actual consumer triangles and PointTable interval memberships against
the retained Consumer windows; it need not trust JSON. At activation use native
[min,cut46], composite[min,cut66] and composite[cut66,max] with the actual keyed event.

## Bounded instrumentation

The bounded revision avoids cloning the complete request plan for each graph:
only the selected consumer's at-most-four original nodes plus scalar/Arc plan fields
are cloned. Request rows reserve exactly the consumer count; a guard emits at most
one row. Rows contain counts/windows and sharing status, not duplicated triangles
or edge memberships. Their serialized aggregate is bounded below 512 KiB, reserving
4 KiB for fixed header; overflow forces incomplete status and refuses row storage.
The existing owned-geometry ledger remains unchanged; JSON instrumentation is not
represented as covered by that allocator audit. A accounts the actual prepared
plan/consumer/boolean-vector layouts separately under the unchanged 64 MiB policy.

## Controls and execution handoff

New focused filters (use exact namespaces to avoid accidentally matching the
existing `stage4_component_b_original_source_attempt`):

- `cell_mesh::component_consumers_b::component_b_request_controls_preserve_refusal_and_cleanup`
- `component_b_frontier_request_reconstructs_and_validates_actual_graph`

The first checks configuration rejection (duplicate consumer, unmatched canonical
endpoint, nonfinite parameter), incomplete/missing path binding, nested-scope
refusal, cleanup after unwind, and bounded report overflow. Its synthetic windows
authorize no source/geometry queries. The second runs the original actual frontier
positive reconstruction through the new request adapter and retains all existing
local topology, f64/f32 contacts/orientation and generated-query checks. The original
local-scope positive test is retained separately and calls the same test body.

Retain existing `activation_c_`, `alias_c_`, `alias_a_`, `alias_b_` and source checks.
Root's fresh complete constructor attempt is the decisive test of all seven actual
secondary consumers; B has not inferred that complete component success follows
from the frontier replay.

## Explicit limits

A's preparation must bind actual FaceRecords and opposite consumers; B's graph API
has only their canonical node/window contract. It checks local exact boxes and source
identity but does not independently establish octree/record closure. Whole-cell edge
coverage, interval coverage, interfaces, patch ownership, outside contacts and atomic
rollback remain constructor/C obligations. Physical/generated source coefficients
remain distinct as in round32. No production, native/WASM/GPU or full-model acceptance
is claimed. No resource or geometric limit was increased.
