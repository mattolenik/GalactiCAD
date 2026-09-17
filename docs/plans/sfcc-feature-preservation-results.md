# SFCC branch and curve preservation implementation results

Implementation checkpoint: September 7, 2026. This records the delivered changes and the remaining work from the [implementation plan](sfcc-feature-preservation-implementation.md). It does **not** establish complete analytical feature coverage.

## Delivered changes

- `3a2f2ab3`: the bridge builds operands normally and complements a completed subtraction RHS once. Independent hard and round/soft/chamfer algebra controls failed before the fix and pass afterward. Application tests include real CAD serialization, variadic subtraction, transformed compound cutters and cavity orientation. A columns-containing cutter returns a node-specific bridge error; direct columns remain accepted.
- `4aa6687a`: lifted fields retain explicit ancestor partners, signed nearest-two guards and binary operand order. Loft candidates fix both profile edges within an interpolation interval, including transitions where both edges change simultaneously. Descriptors are interned within source-node expansions; shared source trees and partner lists avoid copying whole expressions. Semantic fingerprints include source expressions, branch choices, domains and curve/junction incidence. Bounded expansion reports affected source paths.
- `82ad5bd3`: curve IDs and oriented, unwrapped intervals are retained by edge-cell arcs, corner fans and local feature graphs; conforming refinement projects within those intervals and partitions them at the actual projected parameters. Multiple memberships survive both separate-table assembly paths, cleanup accounting, compaction and worker transport. SFL3/SFP3 reject mismatched feature graphs and invalid/conflicting interval references. WASM and mesh debug output expose final interval records.

The compiled-curve audit checks actual output edges, connectedness, interval coverage and sampled bidirectional geometric agreement using f32 output coordinates. Failures prevent an otherwise clean export from reporting overall validation success. Detailed issues identify curve IDs and parameter ranges. It cannot identify curves omitted by feature compilation.

## Independent controls and failure localization

| Control | Failure stage / evidence | Result |
| --- | --- | --- |
| Compound cutters | Bridge scalar semantics; all three new native controls failed on the original implementation, including a panic for columns complements. | Correct scalar algebra and structured rejection. |
| Three-operand chamfer partner switch | Fixed branch formula and activity guard. In the control, `a=max(x,z)`, `b=y-.6`, `c=-y-.6`; the exposed crease is `x=z=-.4-abs(y)`. | Expected arcs, a four-way compiled junction, and a connected labeled final mesh chain pass at `0.002` mm. |
| Simultaneous loft profile changes | Representing a change in only one profile omitted the expected inset arc by about `0.6364` mm. Both profiles' edge choices must change together. | Expected inset arcs pass for matching and differing vertex counts at `0.002` mm. The control stays inside both profiles, where its independent max-field equation applies. |
| Loft height knot | Opposite one-sided height derivatives after displacement. | Exposed knot curve and normal-jump controls pass. |
| Two nearby curves | The old nearest-compatible-curve search could select the wrong radius. | Refinement follows the recorded curve and interval. |
| Curve parameterization | Adaptive trace knots are not uniformly spaced in physical distance. | Projection and bidirectional checks use geometric distance within the interval; parameter distance is not treated as spatial distance. |
| Negative chain controls | Removing or misassigning an interval while keeping triangles unchanged. | Chain audit fails; a separate negative control retains the same closed manifold mesh. |
| Worker assembly | Curved cylinder features, 1/2/4/8 partitions, forward and reversed completion. | Same interval chains as serial; `serialRecovery == false` is required. Recovery fixtures remain separate. |

Existing housing square-rim checks remain at `1e-5` mm; existing inset-curve checks remain at `0.002` mm; housing/bracket sampled triangle checks remain at `0.02` mm. No tolerance or mesh-density increase substitutes for a fix.

## Remaining work

The full plan remains partially complete. The implementation provides explicit partner/profile choices and end-to-end interval preservation, but does not yet provide the proposed general spatially adaptive region DAG with fixed sibling formulas and explicit adjacency-driven continuation across every nested transition. Some sibling, activation and endpoint fields remain internally piecewise. Expansion currently limits each ancestor-path state set and each loft interval's profile-edge combinations to 128, reporting exhausted source paths instead of claiming exclusion.

Housing and bracket retain existing feature-cell fallbacks. The new chain audit exposes missing or incomplete chains around those arrangements even when topology, vertex residuals and the existing geometric regression samples pass. Those gaps are not declared repaired. Local feature graph meshing still requires one boundary loop and does not solve unrestricted junction arrangements. An empty `unresolvedBranchPaths` list means the implemented enumeration did not exhaust its budget, not that all analytical families are complete.

Stairs/columns region semantics, GPU analytical normals, universal small-component discovery and continuous embedding/Hausdorff proofs remain outside this delivery.

## Validation and artifacts

The committed implementation passed the native workspace test command (`cargo test --offline --release --manifest-path gcad-wasm/Cargo.toml --workspace --no-fail-fast`): **220 tests reported passing**. Historical parity tests early-return because their optional binary fixtures are absent; they do not establish fresh parity coverage. All new native controls execute without optional fixtures.

`make test` completed the required WASM build, TypeScript check, application build and test run: **358 passed, 2 skipped**. Installed dependencies and cached WASM tools were used (`-o setup`, with `TSX='node --import tsx'`) because sandboxed dependency setup could not reach the registry and the `tsx` launcher could not create its IPC pipe. No build or test failure was suppressed.

Sequential WASM export measurements used one warm-up and five measured runs per scene, with identical serialized inputs and export settings:

| Scene | Baseline median | Final median | Change | Final triangles | Median end-of-export RSS, baseline → final |
| --- | ---: | ---: | ---: | ---: | ---: |
| Housing | 31.718 s | 35.675 s | +12.5% | 128,936 | 253.1 → 254.0 MB |
| Bracket | 25.222 s | 25.120 s | −0.4% | 91,764 | 272.4 → 261.7 MB |

Housing feature compilation increased from 5.191 s to 8.667 s (median), with candidate pairs increasing from 2,213 to 3,269 and seed counts from 22,025 to 39,204. This is additional explicit-partner enumeration/tracing work, not evidence of recovered housing geometry: final triangle and curve counts are unchanged. Bracket feature compilation changed from 2.171 s to 2.219 s. These are single-machine measurements, not performance guarantees. RSS is sampled after exports, not a comparable per-scene peak measurement. Final exported interval arrays occupy 226,080 bytes for housing and 248,120 bytes for bracket; these are output metadata sizes, not complete worker payload sizes.

The final WASM chain audit reports housing with 60 missing labeled edges, 9 missing curves, 14 disconnected curves and 40 interval gaps; bracket has no missing edges/curves, 1 disconnected curve and 39 interval gaps. Both have zero off-curve edges, invalid memberships and unidentified edges. These categories can overlap. Topology and vertex-residual checks still pass; overall validation remains `incomplete`. Native floating-point differences can change individual chain counts, so these figures specifically describe the measured WASM exports.

All **60 PNGs** were regenerated after `82ad5bd3` using the existing shell-only `make -C docs/manim pngs` target (with the installed-dependency build overrides above). All 30 render requests succeeded; ImageMagick validated each image and crop before the target installed the complete set. All 60 expected output files were also checked for PNG signatures. Visual QA remains manual.

The updated animation rendered successfully: **273 animations, 1920×1080 at 30 fps, 530.3 seconds**, verified with `ffprobe`. The output is `docs/manim/sfcc-illustration.mp4` (ignored by Git). The render used the existing isolated `/tmp/sfcc-doc-review/manim.cfg` cache configuration; caption layout and visual fidelity remain for manual QA.

Scratch records: `/tmp/sfcc-feature-preservation/` contains the initial revision/diff, serialized housing/bracket trees, independent failing-control logs, native/WASM test logs and sequential export measurements. The baseline revision is `232fd6eb`; pre-existing documentation, Makefile and PNG changes were preserved. Measurements use the actual serialized scenes and unchanged export settings, including the bracket's effective enclosing chamfer.
