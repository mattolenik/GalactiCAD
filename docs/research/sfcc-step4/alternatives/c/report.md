# Step 4 candidate C: exact face-pin lookup sharing

**Recommendation: retain this as a reviewed alternative, not an unconditional
performance acceptance.** The index preserves the accepted contract in the
proof and all tests, and the large-box gain repeats at approximately 5.5%.
However, an unexplained 2.6% sphere slowdown persists in the bounded follow-up,
and the two smaller supported box controls show little whole-export benefit.
The fourth reviewer should reject this candidate if its common gate does not
justify that tradeoff. No further tuning was performed after seeing it.

Baseline is accepted Step 3 `f804044d8c960acea3b3f8735678eecffa31952d`.
The isolated candidate is `/tmp/sfcc-next-xv_s_w7u/stage4-c`.
No other competitor implementation or report was read, no canonical files were
edited, and no subagent, commit, push, browser or visual QA was used.

## Change and correctness argument

The old box-crease verifier scanned all face pins for each endpoint parameter.
A small `CoverageFaces` context now exclusively borrows the same face maps and
lazily indexes exact `(point_id, curve_id)` keys. Identical parameter bits share
one value; any unequal bits retain the existing conflict error. The context
exposes only immutable records and the existing face-use counter increment.
All six cell-record paths and master worker revalidation use their call-local
context. It drops before another group, recovery, export or worker invocation.

This is a lookup transformation, not a new SDF evaluator, numerical bound,
coverage theorem or ownership merge. It retains all duplicate and conflicting
pins, signed-zero distinctions, NaN payload distinctions, exact corner checks,
all crease memberships, and first-error order. Unrelated conflicts do not become
premature errors. The direct uncached verifier remains a test oracle. New tests
compare all parameter results over the bit-adversary matrix and complete real
sphere/box certificates with and without the index. See [the proof and caller
audit](proof.md).

No discovery/scalar/interval routine, tolerance, default depth, feature operation,
quality edit, flip transport, worker wire field, scene transform, or final mesh
payload was changed. The only other runtime change is moving the same existing
consumption increment behind the restricted context API. Profiling appends five
work counters; a benchmark converts the longer counter array to `Vec` for JSON.

## Structural cost and memory

The following rows are complete serial exports, not isolated helper timings.
Each query in these successful controls previously traversed every pin, including
all face-map traversal. The new code visits each pin once and performs the shown
number of indexed lookups. Both versions have identical original counters 0–30.

| Control | Index builds | Pins visited once | Lookups | Old pin visits | Unique entries | Peak retained capacity |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Half-3 default box, 386 cells | 1 | 96 | 216 | 20,736 | 96 | 112 |
| Positive clipped box, 132 cells | 1 | 56 | 208 | 11,648 | 56 | 56 |
| Half-10 box, 4,376 cells | 1 | 324 | 672 | 217,728 | 324 | 448 |
| Other ten native controls | 0 | 0 | 0 | not applicable | 0 | 0 |

Storage is O(U), where U is the number of distinct pin keys in the current
already-materialized face maps; U ≤ P total pins. Capacity is reported separately
from live entries. No hash table allocation occurs without a queried crease.
Actual allocator bytes and WASM heap high-water marks were not measured.
Hash lookup cost is expected/amortized constant under the hashing assumptions,
not an unconditional worst-case theorem. The old scan is O(K(F+P)); the new
construction performs one pass over F faces and P pins plus K indexed lookups.

The matching WASM grew from 1,486,223 to 1,488,688 bytes (+2,465). Ordinary native
harness executables grew from 1,785,872 to 1,786,688 bytes (+816). Neither file
size is a live-memory measurement. See [raw profiling counters](profile-candidate.jsonl).

## Measurements: useful gain plus an unresolved regression

The same [common harness](bench.rs) was compiled against the frozen baseline and
candidate, with Homebrew Rust/Cargo 1.99, release opt3/LTO/codegen1, serde enabled,
no sfcc-profile, and identical dependency versions from the frozen workspace
lock. The sources and binaries were frozen before measurement. All other agent
heavy jobs were stopped, with explicit coordinator timing windows.

The preliminary matrix used three alternating baseline/candidate pairs, one
warmup per scene per process, and one measured export. No observation was
removed. Native milliseconds and changes of medians:

| Control | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| Default half-3 box with checked flips | 48.777 | 48.192 | -1.20% |
| Positive clipped box | 11.090 | 11.171 | +0.73% |
| Coarse three-sheet obstruction | 17.436 | 17.352 | -0.48% |
| Fine three-sheet control | 147.398 | 149.144 | +1.18% |
| Large planar box | 258.785 | 245.038 | -5.31% |
| Sphere | 138.265 | 147.130 | +6.41% |
| Ordinary seam | 257.240 | 256.024 | -0.47% |
| Hidden sphere and box | 102.665 | 105.304 | +2.57% |
| Four duplicate spheres | 89.188 | 91.414 | +2.50% |
| Sixteen duplicate spheres | 238.405 | 241.628 | +1.35% |
| Small seam | 62.659 | 63.621 | +1.54% |
| Fifteen buried hard leaves | 184.156 | 183.893 | -0.14% |
| Sixteen-leaf hidden case | 213.804 | 213.491 | -0.15% |

Because the sphere appeared slower despite never constructing an index, the
coordinator authorized one bounded follow-up: five alternating pairs for sphere
and large box, same binaries and matched one-warmup policy. It confirmed:

| Follow-up | Baseline median | Candidate median | Change |
| --- | ---: | ---: | ---: |
| Sphere | 138.4055 | 142.0334 | +2.62% |
| Large box | 256.6893 | 242.6540 | -5.47% |

All five candidate box samples were faster, and all five candidate sphere
samples were slower. The reduction from the initial sphere estimate does not
erase the regression. Its cause has not been established; the zero index work
and unchanged geometric counters do not prove equal execution cost. No speed
claim is made for the browser or WASM. No 48-blob campaign was run; that remains
reserved for the fourth reviewer's common final gate.

All [preliminary observations](preliminary-timings.jsonl), [their summary](timing-summary.json),
[follow-up observations](followup-timings.jsonl), and [follow-up summary](followup-summary.json)
are retained. These are preliminary candidate measurements, not substitutes for
that final acceptance gate or significance claims from a large sample.

## Final frozen-source validation

- Default native library: **176 passed**, zero failures or ignored tests.
- Serde/profile native library: **198 passed**. Integration tests: cancellation
  2, coverage obstruction 6, diagnosis 11, discovery 6, pruning parity 3,
  numerical exclusion 13, transforms 3, worker partitions 9: **53 passed**.
- Matching actual WASM focused matrix: **23 passed**, no failure, cancellation
  or skip. Includes both fixture extensions, real Node worker 1/2/4/8 partitions,
  reversed completion, raw no-recovery controls and separate recovery.
- Cross-version actual WASM differential: **19 controls** have identical
  oriented triangles with all eight vertex field bits, feature interval bits,
  full non-timing stats/validation, tagged-leaf bytes and decision bytes.
  Includes transforms, opaque blend, quality edits, changed IDs/parameters and
  repeating an earlier box after other exports. [Raw results](wasm-differential.jsonl).
- Same-harness native differential: **13 scenes**, with exact JSON equality of
  canonical all-eight-field oriented geometry, feature intervals, validation,
  tagged leaves and complete first-decision/split/round/unresolved traces.
  All **31 original profile counters are exactly unchanged**. The 26 full
  snapshot/trace files are retained under `/tmp/sfcc-step4-c-native-{baseline,candidate}-snapshots`;
  [the manifest](native-differential.json) records their hashes.

Positive sphere 2,763 cells/6,776 triangles and clipped box 132/656 still succeed;
the half-3 box remains 386/1,308 with transported certificates. Coarse three-sheet
output remains 106/700 with 72 unresolved cells, while fine output remains
4,372/11,608 with two components and zero unresolved cells. Quality-stage geometry
and honest coverage withdrawals match baseline. No newly solved reconstruction
problem is claimed.

The initial native run is retained as precursor evidence only: source editing
was still occurring while separate library/test targets compiled. The final
full matrix was rerun after the wrapper and test source froze. A first standalone
harness build resolved newer cached optional serde dependencies; those binaries
were excluded from all comparisons and rebuilt using the frozen workspace lock.
Artifact packaging initially hit Python 3.9's missing `tomllib`; the equivalent
lock-version check was rerun with standard-library parsing and passed. No runtime
test failure was hidden or assertion weakened.

## Reproduction and provenance

Final 62-file kernel/WASM/Cargo logical source digest:
`a8290c13e73928d5204a01649299cf491ffe25c6f12f20de47801a03de40a1e9`.
[The source manifest](source-manifest.json) defines its serialization and hashes.
Final WASM SHA-256:
`bfe49320eec15b5b14765e3eacd7cee0aa8a1f2e87df31f5b2df834f38c56071`.
It uses Rustup 1.96, wasm-pack 0.15, `+simd128`, release opt3/LTO/codegen1, and
exports version `0.1.0`, matching the unstamped Step 3 baseline package.

Final ordinary native harnesses are preserved in
`/tmp/sfcc-step4-c-artifacts/{baseline,candidate}/sfcc_cost_bench`:

- Baseline: `4994ea11f860ac9ac3681f887d3d66ac78d9c3df3dc9d615a1f27604eb64a107`.
- Candidate: `15456d9cccaae0bd9710a894be02f69efd23a32dbcfef9d670e6a4fe398e59a0`.

The separate `sfcc_cost_bench_profile` executables must not be used for timing.
The matching package is archived at `/tmp/sfcc-step4-c-artifacts/pkg`.
[The artifact manifest](manifest.json) records exact hashes and log provenance.

```sh
CARGO_TARGET_DIR=/tmp/sfcc-step4-c-native CARGO_BUILD_JOBS=1 RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --offline --release --jobs 1 --manifest-path gcad-wasm/Cargo.toml -p gcad-kernel --features serde,sfcc-profile --lib --test diagnosis_contract --test discovery_contract --test coverage_obstruction --test numerical_exclusion --test lever1_prune_parity --test scene_transforms --test worker_partition --test cancel -- --test-threads=1
CARGO_TARGET_DIR=/tmp/sfcc-step4-c-native CARGO_BUILD_JOBS=1 RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --offline --release --jobs 1 --manifest-path gcad-wasm/Cargo.toml -p gcad-kernel --lib
PATH="/Users/matt/.cargo/bin:/opt/homebrew/bin:$PATH" CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR=/tmp/sfcc-step4-c-wasm RUSTFLAGS='-C target-feature=+simd128' wasm-pack build gcad-wasm/wasm --target web --out-dir pkg -- --offline --jobs 1
/opt/homebrew/bin/node --import tsx --test --test-concurrency=1 gcad-wasm/fixtures/sfcc-coverage-obstruction_test.mjs gcad-wasm/fixtures/sfcc-discovery_test.mts gcad-wasm/fixtures/sfcc-numerical-exclusion_test.mts gcad-wasm/fixtures/sfcc-scene-transforms_test.mts gcad-wasm/fixtures/sfcc-quality_test.mts
/opt/homebrew/bin/node docs/research/sfcc-step4-c/compare-wasm.mjs /tmp/sfcc-step3-focused/pkg gcad-wasm/wasm/pkg
```

Standalone harness manifests and locks are included beside this report. Adjust
only their dependency and harness paths for a new frozen pair; use identical
settings for both and keep the lock versions fixed. The common harness's `fast`
filter excludes the 48-blob case. `SFCC_COST_SNAPSHOT_DIR` requests diagnostic
snapshots; omit it for ordinary release timing.

All owned build, test and benchmark processes have ended. Application-wide build,
full workspace/all-fixture gate, visual QA, actual WASM timing, allocator-byte
measurement and the reserved 48-blob campaign were not performed by this
competitor. The fourth reviewer/coordinator owns the applicable broader gate.
