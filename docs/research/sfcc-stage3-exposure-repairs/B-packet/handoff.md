# Stage 3 B: bounded numerical exposure and unresolved endpoint propagation

Source: `/tmp/sfcc-stage3-b`, based on immutable `/tmp/sfcc-stage3-base` (the restored executed Stage 1 source). Main runtime untouched. **Authored, not executed.** Root must build and run the controls and actual-source regression before treating any repair exit as passed.

## Runtime change and justification

The five fixed probe scales become a bounded adaptive descent from the unchanged `probe_delta`. A level is attempted only while the physical candidate displacement exceeds

`resolution = max(32*curve_eps, 32*EPSILON*max(1, |x|, |y|, |z|))`.

The first term is four times the existing `8*curve_eps` source-domain/projection band; the second avoids resolving sub-ULP coordinate changes. This is an explicit **numerical resolution policy**, not a certified geometric-distance or rounding-error theorem. It avoids a model-specific terminal distance or a tuned global probe factor. At most 64 levels and two signs per level are allowed; halving stops on the resolution floor, arithmetic stagnation or work exhaustion.

A positive probe retains the original own-domain, full-field residual and incident-normal tests, and additionally requires:

- finite projected displacement larger than the resolution floor;
- own normalized carrier residual within the existing `8*curve_eps` band;
- normalized residual from the opposite carrier larger than the resolution floor, so a collapsed projection onto the same intersection is not mistaken for a flank.

All field/normal/projection evaluations use existing native kernel APIs. No scene evaluator, tolerance widening, source-domain weakening, graph-degree change, endpoint nudge or duplicate-edge restoration is introduced.

Failure to find a positive probe is `Err(())` (unresolved), never `Ok(false)`. Early center residual/domain and coincident-normal checks retain their previous behavior; this patch does not claim to certify all legacy dead classifications. The public boolean `curve_point_alive` remains a positive-result convenience API whose false includes unresolved; the actual trimmer now consumes the complete tri-state result.

## Uncertainty reaches the output construction

Relabeling the flank result alone is insufficient, as C's executed counterfactual demonstrates. `TrimmedRun` now carries `unresolved_ends: [bool;2]`. The sampled trimmer preserves known-alive spans, marks an endpoint unresolved when its neighboring classification or bisection cannot decide, and increments existing `unresolved_trims`. A bisection encountering an unresolved midpoint retains its last known-alive point with an unresolved marker; it does not reinterpret that midpoint as dead.

The markers survive closed-wrap merging and interior splitting. Unresolved ends do not create/refine corner candidates and cannot be snapped to nearby candidates during remaking. Their output `corner_start/end` remains `-1`; no explicit corner incidence is fabricated. Resolved exact segment-exposure runs initialize both flags false. All changed callers are in `trim.rs` and `segment_exposure.rs`.

The marker is preserved during trim/wiring; after compilation it is represented by unwired feature ends and the existing unresolved-trim diagnostic. This is not a new complete per-interval uncertainty ledger. Whole-unknown intervals remain unrepresented and reported unresolved. No claim of complete feature discovery or reconstructed component follows.

## Actual-source regression and collateral gate

`exposure_b_compiled_original_source_retains_required_continuation` compiles the original full knob, without an octree or mesh. It selects the actual native, field and cylinder strata by source occurrence paths/local face identity, then searches the **compiled** physical/alias curves for a parameter piece covering the whole required height interval:

`[2.6910277686167188, 2.69107776861672]`.

It does not invent an extended curve or require old final curve IDs. The existing `HelixBranch`, `BranchCertificate` and `ConsumedPiece` checks bind the represented supporting source to the actual compiled carriers. Both endpoint-height crossings must be ordered, own-query valid and numerically exposed. Additional own-query controls cover each retained piece. The existing Stage 2 continuous full-ancestor proof supplies the ideal-source obligation; this numerical candidate does not replace that proof or establish every possible future Newton query.

The receipt includes baseline-to-candidate curves/corners/unresolved-trims/unwired-ends and the source families whose indexing geometry, parameter ranges or wired-end presence change. Baseline provenance is recorded in a fixture derived from the archived Stage 1 curves and root's executed Stage 3 C baseline counterfactual receipt (29 unresolved trims).

The lower physical junction formerly called corner 26 is a separate material gate. It must remain within the unchanged merge tolerance and retain every original incident source-pair membership, although corner/curve IDs may renumber. The receipt is written before this assertion. Unknown-end propagation may withdraw a previously legitimate triple refinement there; if it does, **B must fail selection even if the upper continuation passes**. No speculative forced snap is added to hide that risk.

`baseline-regression.patch` adds only this actual-source regression and its fixture to the immutable baseline, so root can execute a genuine old-fails/new-passes comparison. The baseline should fail the compiled-coverage assertion; root must observe that result rather than assume it.

## Authored controls

The `exposure_b_controls_` filter selects five tests:

1. zero search budget and sub-resolution thin strips remain unknown; an ordinary resolved box flank succeeds; a redundant mean-plane carrier cannot become alive merely because it is unresolved;
2. unresolved bisection does not become a resolved transition;
3. a rotated tapered-profile extrusion gives a known-alive prefix and an unresolved narrow end; a nearby existing genuine tip cannot snap that unknown end into a fabricated resolved interval;
4. a true vanishing-angle terminal from a hard sphere intersection inside an outer round-sphere intersection is not promoted; the two lifted branch normals agree at its terminal point;
5. hidden/capped extensions and coincident carriers are not promoted; zero-direction conditioning is unresolved.

The primitive controls supplement, not replace, the original transformed knob regression. The source certificate used by the regression also rejects mismatched source-pair labels. No author execution has established these assertions yet.

## Root validation request

Use pinned Rust 1.99.0, offline/locked, no-LTO/codegen16 diagnostic profile. Build kernel lib tests once under 120 seconds with `--features serde,sfcc-profile --lib --no-run`. Run `exposure_b_controls_` first, then `exposure_b_compiled_original_source_retains_required_continuation`, serially within the 60-second focused campaign. Set a fresh `SFCC_EXPOSURE_B_RECEIPT` for the actual-source test. Its preliminary receipt is written before source-piece checks and final assertions to preserve failures.

The baseline regression uses the same original-source filter and a fresh receipt path, after applying only `baseline-regression.patch` in a distinct restored baseline copy. Do not run the old fingerprint-pinned correlated/full-private tests as if source compilation were unchanged: any successful repair changes the feature set and invalidates those identities. Stage 4 must rebind and revalidate its component obligations.

No build, Rust test, source feature compilation, SDF query, private reconstruction, full export, GPU job or browser was executed by the author. Rustfmt parsing and static caller/literal checks only. Larger probe work, altered unknown boundaries, possible lower-junction loss and other source-family changes are material risks to review. The later outer-round handoff and intermediate-chamfer issue remain separate; this candidate does not repair them.
