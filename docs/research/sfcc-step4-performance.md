# SFCC Step 4: reduce repeated discovery work

Status: the distinct fourth reviewer selected and integrated competitor B from
accepted Step 3 revision `f804044`. Final focused correctness checks and the
fixed five-pair fast / three-pair 48-sphere native campaign passed. Coordinator
broad acceptance and independent review also passed; all four planned stages
are complete.

The change reuses successful computations for exactly identical sphere/box
occurrences within one discovery call. It preserves every original owner and
signed ancestor path. On the final controlled native fast matrix, median export time fell by 26.10%
for four identical sphere operands and 49.24% for sixteen. This is ordinary exact memoization, not a new meshing construction,
coverage theorem, or proof that duplicate-heavy examples represent typical CAD
models. Native timings do not establish a WASM, browser or GPU speedup.

## Selection and review

Three isolated competitors completed before the distinct fourth began. The
fourth inspected their actual implementation and connected callers, checked the
arithmetic/lifetime arguments, and retained the smallest justified improvement.
The alternatives were not combined.

| Proposal | Independent evidence | Consensus decision |
| --- | --- | --- |
| A: immutable per-export primitive preparation | Preliminary sphere −2.95%, seam −4.49%, duplicates16 −6.66%; direct 100k-query cases −0.29% to +0.86%. Six runtime files, additional context plumbing and 3,712 heap bytes for sixteen prepared entries. | Credible constant-expression and borrow argument, but modest benefit did not justify selecting the larger change over B. |
| B: two call-local single-entry successful-result memos | Preliminary duplicates4 −27.02%, duplicates16 −48.39%; some ordinary medians rose, including half3 box +1.11% in all three preliminary pairs. No added heap allocation or persistent state. | Selected unchanged, then independently checked and measured under the fixed final protocol. Preliminary ordinary regressions remain in the record. |
| C: lazy exact face-pin parameter index | Initial large box −5.31%, sphere +6.41%; authorized five-pair follow-up on the same artifacts: large box −5.47%, sphere +2.62%, each direction repeated in all five pairs. | Exact conflict-fold and exclusive-borrow lifetime appeared sound, but the unexplained sphere regression and additional index were not justified for integration. |

The [alternative archive](sfcc-step4/alternatives/README.md) retains original
reports, raw observations, source/artifact manifests and reviewed runtime diffs.
C's negative measurements are not dismissed as noise merely because the sphere
path builds no index. A's original recovery timeout is retained alongside its
later same-artifact isolated pass and final 23-fixture pass; the environmental
cause was not proved and no timeout was relaxed. No gains from unselected
variants are added to B's results.

## Preserved contract

The [preservation argument](sfcc-step4/proof.md) follows the actual code:

- A key compares shape/dimensions, sign, position, scale, translation and every
  represented matrix coefficient by their binary64 bits. Advisory IDs and
  strata are intentionally absent because they do not affect this arithmetic.
- One memo shares a successful eligibility check and whole-cell interval during
  a single immutable fixed-region postorder walk. Every original leaf reference
  is still appended; original min/max order, ancestor truncation and first
  failure remain unchanged.
- A second memo shares only a **fully successful** primitive visibility check
  and its eight corner-sign bits for the same probe. Failed or uncertain checks
  return at the original branch and are never memoized. The original
  pointer-based signed-tree fold receives every original occurrence.
- Opaque subtree computations never enter these supported memos. Direct APIs
  remain checked. Neither memo survives the call, so mutation, new regions,
  independent workers, resumable exports, cancellation and nested recovery do
  not need an invalidation protocol.

No interval formula, floating operation order, tolerance, budget, default,
coverage rule, cleanup operation, worker payload or exported validation type
changed. The original-tree and complete-crease-membership corruption checks
remain. The coarse three-sheet example still has incomplete geometry and
reports its responsible regions unresolved. Quality edits still withdraw
untransported certificates. This milestone improves cost without claiming to
resolve those limitations.

## Claims and connected callers

| Claim | Basis and limit |
| --- | --- |
| Equal keys on the fixed query give the same eligibility and interval bits. | Local functional-dependence argument over the unchanged checked arithmetic; assumes the same arithmetic environment as the accepted Step 2 contract. |
| The memos preserve original paths, first rejection and final discovery decision. | Postorder/owner-loop induction in the preservation argument; failures retain the old visited prefix. |
| Tested native/WASM meshes, complete feature data and validation are unchanged. | Finite cross-version comparison plus inherited corruption/worker/recovery regressions; not exhaustive input coverage. |
| Duplicate native workloads improve repeatably. | Fixed matched five-pair campaign; input distribution, compiler, target and sample spread are explicit. No general or WASM speed theorem. |
| Broader meshing correctness is unchanged. | Identity-class local certificates and supported numerical bounds retain their prior scope; general clipped-component completeness, global termination, f32 embedding and Hausdorff guarantees remain open. |

The changed [owner traversal](../../gcad-wasm/kernel/src/sdf.rs) is the single
original-tree collector used by
[discovery checking](../../gcad-wasm/kernel/src/sfcc/refine_criteria.rs).
Its callers remain the shared pipeline decision, standalone feature-aware
octree decision and direct smooth-refinement entry. Worker preparation and
recovery reach that same pipeline decision; they do not own additional memo
state. [Profiling](../../gcad-wasm/kernel/src/sfcc/perf.rs) only clarifies the
executed-computation counter meanings. Numerical enclosure, feature/face/cell
construction, coverage, cleanup and receiver reverification have no source
changes in this milestone. This is the complete production integration surface.

## Final controlled native measurements

Both versions use the identical committed `sfcc_cost_bench.rs` harness, Rust
1.99 on aarch64 Apple Darwin, release opt-level 3, LTO, one codegen unit, `serde`
and **no** `sfcc-profile`. All other agent builds/tests/benchmarks had ended.
The coordinator explicitly held its heavy work. Scene construction and initial
stratum attachment precede the timer; the timed operation is the complete native
SFCC pipeline, not application scene build or browser rendering. Each fast pair alternates
baseline/candidate order, five samples per version, with one matched unmeasured
warmup per scene/process. All 17 declared fast scenes are retained below;
none was removed after observing its result. Separate profiled runs collect
work counts and phase timings and are not timing evidence.

| Scene | Median baseline → candidate (ms) | Median change | Individual paired changes |
| --- | --- | --- | --- |
| box | 257.173 → 255.867 | -0.51% | -1.18% to +0.88% |
| buried-15 | 182.769 → 182.541 | -0.12% | -1.14% to +0.48% |
| clipped-box | 11.065 → 11.043 | -0.20% | -1.17% to +2.48% |
| default-box-flips | 46.884 → 46.704 | -0.38% | -2.44% to +2.25% |
| duplicates-16 | 238.453 → 121.033 | -49.24% | -49.51% to -48.84% |
| duplicates-4 | 89.125 → 65.864 | -26.10% | -27.28% to -25.41% |
| hidden-box-sphere | 102.376 → 102.338 | -0.04% | -1.10% to +3.90% |
| many-hard-hidden-16 | 212.271 → 212.713 | +0.21% | -0.15% to +0.84% |
| nonadjacent-duplicates | 232.851 → 229.918 | -1.26% | -1.61% to -0.88% |
| opaque-separated-repeats | 81.015 → 72.808 | -10.13% | -11.58% to -9.77% |
| ordinary-seam | 254.072 → 255.265 | +0.47% | -0.19% to +0.84% |
| represented-rotation | 24.817 → 24.965 | +0.60% | -0.26% to +2.41% |
| small-seam | 63.054 → 61.834 | -1.94% | -2.29% to +3.76% |
| sphere | 138.040 → 137.527 | -0.37% | -1.58% to +0.14% |
| three-sheets-coarse | 17.416 → 17.492 | +0.43% | -1.78% to +1.65% |
| three-sheets-fine | 145.895 → 145.773 | -0.08% | -2.55% to +0.84% |
| unique-16 | 248.299 → 248.283 | -0.01% | -0.13% to +4.01% |

The final ordinary controls mostly move within mixed-sign paired variation;
this does not prove universal performance neutrality. The preliminary half3-box
slowdown did not repeat consistently: two final pairs rose, three fell. The
represented-rotation median is +0.60% while three of its five pairs fall; the
many-hard-hidden and ordinary-seam medians rise +0.21% and +0.47%. Those small
changes remain visible rather than being rounded into a blanket claim. Both
duplicate workloads improve in every final pair by margins far larger than
this variation. Alternating duplicate owners improve more modestly because
nonadjacent supported primitives usually evict one another. The opaque-separated
control reuses the two supported spheres surrounding an unchanged opaque
subtree; its gain is not a speedup of opaque blend evaluation.

The one expensive 48-sphere blend campaign used three alternating samples per
version and zero warmups for both. Median time was
**102.702 → 102.657 seconds
(-0.044%)**. Individual paired changes ranged from
-0.177% to +0.084%.
This is evidence of similar cost on this measured opaque workload, not a blend
speedup. All six samples retained **48,378 leaves, 130,590 triangles, 19
components and 22,142 unresolved cells, `ok=false`**. The complete mesh,
feature-interval and validation files are byte-identical across all six samples.
Those files were captured **after** each timed export without another export.
The [raw slow samples](sfcc-step4/48blob-timing.jsonl),
[complete timing summary](sfcc-step4/timing-summary.json), and
[exact output comparison](sfcc-step4/expensive-comparison.json) retain every
observation. This remains a cost workload, not a successful reconstruction
oracle; no failed geometry was reclassified to claim performance.

## Work and storage

| Scene | Executed discovery intervals, baseline → candidate | Whole-cell / completed-visibility hits |
| --- | --- | --- |
| Four identical spheres | 214,460 → 53,615 | 8,463 / 8,463 |
| Sixteen identical spheres | 857,840 → 53,615 | 42,315 / 42,315 |
| Alternating repeated spheres | 831,504 → 804,722 | 0 / 1,393 |
| Sixteen distinct spheres | 858,544 → 858,544 | 0 / 0 |
| Supported spheres around an opaque sibling | 107,230 → 53,615 | 2,821 / 2,821 |

Every other work counter and all structural outcomes matched the baseline in
all 17 scenes. Candidate/traversal/sign-fold work remains proportional to the
original occurrences; reduced arithmetic is not reduced ownership. Counter
20 and 22–24/30 describe executed computations. The n=1/4/16/64/256 tests retain
the original logical/scratch assertions and require the reduced computations.

Each memo holds one borrowed leaf and scalar result on the current call's
stack. There is no added heap allocation, retained capacity, scene/region map,
or cross-export state. Recursive traversal passes one extra mutable reference
per call; source-level constant memo size does not remove existing O(depth)
stack use. Exact compiler stack frames and process peak RSS were not measured.
Native normal harness bytes increased 1,747,008 → 1,747,104 (+96). Matching
VERSION-unset WASM increased 1,486,223 → 1,486,762 (+539). Worker wire format and
payload are unchanged. The much larger Step 3 proof payloads remain a separate
cost; this optimization does not compress them.

## Correctness and reproducibility

Final canonical source passed 199 profiling library tests and 53 integrations
covering cancellation, numerical exclusion, discovery, pruning parity, coverage
obstruction, transforms, diagnosis and worker partitions. Its rebuilt matching
WASM passed all 23 focused fixtures, including actual workers 1/2/4/8, reversed
completion, raw no-recovery and separate asserted serial recovery.

Independent final baseline/candidate comparisons passed:

- **17 native scenes / 102 byte-identical files:** full stride-eight vertex bits
  and indices, feature-interval bits, full validation, prepared leaf tags,
  decisions, and non-mesh first-reason/provenance records. This exact raw equality
  is stronger than oriented canonical equality for these deterministic cases.
- **13 actual WASM scenes:** complete geometry and feature-interval bytes,
  full validation, tags and decisions, including positive sphere/clipped box,
  ordinary planar-flip transport, coarse/fine sheets, duplicate/unique/signed
  operands, represented rotation, opaque-separated repeats and quality sphere.
- **17 separate profiling samples per version:** all counters except the five
  intended executed-interval counters match. Phase times are diagnostic and
  include observer overhead; they do not establish native timing gains.

The useful controls remain genuinely successful: the radius-9 sphere has
2,763 leaves / 6,776 triangles; the genuine clipped-box seam has 132 / 656;
the ordinary half-3 box retains its checked planar-flip transport and `ok=true`.
The coarse three-sheet object remains 106 leaves / 700 triangles /
72 unresolved cells. Those warnings are preserved, not converted into a
coverage success. Quality-sphere output geometry is unchanged with its honest
post-cleanup certificate withdrawals.

The selected runtime exactly matches competitor B's final digest
`93febff42ca87c770209b15e809d598ff11c72e4bb1221e4cede211388ae7c71`.
The final focused WASM digest is
`5f421ff32c8fbb006804d78ad71357a2f9180218d8a0462f09dd444c9cc72d79`;
it also exactly matches B's package. The common expanded final harness is
separately hashed. Native timing/profile executables and the matching package
are preserved under `/tmp/sfcc-step4-consensus-artifacts`; these temporary
binaries are backed by durable source/provenance, not committed build outputs.
The coordinator application build stamps its own git VERSION. Its separately
verified artifact exports `v0.0.0-f804044-dirty`, is 1,486,771 bytes, and has
SHA-256 `ebdc9d30900cf2fcc4a0294b47550f7cdfab59fc8fc8136a2ada88530a4d5492`.
The VERSION-unset focused package remains separately identified above.

See [manifest](sfcc-step4/manifest.json),
[focused validation](sfcc-step4/validation.json),
[native equality](sfcc-step4/native-comparison.json),
[WASM equality](sfcc-step4/wasm-comparison.json),
[work comparison](sfcc-step4/work-comparison.json), and the raw
[fast measurements](sfcc-step4/fast-timing.jsonl). The runnable
[measurement driver](sfcc-step4/measure.py) refuses to overwrite a campaign and
asserts equal structural outcomes, plus equal expensive-workload output hashes.

The final coordinator gate passed: application build, **364 native workspace
tests**, **36 WASM fixtures** from both extensions, and **199 profiling library
plus 23 integration tests**, with no failures, ignored tests or WASM skips.
All 62 runtime source hashes still match the frozen selected source. Commands,
log hashes and the app artifact are recorded in the
[coordinator validation record](sfcc-step4/coordinator-validation.json).
These repeated gates are not counted as independent test coverage. No visual
QA was performed. Native tests whose external TS binary-oracle fixtures
are absent do not establish those missing comparisons. Finite equivalence tests
support the local preservation argument; they are not a universal meshing
coverage, f32 embedding, termination or Hausdorff theorem.
