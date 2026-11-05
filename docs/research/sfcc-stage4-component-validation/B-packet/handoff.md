# Stage 4 B: conditional component capture and topology/interface inventory

Frozen source `/tmp/sfcc-stage4-b`, based on the selected Stage 3 A-rollback
source. The C source selector module is copied byte-for-byte from its frozen
packet; B's new diagnostic uses that selector rather than old dense chart IDs or
the old fingerprint. No main repository runtime is changed. Author performed
static inspection and rustfmt parsing only. Root owns builds and all geometry.

## First refusal and execution boundary

The existing private constructor calls `private_arc_a::admit` before any face,
pin, storage-staging or private-cell construction. Its first reservation requires
actual compiled endpoints on the physical chart. The selected repair deliberately
leaves unsupported upper ends unwired, so `endpoint_missing` is the expected
first obstruction, not permission to insert a corner or bypass admission.

B's full-attempt test uses `pipeline::build_pipeline_context` to get the exact
native pipeline feature set and lattice/tolerances without building an octree.
It verifies native effective tuning against the original fixture, resolves the
source pair through C's occurrence/branch/window checks, and calls the unchanged
private source admission. Any refusal is written with
`stage=FEATURE_SOURCE_PREFLIGHT_BEFORE_OCTREE`, `constructionAttempted=false`,
`octreeBuilt=false`, `facesPrepared=false`, `fullComponentAccepted=false` and
`publicationReady=false`. No unavailable mesh audit is marked passing.

Only if admission succeeds does a scoped request enter the complete original
pipeline. At the existing serial round0 post-contour/pre-cell barrier, B resolves
the source again and compares its fingerprint to the fresh preflight fingerprint.
Then it invokes the unchanged private constructor once, preserving its first
refusal and all existing graph/query/resource evidence. Live faces/points are
borrowed immutably and the existing complete live digest is compared before/after.
The request is scoped so an early exit or unwind cannot leak into another export.

This is a conditional attempt harness. A passing diagnostic test on honest
preflight refusal is **not** passing component validation. The mandatory C
admission test remains a separate gate.

## Candidate evidence if construction becomes reachable

A successful returned `PrivateCandidate` exposes its actual points and triangles.
The capture records every point's exact binary64 coordinate/normal bits and key,
every triangle, required face IDs, all selected/outside leaf consumers on required
faces, exact typed frontier-point bindings, and original directed frontier segments.
It compares those segments against candidate boundary edges without coordinate
welding. Moved or unkeyed/unmatched frontier points remain explicit failures.

A bounded combinatorial checker records edge multiplicities and orientation,
duplicate faces, and vertex links (cycles for interior vertices, paths for boundary
vertices). A component is allowed to have its actual exterior interface: it is not
incorrectly subjected to closed-mesh manifold acceptance. Empty geometry, malformed
triplets, bad point IDs or repeated triangle vertices refuse explicitly. Controls
cover a closed tetrahedron, an open disk, a bowtie, reversed interior edge,
duplicate face and invalid/empty inputs.

No same-stage outside triangles exist at this barrier: ordinary `mesh_all_cells`
has not run. `sameStageOutsideTrianglesAvailable=false` and outside-contact audit
is explicitly not reached. Even a locally valid topology/boundary inventory does
not establish full component acceptance. Independent f64/f32 geometry, contacts,
full source completeness and complete same-stage outside mesh remain required.
The 64 MiB diagnostic serialization limit and original private caps are unchanged;
exceeding a limit refuses rather than truncates a passing receipt.

## Files and root commands

B adds `stage4_component_b.rs` under the private diagnostic module, a cfg(test)
round0 dispatch hook, and sibling visibility for the existing live digest. C adds
its test-only selector module/registration. No source admission predicate,
constructor, mesh topology guard, tolerance or production query implementation is
changed.

Build with the same pinned Rust 1.99.0 diagnostic profile (`serde,sfcc-profile`,
no-LTO/codegen16, offline/locked), fresh task-owned kernel cache and nonzero test
discovery. Root should first run these two controls under the60s focused budget:

- `stage4_component_b_topology_controls`
- `stage4_component_b_request_scope_cleans_up`

Then run exactly one `stage4_component_b_original_source_attempt` under its
separate120s preparation-inclusive watchdog. Set
`SFCC_STAGE4_COMPONENT_B_RECEIPT` to a fresh JSON path. Root may defer the full
attempt after C's mandatory preflight refusal; if executed, B itself stops before
octree preparation when the same prerequisite refuses.

The source includes C's unchanged tests, but those have separate receipt variables
and should not be accidentally swept into B's filters. Reusing C's selector is a
new combined diagnostic source, so root must record and verify B's own complete
source and binary hashes.

## Accepted scope and remaining work

This packet authors the capture/checker and negative controls; nothing has yet
been executed by the author. If the actual source refuses admission, the affected
component has not been reconstructed or validated. Old199-leaf/1001-face/198-root/
396-pin inventories are historical, not regenerated current evidence. No full
export, current-HEAD port, native/WASM comparison, browser or visual check is done.
