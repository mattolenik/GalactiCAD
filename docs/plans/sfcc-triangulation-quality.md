# SFCC triangulation and remeshing implementation plan

Status: initial experimental implementation, September 7, 2026. All four operation families have a conservative analytical-carrier implementation; general-field/chart coverage and complete rollout acceptance remain open. See [implementation results](sfcc-triangulation-quality-results.md) for delivered behavior, validation, measurements and remaining plan work. The scope and acceptance criteria below remain the full target.

## Outcome and delivery order

Improve triangle quality and geometric fidelity while preserving SFCC's analytical feature network, connected components, orientation and shared-boundary guarantees. Compare quality at equal geometric tolerance and report triangle count and runtime alongside it.

Implementation order differs from impact ranking because the smaller diagonal/flip change establishes the acceptance machinery needed by the larger changes:

1. Baselines, patch ownership, robust predicates and a shared candidate validator.
2. **Improvement 2:** surface-aware quad diagonals and protected edge flips.
3. **Improvement 1:** constrained triangulation of individual surface patches.
4. **Improvement 3:** adaptive insertion and conforming refinement driven by geometric error.
5. **Improvement 4:** constrained remeshing across former cell boundaries after assembly.
6. Integration, real-worker tests, measurements, default selection and documentation.

Each stage must be independently reviewable and testable. Keep the baseline mode available during comparison. Do not declare all four implemented when only flips or a new fan heuristic are delivered.

## Current implementation and integration points

- `gcad-wasm/kernel/src/sfcc/cell_mesh.rs`: `triangulate_loop` emits triangles directly, splits quads by the shorter diagonal and usually fans larger loops from a projected centroid. `fan_from_stratum_vertex` also fans feature-graph patches and the two sides of edge cells. A boundary fan is the fallback when projection fails. Neither being inside the cell nor being on the surface establishes that the chosen fan center sees every boundary edge of a concave patch.
- `mesh_feature_graph` currently rejects `loops.len() != 1`. Supporting polygons with holes requires determining which loops bound one patch; blindly filling every loop independently can fill a hole or connect separate sheets.
- `sliver_flip.rs`: candidate threshold is `2*area/longestEdge² < 0.02`; the pair's worst quality must improve by more than 2x. Protected edges and duplicate new edges are checked. Replacement triangles are not checked against the field or against geometric intersection.
- `surface_refine.rs`: runs only when `tree.has_blend()`, samples centroids and edge midpoints, marks all three sides of an inaccurate triangle, and projects conforming edge splits. It preserves recorded curve intervals. It has eight rounds and an added-index budget; samples use field residual rather than a certified surface-distance bound.
- `point_table.rs`: keyed shared points, cell-local unkeyed points, crease locks and multiple oriented `CurveInterval` memberships. These must survive every edit. Current triangle arrays have no parallel patch-ownership record.
- `pipeline.rs` and `worker.rs::merge_partials`: duplicate the assembly cleanup/refinement sequence. Worker partials use SFP3; prepared features carry a fingerprint. New ownership metadata must survive both paths.
- `feature_chain.rs`, `validation.rs`, `manifold_check.rs`: existing preservation/topology checks remain mandatory. They do not certify feature discovery or geometric embedding.
- `gcad-wasm/fixtures/sfcc-housing_test.mts` and `sfcc-bracket_test.mts`: actual scene regressions, including housing flange and hole boundaries. `docs/manim/scenes/torture_housing.yaml` and `torture_bracket.yaml` remain the model sources.

Use the existing native SFCC field/carrier query interfaces. Do not add a TypeScript CPU scene evaluator or change GPU preview/mesh-viewer shading for this task. Keep the geometry kernel dependency-free by default and native/WASM-compatible.

## Non-negotiable invariants

1. **Feature constraints:** corners stay fixed; crease edges retain every curve membership and its oriented interval. A constraint cannot disappear to improve triangle shape. Acute feature angles can force skinny triangles and must be reported rather than rounded away.
2. **Topology:** edits preserve component count, boundary cycles and intended genus; no bowties, duplicated faces, inverted faces, non-manifold edges, T-junctions or unintended connections between sheets.
3. **Patch ownership:** all new triangles/points remain on the intended connected, exposed surface patch. Nearest surface or nearest stratum alone is not a sufficient ownership test.
4. **Shared boundaries:** during cell/partition meshing, existing shared boundary vertices and segments are immutable. Boundary subdivision happens only through a shared owner or globally after merge, updating all incident faces.
5. **Geometry:** candidate triangles pass surface-deviation, orientation and local intersection checks before committing. Evaluate final f32 output as well as working f64 positions.
6. **Transactional mutation:** failed candidates leave vertices, indices, constraints, memberships and counters unchanged. No orphaned protected edges or partially committed splits.
7. **Determinism:** sorted traversal, stable provenance and explicit tie rules; never depend on hash order, worker arrival order or temporary local vertex indices for geometric decisions.
8. **Honest validation:** sampled error checks are not Hausdorff proofs. Budget exhaustion or ambiguous ownership is explicit. Existing missing-feature reports cannot be cleared merely because the new triangulation looks smoother.

## Phase 0 — baseline and shared infrastructure

### Baseline controls

Record HEAD, working-tree delta, source digests, exporter options and resolved tolerances. Capture native and WASM meshes plus per-stage timings for:

- Convex and concave planar patches, skew quads, nearly collinear vertices and strongly nonuniform boundary spacing.
- An annulus, multiple disconnected disks in one cell, a narrow neck and two nearby sheets.
- Curved patches on spheres, cylinders and blends, including a quad whose shorter diagonal has worse surface deviation.
- A constrained crease, tiny boundary segment, acute corner, high-valence junction, closed curve crossing its parameter seam and an edge with multiple curve memberships.
- Housing, bracket and at least one densely sampled curved profile.

Measure area-weighted and count-weighted distributions: minimum angles (p1/p5/median), `2*area/longestEdge²`, counts below 5°/10° and quality 0.02, edge lengths, valence, sampled geometric deviation, triangles, memory and timings. Report triangles incident to unavoidable acute constraints separately without hiding them from totals.

Maintain distinct comparisons: same input boundary for local triangulation; same tolerance for complete exports; same triangle budget where feasible for remeshing. Freeze benchmark fixtures and proposed targets before optimizing.

### Patch and edit data model

Introduce a small internal patch representation, proposed in `surface_patch.rs`:

- Stable patch reference: supporting carrier/field branch, orientation, activation/domain restrictions and connected-sheet provenance. A cell-local patch ID is not automatically a globally shared patch ID.
- Outer boundary plus zero or more holes, all in ordered vertex IDs; embedded feature constraints and corner identities.
- Projection/query policy: analytical carrier for supported strata; existing full/pruned field plus branch/sheet checks for smooth blend patches without a standalone carrier.
- Per-triangle ownership/provenance, retained through splits, flips, cleanup and compaction. Surface membership may have equivalent carrier descriptions; merge only after validated equivalence/exposure and connected adjacency, never from normal similarity alone.
- Vertex mobility: fixed corner, curve-constrained, smooth interior, temporary cell boundary, or unresolved/locked. Store source provenance separately from current geometric position.

Add an internal editable adjacency structure with stable edit IDs and transactional split/flip/collapse operations. Existing flat buffers remain the external output. Begin with only the operations needed by the next phase; do not build an unrelated general-purpose mesh library.

### Shared candidate validator

Proposed `triangle_quality.rs` and `mesh_edit.rs`:

- Measure triangle shape, orientation and local geometric deviation. Compare deviations in geometric units: carrier distance where justified, otherwise controlled projection displacement and sampled field residual with the derivative estimate recorded separately. Do not interpret arbitrary `abs(f)` as Euclidean distance or claim `abs(f)/|gradient|` is a certified bound.
- Sample new edge interiors and triangle interiors; cache unchanged samples. Reject nonfinite/near-singular projection, excessive displacement, wrong exposure/sheet, or inconclusive ownership.
- Check candidate triangles against an AABB-indexed neighborhood, including nearby nonincident triangles on other sheets. Distinguish legal shared edges/vertices from overlap. Test near-coplanar contacts explicitly.
- Validate the affected vertex links and edge incidence before commit. Preserve original data for rollback.
- Use lexicographic decisions: topology/constraints first, geometric tolerance second, quality third, count/cost last. Quality improvement cannot buy worse-than-tolerance geometry.

Implement filtered orientation/incircle predicates with an adaptive exact fallback for planar triangulation; use robust orientation predicates for 3D intersection tests. Verify near-degenerate cases against independent exact fixtures. Preserve deterministic handling of true collinearity/cocircularity. The kernel should contain an attributed, audited minimal Rust implementation rather than adding a C++ meshing runtime. Robust predicates address floating-point sign errors; they do not certify the local chart or projection. [Shewchuk's predicate reference](https://www.cs.cmu.edu/~quake/robust.html)

## Phase 1 — improvement 2: surface-aware diagonals and flips

### Quad triangulation

Replace the unconditional shorter-diagonal choice with evaluation of both candidates. In a validated chart, require the diagonal to remain inside the polygon; in 3D check orientation, surface deviation, constraints and intersections. Among valid candidates within tolerance, maximize the worse triangle quality, then minimize geometric error, then use a stable tie rule.

If neither diagonal is acceptable, request interior insertion or local subdivision; do not select the lesser of two invalid results. Initially route this request through the existing refinement machinery until Phase 3 provides direct insertion.

### Edge flips

Replace the shape-only cleanup acceptance with the common validator and patch compatibility checks. An unprotected edge is not automatically safe to flip: it can still separate distinct patches or sheets. Keep feature edges immutable and preserve corner-star constraints.

Start with current sliver candidates, then allow bounded quality-improving flips for other poor triangles. Use a deterministic priority order and a strict improvement margin to prevent oscillation. Changed neighborhoods invalidate cached candidates. Sample replacement geometry rather than assuming a long-edge flip has small geometric effect.

Tests must include: the shorter diagonal being worse, concave quads, a shape-improving flip that violates surface tolerance, an inverted/overlapping replacement, an existing opposite diagonal, protected creases, adjacent sheets and exact ties. Require strict quality improvement on designated feasible controls, identical boundary chains and no added vertices for accepted flip-only operations.

## Phase 2 — improvement 1: constrained patch triangulation

### Extract valid patch domains

Refactor smooth loops, graph faces and edge-side chains into the shared patch representation. Preserve actual corners and all feature arcs as constraints. Do not apply a disk triangulator to a corner's entire mixed-surface neighborhood; partition its incident patches first.

Classify multiple loops using topology, supporting patch membership, chart containment and winding. Support holes and disconnected components explicitly. Extend `mesh_feature_graph` beyond the one-loop guard only after these classifications are tested. Ambiguous arrangements request refinement or retain a reported unresolved state.

### Local charts and constrained triangulation

Use a carrier's suitable local coordinates where available; otherwise construct a tangent chart from a regular patch sample. Unwrap periodic coordinates consistently. Validate projected boundary simplicity, winding, constraints and sampled orientation/normal spread. Split a patch when a single chart folds or cannot represent it. A projected boundary check alone is not a proof of injectivity; use conservative rejection and subsequent 3D candidate validation.

Build a constrained Delaunay triangulation of the chart's planar segment graph, including holes and embedded feature arcs. A feasible initial constrained triangulation plus robust unconstrained-edge legalization is acceptable. Handle collinear boundary vertices without silently deleting required shared vertices. Unexpected crossing constraints are an error or refinement request; do not invent a feature intersection from a 2D projection.

Initially triangulate existing vertices with optional validated interior points. Integrate Steiner-point quality refinement in Phase 3. Preserve every constrained segment or its explicitly recorded subdivision chain. Validate the lifted 3D triangles before acceptance; planar Delaunay quality is not automatically 3D surface quality. [Triangle's constrained triangulation and quality-meshing reference](https://www.cs.cmu.edu/~quake/triangle.help.html)

Replace both `triangulate_loop` and `fan_from_stratum_vertex` where the domain is supported. Keep a cheap direct triangle path and the validated quad path. Retain exact straight-corner fans only when they pass the same geometric and constraint checks. A legacy fan is not an unconditional escape from a failed embedding.

Acceptance: no overlap or outside-domain triangles in independent planar controls; polygon-minus-holes area recovered; every constraint represented; expected crease chains preserved; lower skinny-triangle counts on the frozen irregular-boundary suite. For curved charts, verify geometric tolerance and sheet identity after lifting. Report chart/refinement failures individually.

## Phase 3 — improvement 3: error-driven insertion and refinement

Replace the blend-only gate with triangle-level eligibility and error measurement. Hard-CSG and primitive scenes can have inaccurate triangle interiors too. Keep efficient analytical acceptance for supported planar/simple carrier cases.

Use a deterministic queue ordered first by geometric error relative to tolerance, then by feasible quality improvement. Distinguish:

- Bad interior approximation: insert a projected interior sample near the worst detected error and retriangulate the local cavity.
- Bad edge approximation or an encroached constraint: split the shared edge and update all incident triangles conformingly.
- Poor shape with acceptable geometry: try a validated flip first, then a quality-driven insertion if the budget allows.

Use centroid/midpoint probes as a cheap screen, adding barycentric/edge samples adaptively when curvature, normal variation or an uncertain result warrants it. Curvature can suggest an initial size proportional to `sqrt(tolerance/curvature)` for regular patches, but samples and projection still decide acceptance. Do not use an uncertain curvature estimate as a guarantee.

Smooth points project to their owned patch. Curve splits use the recorded oriented parameter interval and existing compatible-membership checks; traced-curve knot spacing must be respected. Each child interval partitions its parent for every membership. Corners never move. During cell meshing, boundary encroachment requests a shared face refinement or is deferred to the global pass; workers cannot independently split shared boundaries.

Retriangulation must preserve cavity boundaries and constraints, reject duplicate/tiny insertions and prevent changing sheets. Use scale-aware separation thresholds, maximum work/vertices/rounds, and explicit unresolved reasons. Do not promise a universal minimum angle: acute input constraints and curved geometry can make it infeasible.

Tests: hard-CSG curved surfaces previously skipped by refinement; localized high curvature with otherwise flat patches; shared-edge conformity; closed-curve intervals and multiple memberships; near-singular projection; tiny acute corners; deterministic budget exhaustion. At equal tolerance, seek fewer added triangles than splitting all three edges everywhere. Verify that improved shape does not relax geometric error.

## Phase 4 — improvement 4: remeshing across cell boundaries

Run this pass once on the globally assembled mesh, after partition deduplication and initial cleanup/refinement. The first version is deterministic and serial; parallel remeshing is not part of this plan.

Build smooth connected patch neighborhoods using ownership, exposure and feature constraints. Former octree face edges may cease to be constraints only when both incident triangles belong to the same validated smooth patch. Keep seams, corners, true boundaries, unresolved interfaces and uncertain sheet transitions locked. High-curvature regions may need several charts.

Introduce bounded sweeps of:

1. Splitting overly long edges using the Phase 3 sizing/error policy.
2. Collapsing short smooth interior edges, with the topological link condition, fixed-boundary checks, component preservation and geometric acceptance.
3. Flipping unconstrained interior edges to improve quality/valence.
4. Tangential relaxation of movable smooth vertices, followed by projection to the owned patch and validation of the whole affected star.

Use split/collapse hysteresis, bounded displacement, stable candidate order and strict acceptance to avoid oscillation. Initially prohibit collapse or relocation of feature-curve vertices; allow only validated interval-preserving feature splits. Quality constraints may therefore limit achievable regularity near sharp features. General feature-curve resampling is a separate extension, not a prerequisite for smoothing cell-grid patterns on interiors.

These split/collapse/flip/relax operations follow established surface-remeshing practice; SFCC adds its carrier, feature-interval and exposure constraints. [CGAL's surface-remeshing overview](https://www.cgal.org/2025/05/22/Surface_remeshing/)

Artificial face provenance remains a historical assembly record after its edges move or disappear. Keep the pre-remesh face-consumption audit; add a distinct final-remesh topology/geometry/constraint audit. Do not claim that the old face-segment audit validates the final connectivity. Retain source lineage for debugging, but do not reuse pre-merge point keys as identities for new movable vertices.

Acceptance: reduced interior edge-length variation, low-valence/high-valence outliers and sliver counts on frozen eligible patches; no material increase in error or loss of features/components. Compare matched tolerances and triangle budgets. Include a planar patch spanning many cells, curved patches across worker boundaries, a narrow neck, nearby sheets, an annulus and an acute feature neighborhood. Recheck all invariants after f32 conversion.

## Assembly, workers and API integration

Factor the post-assembly sequence into one helper used by `pipeline.rs` and `worker.rs::merge_partials`, preventing differences in validation, budgets and ordering. Preserve cleanup's closed-component behavior and verify that cleanup cannot invalidate new constraints or ownership records.

Extend partial meshes with triangle ownership, vertex mobility/corner provenance and any new stable identities. Version the partial wire format (rather than silently interpreting new fields as SFP3); validate counts, bounds, feature fingerprints and IDs. Update native encoders/decoders, WASM entry points and affected TypeScript adapters together. Keep public vertex/triangle buffer layouts unchanged unless a concrete consumer needs an extension; diagnostics can remain separate.

Canonicalize global remeshing input and candidate IDs using provenance/topology, including cell-local points. Merely sorting by post-merge vertex index does not establish partition independence. Test serial, shared/separate and Morton paths at 1/2/4/8 partitions, including actual WASM workers and shuffled arrival order. Preserve existing serial recovery reporting; do not silently call serial fallback a successful distributed meshing path.

Add cancellation checks in long predicate/triangulation/refinement/remeshing loops and bounded progress/timing buckets. Propagate failure and budget status consistently. Preserve the current strict `ok` requirements. Mandatory failed checks prevent success; inability to meet an optional shape target alone can be a quality advisory when topology and geometric tolerance still pass.

Expose internal stage switches and budgets through the existing options/diagnostic path for rollout and regression comparison. Avoid new artist-facing controls unless a concrete need appears; final default selection is driven by the acceptance results.

## Test and benchmark acceptance

Use independent checks, not only agreement with the old mesher:

- Exact planar area/containment and constraint-edge incidence; robust predicate fixtures with known signs.
- Analytical planes/spheres/cylinders and expected feature arcs; scalar/carrier checks from the existing SFCC kernel.
- Triangle orientation and nonintersection, edge incidence, vertex links, component/genus expectations and curve-parameter coverage.
- Dense barycentric surface sampling and projected reference-surface samples in the opposite direction, so vertices-on-surface and triangle-to-surface checks cannot conceal a filled hole or omitted patch. Label these as sampled checks.
- Scale/translation/rotation variants, permuted loop starts, reversed input orientation, nearly coincident points and f32 output collapse.
- Housing's square flange and both sides of the screw holes; bracket's known feature-chain gaps. Freeze curve IDs/ranges or geometrically matched baselines and prohibit new missing chains. Attribute any repaired gaps to triangulation versus already-missing compiled features.

Run native tests with the repository's Cargo test target or the established offline workspace command, mandatory WASM fixture tests including housing/bracket, and `make test` (which includes `make build`) for application/wire integration. Check current Makefile test discovery before assuming that fixtures under `gcad-wasm/` ran. Skipped GPU/browser-independent fixtures or missing historical goldens do not count as acceptance. Do not generate a second CPU scene evaluator or perform automated browser visual QA. PNG regeneration is outside this plan unless requested.

Benchmark one warm-up and at least five measured runs per fixture/configuration, recording native/WASM backend, release build, scene/options digests, phase times, total time, peak/estimated memory and triangle count. Start with these proposed gates, to be fixed against the baseline before optimization:

- Zero new topology, intersection, constraint-loss or sampled-tolerance failures on passing controls.
- At least 50% fewer `quality < 0.02` triangles on the designated avoidable-sliver controls at the same boundary/tolerance; report all real-scene outcomes, not just improvements.
- Strictly better p5 minimum angle or fewer triangles at matched error on each designated remeshing control. No requirement to improve infeasible acute-boundary triangles.
- Investigate median export-time growth above 15% or peak-memory growth above 20% on a real scene before enabling a stage by default. These are investigation thresholds, not permission to weaken fidelity or omit work.
- No unbounded refinement loops; cancellation and budgets tested; invalid operations roll back without corrupting mesh state.

## Reviewable implementation slices and completion

1. Baseline fixtures, metrics and quality reports.
2. Robust predicates, patch ownership, candidate validation and metadata transport.
3. Validated quad selection and edge flips.
4. Constrained planar triangulator and chart validation.
5. Cell/feature integration, holes and multiple-loop routing.
6. Error-driven insertion and conforming shared-edge refinement.
7. Global patch neighborhoods and constrained split/collapse/flip/relax remeshing.
8. Unified assembly, final audits, real-worker determinism, performance tuning and defaults.
9. Updated `docs/sfcc-meshing-algorithm.md` and a results report with before/after tables, delivered families and remaining failures.

Commit bounded, passing slices during implementation. Do not promote all new modes to defaults merely because isolated fixtures pass. At completion, report all four improvements separately, including rejected/unsupported chart families, residual feature gaps and measured costs. This work cannot repair a curve that the feature compiler never discovered; keep that limitation separate from mesh preservation.
