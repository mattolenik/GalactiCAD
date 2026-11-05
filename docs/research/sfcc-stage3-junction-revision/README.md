# SFCC stage 3: junction evidence and connection provenance

This revision establishes two bounded mathematical premises and diagnoses the
remaining attachment failure. **It does not restore the missing attachment or
close Stage 3.** Production meshing remains unchanged. The experimental source
patches are based on the same captured Stage 1 baseline as the
[previous repair round](../sfcc-stage3-exposure-repairs/README.md).

Three independent agents implemented competing revisions; root built and tested
them serially, then a fourth agent reviewed their mathematical and measured
claims. [Consensus decision](decision.md) · [Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## What this revision establishes

### A: a genuine source junction location

A derives the lower junction from the actual immutable source occurrences and
represented coefficients. The cylinder and selected twisted profile side define
a fixed-sign helix. Its intersection with a groove-offset boundary is reduced to
an affine equation in height. The checker proves the groove profile is closed and
strictly convex, the selected closest point lies inside its edge, all competing
edges are strictly farther away, and the other ancestors are inactive.

For the original knob, the source junction height is enclosed by
`[-2.4920380357250713, -2.492038035725067]` mm. The old numerical corner is within
`1.9033e-13` mm of the ideal source point. The axial derivative magnitude is at
least `0.83205`, the transverse determinant magnitude at least `14.51068`, and
the closest-edge distance margin is approximately `1` mm.

These bounds establish an isolated regular **source location**, not the entire
incident feature arrangement or a connection from any traced endpoint. The
generated chamfer carrier stores rounded affine coefficients; its exact zero set
is not silently equated with the ideal source chamfer equation.

A also retains per-end raw parameter provenance and makes work exhaustion and
stagnation explicitly unresolved. No new code grants corner authority.
The final correction retains initial and final brackets separately, including
their inactive/unknown statuses. Bidirectional and closed-wrap controls check that
the original raw frames survive. A historical uncertainty reason is not a claim
that the current other bound is unknown or contains a source transition.

### B: local equality of two source-labelled zero sets

B proves the native twisted side and its parent round-union field have the same
zero set in one bounded box containing the missing compiled endpoint and old
junction. It checks the actual immutable occurrences, selected profile branch,
inactive lathe competitor and supported frames. Intersecting each with the
**same compound carrier** therefore preserves this local set equality.

The actual test passes for the missing `[31,10]` representation and retained
`[31,30]` representation. Their source IDs describe this fixture; the proof uses
source bindings, not numeric labels as authority. The endpoint is approximately
`1.20085e-5` mm from the old corner.

This is a conditional zero-set/domain equivalence. It may be vacuous; it proves
neither that an intersection exists nor that the represented interval is connected,
ordered, exposed along its entire length, or attached to a justified endpoint.
There is no membership transport in this revision.

### C: why the final bisection bracket is the wrong connection container

C observes the original full-source compilation with B's runtime, without changing
its public geometry. The missing incoming representation is raw curve 235 with
source pair `[31,10]`. Its original trace starts at parameter `0`, only
`2.61147e-9` mm from the old junction. Trimming starts with the classification
bracket `[0.24267782426778242, 0]`, then stops on an unknown midpoint with the
final bracket `[0.015167364016736401, 0.007583682008368201]`.

**The final bracket excludes the junction at the original trace start.** It bounds
a numerical positive-to-unknown cutoff, not a proved source transition. A resolver
restricted to that final bracket would search the wrong interval. The corrected
provenance must preserve the original search interval separately, with explicit
initial and final classification status. Neither interval is itself proof of
geometric connectivity.

At the failed midpoint, both carrier-point domain tests pass and the normal gap
is approximately `0.117517`. The native side's flank search succeeds. The compound
flank reaches the numerical resolution floor after 26 source-domain rejections,
7 insufficient-separation rejections and 1 normal-disagreement rejection. This
locates the failure in finite flank probing; it does not prove every rejected
probe should have been accepted.

The retained alias is not an independent endpoint certificate either. Its raw
curve 302 projects the old junction to its clamped start with a gap of
`1.46364e-4` mm. Its legacy snapped endpoint cannot supply a proved raw parameter
correspondence merely because the final corner coordinates match.

## Acceptance boundary

Both runtime candidates still retain the required upper interval and fail the
unchanged lower-junction preservation assertion. A loses `[10,31]`, `[15,31]`
and `[30,31]`; B loses `[10,31]`. C retains B's behavior. The old corner position
is unchanged. Passing the new premise checks is not passing the repair gate.

The original C diagnostic had two build defects, then exceeded the 512 KiB
capture limit. Those failures are preserved. Its revised encoding retains every
query and probe attempt, with lossless expansion checks under the same limit.
No capture limit, geometric tolerance or preservation assertion was relaxed.

## Executed validation and artifacts

| Frozen revision | Build | Focused campaign | Passing controls | Original-source preservation |
| --- | ---: | ---: | ---: | --- |
| A, corrected frontier provenance | 13.834 s | 4.681 s | 8 | **FAIL** |
| B, local source equivalence | 14.330 s | 2.114 s | 6 | **FAIL** |
| C, compact causal observation | 15.772 s | 2.155 s | 7 | **FAIL**, unchanged B runtime |

The control counts include retained controls and overlap between candidates;
they are not counts of independent reconstruction successes. Each final campaign
includes its failing original-source test. These are diagnostic timings, not mesh
performance measurements.

Root used pinned Rust 1.99.0, offline/locked, with the no-LTO/codegen16 diagnostic
profile. Each build cleaned only the task-owned kernel cache and required nonzero
test discovery. Build/focused limits remained 120/60 seconds. No job timed out.
All source hashes were checked after execution; each archived flat patch was
applied independently to the common baseline and reproduced every executed input.

The final C capture is **438,866 bytes**, retaining 165 queries and 1,009 probe
attempts. Its in-run expansion check preserves exact canonical JSON. Independent
comparison with the oversized earlier capture matches after removing only
process-local source pointer addresses. Observation-on/off compilation preserves
all compared public curve, corner and refinement values. A's frontier correction
also leaves both source-junction and compiled-geometry receipts exactly unchanged.

| Artifact | Purpose |
| --- | --- |
| [Summary](summary.json) | Separate validated premises and failed reconstruction verdicts |
| [Consensus decision](decision.md) | Fourth-agent source/evidence review and next connection contract |
| [A final patch and handoff](A-frontierfix-packet/handoff.md) | Source-junction checker and corrected interval provenance |
| [A junction receipt](A-frontierfix/junction-A.json) | Source-derived root enclosure, rank, separation and association bounds |
| [A compiled-source receipt](A-frontierfix/repair-A.json) | Preserved upper interval, failed lower memberships |
| [B patch and handoff](B-packet/handoff.md) | Conditional local zero-locus/domain equality |
| [B equivalence receipt](B/junction-B.json) | Actual local box and unchanged compound source |
| [B compiled-source receipt](B/repair-B.json) | Original gate remains failing |
| [C patch and handoff](C-compact-packet/handoff.md) | Bounded, observational causal diagnostic |
| [C compact receipt](C-compact/junction-C.json) | Complete causal observation under the existing size limit |
| [C expander](C-compact-packet/expand.py) | Losslessly restore named probe-attempt fields |
| [Restoration and preservation checks](preservation.json) | Patch/input hashes, unchanged receipts and compact evidence equivalence |
| [Execution runner](run.py) | Exact toolchain, budgets, cache cleanup and test discovery |

Each execution directory contains the manifest, binary hash, discovered test
names, logs and command receipts. Earlier `A`, `C`, `C-fixed` and `C-buildfix`
directories retain superseded source and unsuccessful execution evidence. Native
test binaries remain in the local `.testresults` experiment directory and are not
committed. Restore the captured Stage 1 source, then apply exactly one final flat
candidate patch; the frontier correction is already included in A's final patch.

## Next implementation boundary

1. Bind the missing native incoming arc to its original classification interval,
   raw endpoint and source occurrence. Retain the final numerical cutoff as a
   separate observation.
2. Prove the connection to the source junction. A candidate narrow route is the
   variable-radius twisted branch obtained from the actual groove offset line:
   the radius varies affinely with height, and the selected profile coordinate
   follows its fixed-sign square-root branch. Establish domain survival,
   regularity, ordering and numerical-to-source association over the whole needed
   interval. Unsupported or exhausted proofs remain unresolved.
3. Account for the generated compound's represented affine offset separately.
   Grant attachment or transfer source membership only after connection and
   destination authority are established; neither a nearby corner nor B's local
   equality is sufficient alone.
4. Run fresh compiled-source upper/lower checks and the negative controls. A
   successful synthesis requires new receipts. Only then consider Stage 4's full
   component obligations.

No complete component, current-HEAD transfer, native/WASM parity, GPU evaluation,
transform campaign or visual acceptance is established here. General multi-sheet
reconstruction and the later blend handoff remain open.
