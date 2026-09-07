# GPU derivative composition through nested SDF operations

Status: implemented September 7, 2026. See [implementation results and validation](gpu-normal-composition-results.md) for delivered coverage, scalar-policy decisions, measurements and remaining limitations. The sections below retain the original acceptance plan.

## Outcome

Make the preview's surface normal agree with the derivative of the scene's scalar field at regular points, including nested round, soft and chamfer operations. Carry derivative magnitude through child expressions, transforms and later CSG, then derive a unit normal for consumers. Preserve explicit handling of non-differentiable boundaries and stationary points.

The same shared helpers serve GPU export sampling and `SDFResultMid`; they must obey the same derivative contract. This does not change SFCC's native feature compilation or repair its remaining curve-chain gaps. Mesh-viewer shading changes and automatic visual QA are outside this task.

## Findings that determine the scope

The baseline is the source checked when implementation begins; record its revision and working-tree delta then.

- `src/shaders/hg_sdf.wgsl`: full and Mid round/chamfer operators normalize combined child normals. Parent operators therefore cannot recover the child derivative magnitude.
- Soft union additionally uses weights based on `r-a.d` and `r-b.d`, rather than the derivatives of its polynomial scalar expression. Fixing storage alone will not fix this formula.
- `.g` is not a raw derivative magnitude: round/soft return a fixed `0.5`, and MDC uses it to detect blends and choose projection limits. `safeStepMul` is a separate fast-path quantity. Neither is suitable as implicit derivative storage.
- Hard full CSG uses `SURF_DIST` and IDs to select a returned distance in its near-tie branch. Material ownership, a shading convention at a seam, and the scalar winner must be separated before asserting scalar/derivative parity.
- Rotation, scale, twist, bend, taper, morph and seam helpers also normalize intermediate results. Generated extrude, loft, lathe and threaded-rod evaluators construct results outside `hg_sdf.wgsl` and need an explicit producer audit.
- Loft's full evaluator currently finite-differences its profile field, omits division by `2*eps` because it only uses direction, and then calls `sdfTrue`. This cannot initialize an exact raw derivative by copying `.n` or `.g * .n`.
- There are scalar-path discrepancies to resolve independently of normal algebra: twist/bend Fast divide distance by a position-dependent stretch while Ex/Mid leave it unscaled; seam Fast scales its pipe distance while Ex/Mid do not. Inside a later blend these are not merely interchangeable marching steps. Trace actual generated call paths and establish reduced reproductions before changing them.
- `src/export/iso-simplicial/iso-sample-batch_test.mts` already has a nested-soft GPU scalar control. Its scalar finite differences agree with an independent reference within `1e-4`, but the approximately `1.113°` normal discrepancy is only logged. It must become an assertion.

## 1. Establish independent controls and a producer/consumer inventory

Extend the existing GPU compute tests; do not introduce a CPU scene evaluator or browser visual test. Use actual `SceneInfo` compilation and f32-packed scene parameters. Assert effective nested radii and operation modes, since fluent modifiers can propagate to descendants.

Record for each result producer: scalar expression, derivative source, coordinate map, branch/tie policy, and whether it returns an exact derivative, a numerical approximation or no usable derivative. Cover full and Mid constructors, struct literals, unary copies, generated primitive functions, n-ary selection, BVH paths and wrappers. Inventory every consumer of `.n` and `.g`, including preview lighting/AO, face selection, picking, seam tangents, MDC projection/sign resolution, grid sampling and iso-simplicial sampling.

Add a test-only compute output for scalar value, raw derivative, derivative status and public unit normal, for full and Mid evaluation. Sample Fast scalar values separately. Keep production sample-buffer layouts unchanged unless a measured requirement justifies an extension; if extended, update WGSL offsets, TypeScript packing, allocation sizes and readback tests together.

Controls must fail before the correction:

1. The existing nested-soft point, plus a single soft blend with unequal child distances to isolate the weight error.
2. Nested round and chamfer examples with unequal child gradient magnitudes. Use explicit operand scalar values/gradients and independent chain-rule expectations.
3. Equal opposing derivatives at a smooth stationary point: the true raw derivative is zero, not an arbitrary unit vector.
4. A hard near-tie with reversed IDs, establishing scalar min/max independently of selection metadata.
5. Reduced twist/bend/seam expressions below a later blend, comparing full/Mid/Fast scalar fields and locating any surface discrepancy.

Save numerical before/after measurements. A missing GPU adapter may be reported as unavailable by the general suite, but the designated acceptance run must require an adapter and execute every new GPU control; a skip cannot satisfy completion.

## 2. Introduce an explicit derivative contract

Add a raw `vec3f` derivative to full and Mid results, separate from the public unit normal and existing `.g`. Use an explicit derivative status to distinguish exact regular derivatives, selected one-sided derivatives, numerical approximations, singular points and unavailable derivatives. Exact enum names are an implementation detail; zero derivative must never mean “missing.”

- Raw derivative means `∇d` for that result's actual scalar expression in its caller's coordinates.
- Composition consumes raw derivatives, never unit normals or shading fallbacks. Keep `.n` as the compatibility-facing unit direction for existing consumers; derive it from the raw value at required normal/feature boundaries. Removing redundant normalizations is an optimization after correctness, not a prerequisite.
- Retain current `.g` heuristics and `safeStepMul` behavior during the derivative-only slice. Document their actual meanings; do not substitute `length(rawGradient)` into existing projection or blend-detection code.
- Provide explicit constructors for exact derivatives and numerically approximated derivatives. Do not retain an ambiguous constructor that silently treats every supplied normal as a unit-magnitude derivative.
- Preserve a zero raw derivative at stationary points. Normal consumers use a documented, finite fallback when no unique unit normal exists. Propagate approximation/unavailability conservatively through contributing operands; an inactive operand must not contaminate the winning branch.
- At hard ties, select a deterministic one-sided derivative and mark it accordingly. Optional seam shading conventions stay separate and must not propagate upward as a mathematical derivative.

The two result structs are primarily shader-local, but audit every packed adapter rather than assuming their layout is irrelevant. Keep IDs, color weights and feature payload semantics explicit; derivative weights are not automatically color weights.

## 3. Correct scalar partial derivatives and compose them

For `F(a(p), b(p))`, compute `∇F = F_a ∇a + F_b ∇b`. Share scalar-partial helpers between full and Mid variants so their mathematics cannot drift.

| Operation | Required rule |
| --- | --- |
| Hard union/intersection | Select the actual min/max scalar branch; use a documented exact-tie convention. |
| Complement/difference | Negate both distance and raw derivative once; preserve operand order. |
| Soft union, positive radius | `h=clamp(0.5+(b-a)/(2r),0,1)`; derivative `h∇a+(1-h)∇b`. Define zero-radius handling before division. |
| Round union/intersection | Differentiate the complete max/min plus vector-length expression, including inactive regions. In the active union region the weights are `u/length(u)`, not merely `u`. Handle zero length explicitly. |
| Chamfer | Active chamfer derivative is `(∇a+∇b)/sqrt(2)`; otherwise use the winning branch. |
| Morph | Use the derivative of the actual interpolation, retaining magnitude. |
| Pipe/seam and other binary helpers | Differentiate their actual scalar branch, including constant factors and complement signs. |

Audit every operator reachable inside the supported nesting matrix, including stairs/columns, engrave, groove and tongue. For periodic or discontinuous branches, compute valid branch-local derivatives where possible and distinguish switch/discontinuity points; this task does not make periodic geometry continuous or complete SFCC's analytical feature coverage.

For n-ary blends, retain the application's selected nearest pair and binary operand ordering. Check signed min/max routing, selected-pair transitions and equality cases; do not assume associativity or reorder inputs to simplify differentiation. Preserve behavior of material IDs and blend colors except where a separately tested bug requires correction.

## 4. Preserve derivatives through primitives and transforms

For a coordinate map `q=T(p)`, use `J_T(p)^T ∇f(q)`. Include any scalar distance multiplier: for `d(p)=c(p)f(T(p))`, the derivative is `c J_T^T∇f + f∇c`. The second term can matter away from the child's zero set, precisely where outer blends evaluate it.

- Translation/rotation, reflection and signed nonzero scale: match the evaluated coordinate map. For the existing nonuniform-scale field, `d=m f(p/s)` gives `∇d=m ∇f/s`, with `m=min(abs(s))` constant in position.
- Twist/bend/taper: differentiate the actual map and clamp region; retain all cross terms and magnitude. Test transformed children inside blends and transforms around a completed blend.
- Repeat/elongation and clamp boundaries: use their piecewise Jacobians and explicit boundary conventions.
- Offset preserves derivatives; shell changes their sign on the negative branch and is non-differentiable at its cusp.
- Extrude/loft/profile/lathe/threaded rod: audit full and Mid scalar parity, side/cap selection, height interpolation, twist clamps and profile derivatives. Preserve derivative magnitudes before normalization. For existing finite-difference paths, divide by the actual spacing, label them approximate, and use convergence tests; do not claim analytical coverage until the corresponding analytic producer exists.

Resolve proven full/Fast scalar discrepancies in a separate reviewable slice. Preferred contract is one geometric scalar expression, with conservative step scaling carried separately. Do not mechanically move divisors into `safeStepMul`: check how nested operators propagate step bounds, including morph, and verify conservative stepping on independent fixtures. If that requires a larger stepping redesign, record those operations as a blocked coverage family rather than claiming transformed nested-preview correctness. Unaffected regular blend/primitive controls can still complete independently.

## 5. Regression matrix and acceptance

Use GPU scalar central differences at multiple scale-aware spacings as the independent numerical oracle, supplemented by simple analytic equations and the existing native kernel where its scalar semantics match. Test off-surface points as well as final surface points. A normalized-vector comparison alone is insufficient: check raw magnitude and direction independently.

- Nest soft/round/chamfer in both orders and at depth three; union, intersection and subtraction; reversed binary inputs and three-or-more children.
- Include transformed primitives, generated profiles and the transform placement cases above. Include actual serialized housing/bracket sample points that are regular, but do not infer a unique normal at their sharp seams.
- At branch boundaries use one-sided samples that remain in the intended branch. At smooth opposing-gradient cancellation assert zero derivative and finite consumer output. Exclude known discontinuities from smooth convergence claims and test their classification separately.
- Test full/Mid agreement where they evaluate the same scalar, and Fast scalar agreement for each coverage family. Compare BVH on/off, preview-uniform versus export-storage parameter compilation, structural versus parameter-only updates, and cap-drag parameter reads where affected.
- Check preview-facing IDs, selection payloads, seam metadata and unit-normal guarantees; check existing GPU export sampling and MDC tests because shared helpers can change their numerical output. Do not modify mesh-viewer shaders merely for parity.

For the existing well-conditioned nested-soft control, retain the `1e-4` scalar-derivative-vector check and require the reported unit-normal discrepancy to fall below `0.02°`. Check raw derivatives against the independent reference to an initial `2e-4` absolute vector tolerance. Validate that f32 arithmetic and step-size convergence support these thresholds before adopting them; any adjustment needs independent error evidence, not matching the observed wrong result. Use relative-plus-absolute tolerances for differently scaled fixtures, and no angular assertion at near-zero gradients.

Run `make build` for shader/codegen/type validation and `make test` for integration (avoid a duplicate build if the test target already builds). Run targeted GPU tests as mandatory acceptance, not only textual shader checks. Visual QA stays manual; no automated browser navigation or PNG regeneration is required for this normal-correction task unless requested.

Record GPU adapter/backend, scene parameters, shader compile time and batched full/Mid/Fast sampling time before and after, using one warm-up and at least five measured runs. Inspect shader-local register/payload growth where measurable. Fast evaluation should gain no normal computation from the derivative-only change. Investigate over 10% median full/Mid cost growth with repeated measurements; this is a review threshold, not a promise of zero cost or a substitute for correctness.

## Delivery order and completion report

1. Baseline controls, scalar discrepancy reproductions and producer/consumer ledger.
2. Raw derivative/status contracts plus simple producers, retaining compatibility normals.
3. Correct CSG partials and nested-blend propagation, including full/Mid parity.
4. Primitive/transform propagation and separately tested scalar/stepping prerequisite corrections.
5. Full regression matrix, performance evidence and documentation of exact/approximate/unsupported families.

Commit bounded slices during authorized implementation. Do not declare the entire task complete based only on the original one-point discrepancy disappearing. Report coverage by operation family, mandatory GPU test results, measured normal errors and any unresolved scalar-path or derivative families. Update the algorithm explanation's GPU-normal limitation to the delivered scope; retain SFCC's independent feature-completeness limitations.
