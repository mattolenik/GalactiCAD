# Connection candidate C: source-coordinate query prototype, no attachment authority

Frozen source: `/tmp/sfcc-stage3-r3-c`. Parent is the rejected B runtime with its
local-equivalence checker (`/tmp/sfcc-stage3-r2-b`); flat patch baseline is the
common captured source `/tmp/sfcc-stage3-base`. Main runtime is untouched. Author
performed static inspection and rustfmt parsing only; root owns builds and all
geometry execution.

## Why this alternative exists

A variable-radius source curve may be continuous and regular, but the current
`FeatureCurve::point_at_checked` parameterization is an unconstrained min-norm
Newton projection of a chord seed. Its successful-query residual, conditioning
and maximum-displacement conditions do not imply parameter order. The actual
source test below constructs two existing successful outputs whose swap also
satisfies those pointwise postconditions; that is a counterexample to the
sufficiency of those premises, not a claim that the implementation actually
returns the swapped points.

Even the old seed expression `a*(1-t)+b*t` need not preserve order in binary64.
A deterministic arithmetic control supplied by root shows a one-ulp reversal for
represented descending endpoints and adjacent represented parameters. The control
is deliberately not labelled an observed reversal on the original knob trace.

## Implemented smallest query alternative

All new code is test-only, so production and experimental B queries remain unchanged.

- `newton.rs`: `project_to_carrier_pair_at_height_c` holds seed height bit-for-bit
  and solves the two carrier equations only in XZ. It checks the XZ determinant,
  finite inputs, residuals and the unchanged displacement bound; 24 iterations
  and eight backtracking steps stay bounded. Unsupported conditioning or failed
  progress returns `None`, including when the full 3D pair rank is good but XZ
  rank is singular.
- `feature_curves.rs`: `height_pinned_seed_c` admits a recorded open traced
  interval only if all touched raw knot heights have the same nonzero direction.
  It uses fixed-difference rounded interpolation `a+(b-a)*fraction`, clamps to the
  endpoint interval and returns the exact right endpoint at fraction one.
  `height_pinned_point_c` calls the new constrained projector. `original_seed_c`
  exposes the existing seed for comparison in tests only.
- `trim.rs`: an optional scoped test observer copies the one actual incoming raw
  curve by original native occurrence/local side, compound adjacency and the
  frozen lower-junction witness. It does not alter trimming or authority.
- `connection_c.rs`: three new tests, listed below.

For a fixed finite knot pair, the subtraction is fixed and correctly rounded
multiplication/addition is monotone in the fraction, with direction set by the
endpoint difference. Clamping prevents endpoint overshoot. Exact knot joins and
one common direction extend this non-strict order across the admitted pieces.
Every successful constrained query retains that height bit-for-bit, so successful
outputs have non-strict height order by construction. Closely spaced parameters
may produce equal heights; strict ordering is intentionally not promised.

This argument assumes the normal Rust binary64 arithmetic semantics used by the
pinned diagnostic build, without fast-math reassociation. It is not a proof that
all queries succeed, nor a general scene SDF evaluator. The projector calls the
existing native carrier fields and introduces no new scene-reference evaluator.

## Actual-source and negative controls

`connection_c_actual_source_pinned_queries_have_order_without_attachment_authority`
compiles the full original knob, captures the same incoming native/compound raw
trace and derives its original first classification interval from the current
classifier. Source selection is bound to the native source occurrence; runtime
code has no model IDs or witness coordinates. The test:

1. Uses two actual existing checked points to demonstrate the insufficiency of
   pointwise residual/conditioning/displacement bounds for order.
2. Evaluates 33 bounded pinned and existing queries over the actual interval,
   records all coordinates, differences, domain observations and failures.
3. Requires pinned success for this finite campaign and exact preservation of
   seed-height bits, plus ordered successful heights. The receipt is written
   before assertions. These 33 results do not prove evaluator totality.

`connection_c_pinned_height_handles_rounding_plateaus_and_rejects_reversals`
checks ascending and descending adjacent-float knots, exact joins, expected
rounding plateaus, rejection of a height-reversing interval, admissibility of
its monotone subinterval, XZ singularity and zero-displacement refusal.

`connection_c_original_lerp_can_reverse_one_ulp_while_pinned_chart_does_not`
retains the concrete arithmetic reversal and checks the alternative's order.

Existing B controls and the actual original-source upper/lower test remain intact.
The latter should still fail its lower-junction preservation assertion; this
prototype performs no attachment and must not be selected as a complete repair.

## Integration implications and remaining proof

The smallest plausible later production integration is an internal source-certified
trace query mode, admitted only when an incoming-arc source certificate establishes
an appropriate monotone height chart. It must survive `remake_curve`, splitting,
endpoint substitution and closed-wrap handling, or those operations must explicitly
refuse unsupported cases. Current traced geometry stores no such mode; simply
calling this helper at a few test points would not change downstream query semantics.
A stored range or typed query contract must prevent use beyond the admitted source
interval. Any mode needs to be represented in source/provenance/fingerprint rules.

Before attachment, the analytic variable-radius branch still needs source/domain,
branch, generated-compound offset/max-side and destination-junction proofs, plus
numerical association of actual successful constrained queries. Changing the
projector changes checked geometry; fresh original-source, collateral and later
component receipts are required. All unsuccessful queries must remain explicit.
No nearest-corner fallback or old unconstrained projection may silently confer
endpoint authority when this stronger query contract fails.

## Root execution

Pinned Rust 1.99.0 diagnostic profile, offline/locked with `serde,sfcc-profile`,
fresh task-owned kernel cache and positive test discovery. Existing limits:
120-second build, 60-second focused campaign. Suggested filters:

1. `connection_c_` — three tests. Set `SFCC_CONNECTION_C_RECEIPT` to a new JSON path.
2. `exposure_b_controls_` — five retained controls.
3. `exposure_b_compiled_original_source_retains_required_continuation` — original
   regression, expected lower preservation failure. Set `SFCC_EXPOSURE_B_RECEIPT`.

No agent build or geometry run was performed. This prototype leaves connection,
attachment, full component, native/WASM transfer and production acceptance open.
