# Revision C: bounded lower-junction diagnostic, no unproved attachment repair

Frozen source: `/tmp/sfcc-stage3-r2-c`. Parent runtime is the rejected first-round B;
common patch baseline is `/tmp/sfcc-stage3-base`. No main source changed. No build,
test or geometry execution was performed by this agent. Root owns execution.

## Decision and scope

I do not propose accepting a new runtime repair without a source-bound connection
proof. The smallest useful independent alternative is a causal diagnostic that
locates B's remaining lower-junction loss in the actual raw curve parameter frame.
It neither transports memberships nor grants authority to unresolved endpoints.
The existing B full-source upper/lower regression and five controls remain unchanged.
Passing the diagnostic is **not** passing the repair gate.

The lower preserved corner is the fixture point encoded by
`c022b7c9d907b15a c003efb1a33e9e36 40158f2508500325`, near
`(-9.36,-2.49,+5.39)`, geometrically remote from the upper continuation witness.
The existing upper interval theorem cannot establish this separate junction by
itself. Source 31 remains the compound chamfer diagonal. The diagnostic captures
its actual affine terms, weights, offsets, immutable source paths and domain
identities, rather than inferring its meaning from the numeric label.

## Implementation

Three files are changed relative to B: `trim.rs`, `strata.rs`, and the new
`junction_revision_c.rs`. All observers and identity helpers are test-only.
Bisection's return values are unchanged; its return wrapper records the original
alive/other parameters, final alive/other frontier, orientation, unresolved flag
and stopping reason. On an unknown midpoint, the diagnostic frontier's other
bound is that actual unknown midpoint. It does not alter the returned last-positive
parameter or uncertainty flag. The underlying B public runtime is otherwise equal.

The scoped observer selects at most 16 actual raw curves from the five required
lower-junction source families whose projected distance to the preserved corner
is within the unchanged `4 * probe_delta` diagnostic window. These coordinates,
IDs and window select a test witness only; no runtime gate uses them. Native and
field occurrence paths are asserted against the original source.

For bounded near-junction classifier queries it records exact parameter/position,
first classifier stage, full and rounded residuals, source fields/domains, normal
separation, native/alias values and both flank searches. Flank diagnostics record
per-attempt projected location, displacement, own/opposite normalized residual,
source-domain membership, full residual, normal error and first rejecting
predicate. The diagnostic's mirrored numerical probe verdict is asserted equal to
the real `flank_survives` helper on each captured query. This is sampled numerical
evidence, **not** an interval proof, and does not assign geometric authority.

The capture also records raw source ranges/endpoints, projected old-corner
parameters, actual retained run ranges and unresolved-end flags. Final output
records the nearest retained compiled junction, its exact source incidence set and
its unchanged preservation verdict. Observation-on/off compilations compare all
explicit public curve/corner/refinement fields, fingerprint and unresolved count.
The capture is capped at 256 near-junction queries, 64 frontiers and 512 KiB of
serialized evidence. Exceeding a bound fails explicitly; nothing is silently
truncated. Scope cleanup is tested through an unwind.

## Root execution

Use the already pinned Rust 1.99.0 diagnostic build, clean the task-owned kernel
cache, and require nonzero test discovery. The existing 120-second build and
60-second focused campaign bounds apply. Run these filters in order:

1. `junction_revision_c_` — two new tests. Set `SFCC_JUNCTION_C_RECEIPT` to an
   output JSON path. The first performs two feature-only compilations of the
   complete original knob; the second checks scoped cleanup.
2. `exposure_b_controls_` — the unchanged five negative/authority controls.
3. `exposure_b_compiled_original_source_retains_required_continuation` — unchanged
   B gate, expected still to reject lower incidence. Set `SFCC_EXPOSURE_B_RECEIPT`
   separately. No claim of a passing repair may be based on step 1 or 2.

The root should read the actual frontier and probe results before deciding whether
A/B's junction resolver attacks the demonstrated cause. In particular distinguish
finite flank exhaustion from a domain rejection at the carrier point, normal
coincidence, source-trace endpoint clipping, and a field-evaluation discrepancy.
A pointwise native/alias agreement cannot authorize transport along an interval.

## Remaining obligation

C neither proves nor disproves local interval equivalence of sources 10 and 30 at
the lower junction. It does establish the information required to challenge such a
claim directly, without relying on the failing pair count alone. An accepted
resolver still requires actual source-domain validity, same-branch connection,
ordered interval transport if used, and justified destination endpoint authority.
The original preservation assertion is intentionally retained.

No whole component, native/WASM parity, GPU evaluation, transform campaign or
production acceptance is checked. B remains a rejected runtime candidate unless
new independent evidence and a fresh actual-source repair establish both exits.
