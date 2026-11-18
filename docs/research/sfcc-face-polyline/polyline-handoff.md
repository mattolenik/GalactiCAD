# A: complete captured face-chain correspondence and fixed-boundary obstruction

Isolated source: /tmp/sfcc-face-polyline-a. Verified all229 parent inputs against the round39 Integrated manifest before copying. No production source changed.

## Scope and changes

New diagnostic module `feature49_a::face_polyline_a` in `src/sfcc/face_polyline_a.rs`; one test-only module hook appended to `feature49_a.rs`. No fixture edits, source-family changes, tolerances, budgets, renderer or caller changes. The helper accepts the captured face fixture and captured44-triangle incident fixture; caller must bind them to the actual runtime. Its positive test uses the original scene/tolerances and builds fresh source features, then makes exactly one fresh exhaustive face call. Negative controls refuse before a new source call.

## Checked claim

The actual chain is39→40→38, corresponding to original global points4073→4074→4072. Its two edges are exactly the two original FaceRecord segments.38 and39 have exact represented faceX and exact top/bottom Y, respectively.40 is the original chart49 pin with strata31/15. All three point payloads are rebound to the incident fixture; its two edges each have two incident triangles. The helper checks strict Y progression in both working and f32 positions.

Round38's fresh exhaustive face theorem supplies one root at every closed Y fiber, one connected contour, and precisely two branches separated by ideal Y*. The new correspondence maps each mesh segment affinely in ideal Y: lower39→40 mapsYmin→Y*, upper40→38 mapsY*→Ymax. Both are strict bijections and meet at the same ideal source/face/feature event. Consequently every contour point is covered exactly once. This is a continuous graph argument, not finite sample coverage.

For the chamfer branch, let a=ny/(1-nr), d=faceX-centerX and z(Y)=sqrt(rho(Y)^2-d^2). Then z''=-a²d²/z³. Fresh bound coefficients and the strictly positive lower-end z give the uniform absolute derivative bound M. The whole ideal-curve/chord discrepancy is at most M*(Y*-Ymin)²/8. The cylinder branch is an exact straight segment. For each branch add the maximum L1 original endpoint-to-ideal enclosure bound and maximum L1 same-barycentric f32 rounding bound. This bounds Euclidean error pointwise and in both directions over the entire edge. The helper refuses if that exported error exceeds min(original surface tolerance, original chord tolerance/2). Surface and chord inputs bind exact captured bits; enlarged limits are rejected.

## Compatibility obstruction

The current44-triangle union has38/39 on its outer boundary. Their Z coordinates are strictly above the independently proved ideal face-root intervals:

-38 retainedZ=5.431920990801739; idealZ∈[5.4319133015149506,5.431913301514966].
-39 retainedZ=5.42950236902782; idealZ∈[5.4294818831714915,5.429481883171608].

The helper calculates outward positive gap lower bounds from a fresh face proof. Any correspondence that fixes these projected YZ coordinates, including round39's fixed-outer-boundary transport followed by its same-YZ source lift, cannot equal the exact face-contour correspondence at these endpoints. This does not show a mesh-error violation. Both bounds are tiny relative to the original0.01mm limit.

Furthermore the lower ideal branch is curved in YZ, while round39 is PL on the actual edge. Moving only endpoint40 does not identify that entire face branch. A future common2D map must admit a curved trace and transport the boundary endpoint images with their complete incident consumers, or establish a different compatible domain. This module explicitly reports newCompatibleTwoDimensionalMapProved=false and publicationReady=false.

## Execution request

Root should run filter `face_polyline_a_` on this isolated source with `SFCC_POLYLINE_A_RECEIPT` pointing to a fresh receipt. Test: `face_polyline_a_actual_complete_chain_and_fixed_boundary_obstruction`.

Negative controls: missing segment, changed captured point, enlarged surface tolerance, enlarged chord tolerance. They fail before source work. No builds, tests, geometry or fresh source evaluations run by A. Only static inspection, source copy/hash verification and pinned rustfmt were performed.

The complete-face helper retains its actual legacy128-check/depth16 cap. The44-triangle surface checker is not called here, and its separate128/depth12 cap is unchanged. No query calls are introduced by this source-level theorem. Root must not report the old surface128/depth12 cap as the exhaustive face helper's depth.

## Source hashes

- gcad-wasm/kernel/src/sfcc/face_polyline_a.rs: b03cfeba6a0b2aad51712ab25f506395b63bd1311778e06d3f4a7e9fef134d20
- gcad-wasm/kernel/src/sfcc/feature49_a.rs: 2f291df95318334bda3eb2e724defd1aa7304cca51756db55c16110ba828c13c

## Coordinator execution update

Root reports A-check build and the positive/negative controls pass. The executed whole-export correspondence bound is2.0955268988113107e-5 mm, with10 exhaustive-face source checks. These are coordinator-run results, not independent execution by A. Source is frozen at the hashes above.
