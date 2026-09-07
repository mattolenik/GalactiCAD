# SFCC analytical-feature completeness audit

Status: audited with an initial set of corrections and regression controls. See
[execution results and remaining work](sfcc-analytical-feature-completeness-results.md).
The broader implementation sequence is not complete.

## Objective and boundaries

For the scene subset SFCC already accepts, account for every exposed sharp curve and junction introduced by primitive fields, transforms, and CSG composition. Establish which families have an explicit analytical representation, which are discovered numerically, and where bounded computation can leave coverage unresolved. Separately establish that the normals used by extraction and export follow the derivative of the actual composed scalar field.

An analytical branch boundary is a candidate, not automatically a visible crease. It must survive every ancestor operation and have distinct one-sided limiting normals on the final zero surface. A smooth join, a hidden medial branch, a coincident supporting surface, and a singular point need different classifications. Curvature changes without a normal jump should not be counted as missing sharp edges.

This audit does not expand SFCC to every application node. The bridge currently accepts boxes, spheres, plain cylinders, cones, polygon extrusions with twist, lofts, lathes, translation, rotation, positive uniform scale, and hard/smooth union, intersection and subtraction. It rejects, among other cases, cylinder fillets/chamfers, nonuniform or nonpositive scale, and unsupported node types. Preserve those explicit rejections. Check the actual bridge dispatch and parameter validation rather than treating its comments as a complete support specification.

Do not introduce another CPU implementation of the scene SDF. Reuse existing native kernel evaluation for kernel regressions and diagnostic controls. Use batched GPU queries of the application's generated scene field for an independent end-to-end reference. This is an audit of the existing SFCC architecture, not authorization to move other GPU evaluation paths to the CPU. Visual QA remains manual.

## Evidence at the starting point

The committed checkpoint passed 198 native tests and 354 application/WASM tests; all 60 Manim PNGs were regenerated after correcting the agent/thumbnail scene race. Those results establish the tested cases, not universal feature coverage.

| Area | Code evidence | Audit implication |
| --- | --- | --- |
| Raw derivatives versus unit normals | `field_branches.rs::sample_tree` retains derivative magnitudes. `sdf.rs::CsgNode::grad` and `Pruned::grad` recursively mix child unit normals, then normalize again. | Nested blends can receive the wrong normal direction even where the scalar field is correct. Face tagging, sheet checks and output normals consume this API. |
| Polygon distance branches | `ExtrudePart(0)` calls the complete `polygon_dist_2d`; `LoftPart(0)` interpolates complete profile distances. The polygon query selects a closest segment with a clamped closest-point parameter. | Current cap/side and height-region branches do not enumerate every polygon edge/vertex distance region or nearest-feature switch. Off-surface branches may become exposed by an enclosing blend. |
| Lifted branch identity | `FieldBranch` includes child, chamfer, pair, extrusion, twist and loft branches. `sample_override` can dynamically select another operand at an enclosing chamfer or reselect the nearest blend pair. | A nominal carrier may still change formula internally. Verify explicit domains and identity through multiple enclosing blends, including changes in the other operand. |
| Periodic operators | `sample_blend` evaluates stairs and both columns families with `min`, `max`, `abs`, activation gates and modulo. `append_branch_pairs` has no dedicated periodic-region variants. | Scalar evaluation support does not demonstrate analytical enumeration of all periodic creases. Other feature paths may cover some; measure before declaring individual seams missing. |
| Numerical discovery | `trace_carrier_pair` uses a finite seed grid and bounded continuation. Same-locus seed consumption is now stricter. | Correct deduplication cannot discover a component that never receives a seed. Small loops, tangencies and cusps remain distinct questions. |
| Meshing and verification | The local feature graph requires a supported boundary arrangement; fallbacks and budgets remain. `SfccValidation` checks topology and vertex residuals, not expected-feature coverage or continuous embedding. | A watertight mesh with small residuals can still omit a crease. Coverage must be measured independently of the generated curve list. |

The independent bracket scan still has one of 884 sharp-transition samples farther than 0.002 mm from a compiled curve: approximately 0.003724 mm at `(-7.052082621, 9.4, 5.263836678)`. This is below the 0.02 mm mesh tolerance. First determine whether it is trace approximation, projection error, or a missing local continuation; do not label it a newly proved omission or loosen the diagnostic threshold to remove it.

A separate native control confirms the normal discrepancy on a smooth, nonsingular surface. Let `A` and `B` be radius-1.2 spheres centered at `(-0.8,0,0)` and `(0.8,0,0)`, and `C` another radius-1.2 sphere at `(0,1,0)`. Evaluate `softUnion(softUnion(A,B,0.8),C,0.7)`. At `(0.1,0.4,1.2651338489240112)`, the field residual is approximately `5.6e-17`, but `CsgNode::grad` differs from normalized `sample_tree.gradient` by about 1.7086 degrees. This establishes disagreement inside the native implementation; GPU parity and independent derivative convergence must still be checked. The session-local control is `/tmp/sfcc-doc-review/bracket-audit/src/bin/normal_audit.rs`; turn this construction into a permanent regression in the first implementation slice.

## 1. Establish independent references and traceable diagnostics

Deliver a repeatable audit harness before expanding branch enumeration:

- Serialize each fixture through the application bridge and retain its source, effective operator modes, parameters, bounds, tolerances and version. In particular, preserve the bracket's effective nested chamfers; source-chain spelling alone is insufficient.
- For minimal fixtures, derive expected feature equations and domains independently of `compile_feature_set`. Store expected connected arcs, endpoints, junction incidence and one-sided normals, not only isolated reference points.
- Supplement those cases with a batched GPU surface scan in all three axis directions and rotated frames. Refine candidate normal jumps with decreasing spatial offsets; reject silhouette jumps and smooth curvature masquerading as creases. Mark occluded, unresolved and singular samples explicitly. Surface scans are finite evidence, not a completeness proof.
- At smooth points, compare generated GPU scalar values and analytical normals, native scalar values, raw native derivatives and unit-normal API results. Use convergent finite-difference checks only away from branch boundaries; at creases compare the two one-sided limits separately.
- Assign diagnostic provenance to each expected feature: source node path, local branch/domain, ancestor choices, candidate pair, seed/trace component, trimmed arc, junction, face pin, cell patch and protected output edges. IDs may change across equivalent scenes; retain semantic provenance separately from allocation IDs.
- For each failure, report the first stage where coverage is lost. Preserve rejected-domain reasons, singular Jacobians and exhausted budgets. Raw counts include hidden carrier extensions and must not be treated as exposed-feature failures without this classification.

First targets: the remaining bracket scan point, the nested-soft-union normal control, a convex polygon medial branch displaced by a blend, a concave polygon nearest-feature switch, and one stairs/columns branch boundary.

Exit criterion: every control has an independently specified expected result and can be localized to representation, discovery, trimming, meshing or normal evaluation. A smooth negative control must not acquire a fictitious crease.

## 2. Correct and unify derivative contracts

Audit `sdf.rs`, `field_branches.rs`, primitive derivatives, pruned evaluation and SIMD query paths, then enumerate their callers in refinement, face tagging, projection, sheet selection and vertex-normal generation.

The intended contract is explicit: scalar value plus raw derivative for composition and Newton steps; normalization only where a unit direction is required. Audit gradient bounds separately from pointwise derivatives. Preserve sign, transform scale and chain-rule behavior, including twist and loft interpolation. A zero-gradient or nondifferentiable point must have an explicit policy rather than silently being treated as an ordinary smooth sample.

First reproduce the nested-soft-union control with a converging derivative reference. Then correct the public unit-normal implementation to derive its direction from the composed derivative and align pruned behavior. Avoid creating a third parallel evaluator or normalizing each child before composition. Keep any display fallback at singularities out of analytical acceptance checks.

Tests: all blend families and signs; nested operands with unequal derivative magnitudes; three-plus nearest-pair blends; rotated and scaled twisted extrusions and lofts; pruned/full agreement; one-sided cutter orientation. On a crease, compare each incident patch normal rather than expecting a shared averaged vertex normal to equal a tie-broken preview normal.

Exit criterion: smooth nonsingular reference cases agree with the derivative reference within a documented numerical tolerance, including magnitude where the API promises it. Native/GPU disagreements are classified before using either as a coverage oracle.

## 3. Inventory and represent full primitive-field branches

Create a support table for every accepted primitive covering its native zero-surface features, complete off-surface field regions, domain predicates, singular sets and transform behavior. Audit boxes, cylinders, cones and lathes as well as extrusion/loft: existing native rim or apex features do not by themselves cover all displaced field branches.

For polygon profiles, distinguish segment-interior distance, endpoint distance, nearest-feature ties and sign/winding regions. A segment and its endpoint can join smoothly; retain only exposed derivative discontinuities as sharp features. Include convex, concave, reversed-winding, collinear and near-degenerate profiles, and decide which invalid inputs must be rejected explicitly.

For extrusions, combine profile branch domains with cap/side selection and twist-clamp regions. For lofts, audit both profiles' active distance branches in each interpolation interval, profile-height knots, end clamps, and equal/differing vertex-count paths. For lathes, include profile branch changes, rings, apex/axis behavior and the axis tolerance convention.

Proposed representation: a stable source path plus explicit branch formula and domain constraints, retaining raw derivatives. Confirm the representation on minimal cases before replacing existing native fast paths. Bound enumeration to relevant field ranges and spatial regions; do not eagerly form the Cartesian product of every profile branch and every ancestor.

Exit criterion: every branch family in the support table has either tested coverage or an explicit unsupported/unresolved status. Native straight rims remain exact, including the housing's unchanged 0.00001 mm rim test.

## 4. Propagate branch domains through every operator

Build the operator matrix from hard min/max and all six internal blend modes: Round, Soft, Chamfer, Stairs, Columns and ColumnsI. Cover union, intersection and subtraction mapping, radius-zero limits, and the accepted periodic-count domain.

For each operator, list its formula regions, switching equations, activation inequalities, one-sided derivatives and smooth versus sharp joins. For stairs/columns, derive the finite set of relevant periodic indices from operand ranges and bounds. Handle modulo boundaries and singular loci explicitly rather than relying on a smooth carrier to cross them accidentally.

At nested blends, include both the selected descendant branch and any branch switch in its enclosing partner. Verify nearest-two selection and equal-value ties for three-plus operands. Preserve survival at every ancestor; a later cutter must not revive a branch hidden earlier. Carry candidate junctions through changes of independent constraint basis without merging unrelated nearby sheets.

Tests: each primitive branch as either blend operand; positive and negative displacement; nested hard/smooth ancestors; cutters through an already-composed body; equivalent operand permutations; rigid transforms and positive uniform scale. Do not test associativity as an invariant: nested binary blends and nearest-two multi-operand blends can define different fields.

Exit criterion: each expected crease survives all stages where its independently derived domain says it is exposed, and disappears where hidden or smooth. Relaxing a positional tolerance must not erase a previously accepted domain. Geometric tolerances must not double as branch-ownership rules.

## 5. Audit numerical discovery and junction topology

After representation is explicit, test whether every expected connected component is actually found. Perturb seed spacing, seed-grid phase, trace bounds and equivalent transforms independently. Include loops smaller than the seed spacing, near-tangent pairs, cusps, exact tangencies, high-valence junctions and two components closer than the chord tolerance.

Keep local tracing as a control against whole-owner tracing. Compare pre-trim traces, post-trim arcs and the final spatial index, including endpoint coverage and incident patch identities. Test the current same-locus deduplication against nearly coincident components and partially overlapping traces; preserve every new endpoint continuation.

If fixed-grid seeding misses a represented component, prototype conservative adaptive candidate subdivision and branch-boundary seeds. Terminate a candidate region only with an applicable exclusion test or an explicit unresolved record. Tangential contacts that lack two independent constraints require separate classification/handling; lowering the Jacobian threshold is not the default fix.

Exit criterion: analytic controls retain their known component count and junction incidence under these perturbations. Unsupported singular cases and exhausted discovery budgets remain visible. Broader finite scans are reported with their sampled coverage, not promoted into a universal certificate.

## 6. Verify preservation through mesh assembly and normals

Track represented curves through face crossings, domain tagging, pins, cell graphs, fallback paths, cleanup, sliver flips, surface refinement, worker merge and final crease splitting. Audit graph arrangements currently rejected, especially multiple boundary loops and repeated cell entry. Verify that protected-edge membership is retained through every topology-changing pass.

Use two separate tests: expected analytical arc to compiled feature graph, then compiled feature graph to the correct protected mesh-edge chain. Nearest distance to an arbitrary triangle edge is insufficient. Require chain connectivity, endpoint/junction incidence and compatible one-sided patch normals. Add checks for spurious output features as well as missing ones.

Retain topology, triangle-interior residual and vertex checks, and add targeted triangle self-intersection or local embedding checks where graph triangulation changes. Do not describe sampled field residuals as a Hausdorff bound. Preserve specialized exact straight-corner fans; replacing every case with the general graph previously regressed the housing rim.

Test serial, partitioned, reversed-completion and repeated runs. Record whether worker merge used serial recovery: equality after recovery verifies the returned result, not independent distributed success. Audit feature fingerprints and caches against branch/domain identity and incidence changes.

Exit criterion: all expected feature chains in the declared fixture domain are represented within their specified position and angular tolerances, without hidden topology failures. Unresolved cells have stage-specific explanations rather than being masked by a successful scalar-residual check.

## Validation and delivery sequence

1. Reference fixtures and provenance diagnostics, including the remaining bracket point and minimal normal discrepancy.
2. Derivative-contract correction with native, pruned and GPU-reference regressions.
3. Explicit polygon/primitive field regions, starting with a minimal displaced polygon case and extending to extrusion, loft and lathe.
4. Operator-region propagation, including dynamic partner selection and periodic families.
5. Adaptive discovery or singular-case handling only for demonstrated losses that survive the representation fixes.
6. Mesh-chain preservation, validation reporting and remaining unsupported cell arrangements.

Each implementation slice should contain the reduced failing fixture, the correction, positive/negative controls and relevant existing regressions. Measure candidate counts, field queries, trace attempts, time and peak memory on the bracket, housing and both mixed-shape scenes. Retain numerical and geometry budgets; address regressions through tighter conservative domains or reusable branch evaluation, not by silently suppressing features. The longer render deadline is operational headroom, not a performance acceptance test.

Run focused native tests during each slice, then the complete offline native release suite and `make test` at integration checkpoints. Use `make build` for TypeScript/WGSL validation; do not introduce a new CPU reference scene evaluator. Use GPU scalar/normal sampling for end-to-end parity without browsing the app or conducting automated visual QA. Regenerate all 60 Manim PNGs with `make -C docs/manim pngs` after the integrated fixes pass; keep the thumbnail-isolation and startup safeguards.

A completion report must identify the covered primitive/operator/transform families, the reference types used, unresolved singularities and exhausted budgets. If feature coverage has not been independently checked for a family, report it as not checked. Existing `validation.status = passed` must continue to mean only its documented checks until additional coverage checks are actually implemented and the serialized schema is deliberately updated.
