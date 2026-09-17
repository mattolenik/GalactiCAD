# SFCC performance implementation results

Status: implementation delivered September 10, 2026. Geometry/equivalence and runtime checks pass. Native peak-memory targets are not universally met; the measured exceptions and allocator investigation are documented below.

Implemented from [the performance plan](sfcc-performance-improvements.md), against production kernel revision `e090f2bed4a8cfd8d5cf965123120e6fdd89ace2`. The original [performance analysis](../sfcc-performance-analysis.md) remains a historical measurement of that revision.

## Delivered changes

| Slice | Implementation | Verification |
|---|---|---|
| P0 | Native/WASM binary comparison artifacts, preserved reference routines, and an optional `sfcc-profile` build with work counters and independent optimization switches | Compare positions, normals, oriented connectivity, feature intervals and full validation; profiling is excluded from acceptance timings |
| P1 | Hard min/max winner selection retains the incumbent scalar and evaluates each candidate once | Total-order/tie/signed-zero controls; old/new full and pruned raw samples; counted wide-selection control |
| P2 | Exact-zero orientation shortcuts; eight inline dyadic limbs with unrestricted heap spill; subtraction without operand cloning; reuse of triangle-plane signs; identical-representation shortcut in the final contact audit | Original exact-predicate reference, 1,500 deterministic finite-bit-pattern cases, independent cancellation/extreme-exponent tests, contact and f32 controls |
| P3 | A query-local cache shares scalar/raw evaluations across a carrier's ancestor-survival checks, reusing bounded thread-local storage | Separate scalar/raw slots; borrowed node identity; 128-entry bound; nested smooth operations, distinct roots, capacity and exposure parity tests |
| P4 | Strict/coarse attempts share chart/triangulation preparation and the first eight finite boundary projections | Tolerance-dependent domain/displacement checks and controlled surface projections still execute; strict success/coarse success/both-fail comparisons |
| P5 | Successful classification memo capped at 49,152 cells, keyed by level and packed lattice position; previous-round finite lattice values retained up to 131,072 entries | Forced markers rechecked; failures remain uncached; hanging-node presence remains round-local; explicit failure-reset and sample-visibility tests |

P3 reuses values within the actual immutable `FieldRef` root. It does not equate a cloned feature root with the full/pruned scene by stratum ID, and branch-override samples remain separate from the ordinary node samples. This preserves the nested-union/subtraction exposure semantics. Cached entries are cleared before a different point or moved geometry can use the storage. Node keys are addresses protected by the query's Rust borrow lifetime; they are never dereferenced or serialized. Only vector capacity survives a query, with independent storage for nested calls and cleanup on unwind.

P4 caches only tolerance-independent preparation and finite carrier boundary projections. It does not cache acceptance Booleans or Newton results across different tolerances/budgets. Larger boundaries bypass the projection memo after eight entries. Cancellation is checked before using prepared triangulation.

P5 retains the existing octree rebuild, balancing, contour construction and cell meshing. Classification and current/retained lattice-sample storage are released after the recovery loop, before final assembly allocates its indexes; no sampler or classification queries occur after that point. It saves repeated computations; it does not implement regional topology repair. Values in the retained pool do not satisfy `has_sample_key` until the new build samples them. Failed classifications run again after numerical diagnostics reset, and current forced markers are always applied after feature classification.

Worker protocols and quality defaults are unchanged. Full incremental topology repair, persistent worker contexts, distributed octree decisions, carrier indexing and incremental remesher adjacency remain the follow-up work identified in the plan.

## Correctness evidence

- Native workspace: **259 tests passed** after the final query-workspace change.
- Application: **421 tests, 420 passed, one opt-in benchmark skipped**, including actual WASM worker checks at 1/2/4/8 partitions and reversed completion order.
- Housing/bracket enabled-quality preservation assertions: **2/2 passed in the final delivery rerun**. The final `make build` also passed.
- **120 isolated native exports** (20 configuration/backend-version batches, each one warmup plus five measured runs) match the reference binary geometry, feature intervals and full validation. Completed unchanged-reference batches and the final isolated housing/all probe were reused with their original timestamps and binary hashes.
- Final WASM: **16 exports across two scenes and four modes**, with all 64 position/normal, triangle, feature-edge and validation artifact files matching the original module exactly. Earlier implementation revisions were checked separately and are distinguished in the data.
- Diagnostic ablations also preserve the same artifacts. Extreme-predicate, nested-exposure, cache-capacity, forced-recovery, failure-reset, round-local sample-presence and query-workspace lifetime controls pass.

See the [machine-readable evidence](sfcc-performance-improvements-measurements.json) for all raw samples, hashes, validation counters, diagnostic counts and memory snapshots. Per-curve issue lists are retained in the exact comparison artifacts; the report JSON retains their aggregate counters.

The exact artifact comparisons supplement the independent housing flange/bore/screw-hole and bracket seam assertions. They do not replace those tests. The optimized exports preserve the existing incomplete-validation reports and quality failures; this work does not claim to fix analytical feature completeness or certify the meshes.

## Diagnostic contribution of each optimization

The `sfcc-profile` feature adds counters and diagnostic-only switches. `SFCC_PERF_DISABLE` is a bit mask: selection `1`, predicates/contact reuse `2`, point-query cache `4`, patch preparation `8`, recovery caches `16`. These switches and counters compile away in ordinary builds. The diagnostic harness can run a single export with `runs=0`; such a run makes no measured-median claim.

Each initial housing/all-stages ablation matched the reference export's binary geometry/feature artifact and full validation. These diagnostic runs overlapped other correctness work, so their elapsed times are not performance-acceptance data.

| Change enabled | Observed work reduction on housing/all-stages |
|---|---|
| Exact predicates | About 41.3 million structural-zero shortcuts; remaining exact values needed at most five limbs; no inline-storage heap spills. Disabling the predicate changes recorded about 1.02 billion reference limb-allocation sites. This counter covers instrumented allocation sites, not every allocator call. |
| Query-local reuse | Scalar-composition calls decreased from 2,769,786,256 to 950,023,552; raw-composition calls from 512,782,636 to 213,569,179. |
| Final recovery caches | 49,152 classification hits and 129,850 retained lattice-value hits. Raw-composition calls decreased from 245,676,871 with recovery caches disabled to 220,769,531. |
| Query storage | The final workspace diagnostic recorded four vector-growth events and 5,048,160 storage reuses in one housing export. New same-address-node, changed-point, nested-query and unwind tests protect against stale values. |
| Patch preparation | Preparations decreased from 54,616 to 51,170. A subsequent diagnostic pair including the final boundary memo recorded 16,814 projection hits with identical export artifacts. |
| Winner selection | Housing's binary combiners showed identical selection-evaluation counts with this switch disabled. The benefit is for wider combiners: the counted control verifies one scalar evaluation per child instead of two per comparison. No housing speedup is attributed to this change alone. |

The initial ablations used the first, larger classification cache and preceded the final boundary-projection memo. The P4 on/off pair measures preparation reuse; a further P5 on/off pair measures the final compact cache. The source of each diagnostic result is distinguished in the accompanying data. The final reusable workspace has its own diagnostic export: four vector-growth events and 5,048,160 reuses. Stage contributions overlap: their savings must not be added as independent end-to-end speedups. Work-count ablations were used to separate contributions; the production audit/validation wall-time bucket remains combined rather than adding per-triangle clocks to ordinary builds.

## Isolated performance and memory

| Scene / mode | Reference median | Optimized median | Speedup | Peak RSS change | Peak footprint change |
|---|---:|---:|---:|---:|---:|
| housing / baseline | 24.486 s | 17.907 s | 1.37× | 3.5% | -2.5% |
| housing / audit | 54.128 s | 25.894 s | 2.09× | 5.9% | 0.5% |
| housing / all | 107.277 s | 37.437 s | 2.87× | 15.7% | 29.4% |
| bracket / baseline | 16.696 s | 12.025 s | 1.39× | 9.9% | 0.6% |
| bracket / audit | 35.960 s | 16.109 s | 2.23× | 5.8% | -0.3% |
| bracket / all | 64.531 s | 23.305 s | 2.77× | -0.2% | 16.6% |
| box / baseline | 0.123 s | 0.085 s | 1.45× | 10.6% | 12.0% |
| box / all | 1.778 s | 0.317 s | 5.61× | 16.8% | 18.0% |
| sphere / baseline | 0.037 s | 0.037 s | 1.00× | -4.1% | -4.0% |
| sphere / all | 2.345 s | 0.701 s | 3.34× | 10.0% | 10.6% |

Default housing export is **26.9% faster**, and default bracket export is **28.0% faster**. With all quality stages, housing is **2.87× faster** and bracket **2.77× faster**. Default sphere timing is effectively unchanged; all ten runtime comparisons satisfy the no-more-than-5%-regression check.

The all-quality cell-meshing bucket falls from **32.079 to 5.920 s** for housing and **16.255 to 3.320 s** for bracket. Assembly falls from **53.141 to 15.839 s** and **33.538 to 8.948 s**, respectively. Default octree time also decreases: **10.967 to 7.949 s** for housing and **9.338 to 6.061 s** for bracket. These are independently calculated phase medians, not numbers forced to sum to the median total.

The native memory target fails in five configurations: housing/all, bracket/all, box/baseline, box/all and sphere/all. Housing/all peak physical footprint rises from **305.0 to 394.7 MiB**; bracket/all rises from **197.8 to 230.5 MiB**. The small controls increase by approximately **1.5–3.8 MiB**. These are real process high-water measurements and remain flagged as failures in the raw threshold checks. They are retained as explicit memory tradeoffs, not silently treated as passing gates.

For the deployed WASM backend, the matched two-scene/four-mode run's maximum linear memory decreases from **173,211,648 to 167,510,016 bytes (3.3%)**. Individual earlier configurations can have different high-water marks; the full sequence and each export are recorded. WASM timings from the overlapping correctness runs are not used to claim an isolated browser speedup.

Acceptance timing builds exclude `sfcc-profile`. Reference and optimized process batches use identical input JSON, bounds, tuning and audit mode, one warmup and five measured exports, with order alternating between configuration pairs. Other builds, tests and benchmark processes finish before each isolated matrix starts. Completed reference baseline/audit batches are reused across memory-layout revisions because the reference binary and inputs are unchanged; their original timestamps and resource measurements are retained. Inputs include housing/bracket in baseline, audit-only and all-stages modes, plus box/sphere baseline/all-stages controls. All raw samples are retained.

Native elapsed time measures the kernel export, including validation and final result construction, but excludes bridge parsing/tree construction and artifact writing. Native RSS and peak footprint come from `time -l` for the complete six-export process. Output-buffer bytes are not used as a peak-memory proxy. WASM correctness runs also record linear-memory high water; their overlapping execution is not used to claim browser speedups.

The first cache design passed a preliminary two-export memory check (+4.7% RSS), but a six-export batch reached +10.3% RSS, just above the investigation threshold (+4.5% peak physical footprint). The classification key was then reduced from four coordinates to level plus the existing packed lattice key, and its cap lowered from 65,536 to 49,152 entries to stay in a smaller hash-table capacity tier. Geometry and diagnostics were rechecked after this adjustment. A later audit batch still showed +12% RSS despite only +1.6% physical-footprint growth. The implementation then released the now-unused classification and lattice caches before final assembly/auditing, and repeated native/application/WASM equivalence checks. All-quality native peak memory still exceeded the investigation threshold. A bounded reusable query workspace removed per-query vector allocation and improved runtime further, but did not remove the native footprint increase. Phase-level `vmmap` snapshots then showed lower live allocated heap and more allocator-retained empty large blocks. All sizing experiments and the remaining native peak-memory tradeoff are retained in the results.

### Native allocator investigation

At the start of remeshing in a diagnostic first export, `vmmap` reported live allocated heap of 103.2 M for the reference and 88.7 M for the optimized build, with the same 256,257 live allocations. Dirty memory in `MALLOC_LARGE (empty)` regions rose from 75.3 M to 153.1 M. After remeshing, live allocated heap was 102.3 M versus 87.7 M, again with identical allocation counts. These are phase snapshots in `vmmap`'s reported units, not complete-export peak-live-heap measurements.

At the sampled housing phase boundaries, the additional native footprint is dominated by freed large allocations retained by macOS malloc, despite lower live allocation. This is not a continuous measurement of peak live allocation inside remeshing, nor a separate diagnosis of every small-control increase. Reusable query storage improves runtime and removes millions of small allocation events, but does not eliminate that retention. Native RSS/physical-footprint threshold exceedances remain explicitly marked in the measurement data; they are not described as passing the original 10% metric. The retained implementation is a documented native allocator tradeoff, with unchanged default quality settings and separately checked WASM memory. No platform-specific allocator tuning was added to production code.

## Reproduction

The benchmark extensions are in [`sfcc_quality_bench.rs`](../../gcad-wasm/kernel/examples/sfcc_quality_bench.rs) and [`sfcc-quality-benchmark.mts`](../../gcad-wasm/fixtures/sfcc-quality-benchmark.mts). `SFCC_BENCH_ARTIFACTS` writes untimed comparison artifacts. The WASM runner accepts `SFCC_BENCH_WASM` for a saved module, allowing separate processes to compare the original and rebuilt kernels with the same scene bridge.

```sh
# Normal native timing build; pass scene JSON, cube, mode, and measured run count.
cargo build --offline --release --manifest-path gcad-wasm/Cargo.toml \
  -p gcad-kernel --features serde --example sfcc_quality_bench

# Separate diagnostic build; do not use its timings as normal-build acceptance.
CARGO_TARGET_DIR=/tmp/sfcc-profile cargo build --offline --release \
  --manifest-path gcad-wasm/Cargo.toml -p gcad-kernel \
  --features serde,sfcc-profile --example sfcc_quality_bench
SFCC_PERF_DISABLE=4 /tmp/sfcc-profile/release/examples/sfcc_quality_bench \
  /tmp/sfcc-performance-inputs/housing.json \
  -23.5 -13.199999809265137 -23.5 47 all 0
```

The original performance report supplies input-generation commands. The new reference implementations are test/diagnostic-only and retain the original numerical algorithms; no second application scene evaluator was introduced.
