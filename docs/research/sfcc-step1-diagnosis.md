# SFCC Step 1: observed failures and provenance

Starting revision: `0f32ceb` (implementation `234f3cb` / `e36db4a`). This step adds optional diagnostics and regression fixtures. It changes no acceptance predicate, tolerance, depth limit, operator, worker wire format, or UI. Broad milestone validation belongs to the coordinator; the focused results below do not replace it.

## Selected observer

The consensus combines B's bounded capture and per-cell geometry records, A's executed branch and original-occurrence attribution, and C's feature lifecycle observations. It keeps one `sfcc-profile` module and one native diagnostic suite. Default builds retain the dependency-free kernel; profiling does not require `serde`. JSON fixture ingestion alone uses the existing optional `serde` feature.

Records identify a capture-local export, parent export, recovery round, and integer cell `(level, ix, iy, iz)`. Decision attempts, actual predicate/balance splits, initial descent, superseded decisions, depth ceilings, mesh emissions, and final round snapshots are separate events. Cached feature classifications retain their original reason. Original primitive ownership is the existing leaf occurrence index; the fine-sphere ledger also records its source path `[1]`. No branch is diagnosed by running a later predicate inside the observer.

Capture restores an enclosing capture even on unwind. Native serial, prepare, direct decision, resumable reference, mesh-partition and merge entry points get separate scopes; nested serial recovery is linked to its caller. The JS resumable session transports unchanged tagged leaves and decisions; no profile trace is transported across WASM instances. Its correctness evidence is the actual worker regression, not an invented cross-thread trace identity.

The caller bounds retained **events**, not bytes. A mesh event copies the existing per-cell triangle payload; there is no additional geometry budget or meshing work. `dropped > 0` makes the ledger incomplete. Complete fixture ledgers require zero dropped records. Final unresolved accounting is `degenerate + failed - failed_degenerate`; attempts and earlier rounds are never added to it. A synthetic overlap control exercises that union explicitly.

Runtime hooks only copy existing state. Exact projected-orientation audits run after export and after all 31 production-counter comparisons. They add their own predicate work and never restore or mask counters. Persistent predicate workspaces receive matched warmup before counter comparisons. Geometry, feature edges, validation and tagged-leaf bytes are compared with capture disabled/enabled. These are finite regression results, not a claim of performance neutrality under allocation failure or cancellation timing.

Rejected alternatives: three parallel trace frameworks; A's non-nestable start/finish API and runtime topology scan; B's top-level-only `smooth` attribution as the final explanation; C's detailed feature reason held only in transient thread-local state, which is lost on a classification-cache hit. Exact triangle analysis remains outside runtime hooks. No new global counter restoration API is introduced.

## Claim and evidence ledger

| Claim | Evidence and scope |
| --- | --- |
| Fine hidden sphere: all 36 final cells first fail sampled stratum normal variation | Actual branches and ancestor split events at depth 14, tolerance `1e-5`; 4,199 leaves, two components, zero failed cells and zero re-refinement rounds. All cells belong to sphere occurrence `[1]`. |
| Twenty-one of those cells also fail edge-derivative replay | Secondary counterfactual evidence on fixed captured cells. The original execution returns at normal variation before that predicate. |
| Normal angles are 47.188–159.574 degrees versus 18 degrees | Independent radial-normal calculation at the nine actual probe coordinates. This corroborates a sampled heuristic; it is not a whole-surface bound. |
| Default hidden sphere loses its small component honestly | Depth 8 has one component and four unresolved cells: one primitive-uniform-corner discovery rejection and three sampled-normal rejections. |
| Tight production lens reconstructs both components | Full-object cube `[-4,4]^3`, radius 10.01 spheres at `±10x` and box `[-3,-.5] × [-3,3]^2`: two localized components, 13 trimmed curves, a connected degree-two seam cycle, 267 unresolved cells, zero failed cells. `ok=false` is preserved. |
| Guard-only lens passage does not establish an exporter miss | The ordinary feature-aware exporter reconstructs it. The aligned coarse witness instead first rejects at the real contained-curve feature classifier. |
| Aligned finest-cell lens omission is localized | Cube `[-128,128]^3`, padding 2, depth 8; translate the entire object to actual cell `(8,128,128,128)` center. Side `260/256`. Primitive guard passes; classifier rejects contained loop. Output: one component, one unresolved cell, one fallback, 13 curves, missing seam curve 12. |
| Tight depth-10 output contains unresolved-cell debris | Four components with 2,668 / 5,764 / 32 / 14 triangles, 1,017 unresolved cells and 12 invalid output triangles. Raw cell meshes contain 68 exact collapsed working-f64 triangles; assembly removes 56 and retains 12. |
| Invalid and detached triangles were already constructed in unresolved cells | Every invalid output triangle and all 46 detached-fragment triangles have exact positional source candidates, all degenerate. Multiple neighboring candidates remain explicitly ambiguous; no nearest-AABB assignment is used. |
| The depth-10 problem survives removing unrelated box geometry | Lens-only reduction retains 1,017 unresolved cells, three components (analytic target: one), 68 raw collapses and 12 invalid output triangles. This localizes the first malformed stage to unresolved-cell construction, without identifying a unique internal triangulation branch. |
| Near tangency exceeds feature tracing's conditioning scope | Radius 10.0001: seam absent before trimming, `unresolvedDiscovery=1`, one component and 168 unresolved cells including the lens region. Analytic seam rank about .008944 is below `sin(2°)` about .034899. |
| Actual recovery rounds reconcile | Twisted extrusion plus hidden sphere: 5,824 unresolved in round 0, 6,162 in final round 1. Final count is 6,162, not their sum. The separate cylinder control enters serial recovery with zero extra refinement rounds. |
| Ordinary success remains useful | A planar box has one component and zero unresolved cells. A unit sphere in the tight cube has eight unresolved cells; it is retained as an honest unresolved control. |
| Numerical exclusion and clipped-component completeness | **Not established here.** Existing engineering interval allowances, pruning assumptions, unsupported operators, general termination, embedding and Hausdorff guarantees remain open. |

The analytic lens satisfies `|x| ≤ .01`, `y² + z² ≤ .2001`; its exposed seam is `x=0`, `y²+z²=.2001`, separated from the box by .49. Those elementary geometric targets are independent of the exporter. The finite vertex and incidence tests do not establish triangle-interior or global approximation error.

Changing surface tolerance `.01 → 1e-5` at depth 14 preserves the 36 final cell identities and reason counts, but **both vertex and triangle buffers differ**. Changing depth also changes the existing lattice jitter/origin. Cross-depth runs therefore are not refinement of one fixed grid. Frozen inputs retain the actual settings and lattice origins.

The matrix also retains depth 6, grid phase, coherent translation and scale, exact quarter-turn rotation, a clipped cap and a cavity. Variant inputs are stored exactly; different competitor phase/cap/cavity constructions are not presented as contradictory runs of one scene. A cavity has two boundary components, not two solid volumes.

## Worker evidence

Fine hidden sphere and ordinary tight lens are designated no-recovery cases. Actual WASM workers at 1/2/4/8 partitions, forward and reversed merge completion, must preserve oriented triangles (all eight vertex fields), feature-edge parameters and validation while asserting `serialRecovery=false` and zero failed cells. Native tests additionally compare serial/resumable/direct decision bytes and first reasons for all 36 fine cells.

The aligned lens has a fallback and therefore the public coordinator intentionally invokes serial recovery. Its WASM check asserts that recovery. A separate native `merge_partials` test records the raw 1/2/4/8 outcome in both orders. Recovery output is never substituted for raw merge evidence. The twisted-extrusion fixture separately proves a genuine extra refinement round, nested export isolation and final accounting.

## Durable artifacts and reproduction

The `sfcc-step1/` directory contains [frozen inputs](sfcc-step1/frozen-inputs.json), [all 36 fine-cell records and split provenance](sfcc-step1/fine-hidden-ledger.json), [depth-10 positional provenance](sfcc-step1/depth10-provenance.json), a [matrix/recovery summary](sfcc-step1/matrix.json), and [validation provenance](sfcc-step1/validation.json). These are a bounded evidence snapshot, not universal expected counts for future policies. Runnable tests remain the authoritative reproduction; they can emit their full structured results with `SFCC_DIAG_DIR` pointing outside the repository root.

```sh
SFCC_DIAG_DIR=/tmp/sfcc-step1 CARGO_BUILD_JOBS=1 cargo test --offline --release --jobs 1 \
  --manifest-path gcad-wasm/Cargo.toml -p gcad-kernel --features serde,sfcc-profile \
  --test diagnosis_contract -- --test-threads=1
CARGO_BUILD_JOBS=1 cargo check --offline --jobs 1 --manifest-path gcad-wasm/Cargo.toml \
  -p gcad-kernel --all-targets --no-default-features --features sfcc-profile
PATH="/Users/matt/.cargo/bin:$PATH" CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=1 \
  RUSTFLAGS='-C target-feature=+simd128' wasm-pack build gcad-wasm/wasm --target web --release
node --import tsx --test --test-concurrency=1 gcad-wasm/fixtures/sfcc-discovery_test.mts
```

Compilation is sequential. Native validation uses Homebrew rustc/cargo 1.99; WASM uses Rustup 1.96 with `simd128`; current Node is 26.11.1. Competitor Node 23.11.0 runs are historical evidence, separately identified. Release settings remain opt-level 3, LTO and one codegen unit. Enabled capture costs copying proportional to decisions, emitted triangles and final cells; no speed improvement is claimed.

## Focused validation

- The initial integrated native suite passed all 11 diagnostic tests; the six existing discovery contracts also passed. A later strengthened near-tangent assertion incorrectly expected 12 raw curves. The observed 17 include five unrelated candidates that trimming removes. Ten other diagnostic tests passed; the corrected focused test passed with raw count 17, trimmed count 12, and explicit absence of the sphere/sphere stratum pair in both stages. No production change was made to satisfy that assertion.
- Default and profile-only **all-targets** checks passed without `serde`. The profile-only failed/degenerate overlap unit passed. The coordinator also added and passed a profile-only cached-feature regression: it proves an actual classification-cache hit retains the two original `feature_two_corners` reasons. This test-only addition postdates the focused WASM artifact; production source is unchanged.
- The matching normal-release WASM package built successfully (31.90 seconds including optimization). Its SHA-256 and source/artifact hashes are in `sfcc-step1/manifest.json`. All seven actual WASM discovery fixtures passed in 27.659 seconds, with zero failures/skips/cancellations. This includes 1/2/4/8 workers and reversed merges. The coordinator broad gate below passed on the final integrated source.

## Coordinator acceptance gate

The final application build passed, followed by **324 default native tests**, **26 WASM fixtures**, and the complete profiling run (**176 library + 11 diagnosis tests**), all with zero failures. These overlapping suites are reported separately, not added as independent coverage. The profiling run includes the final near-tangent and cached-reason assertions together. Existing native tests without their external TS binary oracle do not establish the missing oracle comparison.

Commands and log hashes are recorded separately in the validation artifact. The broad build stamps version `0.0.0-0f32ceb-dirty`; its WASM/glue hashes are separate from the earlier focused package. Some correctness checks ran concurrently with isolated Cargo targets, so their durations are not performance measurements. Manual visual QA remains with the user. Step 1 is accepted; numerical exclusion proceeds from this committed source.

## Step 2 handoff

Inventory every interval/discard boundary, including initial descent, child culling and pruned views before discovery. Define the continuous field under the actually represented transforms and prove a conservative exclusion contract; a passed fixture is not an enclosure theorem. Preserve the positive lens/box controls, the explicit near-tangent and contained-loop limits, original signed occurrence paths, and raw-versus-recovery distinction. None of the depth-10 debris establishes an accepted-cell false-success defect. Its finer internal triangulation attribution remains open if later work targets those unresolved outputs.
