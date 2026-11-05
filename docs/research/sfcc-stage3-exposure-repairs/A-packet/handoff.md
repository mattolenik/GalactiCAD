# Stage 3 A: source-positive exposure and uncertain endpoint authority

Frozen candidate: `/tmp/sfcc-stage3-a`, against the immutable restored Stage 1
source `/tmp/sfcc-stage3-base`. Main runtime is untouched. No build, test, feature
compilation, field evaluation, meshing or export has run by this author.

## Candidate and scope

This candidate repairs the **inference** from exhausted finite flank probes.
The old five-scale numerical search still supplies its positive results. Exhaustion
now remains `Err(())`, not `Ok(false)`. Before accepting that unresolved outcome,
the trimmer can obtain a narrow **positive source certificate**. It does not make
more flank probes, change the global probe factor, modify the degree guard, move
an endpoint or restore duplicate geometry.

The certificate dynamically finds a cylinder and native twisted-side / ordinary
round-union field in the actual strata. No model ID, source index, coordinate or
witness interval is hardcoded in runtime. It reuses the existing correlated helix
source checks, profile restrictions, lathe bound and outward arithmetic. The
certificate checks the original ordered ancestor class:

```
roundMax(max(chamferMax(max(roundMin(L,E),C),-G),-K),S)
```

with actual radii/coefficients. L/G are lathe operands, E/K extrusions, C a cylinder
and S a coaxial sphere. All frames must be the supported identity/coaxial frames;
this is not a general transformed-source certificate. Strict inactive-operand
margins make the root locally `max(E,C)`. The nonzero transverse determinant gives
an exposed regular crease in a height neighborhood sized from the existing
numerical association epsilon. The numerical point is separately bounded against
the ideal same-height helix point using the unchanged `curve_eps*8` allowance.

Actual immutable source occurrences remain bound by the pre-existing pointer/path
checks. A bounded structural comparison additionally binds their immutable root
copy to the **actual SfccTree root**, without a hash-collision assumption. This
comparison includes leaf shapes/signs/frames/positions/indices and operator
kind/mode/radius/exponent/ordered children; irrelevant leaf carrier caches are not
field semantics. It permits at most 64 source nodes, 256 strata, 128 extrusion
coordinates and 64 lathe edges. Failure returns no certificate, never absence.
The source class/shape bounds deliberately refuse unsupported inputs.

`BranchCertificate` now borrows a stratum slice so feature compilation can reuse
its checks without creating/cloning a fake `SfccFeatureSet`. Its old feature-set
entry point delegates to the slice entry point. `ConsumedPiece` keeps its own
feature-set borrow for numerical curve queries; the original mathematical checks
remain in place. The full original dependency assumptions remain necessary.

## Uncertainty through actual construction

Merely changing the reported status is insufficient. `TrimmedRun` now retains two
uncertain-end flags. Initial sample/bisection uncertainty is recorded in the
existing unresolved-trim count, and per-end flags survive wrap merging and
interior run splits. An uncertain truncation:

- does not add/refine a candidate as if it were a junction;
- cannot use a nearby existing candidate via `nearest_candidate`;
- cannot adjust its parameter span, replace its endpoint coordinate or acquire
  corner incidence through remaking;
- leaves the corresponding final `corner_start`/`corner_end` as -1.

Interior cuts made at pre-existing candidates retain their existing behavior;
only the original uncertain outer ends keep the flags. Dedup reconstructs incidence
from the final corner fields, so it cannot restore an unwired end. Other numerical
failures also lose unwarranted endpoint authority. This can materially change
collateral feature graphs and is **not** assumed harmless.

The public boolean `curve_point_alive` still means positive exposure only; false
includes uncertainty. The actual trimmer uses the tri-state result. Known early
negative conditions (off-surface, off-domain and coincident normals), the separate
hard-box interval trimmer, and numerical/source tolerances are unchanged.

## Actual compiled-graph regression

Filter `exposure_a_` selects three authored tests. Set fresh
`SFCC_EXPOSURE_A_RECEIPT` for the original-source test.

The main differential test uses a test-only legacy scope to restore the original
flank result and endpoint treatment, then compiles the exact original knob. It
requires fingerprint `9875508341830920921` before accepting the baseline. It then
runs the actual modified compiler and checks both physical and alias source pairs
on the positive height interval `[2.6910277686167188,2.69107776861672]`.

The test matches **candidate curves by source pair and fixed branch**, not candidate
curve/corner IDs. It requires a stored indexing piece spanning the interval, binds
its stored carrier identities, checks an own-parameter range and five actual own
queries, and proves the ideal source crease continuously across the whole height
interval. This is not a theorem that the floating curve evaluator is total at every
real parameter, nor a component triangulation proof; the receipt states those
limits. If no qualifying compiled span exists, the test fails. The old compiled
span must fail while both new source identities pass.

The same receipt reports curve/corner counts, unresolved trims and unwired ends
by source family before/after. It also checks the **original lower junction** by
geometry and incident source-pair membership under unchanged stratum extraction.
That gate is material: globally withholding uncertain endpoint authority may
unwire a real lower triple junction which this narrow certificate cannot prove.
The receipt is written before this gate. A failure is evidence that this candidate
is not a sufficient Stage 3 repair; do not force snapping or weaken the gate.

The other controls cover:

- wrong actual runtime root and a same-coefficient carrier from another root;
- nearby distinct points, coincident pair IDs and corrupted branch sign;
- capped extension, active outer-round region and a tangential radius/side case;
- zero numerical allowance and the stratum-work cap;
- an uncertain endpoint next to an already existing candidate: it must not even
  consult that candidate for snapping authority.

Unsupported actual terminal creases are not promoted to certified alive. The
symbolic genuine-terminal counterexample remains valid; this candidate does not
implement a general vanishing-angle terminal recognizer. The stored raw-trace
endpoints that were not produced by an uncertain trim keep historical behavior;
this patch does not claim to solve every numerical trace-stop provenance problem.

## Root execution

Use pinned `/opt/homebrew/Cellar/rust/1.99.0_1/bin/{cargo,rustc}` with the existing
no-LTO/codegen16 diagnostic profile. Build kernel lib tests under 120 seconds,
`--offline --locked --release --features serde,sfcc-profile --lib --no-run`.
Run `exposure_a_ --nocapture --test-threads=1` within 60 seconds. The main test does
two feature compilations; the negative test does one legacy feature compilation
and one small source-tree/stratum construction. There is no octree or mesh export.

Existing correlated full-fixture tests hardcode the old feature fingerprint and
curve endpoint inventory. A source repair invalidates those whole-fixture
expectations; do not change their constants to hide the distinction. Their math
checks need rebinding to the new inventory before any component integration.

Author validation was source/caller inspection and pinned rustfmt parsing only.
No execution results are claimed. The patch and manifest preserve every changed
input. Later outer-round handoff, generic transforms, source completeness,
full-component topology/contacts/f64-f32 geometry and native/WASM/GPU equivalence
remain unvalidated. Main runtime must not receive this candidate merely because
the local positive interval test passes.
