# SFCC field and seam coverage audit

> **Historical audit and implementation checkpoints:** the findings below refer to their stated baselines. See the [current algorithm explanation](../sfcc-meshing-algorithm.md) and [September 7 audit results](sfcc-analytical-feature-completeness-results.md) for subsequent fixes and remaining limitations.

Date: 2026-09-06. Scope: current working tree, including the uncommitted housing fixes.

The common structural problem is that SFCC's feature compiler represents supporting zero surfaces, but blends consume operand field values away from those surfaces. Supporting surfaces alone do not describe all those values. Missing blend patches then leave no curve to constrain a later cut, intersection, or union. Trimming can remove incorrect candidates; it cannot recover candidates that were never generated.

This is a source audit and implementation plan, not a claim that every case below has a reproduced mesh artifact. The inward housing hole has an existing measured seam gap of approximately 1.3 mm. Other confirmed omissions below follow directly from the field formulas and candidate enumeration; their visible impact needs regression scenes. That statement describes the pre-implementation audit; the implementation checkpoint below records subsequent work.

## Implementation checkpoint

The first delivery now uses exact subtree fields for blend operands instead of eagerly expanding every primitive distance region. `FieldRef` paths share one immutable scene tree; `FieldSample` retains raw values and derivatives. This covers primitive rim/vertex regions and clamped loft/twist values in nested blends without assuming that supporting zero surfaces are their distance fields.

Implemented in this working tree:

- Raw field composition and row-scaled pair/triple Newton solves, with finite/singularity checks and backtracking; raw full/pruned derivatives for cell-interior and face-midpoint projection.
- Chamfer expressions built from exact operands; other blend surfaces available to subsequent hard cuts.
- Ancestor-path surface domains, including trim endpoint refinement that cannot be fooled by a later cutter's zero residual.
- Conservative enumeration of lower/upper loft supporting-edge combinations, supplementing the existing native correspondence fast path. Pointwise domain trimming remains necessary; this is not complete concave endpoint-region certification.
- Tangent retry and loop-closure corrections, smaller flank probes, retention of short exposed arcs, actual-endpoint trim classification, and local feature-graph meshing for cells containing multiple junctions.
- Per-export trace diagnostics and prepared-worker feature-graph fingerprints.
- Both-face housing boundary samples, reduced hole/loft/blend/clip triangle-interior checks, and a primitive-region matrix through chamfer, round and soft blends.

Remaining audit work is explicit: adaptive/domain-certified seed discovery; complete periodic and nearest-pair-switch crease enumeration; interval domain exclusions and proven generated bounds; replacement of the native concave loft supporting-line approximation; migration of remaining normal-cone and active-owner consumers; GPU derivative parity and the full transform/permutation/performance matrix. Trace counters describe work performed, not proof that an unseeded component is absent. The original plan below remains the specification for those later checkpoints.

### Validation of this checkpoint

- Full release Rust workspace: 190 tests passed, including worker partition equivalence and fingerprint mismatch rejection.
- Application/WASM suite (`make test`): 353 tests passed, including the housing boundary-to-mesh checks on both flange faces.
- The reduced loft/chamfer/hole/clip scene passes topology, exported vertex residuals, and the 0.02 mm sampled triangle-interior limit. The complete housing probe measured a worst hole-region triangle residual of approximately 0.0157 mm after the seam graph and endpoint fixes.
- Native square-to-pentagon loft coverage exposed another defect: an inset trim classification promoted unchecked raw endpoints to live endpoints. Including actual endpoints fixed the off-cap vertex without relaxing existing mesh assertions.
- The application still reports bounded refinement/fallback limits for the housing. These measurements establish sampled fidelity for the tested regions, not universal seam completeness.

## Findings

### 1. Primitive field coverage is incomplete

Evidence: `kernel/src/sfcc/blend_surfaces.rs::append_chamfer_carriers`, `kernel/src/sfcc/feature_set.rs` strata builders, `kernel/src/primitives/shapes.rs`, and `kernel/src/strata.rs`. All paths here are relative to `gcad-wasm/`.

| Primitive | Current coverage gap | Status |
| --- | --- | --- |
| Sphere | Its single analytic field represents the primitive, except for the usual center singularity. | No analogous missing branch found. |
| Box | Six face planes omit positive distance to edges and corners. For a unit box at `(2,2,0)`, the actual field is `sqrt(2)` while the two nearest face fields are `1`. | Confirmed omission. |
| Capped cylinder | Mantle and cap fields omit the rim-distance region. The recent patch adds both rim fields as blend inputs. | Previously reproduced and partially addressed; domain, sign, transform, and nesting coverage still need tests. |
| Cone | Mantle and base omit the finite base-rim distance region. The cone carrier already handles the apex extension; do not add a duplicate apex fix without checking its branch conditions. | Base-rim omission confirmed. |
| Untwisted extrusion | Side planes omit polygon vertex-distance regions. Concave profiles additionally require the polygon's actual inside/outside and closest-feature classification. | Confirmed omission. |
| Twisted extrusion | Side carriers are excluded from blend generation. Their normalized projection residual is not the raw field. Supporting edge fields also omit vertex-distance regions. | Confirmed omission. |
| Loft | Side carriers are excluded from blend generation. Raw profile-distance interpolation, segment selection, and height clamping must be preserved. | Confirmed; housing inward hole reproduces it. |
| Lathe | Plane/cylinder/cone carriers cover profile-edge surfaces but omit distance to profile endpoints, which revolves into ring-distance regions or axis-point regions. Concave profiles require correct signed domains. | Confirmed omission. |

Simply allowing `LoftSide` and `TwistedSide` in the existing filter is incorrect: `Stratum::f` normalizes their residual, while blends need the raw value. `compound_field` currently combines field values with unit normals, valid only under its restricted inputs and flattening rules.

### 2. Loft coverage has an additional native-feature limitation

`feature_set.rs::build_loft_strata` pairs equal-count profiles by matching edge index. The general builder uses `loft_seg_carriers`, an angular correspondence heuristic whose comment assumes profiles are star-shaped about their centroids. Neither enumeration establishes all closest-edge combinations of the interpolated polygon fields. `seg_signed_dist` also documents its supporting-line sign as correct through a convex corner.

These restrictions can omit active surfaces or native creases even before a loft participates in a blend. Treat arbitrary concave profiles, shifted profiles, rotated vertex ordering, and unequal vertex counts as separate regression cases. Existing trimming of mismatched pairs does not establish completeness.

### 3. Generated surfaces cover chamfer only

`append_chamfer_carriers` generates a surface only for `SminMode::Chamfer`. At other blend nodes it forwards child candidates, omitting the operator's own new field branches.

Consequences:

- A hard cutter through a round or soft blend can create a sharp boundary on the blend itself, for which leaf-carrier intersections are insufficient. Smooth attachment to the operands need not be represented as a sharp crease, but the later cut does.
- A chamfer around a round/soft/stairs/columns subtree composes incomplete child candidates.
- Stairs and columns variants introduce additional branch transitions that need explicit classification; periodic boundaries must follow the implemented modulo semantics.
- Multi-operand blends select the nearest two children. Pair changes, sign inversion for Smax/difference, and nested hard operations require active-domain rules. Enumerating pairs without their domains is not a completeness argument.

Evidence: `primitives/smin.rs`, `sdf.rs::nearest_pair`, `sfcc/tree.rs::visit_seam`, and both seam enumeration functions. The leaf-pair displacement skip only suppresses displaced original seams; it does not generate their replacements.

### 4. Activity and differential information lose blend structure

`sdf.rs::collect_owners` descends through a blend only when a child's value is close to the final value. In the interior of a displaced blend it can return no owner. `refine_criteria.rs::active_strata` then selects only leaf strata; it cannot identify a generated blend patch. Separate blend refinement exists, so this does not by itself prove an absent triangle, but it leaves feature completeness dependent on the compiler's candidate list.

Related differential issue: `CsgNode::grad` and the pruned evaluator combine child unit normals and normalize again. For nested blends or non-unit-gradient primitives, this generally differs from differentiating the scalar field. Flank survival compares generated carrier normals against that tree normal. Incorrect agreement can reject a valid seam. Add a reproducer before attributing an existing artifact to this mechanism; keep shading-normal compatibility separate from geometric derivatives.

`trim.rs::refine_transition` already has an added scan of generated strata, but it remains a local recovery mechanism rather than complete active-branch tracking.

### 5. Tracing and trimming can lose represented curves

These are related loss mechanisms, not newly reproduced defects:

- `trace_carrier_pair` uses a fixed seed grid and proximity-based seed/curve deduplication. Small loops or nearby distinct components can be missed or merged.
- `trace_direction` stops at near tangency, tangent reversal, correction failure, or its step budget. Singular junctions require explicit continuation/endpoint handling.
- `trim.rs::classification_params` caps sampling at 2048 and insets open curves. A short surviving interval can fall between samples.
- Fixed-distance flank probes can cross a neighboring boundary in a narrow strip or near a multi-surface junction.
- Generated-patch bounds are assembled from child boxes and radius expansion. Their conservativeness needs testing for nested, signed, and non-distance fields; this audit does not establish a bounds bug.

### 6. Validation cannot establish seam completeness

`pipeline.rs::build_pipeline_context` discards the diagnostics returned by feature compilation as `_diag`. Trace diagnostics distinguish only a subset of termination causes. `validation.rs` checks topology, face segments, vertex residuals, and existing fallback/numerical counters, but has no missing-feature coverage audit or triangle-interior error audit.

A watertight triangle can have all vertices on the SDF while bridging a crease incorrectly. Existing housing tests cover the tee and outward hole region but missed the inward hole arc.

## Implementation plan

### Step 1: Add failing coverage regressions and useful diagnostics

Extend `kernel/tests/chamfer_seams.rs` and the actual housing WASM fixture first. Follow each exposed hole boundary on both flange faces, including where the active body surface changes. Account explicitly for the bottom clipping plane instead of asserting nonexistent complete circles there.

Add minimal scenes for box-edge/corner, cone-rim, extrusion-vertex, twisted-side, loft-side, and lathe-ring blends, each intersected by a cutter. Add a cut through round and soft blends. Record expected branch transitions and connected seam components, not only nearest distance to any curve.

Thread feature-compilation diagnostics through serial and worker results. Distinguish unsupported field coverage, unseeded/unresolved candidate regions, tangency, correction failure, trace budget, and trim uncertainty. Harmless discarded carrier extensions must not automatically fail an export; unresolved potentially exposed features must prevent a completeness claim.

### Step 2: Separate field expressions from surface projection

Introduce an explicit branch representation with raw value, unnormalized derivative, validity domain, conservative bounds, and provenance identifying primitive region or operator branch. Keep normalized residuals and unit normals as separate projection/shading operations.

Use a shared expression graph for nested combinations rather than repeated Cartesian expansion and cloning. Preserve sign, similarity scale, operator constants, and nearest-pair semantics. Replace `leaf_index == usize::MAX` as the feature-policy distinction with explicit provenance.

Do not introduce a new CPU scene evaluator or move GPU rendering/export sampling to the CPU. Extend existing SFCC analytic feature machinery only; keep application field evaluation on the GPU and use GPU field samples as the application parity reference. Native evaluator tests provide fast local regressions, not an independent replacement for that reference.

### Step 3: Complete primitive regions, starting with the housing

Implement raw loft/twist evaluation and its exact derivative, including height clamps and profile segment boundaries. Replace assumed edge correspondence with domain-driven candidate discovery. Reuse actual polygon closest-feature/sign semantics, including endpoint regions and concavity.

Then add box edge/corner, cone base-rim, extrude vertex, and lathe endpoint regions. Consolidate the cylinder-rim patch under the same region/domain abstraction. Validate candidate values throughout each active off-surface region, not merely on its zero set.

For lofts, enumerate conservatively and prune by proven domain/bounds exclusions; do not substitute another angular heuristic. Measure candidate count, memory, and compile time on the housing and larger profiles before enabling broad enumeration.

### Step 4: Compile operator surfaces and their boundaries

Migrate chamfer generation to the branch representation. Add round and soft surfaces so later hard cuts can trace against them. Add stairs and both columns variants with their piecewise and periodic domains. Preserve smooth joins as smooth and identify actual normal discontinuities.

Cover Smin, Smax, difference, mixed nesting, and three-or-more operands. Track pair-selection boundaries and trace only exposed branch intersections. Share active-branch queries with refinement and trim endpoint resolution.

Use raw derivatives for geometric projection and branch validation. Verify nested blend derivatives against numerical differentiation away from discontinuities and against the GPU scalar field. Do not silently change preview shading conventions as part of this correction.

### Step 5: Make curve discovery and trimming report their limits

Use adaptive candidate-region subdivision and domain-aware seeding, with explicit unresolved status at resource limits. Deduplicate by branch identity and component continuity as well as distance. Track trace termination reasons and resolve junctions through branch-aware endpoint refinement.

Subdivide uncertain trim intervals instead of treating uniformly dead samples as proof of absence. Adapt flank probes to local boundary spacing. Test near-tangent X junctions, short exposed arcs, closely spaced loops, triple junctions, and narrow strips independently.

### Step 6: Verify mesh fidelity and close the documentation gap

For every regression, check seam-to-mesh correspondence, expected connectivity, triangle straddling, and triangle-interior residuals in addition to manifoldness and exported f32 vertex residuals. Residual samples are not a certified Hausdorff bound; label them accordingly. Apply transforms, scale changes, operand permutations where semantically equivalent, and signed operations to the test matrix.

Run focused native tests during development, then the complete Rust workspace tests and `make test`/`make build` as appropriate. Exercise serial and worker exports. Record feature compilation time and candidate counts against the pre-change baseline. Regenerate authorized housing PNG assets for manual user QA after numerical regressions pass.

Update `docs/sfcc-meshing-algorithm.md` and affected animation explanations to describe supported coverage and unresolved cases accurately. Completion requires both housing flange faces to meet the configured geometric tolerances and every added reproducer to pass. A case still limited by representation or tracing must be reported as incomplete rather than silently accepted.

## Delivery order

Implement Steps 1-3 as the first reviewable change, resolving the remaining housing defect through the shared field representation. Follow with operator coverage, then tracing robustness and broader fidelity validation. Keep failing coverage cases explicit throughout; do not describe the system as generally fixed after the housing alone passes.

## Detailed implementation design

The following expands the steps above into implementation units. These are proposed interfaces and filenames, not APIs that already exist.

### Field and constraint contracts

Add `kernel/src/sfcc/field_branches.rs`, with an immutable arena shared by the compiled feature set. Use deterministic integer IDs and intern repeated expressions; do not embed recursively cloned `Stratum` trees in every candidate.

- `FieldSample`: raw scalar `value` and actual `gradient: [f64; 3]`, with explicit singular/non-finite handling.
- `FieldExprId`: an analytic primitive-region or operator-expression reference. Expressions preserve raw scale through nesting.
- `BranchId`: expression plus validity domain and provenance. A branch is valid only where it agrees with the corresponding scene subtree, including sign and active operand selection.
- `DomainResult`: `Inside`, `Outside`, or `Uncertain` for a region. Point tests may select multiple branches at a tie. Box tests must never turn an unsupported proof into `Outside`.
- `SurfacePatch`: branch constrained to value zero, conservative bounds, and normal/crease classification. A distance-to-edge field is an operand branch; its degenerate zero set is not automatically an exposed surface patch.
- `SeamCandidate`: two constraints, adjacent exposed patches, and a domain intersection. Ordinary patch intersections use two zero-field constraints. An internal branch switch may instead use the surface equation and a branch-equality equation. This avoids assuming every feature originates at two primitive zero surfaces.
- `FeatureCompileReport`: supported/unsupported region coverage, bounded unresolved regions, termination causes, and work counters. Coverage is separate from topology and from sampled fidelity.

Keep existing native analytic planes/circles and their fast paths during migration. Adapt `Stratum` to reference a field expression for new patches. Only retire `CompoundCarrier` and the chamfer-only sentinel policy after the replacement passes the existing tests.

For a similarity `p = s R q + t`, raw world field and derivative are `s f(q)` and `R grad(f(q))`; apply the CSG sign to both. Do not normalize the derivative before composing expressions. Reject invalid transform parameters at the existing boundary rather than hiding them with arbitrary derivative clamps.

### Solver migration

Target `strata.rs`, `sfcc/newton.rs`, `feature_curves.rs`, and the projection consumers in `face_contour.rs` and `cell_mesh.rs`.

At each Newton iteration, evaluate raw `f` and `g`. Scale that equation's row and residual by the same `|g|`: use `g / |g|` and `f / |g|` in the linear solve. This is row scaling of the raw equation, not a claim that the derivative of the normalized residual is a unit vector. For two constraints, preserve the minimum-norm solve; for triples, solve the scaled three-row system. Use normalized cross products for angular conditioning and keep displacement budgets in world units.

Use finite checks and backtracking consistently for pair and triple projection. A small or zero gradient is an explicit singular case. Require geometric residual and valid domain at acceptance; do not jump across an invalid region to another component. At a branch boundary, hand off to the neighboring branch or return a classified endpoint.

Tests: multiply either constraint independently by positive factors `0.01`, `1`, and `100`, and require the same projected locus within tolerance. Include nested chamfer plus loft, near-parallel planes, a true singular junction, and a trial step that leaves its branch domain. Keep finite differences confined to derivative verification in tests.

### Complete domains without exponential eager expansion

Compile candidate branches locally inside the export cube. Begin with conservative primitive-region bounds and recursively restrict operator operand regions. A region can be pruned only when field/domain bounds exclude it; otherwise subdivide or report it unresolved at the work limit.

For lofts, the candidate space is the lower profile's closest segment/endpoint regions crossed with the upper profile's regions, for each height segment and its clamped extensions. Equal vertex counts do not imply matching nearest-edge indices. Enumerate candidate pairs lazily, reuse their expressions, and intersect their domains before tracing. Polygon sign comes from the polygon classification, not the side of an arbitrarily chosen supporting line.

Box regions use the active positive coordinate set outside and dominant signed face inside. Cylinder and cone regions follow their actual cap/mantle/rim conditions. Lathe regions follow closest finite meridian segments/endpoints and polygon sign, including the special treatment of axis edges. Preserve the implemented field formulas; do not replace max-based extrusions with Euclidean capped-distance formulas.

For Min/Max, domain selection uses subtree winner inequalities. For multi-operand blends, select the two nearest transformed values using the actual operator's ordering rules. Build equality boundaries for competing selections and classify their one-sided derivatives before labeling them creases. A branch switch that is smooth must not become an artificial mesh edge requirement.

For periodic operators, enumerate only periods intersecting conservative operand-value intervals. If those intervals or the number of periods cannot be bounded within budget, report the affected region unresolved. Do not silently truncate the list.

### Active surfaces and downstream consumers

Add an active-patch query alongside the existing leaf-owner query. Migrate geometric consumers deliberately: blend flank comparison, trim endpoint refinement, active patch normal checks, and local seam classification. Preserve leaf ownership for object identity and other callers that require it.

Use the field branch's geometric derivative for projection and one-sided comparisons. The existing scene normal API may encode rendering compatibility; do not globally replace it without enumerating callers. Tests must compare normal direction to the derivative of the scalar field at points away from discontinuities, with one-sided checks at seams.

When candidate generation has an unresolved exposed region, pass that spatial information to refinement. Refinement may recover coverage by subdivision or reach its budget and mark that region incomplete. Raising mesh density alone is not an acceptable substitute for the absent seam representation.

### Worker consistency and reporting

Target `sfcc/pipeline.rs`, `worker.rs`, `validation.rs`, `wasm/src/lib.rs`, and the validation fixture/schema consumers.

Workers currently rebuild the feature set while receiving cells already tagged with curve/corner IDs. Generate branch, patch, curve, and corner IDs in stable order; sort any hash-based collections before assignment. Keep compiler budgets deterministic and independent of thread scheduling. Add a feature graph fingerprint to prepared metadata and verify it when workers rebuild the graph. On mismatch, use the existing explicit worker failure/recovery path; never consume mismatched IDs.

Count deterministic feature-compilation diagnostics once per export, not once per worker. Aggregate partition-local failures separately. Update and version the relevant wire format if its payload changes; add mismatch and round-trip tests. Preserve serial/worker validation parity in `kernel/tests/worker_partition.rs` for multiple partition counts and reversed completion order.

Report three distinct concepts: supported representation coverage, unresolved extraction work, and sampled mesh fidelity. An empty seed list is not proof that a seam is absent. A successful manifold audit is not evidence of geometric coverage. Until complete domain exclusion is implemented for a case, report its coverage as unchecked or incomplete instead of inventing certification.

## Reviewable work packages

| Package | Depends on | Main edits | Required result |
| --- | --- | --- | --- |
| A. Reproducers and baseline | None | Housing fixture; new native coverage tests and test helpers | Reproduce inward hole failure and record outward/X baselines; minimize one example for each confirmed omission. |
| B. Raw field contract | A | `field_branches.rs`, `strata.rs`, `newton.rs`, `mod.rs` | Projection scale-invariance and derivative tests pass; existing primitive/chamfer regressions retain their tolerances. |
| C. Domain-aware loft and housing | B | Polygon-region helpers, loft feature builders, blend surface compiler, trim | Full exposed hole boundaries on both flange faces pass; equal/unequal-count and concave loft regressions pass. |
| D. Remaining primitive regions | B, C | Box/cone/extrude/twist/lathe branch builders | Every primitive-region reproducer passes, including transformed and negated variants. |
| E. General operator branches | C, D | Blend compiler, active-patch query, refinement consumers | Cut-through round/soft and nested chamfer cases pass, followed by stairs/columns and nearest-pair changes. |
| F. Extraction robustness | B; completed against E | Seeding, tracing, trim intervals, junction wiring | Small loops, short arcs, nearby components, and singular endpoints are recovered or explicitly unresolved. |
| G. End-to-end reporting and release checks | C-F | Pipeline/worker/WASM reporting, fixtures, docs, PNGs | Deterministic worker IDs, report parity, full test suite, performance review, and manual housing QA. |

Basic diagnostic plumbing from G belongs in B/C so early fixes do not discard failures. Likewise, deterministic IDs are a requirement from B onward, not a final cleanup. Packages are implementation checkpoints, not instructions to commit or publish without a user request. Keep each package's final checked-in tests passing; capture pre-fix failures during development rather than leaving unexplained red tests between packages.

## Regression specification

Use shared test helpers under `kernel/tests/` for expected-curve sampling, mesh-edge correspondence, and geometric measurements. Avoid a separate hand-written implementation of the full scene field. Analytic reference equations are appropriate for minimal test shapes; use the existing native evaluator for native integration and GPU scalar samples for application parity.

| Case | Reference and checks |
| --- | --- |
| Housing inward/outward holes | Parameterize each cutter circumference. Find body crossings on both sides with bracketed roots; include every exposed interval after clipping. Adapt angle spacing near body branch changes. Assert feature coverage, continuity, mesh-edge coverage, and local triangle error. |
| Housing X junction | Retain all existing arms and crossing tests; approach the junction from every branch. Check that any singular endpoint is shared and that no gap exceeds the configured geometric tolerance. |
| Box edge/corner chamfer plus cut | Exercise two and three positive coordinate components. Assert raw field agreement away from the box and the resulting cut boundary on the blend. |
| Cone and cylinder rims | Exercise both sides of region boundaries, signed operands, and a tilted/translated/scaled shape. Include the cone apex as a control for existing behavior. |
| Polygon extrude/twist | Include convex and concave vertex regions, positive/negative twist, zero twist, and points beyond both cap heights. Require continuity with the untwisted limit. |
| Loft | Equal-count profiles with cyclic index shifts and reversed winding; unequal counts; translated profiles; concavity; multiple height segments; cap clamps. Equivalent polygon descriptions must preserve the field and recovered geometry. |
| Lathe | Convex and concave profile corners, a bore, and endpoints on the axis. Check signed domains instead of assuming every endpoint ring is exposed. |
| Blend families and nesting | A hard cutter through each blend, chamfer over another blend, mixed Min/Max, smooth difference, and nearest-pair switches. Only permute operands where the implemented semantics promise equivalence. |
| Trace/trim stress | Two close disconnected loops, an arc shorter than old trim spacing, narrow surviving flanks, a tangent contact, and an X/triple junction. Check component identity and endpoint incidence, not merely nearest distance. |
| Forced limits | Small candidate/trace/trim budgets must produce explicit incompleteness in serial and worker results. A safely excluded hidden branch must not produce a false failure. |

For the housing at its existing defaults, retain the current 0.02 mm local triangle/chord target and use the resolved feature tolerance for seam projection. Do not loosen either to make a regression pass. Measure seam coverage in both directions: reference samples must reach the correct extracted component, and extracted samples must lie on the intended reference/domain. Include endpoint intervals rather than excluding difficult corners from assertions.

Choose sample spacing from tolerance and available curvature bounds; adapt where bounds are unavailable. These measurements remain sampled checks. Runtime completeness status must come from representation and extraction accounting, not a test's sample count.

## Execution and stopping criteria

1. Record current feature count, candidate pairs, compile time, memory where measurable, mesh counts, validation, and existing housing measurements. Keep source, transforms, tolerances, and export cube fixed for before/after comparisons.
2. Implement A-C first. Stop treating the housing as resolved until both flange sides and the X pass together; regenerate the PNGs at that checkpoint for user review.
3. Complete D-E with focused tests per primitive/operator, then run F against the complete candidate representation. Do not spend time tuning a tracer for a surface that has no candidate.
4. Run the full native workspace tests, `make test`, and build validation required by changed files. Re-run broader checks only after relevant changes or failures. Exercise the worker path explicitly.
5. Compare performance on the housing, a larger loft profile, and a nested multi-operand blend. Record scaling with profile vertices and tree depth; resolve uncontrolled Cartesian growth before completing the change. Do not hide that cost by reducing candidate coverage.
6. Update the audit with reproduced outcomes and remaining limits. Update explanatory docs only to claims supported by the final implementation. A supported case with unresolved geometry remains incomplete; unsupported modes are listed explicitly. No overall certification claim follows solely from a passing render or topology test.
