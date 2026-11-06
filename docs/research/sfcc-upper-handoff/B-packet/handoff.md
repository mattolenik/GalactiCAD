# Upper candidate B: preserve intermediate chamfer dominance

Frozen source `/tmp/sfcc-upper-b`; parent `/tmp/sfcc-stage4-c`; common patch baseline
`/tmp/sfcc-stage3-base`. No main source changed. Author read connected Rust code,
inspected callers, and ran rustfmt syntax formatting of the new test module only.
No builds, tests, geometry evaluations or exports were run by the author.

## Root cause and minimal runtime change

`branch_surfaces::sample_override` distinguishes a selected piecewise branch at
its target from the ancestors through which that branch is lifted. However, its
path-nonempty Chamfer case unconditionally returned the supporting diagonal:
`(a+b-r)/sqrt(2)` for union or `(a+b+r)/sqrt(2)` for intersection. The actual binary
chamfer field is the min/max of BOTH child values and that diagonal. Thus a child
may dominate while the override substitutes an unrelated diagonal value.

The correction routes this intervening ancestor through the existing `sample_blend`
with the overridden child and its selected partner, as other blend modes already
do. Binary nodes use their two operands; multioperand nodes retain the existing
fixed-partner selection and `override_valid` guards. The partner expansion budget
and all activity tests are unchanged.

An explicitly selected `FieldBranch::Chamfer` still returns its supporting diagonal
when the target path is empty. This is intentional: it is a particular support
branch, whose activity is checked separately. The patch does not turn an explicit
support branch into the full min/max field. Hard ancestors still use their existing
selected-child supporting extension plus activity checks. This is not a claim
that all such lifted fields are smooth globally or that branch enumeration is complete.

The only non-test runtime change is removing the forced intermediate-chamfer
return. A scoped test-only switch retains that exact old return for paired evidence.
There is no scene evaluator replacement, new dependency, tolerance change, endpoint
welding, synthetic corner, admission relaxation or ownership-band change.

## Actual original-source discriminator

The test binds the hard-Max source occurrence at path `[0,0,0]` under the outer
round intersection. Its two branch fields are `Child(0)` and `Child(1)` with the
actual ancestor partners `[1, usize::MAX, 1]`. Source identities discover their
stratum IDs; no runtime model IDs or coordinates select the fix.

A numerical witness at height 3 is constructed using the actual native extrusion
and cylinder coefficients and the existing full `root.f` evaluator. Bounded radial
bisection locates a point where the actual root vanishes and both hard operands
agree at a nonzero value. The test explicitly verifies that the actual parent
round-union agrees with the selected extrusion at THIS point. This finite numerical
witness is not a continuous source theorem; the independent source agent supplies
that separate investigation.

The test records legacy/corrected lifted values, gradients and activity, then
compiles the complete original source under each mode. It requires the legacy
fingerprint to match the selected Stage 3/4 parent. It checks that an actual compiled
curve with the correct lifted source pair has a successful own checked query near
the witness and passes both source domains. A `project` proposal or interpolation
fallback cannot alone count as recovery. The old compiled representation must not
have supplied that same checked outgoing witness. The receipt is written before
these positive/rejection assertions.

A read-only hook records the current upper raw physical/alias traces' stored
polylines, original/final parameter brackets, classification statuses and trimming
reasons before lower connection resolution. It adds no geometry queries and is
bounded to eight source-filtered raw records. It selects the original witness in
test code only. Complete source-family endpoint/range/count summaries are also
recorded for both compilations so collateral changes remain visible.

The complete admission result is observed in the receipt, but the actual unchanged
`stage4_c_complete_source_admission_gate` must be run separately. Correct outgoing
field semantics and one recovered point do not prove a complete upper handoff,
endpoint authority, continuous coverage, source completeness or component validity.
In particular the existing displaced-field native-band exclusion may still leave
an unrepresented transition; this candidate does not alter it.

## Controls and root execution

Use the pinned Rust 1.99.0 diagnostic profile, offline/locked, no-LTO/codegen16,
`serde,sfcc-profile`, fresh task-owned kernel cache and positive discovery. Existing
120-second build and 60-second focused budgets apply. Run in this order:

1. `upper_b_intermediate_chamfer_` (one test): both union/intersection signs and
   child/partner/diagonal dominance, with a concrete legacy mismatch.
2. `upper_b_explicit_chamfer_` (one test): explicit diagonal remains distinct and
   inactive when appropriate; legacy/capture scopes clean up after unwind.
3. `fixed_partner_keeps_its_formula_outside_its_guard` (existing multioperand
   partner/activity/identity control).
4. `upper_b_original_source_lifted_field_and_outgoing_curve_recover` (one test).
   Set `SFCC_UPPER_B_RECEIPT` to a fresh JSON path. Receipt cap remains 512 KiB.
5. `exposure_b_compiled_original_source_retains_required_continuation` (unchanged
   prior upper-window/lower-membership gate); set `SFCC_EXPOSURE_B_RECEIPT`.
6. `stage4_c_complete_source_admission_gate` (unchanged mandatory complete source
   admission); set `SFCC_STAGE4_SOURCE_C_RECEIPT`. A failure remains a failure.

The parent includes the prior lower connection controls if additional changes or
results require them. Do not sweep all similarly named tests into an unbounded run.
The root determines which controls fit the declared campaign and archives every
failed build/control/refusal. No author-side passing claim is made.

## Limits

This is an operator-composition correction with a full-model numerical discriminator,
not a source-complete handoff implementation. Source equations are bound at the
sampled witness; continuation over a nonzero-level interval, all branch switches,
correct endpoint joining and broader collateral preservation remain separate gates.
Neither this packet nor an outgoing trace alone closes Stage 4 or authorizes
production integration, full-model acceptance, native/WASM parity or visual claims.
