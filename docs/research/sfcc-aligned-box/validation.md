# Consensus validation ledger

Baseline: `04d889f911ba6c89981752df02cc2ad7a67ddc0f`.
Final runtime logical digest:
`c1b46cefea878af06f115311b5ca130564c35aa9e4b1c936575038a0c4adade3`.
The [source manifest](source-manifest.json) hashes 63 Rust/Cargo files and the
changed interface/fixtures separately. Matching focused WASM is archived at
`/tmp/sfcc-arrangement-consensus-artifacts/pkg`, SHA256
`549d0b8f20b11773845be6487602e496f287d3c5fc4e37b70ab2a39bc8b152a3`,
1,586,550 bytes. VERSION was unset (0.1.0). The coordinator's application build
sets its Git build stamp and is a distinct artifact.

## Final focused gates

All final gates below passed without ignored/skipped/cancelled tests:

- Native serde/profile: 209 library + 7 arrangement + 6 coverage + 11 diagnosis
  + 6 discovery tests = 239.
- Native default/no-feature: 178 library tests.
- Fresh matching actual WASM: 15 tests across arrangement, coverage, quality,
  and validation fixtures. Actual Node workers cover 1/2/4/8 groups and both
  completion orders on the coarse target, retaining oriented all-eight-field
  geometry, feature intervals and full validation, without serial recovery.
- Actual-worker positive cases additionally cover enclosed whole components,
  a cavity, a through hole, thin walls and separated non-f32-exact carrier
  planes. Six malformed wire cases reject: high-word manifest size, embedded
  leaf count, group, group count, invalid level, and invalid index.
- Native receiver mutations include bad payloads, duplicate partitions,
  malformed counts and indices. New cleanup checks reject altered original
  patches, an invented final-triangle patch, extra protection and extra
  memberships. Existing checked flip transport and quality stages remain.

The new runtime module's adversaries also cover zero-only sheets/edges/points,
nonmanifold edge/point contacts, f32 collapse, adjacent f64 events without a
represented midpoint, original duplicate paths, arithmetic/grid failures,
budget limits, and actual 2:1 interfaces. Cancellation and broader caller
coverage are additionally part of the coordinator workspace gate.

Native toolchain is Homebrew Rust 1.99; WASM uses Rustup Rust 1.96, release opt3,
LTO/codegen1, `+simd128`, and offline dependencies. Node is 26.11.1. Commands:

```sh
CARGO_TARGET_DIR=/tmp/sfcc-arrangement-consensus-native CARGO_BUILD_JOBS=1 \
RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --offline --release \
--manifest-path gcad-wasm/Cargo.toml -p gcad-kernel --features serde,sfcc-profile \
--lib --test box_arrangement_contract --test coverage_obstruction \
--test diagnosis_contract --test discovery_contract -- --test-threads=1

CARGO_TARGET_DIR=/tmp/sfcc-arrangement-consensus-native CARGO_BUILD_JOBS=1 \
RUSTC=/opt/homebrew/bin/rustc /opt/homebrew/bin/cargo test --offline --release \
--manifest-path gcad-wasm/Cargo.toml -p gcad-kernel --lib -- --test-threads=1

PATH=/Users/matt/.cargo/bin:/opt/homebrew/bin:$PATH CARGO_NET_OFFLINE=true \
CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR=/tmp/sfcc-arrangement-consensus-wasm \
RUSTFLAGS='-C target-feature=+simd128' wasm-pack build gcad-wasm/wasm --target web

SFCC_COVERAGE_B_DIR=/tmp/sfcc-arrangement-consensus-wasm-evidence \
/opt/homebrew/bin/node --import tsx --test --test-concurrency=1 \
gcad-wasm/fixtures/sfcc-box-arrangement_test.mjs \
gcad-wasm/fixtures/sfcc-coverage-obstruction_test.mjs \
gcad-wasm/fixtures/sfcc-quality_test.mts \
gcad-wasm/fixtures/sfcc-validation_test.mts
```

## Independent geometry evidence

[The exact Fraction oracle](facet_oracle.py) imports no mesher or scene evaluator.
It verifies containment in the twelve independently specified target rectangles,
orientation, exact per-face area and strict interior nonoverlap. A closed union
of finitely many triangles contained in a rectangle, with no overlap and its
full area, equals the rectangle: an omitted point would leave a nonempty
relative open neighborhood of positive area. Thus area is sufficient here only
in conjunction with those additional conditions.

Fresh final native and WASM outputs both pass: 848 triangles, twelve complete
facets, area 400, volume 288, and 46,848 same-facet triangle-pair checks. Nine
native operand-order/duplicate/grid-phase variants pass. The oracle itself
rejects omission, equal-area duplicate overlap and reversed winding. Results
are in [oracle-results.json](oracle-results.json); full final witnesses are
[coarse-native.json](coarse-native.json) and [coarse-wasm.json](coarse-wasm.json).
Index incidence, connected vertex links, and worker identity are checked
separately by the implementation/tests, not inferred from this geometric oracle.

## Wire and work costs

The original manifest has 106 leaves, 72 historical degenerate flags, and 5,144
bytes. Total arrangement partial bytes for 1/2/4/8 groups remain
193,922 / 203,204 / 219,788 / 251,736. These include repeated complete manifests
and per-cell snapshots; they are not geometry-buffer sizes alone. See
[wire-cost.json](wire-cost.json). Receiver and workers repeat bounded complete
target work. No speed improvement or small worst-case memory claim is made.

The final quiet comparison ran after all coordinator/consensus heavy jobs
exited. One matched warmup and five alternating samples per version/case
completed in 26.11 seconds under a 45-second hard deadline. Every repetition
checked ordered eight-field vertex bits, triangle indices, feature-interval
bits and validation against that version's reference; the three healthy
controls also match across versions exactly.

| Case | Baseline median ms | Final median ms | Change |
| --- | ---: | ---: | ---: |
| Ordinary half-3 box | 55.482 | 56.549 | +1.92% |
| 16 duplicate boxes | 2057.284 | 2063.719 | +0.31% |
| Clipped intersection | 14.034 | 14.371 | +2.40% |
| Coarse three-sheet reconstruction | 22.361 | 26.101 | +16.73% |

The last row measures deliberately changed behavior: 700→848 triangles,
1→2 components, 72→0 unresolved cells, incomplete→successful. It is not an
equal-output optimization comparison. These short local wall times establish
neither a general regression percentage nor a speed gain. Raw rows, artifact
hashes and sampling details are in [timings.jsonl](timings.jsonl) and
[timing-summary.json](timing-summary.json); [timing.mjs](timing.mjs) is the
bounded harness. Historical candidate B costs remain separately labeled.

Focused WASM grew from 1,486,762 to 1,586,550 bytes (+99,788 bytes). No claim
of reduced worker memory or wire size is made.

## Failed experiments and provenance limits

The first focused WASM run passed 14/15: the new inexact-plane fixture was a
healthy ordinary unit box, so it correctly retained `positiveBoxIntersection`
rather than entering the expected arrangement. Only the test geometry was
changed to the already-required enclosed-one-cell scale. The final runtime
artifact did not change; the repeated 15-test pass includes actual workers.
The failure is preserved in [frozen-wasm-tests.log](frozen-wasm-tests.log), and
the accepted run in [accepted-wasm-tests.log](accepted-wasm-tests.log).

Two earlier native development runs completed while source review was still in
progress. One log filename was accidentally reused before the precursor's last
test exited, leaving a NUL hole and interleaved tail. That log is excluded from
acceptance. The final `frozen-profile.log` and `frozen-default.log` use new
filenames after those processes exited; they contain no NUL bytes and correspond
to the frozen source. Archived executable hashes accompany those final logs.

Candidate A/B/C proofs, costs and manifests are predecessor evidence. In
particular B's exact-f32-plane restriction no longer describes the selected
runtime. The main consensus proof states the relaxed ordered-map result.
The abandoned C 256-duplicate campaign yielded no matched sample and is not
performance evidence; it was not repeated. Optional absent external native
TypeScript fixtures do not establish those missing comparisons.

All three byte-exact competitor patches and the selected runtime-only diff are
retained in [patch-manifest.json](patch-manifest.json). The selected diff applies
cleanly to the frozen baseline. This permits reconstructing alternatives after
their temporary checkouts disappear; archived patch/log whitespace is evidence,
not a source-format edit.

## Coordinator gate

The coordinator independently reviewed the construction, numerical argument,
cleanup lifecycle and worker callers, then completed every final gate:

- Full native workspace release: 381 passed, zero failures or ignored tests.
- Independent serde/profile rerun: 239 passed, zero failures or ignored tests.
- Application `make build`: passed, including WASM rebuild and TypeScript check.
- All actual WASM fixture files ending in both `_test.mts` and `_test.mjs`:
  39 passed, zero failures, skips or cancellations.
- Independent exact oracles: self-test adversaries, final native output,
  focused WASM output and fresh application-built WASM output all passed.

The [coordinator ledger](coordinator-validation.json) contains commands, exact
log hashes, source/interface/fixture checks and the separate application WASM
artifact. That artifact is 1,586,568 bytes, SHA256
`ca7ed3b99ef96812482ed814fdda652b98b4a69b5050f7c0ccb8dee4c5c759f5`,
with verified exported VERSION `v0.0.0-04d889f-dirty`. Its runtime source matches
the frozen logical digest above; the different VERSION explains why it is
recorded separately from the focused package.

The build skipped dependency/browser installation using `-o setup` because
dependencies were already available; no compile or type-validation stage was
skipped. All new text uses LF. Byte-exact archived patches/logs are excluded
from source/document whitespace checks. Manual visual QA remains unchanged,
and absent external native TypeScript fixtures remain untested comparisons.
No push was performed.
