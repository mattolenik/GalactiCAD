# Stage 2 endpoint lineage: executed result review

**Accept the complete compact capture and the causal localization for this
witness. The first loss is in sampled exposure trimming: a finite set of failed
cylinder-flank domain probes becomes `Ok(false)`, and bisection turns that
classification boundary into the endpoint subsequently stored as corner 27.**
The raw trace already extends through the local source-required continuation.
Transition refinement retains the trim seed; candidate merging, remaking and
renumbering preserve its position. This is not a meshing repair or complete
component acceptance.

## Source, execution and representation checks

Selected source: `/tmp/sfcc-graph-lineage-b-compact`, packet manifest
`5dc7bc3246efee636c1f8edf91b9ade34af5c5505cfb7f6be7592f70584cb836`.
Evidence: `.testresults/sfcc-critical-repairs/e4-invalid-construction/round21-endpoint-lineage/compact/`.

I independently verified all 157 executed source/configuration hashes against the
root manifest and the actual test binary hash. The controls and feature-only
capture pass. Root records the build at 13.983 seconds, five controls at 0.303
seconds and capture at 1.980 seconds, within their declared bounds. These are
execution receipts, not timing benchmarks.

The capture contains 766 events and 347,817 encoded event bytes. Its complete
compact JSON is 356,778 bytes, below the unchanged 524,288-byte cap. Both
`complete` and `lineageJoinComplete` are true; `compiledOutputExactlyEqual` is
true and fingerprint `9875508341830920921` is preserved.

The earlier observation ended incomplete at its aggregate-byte cap. I independently
expanded all 32 source references in this new record, normalized process-local
source-root labels by sharing partition, and compared all 765 retained old events:
they are exactly equal to the new prefix. The additional final event supplies the
previously missing corner/curve result. No failed probe, source record or earlier
outcome was removed to obtain completeness. The prior syntax failure and incomplete
capture remain distinct preserved experiments.

I also compared final curves 20/33 and corner 27 directly with Stage 1: curve
ranges, all indexing-coordinate bits, source strata, endpoint IDs and the corner
position/incidence agree exactly. The off/on equality test covers public flags,
owners, end links, ranges, indexing values and stored segment/circle/traced geometry,
including traced refinement settings, as well as all corners. Source construction
and query order remain covered by the reviewed static diff; equality does not rely
on the fingerprint alone.

## Actual lineage

| Stage | Physical curve | Alias curve |
| --- | --- | --- |
| Raw-vector index / raw curve ID | 103 / 103 | 131 / 131 |
| Canonical and stored carrier IDs | 10/15 | 30/15 |
| Raw parameter range | 0..79 | 0..111 |
| Upper trimmed raw parameter | 65.72141966101242 | 97.23453855051577 |
| Pre-dedup curve ID | 20 | 39 |
| Final curve ID | 20 | 33 |
| Endpoint candidate | Creates 27 | Reuses 27 |
| Candidate-to-final-corner map | 27 → 27 | 27 → 27 |

The raw records identify the actual stored traced-carrier occurrences, separately
from canonical adjacency tags. Physical carrier 10 is the selected extrusion
occurrence `[0,0,0,0,1]`; carrier 15 is the cylinder `[0,0,0,1]`. Alias carrier 30
is the inner aggregate field `[0,0,0,0]`. Their captured domain/field roots share
the same process-local root label. The large leaf sentinel is losslessly encoded.
No raw/final ID or parameter equality was assumed.

Raw 103's indexing heights increase from approximately -8.999964 to 4.999832.
Knots 65/66 have heights 2.5434238994082565 and 2.7479446581630027, bracketing the
required local interval. Raw 131 also extends beyond the interval, but its full
indexing-height sequence is not monotone; its actual local status/query records,
not the global extrema alone, bind the relevant branch. These indexing facts are
not promoted into a continuous raw-parameter coverage theorem.

More decisively, actual raw-103 checked queries during bisection return points
beyond the final endpoint on the registered supporting pair inside the already
proved source-height neighborhood. The captured program therefore had that local
supporting continuation available before trimming.

## The executed cutoff predicate

The upper raw-103 bisection starts with alive parameter 65.65296803652969 and dead
parameter 65.83333333333333. It performs 14 midpoint classifications and stops
because the existing parameter-distance estimate falls below one quarter of the
corner-merge tolerance. It does not exhaust its 40-iteration cap.

Its final adjacent sides are:

| Side | Raw parameter bits | Height | Actual result |
| --- | --- | ---: | --- |
| Retained alive, sample 986 | `40506e2bbd5eaf58` | 2.6909777686167193 | `Ok(true)` |
| Rejected dead, sample 987 | `40506e2beb8b1ae3` | 2.6909800203269927 | `Ok(false)` |

Sample 987 reaches the flank tests, so the earlier finite/residual/carrier-domain/
normal-gap guards have passed. The selected extrusion-side flank succeeds.
For cylinder stratum 15, **all ten actual probes**—both signs at scales 1, 1/2,
1/4, 1/8 and 1/16—return `domain_rejected`. The cylinder flank returns `Ok(false)`
and the pair returns `Ok(false)`, not numerical uncertainty `Err(())`. The selected
trim reports zero unresolved trims.

Other actual bisection samples inside the proved neighborhood show the same
transition: e.g. height 2.6910273062355774 is rejected with all ten cylinder probes
failing domain checks, while height 2.690973265196079 is retained after the smallest
cylinder probe succeeds. These are actual compilation decisions, not the manually
extended test curve from the previous discriminator.

The accepted source proof establishes a regular exposed ideal crease across this
height interval and associates the stored numerical endpoint with it within the
unchanged tolerance. The raw checked-query implementation also enforces its
existing normalized carrier residual conditions. Taken together, these facts
identify premature *exposure classification and trimming* of the required local
crease. They do not assert that every recorded numerical point is an exact real
zero, or establish GPU/floating-evaluator parity.

The domain checks themselves are not demonstrated wrong: the attempted offset
points may correctly fall outside a surviving carrier patch. The demonstrated
logical failure is treating a finite set of unsuccessful flank probes as proof
that no sufficiently small exposed flank exists. This capture does not record
which internal ancestor rejects each cylinder probe, so do not attribute every
one specifically to the outer sphere without another justified analysis.

## Later stages preserve rather than create this endpoint

`refine_transition` receives the raw-103 last-alive point as its seed, searches
within the existing 0.4 mm maximum distance, accepts no triple candidate and
returns the seed unchanged. The record distinguishes that aggregate outcome from
a genuine source junction. Candidate insertion creates candidate 27 at exactly
those bits.

Raw 131's upper bisection has its analogous last-alive height
2.6909793801528004 and first-dead height 2.6909816223185627. It likewise retains
its seed after no accepted refinement candidate. Its nearby offered endpoint is
merged into the already existing candidate 27, keeping raw 103's position.
This is the recorded actual merge origin, not an inference from the carrier pair.

During remaking, candidate projection slightly adjusts the raw parameter limits:
raw 103's upper span changes from `40506e2bbd5eaf58` to `40506e2bbd4b869d`, and raw
131's from `40584f02adfb0774` to `40584f028ce80e6b`. The explicit endpoint override
still uses candidate 27's unchanged coordinates. Remaking resets each traced
parameter range to 0..31. Dedup keeps physical pre-ID 20 as final 20 and renumbers
alias pre-ID 39 to final 33. Corner compaction maps 27 to 27 and wires both ends.
The private alias removal later leaves the one physical incidence seen by the
exact Stage 1/2 graph replay.

Thus neither an already-short raw input, transition refinement, candidate merging,
parameter reindexing nor final dedup/compaction is the first demonstrated loss
for this local continuation. They carry the trim cutoff forward. This does not
prove global feature compilation completeness or exclude other defects elsewhere.

## Stage 3 repair contract

The causal localization part of stage 2 is now satisfied for this witness. Next,
use the planned three competing source-level repairs plus fourth review. Their
common contract is:

1. The actual original-source compiled feature graph must retain the certified
   positive-height continuation and consistent source/parameter incidence. A
   separately constructed supporting test curve alone is insufficient.
2. A finite flank search that finds no success must not invent geometric absence
   or an authoritative terminal corner when supported source evidence contradicts
   that conclusion. Use justified positive/source bounds or a bounded numerical
   strategy whose undecidable outcome remains explicitly unresolved.
3. Keep genuinely hidden/capped extensions, true vanishing-angle terminals,
   coincident aliases, nearby distinct curves, conditioning failures and exhausted
   budgets as negative controls. Merely decreasing the global probe factor or
   increasing search work until this one case passes is not the contract.
4. Do not restore a duplicate canonical edge, relax the degree guard, nudge the
   endpoint, accept the fallback fan or weaken source/geometry tolerances.
5. Passing this local source obligation is not component completion. The actual
   outer-round activation occurs later inside the failed cell, and continuation
   or a justified handoff through it remains necessary. The separately observed
   deeper-branch/chamfer representation gap must be addressed in its actual region,
   not silently combined with an unrelated local workaround.
6. Preserve the full component's boundary, interval/metadata transport, f64/f32
   geometry, links and internal/outside contacts, then current native/WASM and
   complete-model gates before production integration.

An honest unresolved result is safer reporting, but it is not a successfully
reconstructed component. Keep those exits distinct when selecting candidates.

I performed read-only source/hash review and integer-preserving analysis of saved
records; no new geometry evaluation, builds, tests or runtime edits. The first
loss is now localized for the witnessed endpoint. No repaired mesh or production
acceptance has been established.
