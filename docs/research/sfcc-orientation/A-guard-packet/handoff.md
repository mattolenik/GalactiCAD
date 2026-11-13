# A guard: refuse a non-disk patch walk before triangulation

Frozen `/tmp/sfcc-orientation-a-guard` is copied from the executed observational A packet, `/tmp/sfcc-orientation-a`. Exactly one additional file changes: `gcad-wasm/kernel/src/sfcc/cell_mesh.rs`.

Before choosing a patch stratum or calling the fan, the existing graph walk now rejects a repeated polygon vertex with `non_simple_patch_boundary`. The failure capture records the complete polygon, first directed edge, repeated point and candidate stratum set. There is no angle reordering, point/curve deletion, endpoint merge, triangle flip, new field query, tolerance change or resource-cap change.

The mathematical scope is deliberately narrow. A face-orbit walk with repeated vertices is not a simple disk boundary, which is the precondition of the existing fan mesher. The actual captured walk traverses two radial chains twice and emits exact opposite duplicate triangles. A valid triangulator for slit or multiply connected domains would need another representation; this guard does not implement one, and a unique-vertex polygon alone is not a complete geometric simplicity certificate.

This is a fail-closed correction to false local graph acceptance, not a physical alias quotient or a successful component repair. The source46/66 correspondence and distinct face ports remain unresolved. Other selected cells and the previously complete component cannot be declared accepted after this refusal.

No new helper mirroring BTreeSet was added. Root should run the existing meaningful positive graph construction (`modeled_feature_paths_connect_two_boundary_loops_without_caps`), graph capture controls, planar-fan preservation controls and a fresh bounded full component. The actual captured original case must now refuse at this exact guard before fan construction, while the original source/query/face limits and live-state preservation remain. The negative evidence is the real 20-entry patch walk, not a synthetic list-only control.

No builds, tests, source-field evaluations or geometry execution were run by this agent.
