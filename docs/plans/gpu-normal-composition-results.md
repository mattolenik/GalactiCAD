# GPU normal composition: implementation and validation

Implemented September 7, 2026, against `07ab1f5ddac15ecaa1159a2301c92cf6555cefe1`. The initial working-tree delta was the untracked implementation plan. This changes shared GPU field evaluation, not the native/WASM SFCC feature compiler.

## Result and derivative contract

`SDFResult` and `SDFResultMid` now carry `gradient`, the unnormalized derivative of their own `d`, and `derivativeStatus`. Parent expressions consume this derivative rather than the public unit normal. `.g` remains the existing projection/blend heuristic; Fast retains its separate `safeStepMul`.

Status is a bitmask: exact regular (`0`), selected one-sided (`1`), numerical approximation (`2`), singular (`4`), unavailable (`8`). Contributing child flags propagate; inactive operands do not contaminate a winner. A stationary smooth derivative remains exactly zero with a finite `(0,1,0)` consumer fallback. Normalization rescales small nonzero derivatives before taking their length, so a small regular gradient does not incorrectly use the stationary fallback.

Status is not a universal differentiability detector. Polygon profiles conservatively identify their selected segment as one-sided. Numerical producers remain approximate at their sampling scale; this does not establish a unique derivative at every primitive cusp or medial axis. Invalid transform parameters, such as zero scale or a taper crossing zero width, remain outside the supported regular domain.

Explicit shading payload construction is separate from derivative construction. Extrude's optional artistic side smoothing and Mid's primary feature-face conventions do not become mathematical input to a parent blend. Packed iso/grid/MDC output layouts and preview bindings are unchanged.

## Producer and consumer audit

| Family | Delivered behavior |
| --- | --- |
| Hard union/intersection/difference | Actual min/max chooses the distance and raw derivative. Exact ties choose a deterministic one-sided derivative. Near-tie material ownership and seam metadata remain separate. Difference complements the raw derivative exactly once. |
| Soft, round, chamfer | Shared full/Mid scalar partials preserve child magnitude. Soft uses polynomial weights; round divides by the length of its active distance vector; chamfer includes `1/sqrt(2)`. Soft radius zero routes through hard union before division. |
| Morph, pipe, seam, engrave, groove, tongue | Chain rule follows the actual selected scalar branch and constant factors. |
| Columns/stairs | Shared branch-local scalar partials follow rotations, modulo, absolute value, and min/max. Branch switches are explicitly one-sided; this does not repair periodic geometry discontinuities. |
| Binary/n-ary/BVH routing | Existing source ordering and nearest-pair routing retained. Results carry their derivatives through selection; no associativity assumption introduced. |
| Rotation, signed scale | Jacobian-transpose composition, including the minimum-absolute-scale distance multiplier. |
| Twist, bend, taper | Jacobian and distance-multiplier product rule, including the off-surface term. Taper and extrude-twist derivatives respect their clamp intervals. |
| Elongation, shell, offset, polar repeat | Elongation masks clamped derivative coordinates; shell flips the derivative with distance sign; offset preserves it; polar repeat uses the rotation helper. Fold boundaries still need one-sided interpretation. |
| Sphere, box, cone, torus, capsule, plane, hex prism, disc | Existing primitive field derivatives initialize raw values. Sphere-center and box-branch conventions are explicit; Mid box feature-face normals no longer replace the scalar derivative near an edge. |
| Cylinder, blob | Existing numerical differences retain magnitude and are labeled approximate. Cylinder's meridian helper no longer normalizes away that magnitude. |
| Extrude and lathe | Preserve polygon-profile derivative before optional shading normalization, including transformed side/cap routing and feature returns. |
| Loft and threaded rod | Existing numerical differences divided by `2*eps`, then composed through caps and later CSG. Threaded rod preserves the derivative of its cap fillet/chamfer result. |
| Preview | Lighting, AO, picking and stored hit normals keep the public `.n` interface. IDs, blend colors and seam payloads are distinct from derivative weights. |
| MDC, grid and iso sampling | Shared Mid/full helpers updated. Existing `.g` projection heuristics and packed buffers retained. Feature-face normal conventions remain distinct from raw derivatives. |

## Scalar discrepancies resolved

The plan preferred a canonical geometric scalar with separate stepping bounds. This implementation instead preserves the established Fast scalar for twist, bend and taper and makes full/Mid differentiate that same expression, including its position-dependent multiplier. This avoids changing nested stepping propagation without an independent bound redesign. Seam full/Mid likewise include the existing Fast pipe factor.

Extrude's Fast evaluator formerly substituted its profile AABB or bounding-circle distance in empty space. That value can change a later smooth blend's geometry. Fast now evaluates the actual profile scalar; its stepping multiplier remains separate. This removes an optimization and can increase work for densely tessellated profiles. No normal calculation was added to Fast.

These changes make the tested GPU paths agree with one another. They do not assert that every distorted field is a Euclidean SDF, that every existing march multiplier is a global Lipschitz bound, or that native SFCC and GPU scalar semantics match for every operation.

## Regression evidence

The existing nested-soft GPU test failed before implementation with **1.1130408247 degrees** of normal error. It now passes the **0.02-degree** assertion and reports **0 degrees** at f32 readback precision. A separate test compares the raw vector to the independent reference `(0.02261709385, -0.05698498450, 0.85724430306)` with a `2e-4` absolute vector tolerance; scalar central differences retain their `1e-4` reference check.

`gpu-normal-composition_test.mts` adds actual GPU compute controls for:

- Every soft/round/chamfer nesting pair, depth three, three children, signed scaling, and transforms inside and outside blends, with BVH enabled and disabled.
- Extrude (including a triangular profile that exposes the bounding-distance mismatch), loft, lathe, cylinder, threaded rod, cone, torus, capsule, disc and hex-prism children.
- All 22 binary operator variants in the control table, using affine operands with unequal derivative magnitudes and independently sampled scalar differences.
- Smooth cancellation, small regular derivatives, hard near-ties with reversed IDs, exact ties, radius zero, inactive approximate children, and Mid feature-face separation.
- GPU full/Mid raw-vector and scalar agreement, Fast scalar agreement, and unit normals at regular points. Differences use two step sizes for scene controls and both on/off-surface reference points.
- Preview uniform versus export storage layouts, reused shader modules with new packed parameters, and cap-drag uniform updates. These are compute tests, not browser automation or a complete UI interaction test.
- Regular points in the actual housing and bracket YAML scenes. They do not assert a unique normal at a sharp X seam.

The designated run uses `REQUIRE_WEBGPU=1`; adapter unavailability fails acceptance. `make test` includes `make build`. Validation used the installed dependencies with `-o setup TSX='node --import tsx'` and the installed wasm tool paths because the ordinary setup target could not reach the package registry to verify pnpm. No signature verification was disabled. GPU runs needed Metal access outside the filesystem sandbox.

The build and integration run passed **417 tests**, with only the opt-in sampling benchmark skipped. The benchmark was run separately and passed. No PNGs or video were regenerated; visual QA remains manual.

## Performance evidence and limits

On Apple M1 Max (`apple`, `metal-3`, Metal driver on macOS 26.5.1 build 25F80), the nested-soft fixture sampled **1,048,576 positions**, with one warm-up followed by five measured batches per mode. Times include submission, GPU execution, copying and mapping readback; they are not isolated GPU timestamp measurements.

| Mode | Baseline median | Updated median | Change |
| --- | ---: | ---: | ---: |
| Full normal + scalar | 7.999 ms | 8.401 ms | +5.0% |
| Mid normal + scalar | 7.852 ms | 8.031 ms | +2.3% |
| Fast | 8.000 ms | 6.011 ms | -24.9% |

Individual batches varied substantially (roughly 5–12 ms). The Fast number is not evidence of an algorithmic speedup: this fixture's Fast computation is essentially unchanged. Full/Mid medians did not exceed the plan's 10% investigation threshold. Shader module/codegen/compilation-info time increased from about **86 ms to 100–105 ms**, consistent with the larger shared source. Pipeline creation is outside that compile bucket and the measured steady-state batches.

The structs add a shader-local `vec3f` plus `u32`; actual compiler register allocation was not available. This benchmark does not establish preview frame-time neutrality, particularly for complex extrudes after removing the bounding-distance substitution. Restoring a cheap empty-space bound requires a separate bound channel or a context-aware proof that the bound cannot enter a parent field expression.

SFCC's remaining native feature-chain, adjacency and periodic-coverage limitations are unchanged.
