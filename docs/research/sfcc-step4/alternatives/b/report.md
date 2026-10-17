# SFCC Step 4 B: exact repeat reuse inside discovery calls

Baseline: accepted Step 3, `f804044d8c960acea3b3f8735678eecffa31952d`. This candidate changes repeated arithmetic only. The numerical-exclusion and local-coverage claims remain exactly those of Steps 2 and 3. It does not add a completeness, embedding, distance, or termination theorem.

## Selected scope

Two one-entry, stack-local memo records retain the most recently successful supported primitive result:

1. The original-tree zero-owner traversal reuses the primitive's checked interval and discovery eligibility result over its one fixed cell region.
2. The primitive visibility loop reuses a fully completed corner/edge/face check and its eight corner-sign bits over its one fixed probe.

The key comparison includes the sphere/box variant, every radius/half-extent bit, signed orientation, scale, all three local-position and translation components, and all nine represented matrix coefficients. Signed zero, subnormals and distinct NaN payloads are not canonicalized. Leaf IDs, strata and signed ancestor paths are deliberately absent from the arithmetic identity because the reused calculations do not read them. Every actual leaf reference is still appended and traversed through its original min/max path; the root sign fold and candidate scratch remain unchanged.

A single entry avoids hash tables, per-export indexing, retained region keys and scene invalidation state. It helps runs of repeated primitives, including repeats separated only by an opaque subtree or an excluded ancestor. Alternating distinct supported primitives evict one another. This is a bounded tradeoff, not an arbitrary-duplicate lookup guarantee.

## Preservation argument

Let `A(L,q)` be the existing eligibility check followed by the existing outward interval computation. The result depends only on the fields compared by `same_discovery_primitive` and the query box `q`. Every successful memo hit has exactly the same argument bits as its stored computation. No arithmetic expression or rounding order is changed. The primitive result is therefore bit-identical, and successful eligibility remains valid. A failed eligibility/arithmetic check exits before storing any result, so malformed input cannot create a reusable entry.

The cell query box is immutable and constant throughout one recursive `collect_zero_owners` invocation. Its memo is created only after direct-entry region validation, passed by mutable reference through that invocation, and dropped on return. Opaque operators do not call this supported primitive cache recursively: their original validation and opaque result remain unchanged. An identical hard sibling may safely reuse an earlier hard sibling even when an intervening opaque node exists; no legacy interval is ever inserted in this cache.

Induction over the original tree gives the same interval endpoints, strict exclusion/truncation decisions, and ordered occurrence references. Every min/max node still executes in its original order. A reused primitive interval does not reuse an ancestor's exposure result.

The second memo is populated only after a primitive passes all eight strict corner checks, all requested same-sign edge exclusions, and all requested homogeneous-face exclusions. Equal primitive input bits and a fixed immutable probe imply the same query coordinates, identical intervals, corner signs, and branches. Any first rejection still executes at the same occurrence, since unsuccessful checks never populate the memo and later equivalent successes cannot reject. An actual leaf reference is appended even on a hit, preserving pointer-based root sign folding, signed paths, ties and owner diagnostics.

The guards read immutable references; Rust prevents mutation of those leaves or probes while a call is active. No memo survives a cell call, direct API call, export, nested recovery, cancellation, or worker boundary. Changed IDs, coefficients, signs, queries, transforms or scenes therefore require no external invalidation protocol. The existing standalone leaf interval API remains fully checked and uncached.

Serial, resumable and worker decisions all reach the same discovery guard. This patch changes no local certificate, cleanup, flip-transport capability, partial serialization, merge receiver, quality operation or export validation code. Identical guard results plus identical original occurrences leave those downstream operations unchanged; finite native/WASM comparisons check that integration claim.

## Work and storage

On a run of N exactly equal primitive occurrences, cell interval computations fall from N to one, while the visibility work falls from N completed checks to one. Traversal, candidate entries and root sign-walk remain O(N). A miss compares at most 20 floating fields plus a shape tag, independent of N. The cache does not change the existing O(N) pending-candidate allocation or O(tree depth) recursive traversal.

The cell memo holds one borrowed leaf and two f64 endpoints; the visibility memo holds one borrowed leaf and u8 signs. Neither allocates. They are used in consecutive phases, not as an export-lived cache. The recursive traversal passes one additional mutable reference per call. Exact compiler stack-frame sizes and process peak RSS were not measured; neither is inferred from source field sizes. Existing output, worker wire and persistent memory structures are unchanged.

Profiling counters 19/21/27/28 retain logical traversal/candidate/scratch/sign-fold semantics. Counters 20/22/23/24/30 now count actual arithmetic executions. The n=1/4/16/64/256 duplicate regression retains every logical and scratch assertion while requiring exactly one cell computation and eight point computations. The buried-256 control still traverses 260 nodes and retains the same exposed owner, but performs three cell computations instead of 258. No geometric assertion is removed.

## Evidence

The accompanying common harness is built identically against the frozen baseline and candidate. It separates ordinary release time from profiling and optional saved evidence. Saved comparisons include complete stride-eight f32 vertex bits and index buffers, exact f64 feature-interval bits, full validation, prepared tagged leaves, decision bytes and first-branch traces. Exact raw mesh equality is stronger than the required canonical oriented equality for these deterministic runs.

Results and source/artifact identities are recorded in the companion `sfcc-step4-b/` artifacts after all checks complete. Final controlled alternating measurements and the one expensive 48-blob campaign belong to the distinct consensus agent. No browser, GPU or WASM speed claim follows from native timing.

## Final candidate validation

All runtime edits preceded the final matrix and matching WASM rebuild. The candidate passed **199 profiling library tests and 53 integration tests**, comprising cancellation (2), coverage obstruction (6), diagnosis (11), discovery (6), pruning parity (3), numerical exclusion (13), transforms (3) and worker partitions (9). These are overlapping validation suites, not independent proofs. The initial 20-test discovery-only run preceded the additional key/lifetime tests and is not the final gate. No candidate test failed. Existing library tests whose external TS fixture files are absent do not establish those missing comparisons.

The candidate's rebuilt Rust 1.96/WASM package passed **23 focused fixtures**, with no failures, skips or cancellations. The fixtures include actual worker 1/2/4/8 partitions and reversed completion, raw no-recovery controls and separately asserted serial recovery. A separate cross-version comparison against the preserved Step 3 package passed **13 cases**: sphere, default planar box, genuine clipped-box seam, coarse/fine three-sheet objects, duplicates 4/16, alternating duplicates, 16 distinct primitives, opposite-sign shell, represented rotation, opaque-separated repeats and quality sphere. It compares complete raw mesh and feature-interval bytes, tagged leaves, decisions and full validation, not just triangle counts.

Native cross-version evidence covers **15 fast cases**, with all **90 saved files byte-identical**: six files per case contain mesh bits, feature bits, validation, tagged leaves, decisions, and non-mesh diagnostic events including first reasons. Every logical outcome and all profile counters except the five intended interval-computation counters are equal. The two duplicate controls preserve 2,763 leaves, 6,776 triangles, one component, zero unresolved cells and `ok=true` in both versions. The coarse three-sheet control remains 106 leaves / 700 triangles / 72 unresolved, and its geometry remains incomplete. The planar box retains its certificate transport and `ok=true`; quality sphere retains its honest certificate withdrawals.

| Structural workload | Discovery interval calls, baseline → candidate | Cell / completed-visibility cache hits |
| --- | --- | --- |
| Four identical spheres | 214,460 → 53,615 | 8,463 / 8,463 |
| Sixteen identical spheres | 857,840 → 53,615 | 42,315 / 42,315 |
| Alternating duplicate spheres | 831,504 → 804,722 | 0 / 1,393 |
| Sixteen distinct spheres | 858,544 → 858,544 | 0 / 0 |

Some alternating operands become adjacent after conservative owner removal; that explains visibility hits without cell-traversal hits. No occurrence is removed by the memo itself. Complete counters, traces, validation hashes and exact commands are retained in the companion artifacts.

## Preliminary quiet native measurements

The coordinator stopped all other agent builds/tests/benchmarks for this window. The same ordinary-release harness and Rust 1.99 toolchain ran three alternating baseline/candidate pairs, with one warmup per scene in each process, producing 90 raw rows. Profiling and evidence capture were disabled. This is preliminary evidence; the final consensus gate still requires its independent five-pair fast campaign and one three-sample-per-version 48-blob campaign.

| Workload | Median baseline → candidate (ms) | Median change | Individual paired changes |
| --- | --- | --- | --- |
| Four identical spheres | 91.222 → 66.573 | −27.02% | −28.01% to −24.30% |
| Sixteen identical spheres | 242.252 → 125.023 | −48.39% | −48.75% to −48.37% |
| Alternating duplicate spheres | 237.289 → 232.379 | −2.07% | −2.80% to −1.13% |
| Sixteen distinct spheres | 251.832 → 252.039 | +0.08% | −0.50% to +0.70% |
| Default planar-box flips | 48.438 → 48.974 | +1.11% | +0.42% to +4.67% |
| Genuine clipped-box seam | 11.310 → 11.589 | +2.46% | −0.01% to +2.97% |

Ordinary-case median changes range from −1.56% to +2.46%. Small-case paired variation ranges more widely (coarse three-sheet: −1.62% to +6.56%; small seam: −5.63% to +4.86%). The box-flip case increased in all three pairs, so these observations do **not** prove performance neutrality: the extra branch/equality checks are a plausible small real cost, while process/thermal variation also remains. The final consensus should resolve that tradeoff with its fixed five-pair protocol rather than select a new favorable threshold. The duplicate improvement is much larger than this observed variation and repeats in every pair.

The proposed acceptance is therefore this small bounded optimization, conditional on the final consensus campaign. No expanded persistent cache or broader primitive deduplication is justified by these measurements. Native timing does not establish a WASM speedup. The rebuilt WASM grew by 539 bytes (1,486,223 → 1,486,762); no additional heap allocation, worker payload or retained context is introduced. Exact stack-frame sizes and peak RSS were not measured.

All owned build, test, evidence and timing processes ended before handoff. The application build, broad workspace/all-WASM gate and expensive 48-blob comparison are reserved for consensus/coordinator; manual visual QA remains with the user.
