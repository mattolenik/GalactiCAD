# Step 4 candidate A: prepare immutable discovery operands

Recommendation: consider this small independent optimization for the fourth agent's final controlled gate. The nine fast native controls show modest preliminary improvements, strongest on duplicate operands and the ordinary seam. It preserves every tested decision and endpoint bit. It does not solve the expensive culling, local-coverage or final-assembly work, and it adds immutable per-export storage. No general speedup, WASM speedup or broader geometric theorem is claimed.

Baseline: accepted Step 3 commit `f804044d8c960acea3b3f8735678eecffa31952d`. Runtime source manifest and binary hashes are in [manifest.json](manifest.json). The candidate source logical digest is `6d09e0fc731204c8695519cfa496df922018890424fb6e2d16ab22839b76dbb5`. Matching WASM: `aab3ced225cdd2053865f84de6d16d063007f1ab031c79b55edd3560ac5d10f6`, 1,489,764 bytes, 3,541 bytes larger than the VERSION-unset baseline.

## Implementation and argument

[proof.md](proof.md) gives the exact contract. A private `DiscoveryContext` borrows the original immutable tree and prepares the original DFS terminal occurrences. It saves pure eligibility results and query-independent outward interval coefficients. The query still walks the original min/max tree, uses a fresh preparation cursor, branches at its original error points and preserves every signed occurrence and ancestor path. Opaque ancestors retain their previous validation scope. There is no ID lookup, deduplication, region-result cache or global lifetime.

The shared serial/worker `PipelineContext` and standalone feature-aware octree own this context. Direct discovery calls build a fresh one. Direct CSG/pruned bound APIs still validate actual inputs on each call. Public `Leaf` fields cannot change during the borrowed context's lifetime; after dropping it, edits obtain a new preparation. Recovery, independent workers, partial traversal and cancellation cannot reuse another export's state.

Cached arithmetic expressions retain the original operation order within each expression. Query-dependent radial metric failures still try the affine route; failure of one route does not invalidate the other. Finite/extent checks remain on each query. Code for original box-edge rejection, local coverage, sliver-flip transport, quality withdrawal and SFP5 checks is untouched.

## Focused correctness gate

- **253 native tests passed:** 202 profiling library tests, 6 coverage obstruction, 11 diagnosis, 6 discovery, 13 numerical exclusion, 3 scene transforms and 3 pruned-query parity plus 9 worker partition tests. No test was ignored or weakened. The library includes five new preparation tests and preserves the inherited n=256 work assertion.
- **23 actual matching WASM fixtures passed** in the final focused run, including the `.mjs` coverage fixture, real 1/2/4/8 workers, reversed completion, raw no-recovery merges, separate recovery, quality controls, scene transforms and numerical inputs. Final elapsed duration 41.864 seconds is diagnostic, not a speed measurement.
- **24 full-scene cross-version comparisons** preserve canonical oriented triangles using all eight f32 vertex fields, full feature endpoint payloads and f64 interval bits, complete validation/count stats excluding times, prepared tagged-leaf bytes and decision bytes. Cases include all nine old fast controls; the successful sphere/clipped box; half-3 box flips; coarse/fine three sheets; quality sphere; all frozen represented-rotation and opaque controls. An additional **600 deterministic coefficient/query cases** preserve all bound endpoint bits. The complete baseline/candidate rows are [baseline-wasm-contract.jsonl](baseline-wasm-contract.jsonl) and [candidate-wasm-contract.jsonl](candidate-wasm-contract.jsonl).
- **132 native and 132 WASM frozen Step 2 records** match exactly, including actual primitive/query bits and all enclosure endpoints. Native and WASM are each compared with their own prior artifact; parser differences across targets are not hidden.
- **Nine native diagnosis artifacts** exactly match the frozen final Step 3 artifacts, including actual first reasons, final cells, recovery rounds and triangle provenance. The additional 11-test diagnosis replay passed. [diagnostic-parity.json](diagnostic-parity.json) records every file comparison.
- All original profile counters 0–30 match the baseline exactly on all nine old fast scenes. The added counters measure coefficient preparation, eligibility preparation and discovery coefficient reuse separately.

The first full WASM attempt had 22 passes and one 180-second timeout; the affected recovery test reported 308.885 seconds. The failed log is preserved as [validation/wasm-tests.log](validation/wasm-tests.log). Without changing source, artifact, assertions or timeout, the exact candidate test passed in 12.218 seconds and its exact baseline counterpart in 11.996 seconds. The final complete focused run passed all 23. This resolves the reproduction but does not establish the environmental cause of the earlier delay. No assertion failure was suppressed.

Two extra command mistakes are preserved: an incorrect guessed native diagnostic executable path exited 127, and an overly strict short filter ran zero tests. The corrected identified executable passed all 11 diagnosis tests; the fully qualified memory-test name ran and passed one test. Neither mistaken command is counted as validation.

## Structural work and storage

[structural-summary.json](structural-summary.json) and the raw profile JSONL files contain the measurements. A sphere export replaces 2,821 eligibility validations with one and reuses prepared coefficients for 53,615 discovery interval queries. Sixteen duplicate spheres replace 45,136 eligibility validations with sixteen and reuse coefficients for 857,840 discovery queries. All occurrences remain present, and every query still performs its region-dependent enclosure arithmetic.

Direct culling still prepares per call: 302,640 coefficient preparations remain on the sixteen-duplicate scene, 428,070 on the buried-15 scene and 412,192 on many-hard-hidden-16. These counts explain why the change is not an order-of-magnitude export optimization. It does not claim that all validation or all interval work has disappeared.

Measured on native arm64: context 32 bytes, entry 232 bytes, prepared primitive 224 bytes. Sixteen occurrences have capacity 16 and add 3,712 heap bytes. Vec capacity is retained for the context's lifetime, not proportional to queried regions; a small export may allocate the Vec's minimum capacity. Opaque scopes occupy entries too. Each independent worker has its own context. The bound is O(terminal discovery scopes), with no cell-count-dependent cache growth. No allocation count or browser peak-memory claim is inferred from these struct sizes.

## Preliminary performance

The coordinator paused the other agents and had no heavy work running. We ran three alternating baseline/candidate pairs, using identical release compiler/options, one warmup per version for each nine-scene batch and one measured export per scene per pair. This is a preliminary comparison; the fourth agent must run the specified five-sample final campaign and single three-sample 48-blob comparison. Raw observations, paired order and ranges are preserved in [preliminary-native-timings.jsonl](preliminary-native-timings.jsonl) and [preliminary-native-summary.json](preliminary-native-summary.json).

| Native scene | Baseline median ms | Candidate median ms | Change |
| --- | ---: | ---: | ---: |
| Box | 265.371 | 263.021 | -0.89% |
| Sphere | 148.155 | 143.786 | -2.95% |
| Ordinary seam | 264.850 | 252.954 | -4.49% |
| Hidden box/sphere | 104.010 | 103.408 | -0.58% |
| Four duplicates | 91.622 | 87.923 | -4.04% |
| Sixteen duplicates | 243.673 | 227.434 | -6.66% |
| Small seam | 64.243 | 63.280 | -1.50% |
| Fifteen buried leaves | 187.581 | 186.541 | -0.55% |
| Many-hard hidden | 215.899 | 214.011 | -0.87% |

The common direct-API probe executes 100,000 queries for each shape/matrix case; all output hashes match. Median changes were +0.17% identity sphere, +0.86% represented-rotation sphere, -0.29% identity box and -0.16% represented-rotation box. Thus this bounded probe shows no large direct-path penalty, but it cannot rule out a regression elsewhere. The constructor computes some unused affine coefficients when the radial metric succeeds; the measured direct rotated-sphere change must remain visible in the decision.

Only the original nine fast scenes were timed here. Step 3's clipped box, cross-cell planar flips, coarse/fine three-sheet examples and quality sphere were exercised for correctness, not native timing. The fourth common harness should include those and a represented-rotation export where metric hoisting is relevant. No 48-blob timing, WASM performance claim, browser/visual validation or broad application build was performed in this competitor.

## Reproduction

Native uses `/opt/homebrew/bin/cargo` and `RUSTC=/opt/homebrew/bin/rustc`, offline, release, jobs 1. Correctness uses `--features serde,sfcc-profile`; ordinary timing uses `--features serde` without profiling. Targets are isolated under `/tmp/sfcc-step4-a-*`.

```sh
CARGO_TARGET_DIR=/tmp/sfcc-step4-a-native CARGO_BUILD_JOBS=1 RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --offline --release --manifest-path gcad-wasm/Cargo.toml -p gcad-kernel --features serde,sfcc-profile --lib --test diagnosis_contract --test discovery_contract --test coverage_obstruction --test numerical_exclusion --test scene_transforms --test worker_partition --jobs 1 -- --test-threads=1
CARGO_TARGET_DIR=/tmp/sfcc-step4-a-native CARGO_BUILD_JOBS=1 RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --offline --release --manifest-path gcad-wasm/Cargo.toml -p gcad-kernel --features serde,sfcc-profile --test lever1_prune_parity --jobs 1 -- --test-threads=1
PATH="/Users/matt/.cargo/bin:/opt/homebrew/bin:$PATH" CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR=/tmp/sfcc-step4-a-wasm RUSTFLAGS='-C target-feature=+simd128' wasm-pack build gcad-wasm/wasm --target web --release --out-dir pkg -- --offline --jobs 1
/opt/homebrew/bin/node --import tsx --test --test-concurrency=1 gcad-wasm/fixtures/sfcc-coverage-obstruction_test.mjs gcad-wasm/fixtures/sfcc-discovery_test.mts gcad-wasm/fixtures/sfcc-numerical-exclusion_test.mts gcad-wasm/fixtures/sfcc-scene-transforms_test.mts gcad-wasm/fixtures/sfcc-quality_test.mts
/opt/homebrew/bin/node docs/research/sfcc-step4-a/compare-wasm.mjs /absolute/matching/pkg
```

The direct probe is `gcad-wasm/kernel/examples/sfcc_preparation_probe.rs`; the exact same file was built in an owned frozen-baseline copy. Ordinary export timings use the unchanged `sfcc_discovery_bench` on both revisions. A release-only dead-code warning remains for the crate-private old leaf discovery wrapper, now called only by native unit tests; its validating behavior is retained.

The fourth agent may reject this variant if its modest gains do not justify its storage/plumbing, or combine it only after testing interactions. The fixed-grid obstructions, unsupported coverage scope, coarse three-sheet missing geometry and honest quality withdrawals remain exactly those of Step 3.
