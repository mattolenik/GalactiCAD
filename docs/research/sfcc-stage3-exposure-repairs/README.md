# SFCC stage 3: first repair round, no accepted candidate

Status: November 4, 2026. Three independent agents produced two runtime repair
candidates and a counterexample to an insufficient alternative. Root executed the
tests serially; a fourth agent reviewed the source and receipts.

**Neither runtime candidate meets the preservation contract.** Both retain the
previously lost upper continuation, but both lose required source incidence at
the existing lower junction. Stage 3 remains open. Main runtime is unchanged;
these patches are preserved as isolated experiments, not enabled meshing fixes.

[Fourth-agent decision and verified measurement addendum](decision.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md) ·
[Established cause](../sfcc-endpoint-lineage/README.md)

## Implemented candidates

**A: positive source evidence.** The existing finite search retains its positive
results; exhaustion becomes unresolved. A source-bound interval certificate can
then establish positive exposure for the supported cylinder/twisted-side source
family and its ordered ancestor class. It derives source roles and coefficients,
without runtime model IDs or witness coordinates. It reuses the existing correlated
branch/profile/lathe bounds and checks the actual root, strict ancestor inactivity,
regularity and numerical point association.

This is a restricted parametric certificate, not arbitrary transformed-CSG support.
It also carries uncertain ends through splitting/wrapping and blocks their corner
creation, nearest snapping, parameter/coordinate replacement and incidence wiring.
The old mathematical helper now borrows strata rather than cloning a fake feature
set. [A handoff](A-packet/handoff.md).

**B: bounded numerical exposure.** The global probe factor remains unchanged.
Adaptive descent stops at a declared numerical-resolution floor, stagnation or
work cap. Positive probes additionally require own-carrier residual and separation
from the other carrier. Search exhaustion stays unresolved. The same endpoint
provenance prevents an uncertain cutoff from becoming an ordinary corner through
later snapping/remaking. This is a numerical policy, not a universal exposure
proof. [B handoff](B-packet/handoff.md).

**C: rejected reporting-only alternative.** A test-only counterfactual changes
exhausted-search `Ok(false)` to `Err(())` while retaining the original consumers.
The explicit compiled curve/corner/refinement values remain exactly unchanged,
including the bad endpoint. Unresolved trims increase from 29 to 89. This proves
that reporting uncertainty without changing its downstream treatment is not a
continuation repair. [C argument and adversarial cases](C-packet/handoff.md).

## Actual compiled-source results

The primary case is the complete original twisted knob. The required upper
height interval remains `[2.6910277686167188, 2.69107776861672]` mm. Candidate
curve IDs may change; selection uses the actual source roles and branch.

| Gate / observation | Unchanged baseline | A, corrected measurement | B |
| --- | --- | --- | --- |
| Required upper source interval represented | No | Yes | Yes |
| Existing lower source incidence preserved | Yes | **No** | **No** |
| Missing lower source-pair memberships | None | `[10,31]`, `[15,31]`, `[30,31]` | `[10,31]` |
| Compiled curves | 81 | 80 | 76 |
| Compiled corners | 77 | 39 | 40 |
| Unwired curve ends | 2 | 92 | 77 |
| Unresolved trims | 29 | 89 | 83 |
| Decision | Demonstrated original failure | Reject | Reject |

The candidate lower corner is at exactly the original position. This is not a
renumbering or nearest-point tolerance discrepancy: its incident source-pair set
has changed. The new positive interval checks and the lower preservation gate are
separate; passing the former does not excuse failing the latter.

The missing source pairs must not automatically be interpreted as the same number
of distinct physical arcs. Source 31 is a generated compound chamfer diagonal;
source 30 can coincide with native source 10 where the inner union is inactive.
Thus some labels may describe equivalent local geometry. Neither candidate proves
the needed interval/domain equivalence or transfers the missing membership.
Discarding a failing label because another one is nearby would weaken the contract.

The result exposes a real distinction: **unresolved truncation must not be treated
as a junction, but a genuine junction must still be resolvable from adequate
evidence**. Blanket unwiring avoids one unjustified inference while withdrawing
other incident attachments. It is not sufficient reconstruction.

## Tests and corrected measurements

- The restored baseline passes its six retained correlated-source controls.
- The new actual-compiled-source regression applied to the unchanged baseline
  fails upper coverage and preserves the lower junction, as expected.
- B passes five adversarial controls, then its actual-source test passes upper
  coverage and fails the lower-junction gate. Controls include numerical/work
  limits, redundant/coincident/hidden/capped cases, a true vanishing-angle terminal
  and prevention of snapping an unresolved end to a nearby existing corner.
- A passes two source/endpoint controls. Its corrected actual-source test passes
  the intended upper physical/alias coverage, then fails the lower-junction gate.
  The reviewer also found a separate 40-iteration exhaustion path that does not
  mark uncertainty; it must be corrected before any later selection.
- C's two tests pass: unchanged geometry under uncertainty-only relabeling, and
  cleanup after an interrupted test scope.

A's initial test had two measurement defects. It selected an unrelated profile
side through parent field 30 using branch sign alone, and assumed increasing
parameter always meant increasing height. The corrected test binds the full
native/field/cylinder source triple and handles orientation. It selects physical
curve 20 and alias curve 40 for this candidate; curve 35 is a different profile
side, **not evidence of duplicated target geometry**. The correction changes only
tests. The independent lower-junction failure remains.

A separate syntax-only `json!` parentheses fix was needed before A's tests could
compile. Both the original compiler failure and the earlier measurement result
are preserved, rather than being presented as final-candidate results.

The first C invocation reused the baseline artifact in a shared Cargo target and
ran zero matching tests. That invocation is **invalid evidence**. Subsequent runs
clean only the task-owned kernel release cache before building and require positive
test discovery. The valid C-rebuilt run discovers and executes both tests. Source
hashes alone do not establish that a reused binary contains newly authored tests.

All builds used the pinned Rust 1.99.0 compiler, offline/locked, no-LTO/codegen16
diagnostic profile. Build and focused limits were 120 and 60 seconds respectively;
kernel-cache cleanup had a separate 30-second bound. No full mesh, octree, private
component, release-WASM geometry or GPU/browser campaign ran. Execution times in
receipts are not performance claims.

## Preserved artifacts

| Artifact | Purpose |
| --- | --- |
| [Summary](summary.json) | Separate target, preservation and acceptance verdicts |
| [A measured receipt](A-measured/repair-A.json) | Source-specific coverage, lower incidence and collateral families |
| [A measured patch](A-measured.patch) | Buildable reproduction including the syntax/test corrections; still rejected |
| [A source packet](A-packet/handoff.md) | Original frozen candidate and supported proof scope |
| [B receipt](B/repair-B.json) | Positive coverage, failed preservation and all changed source families |
| [B patch](B-packet/candidate.patch) | Frozen runtime candidate, still rejected |
| [Baseline regression receipt](B-baseline/repair-B.json) | Actual old-fails comparison using B's checker |
| [Baseline-only regression patch](B-packet/baseline-regression.patch) | Same checker on unchanged source |
| [C valid receipt](C-rebuilt/repair-C.json) | Reporting-only counterexample |
| [C packet](C-packet/handoff.md) | Test-only toggle, propagation audit and analytic adversaries |
| [Source restoration check](preservation.json) | Measured A patch reproduces all 158 executed input hashes |

Restore the [executed stage-1 source](../sfcc-graph-rejection-capture/README.md),
then apply one candidate patch in an isolated checkout. A's measured patch already
includes both corrections; do not apply them twice. Each executed directory has
its actual source/compiler manifest, binary hash, discovered tests, commands and
results. Author handoffs describe unexecuted proposals at their freeze; the root
receipts and fourth review determine what was actually validated.

## Required next revision

Keep the passing upper-continuation obligation, the lower-junction preservation
gate and all negative controls. The next repair must:

1. Retain the bounded source/parameter frontier responsible for an unresolved end,
   including its reason. A boolean alone is insufficient if resolution needs the
   discarded bracketing interval.
2. Resolve that end only with independent source-bound junction/attachment
   evidence, or certified transport of an equivalent source membership along a
   retained physical interval. A successful numerical triple solve or nearby
   existing corner is not a certificate by itself.
3. Preserve source identity, branch and parameter order. If an original membership
   is redundant or invalid, prove that from the full source instead of deleting
   the failed assertion.
4. Leave unsupported ends unresolved without restoring unconditional legacy
   snapping, forcing unknown to alive, widening tolerances or altering the mesh
   degree guard.
5. Repeat actual old/new compilation and all affected controls on a freshly frozen
   revision; correct A's work-limit handling as well if that route is retained.

No candidate is selected for stage 4. The later outer-round continuation,
intermediate-chamfer issue, complete component and native/WASM/GPU obligations
remain open. Current production meshing logic remains at `421f5a9`.
