# SFCC composite subtraction and analytical feature preservation

Status: partially implemented, September 7, 2026. See the [implementation results](sfcc-feature-preservation-results.md) for delivered commits, regression evidence and remaining region/chain work. The original plan below remains the reference scope; unfinished work is not marked complete.

## Outcome and scope

Correct compound cutters, then make exposed branch transitions explicit and preserve their identity from feature compilation through the final mesh. The primary geometric targets are the housing and bracket scenes. Improvements must be demonstrated by independently specified curves and connected mesh chains, not only by appearance, triangle counts or manifoldness.

This follows the [analytical-feature audit results](sfcc-analytical-feature-completeness-results.md) and the [current algorithm explanation](../sfcc-meshing-algorithm.md). Raw native/WASM differentials and the initial displaced primitive branch families are already implemented; do not repeat those changes or treat historical audit failures as current failures. In particular, the old bracket scan outlier was a switch between different ray crossings, not a confirmed missing local crease.

Included: composite subtraction, explicit branch/partner states for hard and continuous round/soft/chamfer compositions, simultaneous extrusion/loft branch changes encountered by those compositions, curve provenance, junction routing, worker transport, protected-edge refinement and targeted coverage diagnostics.

Deferred: new stairs/columns region semantics, the GPU normal contract, a general multi-axis surface scanner, universal discovery of arbitrarily small components, unrestricted planar graph arrangements, geometric self-intersection proofs and continuous Hausdorff guarantees. Existing periodic evaluation must not silently change; unsupported periodic subtree complements must produce a structured error rather than a panic. This plan does not claim analytical completeness for all accepted scenes.

Reuse the existing native kernel for numerical kernel tests and existing GPU scalar-query infrastructure for application parity controls. Do not add a new CPU scene evaluator. GPU analytical normals remain unsuitable as the sole derivative reference for nested blends. Visual QA remains manual.

## 0. Establish controls and preserve the baseline

Before changing implementation:

1. Record the current source revision and working-tree delta. Preserve the existing documentation, Makefile and PNG changes; use a separate scratch directory under `.agents/tmp/` for measurements.
2. Capture the actual serialized housing/bracket trees, effective operator parameters, test bounds, tolerances and export settings. The bracket's enclosing chamfer overrides its source-level inner round setting.
3. Record native and WASM validation diagnostics, curve/corner counts, feature fallbacks, unresolved work and worker recovery status. Record feature compilation and total export time, peak memory where measurable, and worker payload sizes.
4. Add independently derived fixtures for each failure below. Each fixture specifies its expected scalar behavior or connected feature arcs, domains, endpoints, incident patches and one-sided normals. Do not derive the expected feature list from `compile_feature_set`.
5. Separate failures into scalar semantics, representation, discovery, trimming, junction wiring, meshing and assembly/refinement. Keep a per-fixture ledger of the first failing stage.

Retain existing housing square-rim checks at `1e-5` mm, inset curve checks at their existing `0.002` mm threshold, and housing/bracket sampled triangle checks at `0.02` mm. New fixtures need scale-aware tolerances justified by their equations and numerical conditioning, not thresholds adjusted to fit current output.

## 1. Correct composite subtraction

### Implementation

Primary files: `gcad-wasm/kernel/src/scene_bridge.rs`, `sdf.rs`; application boundary tests under `gcad-wasm/fixtures/`.

The present bridge walks the RHS with `!neg`, changing internal combiners, and then calls `sdf::negate(r)`, changing them again. Primitive construction ignores the walk's `neg` flag. A leaf RHS therefore does not expose the same error as a composite RHS.

Use a single complement mechanism. Preferred implementation: build each operand in its ordinary orientation, remove polarity-driven combiner rewriting from the bridge walk, and complement the completed RHS exactly once when constructing subtraction. Hard subtraction is `Max(A, complement(B))`; supported smooth subtraction uses its existing Smax operator and operand order. Leaf sign changes, stratum orientation, and De Morgan transformations belong to the complement operation alone. Build leaf strata after normalization as today.

Make the bridge complement path fallible. Existing `sdf::negate` explicitly disallows columns subtrees; detect unsupported complements and return a node-specific bridge error. Do not assume an asymmetric periodic formula obeys a complement identity, exchange Columns and ColumnsI speculatively, or replace an unsupported subtree with one child. Preserve supported direct periodic operators and current empty/unsupported-node behavior unless an independent control demonstrates a separate defect.

### Tests

- `A - union(B,C)` against the independent expression `max(a,-min(b,c))`; sample points in B only, C only, overlap, neither and outside A. Include disjoint cutters so replacing the union by an intersection cannot pass accidentally.
- `A - intersect(B,C)` against `max(a,-max(b,c))`; `A - (B - C)`; deeper alternating nesting; a union/intersection containing a subtraction.
- Supported round/soft/chamfer composite cutters, preserving the application's actual scalar formulas and binary source order. Compare scalar values to independent algebra or generated GPU scalar samples, not merely two queries of the same incorrectly built tree.
- Transform cutters by translation, rotation and positive uniform scale; check one-sided cutter normal orientation and raw derivatives away from singularities.
- Actual CAD-source serialization through `SceneInfo` and `serializeSceneToBridgeJson`, including the application's variadic subtraction lowering. Add a mandatory WASM fixture, proposed `sfcc-composite-subtract_test.mts`.
- Full/pruned/paired agreement remains a secondary consistency check. Existing tests in `sfcc-differentials_test.mts` currently check agreement and cannot by themselves establish correct CSG semantics.
- Unsupported periodic subtree complements return descriptive errors; direct supported periodic calls retain their existing behavior.

**Exit:** independent truth-table/scalar controls pass, cavity geometry and orientation are correct, unsupported cases do not panic, and existing housing/bracket regressions do not worsen. Commit this bounded correction separately.

## 2. Introduce explicit branch states and stable feature provenance

### Data contracts

Primary files: `sfcc/field_branches.rs`, `branch_surfaces.rs`, `blend_surfaces.rs`, `feature_set.rs`, `feature_curves.rs`, `strata.rs` (under `kernel/src`), and `sfcc/tree.rs`.

Introduce compact, interned descriptors; names below describe the proposed contract rather than existing APIs:

| Descriptor | Required information |
| --- | --- |
| Branch state | Source-tree path, primitive/profile branch, height/twist region, selected child/partner pair and relevant ancestor choices. |
| Region expression | Fixed scalar formula plus raw derivative, orientation, domain guards and adjacency to neighboring states. |
| Feature identity | Adjacent region identities, surviving connected component and endpoint/junction incidence. Distinguish semantic provenance from allocated curve IDs. |
| Curve interval | Curve reference, oriented parameter endpoints and explicit wrap/unwrapped interval for closed curves. |
| Junction incidence | Curve endpoint references and participating branch identities; multiple aliases may describe the same geometric patch. |

Keep native segment/circle representations and fast paths. A registry may assign dense IDs for runtime use, but worker fingerprints must include the semantic descriptors and incidence they resolve to. Preserve source operand order; no associativity or arbitrary reordering invariant is assumed for n-ary blends.

A geometric edge or junction can legitimately have multiple feature memberships. Represent this explicitly instead of overwriting the first label or merging unrelated curves by proximity. Equivalent supporting patches may carry provenance aliases after domain-aware equivalence checks.

### Independent test support

Add a diagnostic/test mapping from expected arc to candidate states, traced component, trimmed curve, junctions and eventual mesh chain. Allocation IDs alone must not define the expected result. This mapping is needed before large enumeration changes so newly added candidates can be shown to represent real exposed features.

**Exit:** existing feature geometry is unchanged by the descriptor introduction; repeat compilation and worker fingerprint tests agree. Altering a branch domain, partner choice or corner incidence changes the fingerprint. Equivalent aliases preserve their incidence without duplicating geometry.

## 3. Replace dynamic partner selection with region-aware lifting

### Implementation

`sample_override` currently chooses a chamfer partner dynamically and sorts blend values at evaluation time. Loft enumeration overrides one profile edge while its partner remains piecewise. These are the main representation targets.

1. Separate full-field evaluation from fixed-region evaluation. The latter must retain its chosen formula inside its domain; encountering a partner/branch guard must not silently select another derivative under the same identity.
2. Express guards for hard winners, blend activation, signed nearest-two selection, primitive/profile branches, and extrusion/loft height regions. Preserve binary operand order; explicitly identify n-ary pair choices and ties. Include equality faces as boundaries shared by adjacent regions.
3. Lift adjacent alternatives through the actual ancestor expression, fixing relevant sibling states where they affect the formula. Keep raw values and derivatives, similarity transforms and signs consistent with the existing scalar evaluator.
4. For lofts, represent the relevant pair of profile branches in each interpolation interval. A transition in both profiles must form an explicit adjacency/junction case instead of leaving an internally switching partner field. Include differing profile vertex counts and height-knot transitions.
5. Share expressions through an interned DAG and expand adjacent states on demand over relevant spatial regions. Avoid eager Cartesian products of every primitive region and ancestor choice. Exclude candidates only with a justified domain/range test; otherwise retain them or report an unresolved enumeration budget.
6. Keep distinct classifications for a smooth join, exposed normal jump, hidden branch, coincident fields and singular junction. Finite segment-to-endpoint transitions are not automatically creases.
7. Add explicit representation-budget diagnostics, localized to the affected node/region. An unimplemented family or exhausted expansion must never appear as a successful exclusion or as a universal coverage pass.

### Tests

- A three-child chamfer whose nearest sibling changes along an exposed lifted crease; nested round/soft/chamfer variants.
- N-ary nearest-pair switches and binary operand reversal, without imposing associativity or symmetry on formulas that do not have it.
- Convex and concave extrusion profiles with inward exposed medial branches and outward smooth endpoint negative controls; cap/side and twist-clamp transitions.
- Equal- and differing-topology lofts with simultaneous active-profile edge switches and transitions at a profile-height knot.
- Each representative transition under a later hard union, intersection and cutter. Include a zero-valued cutter touching an operand patch already hidden by an earlier ancestor: it must stay hidden.
- Coincident carrier aliases and singular/triple junctions: no duplicate curves and no independent-constraint claim from a rank-deficient Jacobian.

**Exit:** independently specified arcs exist over their full sampled parameter intervals, with correct one-sided normals and domains; negative controls have no artificial creases. Unknown or exhausted regions are reported. Reduced fixtures and actual housing/bracket points show the intended improvement before advancing.

## 4. Trace, trim and wire the explicit region graph

Primary files: `sfcc/seam_trace.rs`, `trim.rs`, `newton.rs`, `feature_curves.rs`, `feature_set.rs`.

- Trace each represented pair within its fixed domains. At a guard crossing, locate the boundary, split the arc and continue through identified adjacent states; retain source knots and provenance.
- Wire simultaneous transitions using all incident region identities. Select a numerically independent constraint basis and validate the other incident constraints; do not treat coincident equations as a unique corner.
- Preserve distinct nearby components and valid short arcs. Merge junctions only with compatible incidence/domains as well as geometric tolerance. Closed curves need explicit seam/wrap handling.
- Keep projection, domain termination, tangency and budget outcomes distinct. Change seed or continuation behavior only for a reduced case that proves a represented component was lost.

Tests require connected interval coverage, correct open/closed components, endpoint valence, no duplicate arcs and stable behavior under modest changes to seed spacing and lattice phase. One-sided samples must converge to the same surface point; the old bracket scan's fixed depth-jump threshold is not an acceptable crease oracle.

**Exit:** every expected arc in the targeted fixture matrix survives as the correct trimmed component with correct junction incidence. Unresolved tangencies/arrangements remain explicit rather than being hidden by a fallback or tolerance increase.

## 5. Carry curve identity through the entire mesh pipeline

Primary files: `sfcc/face_contour.rs`, `cell_mesh.rs`, `point_table.rs`, `surface_refine.rs`, `sliver_flip.rs`, `pipeline.rs`, `worker.rs`, `validation.rs`; WASM/debug output adapters as needed.

### Placement and refinement

- Extend protected-edge metadata to carry oriented curve intervals and provenance memberships. Keep the existing boolean lock as a derived fast query. Distinguish a generic protected edge from an edge verified to follow an analytical curve.
- Face pins carry their curve parameter and memberships. Local graph arcs, edge-cell polylines and straight-corner fans create interval-bearing edges at creation time. Preserve all incident arcs; unsupported arrangements remain diagnosed.
- Replace `surface_refine`'s nearest-compatible-curve search for identified edges with projection onto the recorded curve **within its interval**. Preserve interval orientation and periodic wrap when splitting. Child intervals must cover the parent without a gap, overlap or accidental long way around a closed curve.
- Keep smooth surface projection for unfeatured edges. If a curve identity is missing, ambiguous or incompatible, retain a lock and report unresolved feature preservation; do not claim that choosing a nearby curve proves correctness.
- Sliver flips must not remove identified curves. Component cleanup, triangle removal and final point compaction must either preserve required chains or report their removal; remap memberships into final output vertex IDs.

### Workers and validation

- Serialize feature references and interval memberships in partials, retaining f64 parameters until output. Bump affected wire versions and validate IDs, counts, intervals and feature fingerprints before use.
- Remap endpoint IDs on merge, preserve multiple memberships and reject incompatible labels instead of first-writer-wins loss. Ensure repeated/reordered partial processing does not duplicate interval coverage.
- Validate compiled-curve-to-output-chain correspondence separately from independent expected-feature coverage. A mesh can preserve every compiled curve while compilation omitted a feature.
- Report missing, disconnected, misassigned or off-curve chains distinctly from topology failures. Keep periodic/unknown representation coverage explicitly unchecked; do not turn the new chain audit into a global completeness claim.

### Tests

- Two close curves and a junction where nearest-curve projection would select the wrong arc; splitting must follow the recorded identity.
- Reversed edge orientation, a closed circle crossing its parameter seam, multiple memberships, corner-fan edges and curved multi-junction graph edges.
- Sliver-flip protection, cleanup, f32 output residuals, compaction and partial serialization/remapping.
- Actual merges at 1/2/4/8 partitions and reversed worker completion order, requiring `serialRecovery == false` for designated merge fixtures. Exercise explicit serial recovery separately; it must not satisfy the independent merge gate.
- Negative tests deliberately remove or relabel an interval. The chain audit must fail even when the resulting triangle mesh remains manifold and has small vertex residuals.

**Exit:** each independently expected exposed arc in the targeted fixtures corresponds to a connected, correctly labeled output chain with the right endpoints/junction incidence. Bidirectional sampled distance checks constrain both missing portions and spurious excursions. No existing strict flange, hole or X-seam test is weakened.

## 6. Integration, performance and artifacts

Run focused native/WASM tests after each slice. At integration, run:

```sh
cargo test --offline --release --manifest-path gcad-wasm/Cargo.toml --workspace --no-fail-fast
make build
make test
```

If `make test` already performs the required build, do not repeat it without a subsequent code change or failure. New required fixtures must not soft-skip; identify any historical optional-fixture skips separately.

Use sequential before/after runs with one warm-up and at least five measured exports of housing, bracket and representative smooth/hard controls. Report medians, candidate/state counts, final triangle counts, payload bytes and peak memory where measurable. Investigate material regressions, using 20% time or memory growth as an initial review trigger rather than a performance guarantee. Explain costs attributable to newly represented geometry separately from redundant enumeration. Keep explicit expansion and refinement budgets.

Preserve current budgets and tolerances for comparison. Controlled success fixtures must pass all relevant checks; real torture scenes must not acquire new unexplained failures, and existing unresolved work must remain visible. Report recovered arcs and their connected-chain results, not just lower nearest-curve gaps.

After implementation checks pass, regenerate all 60 PNGs with `make -C docs/manim pngs`, using the existing shell-only target and devserver skill. Leave visual QA to the user. Update the explanation, support table and audit results to the scope actually delivered, then regenerate the animation if its explanation changes. Do not describe deferred periodic semantics or global completeness as fixed.

## Delivery order

| Slice | Reviewable deliverable | Dependency |
| --- | --- | --- |
| A | Independent compound-cutter controls and single-complement bridge fix. | Baseline. |
| B | Branch/provenance descriptors, fingerprint tests and expected-arc harness. | Baseline; use A for cutter fixtures. |
| C | Explicit ancestor/partner regions and simultaneous profile transitions. | B. |
| D | Domain-bound tracing, trimming and junction wiring with connected-arc controls. | C. |
| E | Curve-interval metadata from pins/graphs through refinement, cleanup and worker output; chain audit. | B and D. |
| F | Integrated housing/bracket coverage, genuine worker-merge tests, performance measurements, PNGs and documentation. | A–E. |

Implement and commit in these bounded slices once implementation is authorized. Introducing metadata can precede expanded enumeration, but completion requires both representation and output-chain preservation. If a targeted arrangement remains unsupported, retain its reproducer and explicit unresolved status and report that slice as unfinished.
