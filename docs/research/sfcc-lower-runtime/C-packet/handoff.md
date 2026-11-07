# C: bounded inverse proposals under unchanged acceptance

Candidate: `/tmp/sfcc-inverse-c`, parent `/tmp/sfcc-lower-runtime-base`.
This agent ran static reads/edits and rustfmt only. Root owns all builds, tests,
field/geometry execution and component attempts. No execution result is claimed.

## Change and reach

Only two files differ from the common base:

- `gcad-wasm/kernel/src/sfcc/correlated_transport_a.rs`
- `gcad-wasm/kernel/src/sfcc/inverse_proposal_c_tests.rs` (new)

`Transport::map` callers in initial admission, required pins, typed-face root
checks, generated-point validation and post-graph edge checks all retain the same
common map implementation and downstream pair/sequence validation. No caller,
feature geometry, fixture, export option, reservation or source certificate changes.

After the existing unique height window is selected from actual checked knots,
the first two iterations may propose linear height interpolation. Inputs must be
finite, the target height strictly between endpoint heights, and the rounded
parameter strictly inside the current parameter interval. Otherwise the iteration
uses the existing midpoint proposal. After those first two iterations, every
proposal is the existing midpoint. Endpoint heights are updated only from actual
checked query results. These two attempts avoid unbounded regula-falsi stagnation.

Every proposal goes through the same `query()` method and outward 3D-distance
acceptance. Source/branch/container validation still occurs in `ConsumedPiece`.
A failed actual query propagates immediately; it is not suppressed by trying a
midpoint afterward. Invalid interpolation arithmetic alone can select midpoint
because no new geometry query has then been attempted. Matching height alone
never authorizes a correspondence. Existing checks of original point bits,
endpoint identities, pairwise separation, monotone event sequences, cancellation,
cache identity, memory and failure accounting remain intact.

The total iteration loop remains 64 (interpolation occupies its first slots),
request cap remains 64 new queries and total cap remains 16,384. No refund, new
correspondence cache, new acceptance tolerance or fallback publication exists.
`cost.inverse_iterations` counts every executed proposal as before. The two saved
bracket heights are stack scalars; no new retained cache storage is introduced.

A test-only scoped predecessor mode forces midpoint-only proposals through the
same code. It is thread-local and restores on nesting and panic; it is not a user
setting or export knob. Normal builds contain no mutable mode.

## Tests for root

Run `inverse_c_` (four tests) with `SFCC_INVERSE_C_RECEIPT` set, plus the three
`lower_c_` ledger/cap controls and retained source/admission/upper tests. A future
geometry-combined candidate needs its own complete validation.

1. Paired campaigns use the exact same compiled source, original knots and three
   interior parameters in every span of both selected charts. Both old and new
   mappings must pass complete/pair/source/3D checks and final sequence order.
   Every original query point and parameter must match bitwise. Mapped parameters
   may differ; each result is checked directly against its own original point
   under the unchanged allowance, and the old/new distance is recorded separately.
   The candidate must use fewer fresh consumes than the old campaign; no reduction
   has yet been measured. Receipt records every event and both cost summaries.
2. Arithmetic guards cover ascending/descending height brackets, degenerate and
   reversed parameter intervals, out-of-bracket/endpoint heights, nonfinite input,
   overflowing intermediates and adjacent floats. Ambiguous-window and midpoint
   stagnation refusals remain. Scoped predecessor mode restores after nested calls
   and panic.
3. Actual source-backed checks reject same-height forged events, off-branch
   retained points, repeated/reversed order, changed source and cancellation even
   when the origin is cached. Repeated identical maps add no query charge. Filling
   the real unchanged ledger via `reserve_external` causes TotalCap before the
   first uncached proposed query; no manually lowered cap is used.
4. An actual traced projector with zero displacement allowance fails through the
   real consume path, remains charged, and does not enter the cache. The unchanged
   request-cap controls in `lower_c_` exercise 64 real queries and the next refusal.

The paired result may reveal non-strict sequence transport or no measured query
benefit; either is a real rejection of this candidate. Do not weaken the existing
sequence or numerical gate to obtain a passing receipt.

## Limitations

The interpolation is a numerical proposal, not a proof of monotonicity or root
exclusion. Narrowing the bracket follows the existing heuristic height direction;
only a checked 3D match grants correspondence. This change can choose different
accepted numerical parameters and therefore needs downstream component validation.
It does not promise bit-identical mapped geometry, fewer queries for every source,
or that a total-cap failure disappears. At most two extra unsuccessful proposals
can consume budget that midpoint-only search would use differently; all refusal
limits remain unchanged. No full component, performance timing, native/WASM/GPU or
production result is claimed.
