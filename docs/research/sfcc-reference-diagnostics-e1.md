# E1: bounded GPU reference searches and diagnostic evidence

Status: bounded E1 implementation validated, October 24, 2026. Baseline: `f0e01bc`
(the execution plan), with mesher implementation `701997c` and the
[previous five-model report](../../.testresults/sdf-meshing/2026-10-24T08-17-05-970Z/report.md).
This package changes measurement, not SFCC construction or the model sources.
It does not repair the housing bore or establish general surface completeness.

## Contract and competing candidates

The fixed two-endpoint normal probe can cross two sheets while reporting equal
endpoint signs. Previously the rejected endpoints were discarded. E1 retains
the numerical evidence and searches a bounded set of smaller extents, while
keeping the original surface-discovery grid, 0.01 mm surface budget and 0.02 mm
feature budget. Field residuals and geometric distances remain separate.

Three agents implemented independent alternatives in isolated snapshots. The
coordinator ran their checker tests sequentially and acted as the fourth,
non-author consensus reviewer under the execution plan's thread-limit fallback.
All original handoffs, patches and source hashes are preserved under
`.testresults/sfcc-critical-repairs/e1-reference-diagnostics/`.

| Candidate | Approach | Checker evidence | Decision |
| --- | --- | --- | --- |
| A | Fifteen nested samples; refine all observed crossings; complete before/after refinement brackets and rejection evidence | 31 checker tests passed | Selected base: fullest attempt history with direct integration into existing receipts |
| B | Eleven samples; reject multiple crossings before refinement; exact sample identity/replay checks; directed crease-side update | 30 checker tests passed, then all nine final search tests passed | Adopt sample-identity and invalid/opposed-normal safeguards; defer the changed crease-seed strategy and extra replay module |
| C | Nine samples; separate distance witnesses from branch association; positive planar/wedge and multiple-crossing controls | 32 checker tests passed | Adopt distinguishing controls; its rejected refinement samples lack the complete active before/after brackets required here |

This is an evidence-based selection, not a union of patches. The integrated
candidate must pass its own tests and live captures; isolated candidate results
do not constitute validation of the combined implementation.

## Bounded search and interpretation

Keep the existing maximum normal extents: 0.04 mm for mesh samples and 0.03 mm
for crease samples. Sample the center and seven symmetric radii `R / 2^k`, for
`k = 0..6`. Between consecutive nonzero observations, retain every strict sign
change; zero observations are retained and never assigned an invented sign.
Each bracket receives at most 18 midpoint/quarter rounds and a final center
sample. The worst-case budget is `15 + 14 * (18*2 + 1) = 533` samples per line.
The existing four crease-update radii and three shrinking verification offsets
remain fixed. This is finite sampling, not root isolation: smaller hidden pairs,
tangencies and unsampled intervals can remain undiscovered.

Every normal search retains its target/direction, extent, sampled values and
normals, nested endpoint pairs, adjacent intervals, strict brackets, refinement
history, widths and rejection/stop reasons. Crease receipts also retain rejected
tangent-plane updates and field-agreement failures. Original same-sign discovery
grid segments remain unsearched; this package does not relabel them as excluded.

A strict bracket conditionally supports existence of a root of a continuous
field if the GPU signs are faithful. Any suitably close bracket can support an
existential displacement upper bound. Multiple observed crossings do not identify
which incident sheet a face belongs to. Centroid/crease normal association also
requires a sufficiently narrow bracket and a usable, consistently oriented root
normal. Such association remains empirical even with one observed crossing.
The float32 position allowance does not bound arbitrary WGSL arithmetic error.

Sampler count, finite values and returned coordinate identity must match the
requested float32 positions; malformed replies are harness errors. Signed zeros
represent the same geometric coordinate here; JSON transport is not claimed to
preserve their bit pattern. A zero or opposed normal cannot turn a usable
distance witness into a claimed incident-sheet normal. Unresolved associations
remain visible separately from missing distance witnesses.

## Validation gates

- Preserve the old closed-bracket omission counterexample and all four live
  corruptions: deleted junction, bridged passage, removed labels and flattened
  crease positions.
- Calibrate with positive planar and sharp-wedge controls, two crossings with
  equal endpoint signs, three crossings with opposite endpoint signs, rounded
  zero plateaus, tangencies, hidden separated sheets and float32 collapse.
  Synthetic samplers test the checker; they are not CPU scene references.
- Run the integrated harness tests and `make build`, then targeted GPU captures
  before the full five-model campaign. Record actual sampling overhead and
  receipt size; no performance improvement is claimed by E1.
- Compare raw vertex/index/feature buffers and original discovery-grid witnesses
  against the baseline. Apply the revised measurements to both retained meshes
  with the same source-pinned GPU evidence. A newly observed problem on identical
  geometry is an existing defect, not a mesher regression or a repaired surface.
- Keep the housing bore failure, prior empirical crease failure and unresolved
  reference obligations visible in the comparison. E1 completion means usable
  diagnostic evidence or a specific unresolved reason for attempted normal
  references; it does not require guessing a reference for every flange section.

## Results and retained limitations

The integrated candidate passed **38 harness tests** and `make build`. The
[targeted housing run](../../.testresults/sdf-meshing/2026-10-24T09-09-02-720Z/report.md)
preserved all three mesh buffers and the complete original discovery-grid
reference record. All three housing corruptions were detected. Integration
retained A's complete histories, added B-inspired reply/normal guards and C's
positive controls; it did not adopt B's alternative crease-update strategy.

The [final report with recorded recovery](../../.testresults/sdf-meshing/2026-10-24T09-14-43-401Z-postprocessing-recovery/report.md)
contains all five original cases. Every available vertex, index and feature
buffer is byte-identical to the milestone-5 baseline. Original bracket/housing
discovery-grid records are unchanged. The revised surface/crease checks and
corruptions were replayed on both baseline and captured meshes using the same
source-pinned GPU evidence; equal sample positions share the measured values,
without CPU field evaluation or interpolation. Receipts are
`final-bracket-replay.json` and `final-housing-replay.json` in the E1 evidence
directory.

| Observation | Before E1 | E1 result |
| --- | --- | --- |
| Bracket normal projections | 106 lacked usable brackets | 57 have no observed crossing; 49 reveal multiple crossings. All 106 still have unresolved normal association. |
| Housing flange mesh projections | 30 lacked usable brackets | 28 have no observed crossing; two reveal multiple crossings. All 30 still have unresolved normal association. |
| Housing flange crease references | Nine sections had a combined bracket/field-agreement failure | The retained 0.005 mm side probes show multiple observed sign-changing intervals; association remains ambiguous. Coarser 0.02/0.01 mm side probes resolve in the recorded sections. |
| Housing main bore | 92 surface witnesses fail; maximum 0.0132767 mm | Unchanged; 24 field-residual failures and 24 over-budget projection obligations remain. |
| Housing loft/chamfer crease | Section 5 fails the empirical centroid-normal check | Same failed section; the other eight sections pass their sampled checks. |
| Deliberate corruptions | Four detectable corruptions | All four remain detectable. |

Multiple sampled crossings are observations of the floating GPU field, not a
proof of multiple physical sheets. They now have endpoints, widths, normals
and refinement histories available for the next investigation. E1 does not
guess an association to close the flange exit.

The final capture measured approximately 2.89 seconds of bracket coverage work
and 12.95 seconds for housing, separate from export time. These are single-run
overheads, not benchmark conclusions. Complete JSON histories occupied about
131 MB in the first housing trial; unindented serialization preserves every
value and reduces the final housing receipt to about 44.2 MB. Bracket's receipt
is about 9.5 MB. No trace was truncated to achieve that reduction.

## Infrastructure recovery and provenance

The [original full run](../../.testresults/sdf-meshing/2026-10-24T09-14-43-401Z/report.md)
retains two failed image-comparison commands and a housing corruption-stage
`fetch failed` error. The completed coverage and mesh captures were preserved.
An attempted restore-only GPU recovery was correctly rejected by the source
guard: loading mesh bytes alone does not establish a matching built GPU scene.
The guard was not bypassed or weakened.

A [normal single-case housing retry](../../.testresults/sdf-meshing/2026-10-24T09-32-52-713Z/report.md)
completed successfully. Its source, all mesh bytes and complete coverage records
were verified equal to the original full run before its successful corruption
results were used in the derived report. The two image comparisons were retried
offline with the existing wrapper on retained PNGs. The derived report records
the recovery and keeps the original full-run export timings/images; it does not
claim the original harness invocation succeeded. All original errors and retry
results remain linked in `image-comparison-recovery.json`.

Runtime/source hashes remained unchanged through the final campaign and recovery.
The application build regenerated the version-stamped WASM package at `f0e01bc`;
Rust source was unchanged and final mesh identity was checked explicitly. The
final package SHA-256 is
`512f2321a3771c2065b8faf1e0e6336145ee99f6f5bf456d3332260b4f973626`.
Baseline/freeze manifests, candidate patches, test/build logs, replay tools and
recovery evidence live under
`.testresults/sfcc-critical-repairs/e1-reference-diagnostics/`.

E1's bounded diagnostic exit is met. Overall bracket, housing, knob and Mess 2
remain FAIL; Mess 1 retains its 180-second TIMEOUT. The next construction package
is E2, the demonstrated housing bore error. Universal reference discovery must
not block that bounded repair.
