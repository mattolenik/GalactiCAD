# Stage 3 revision 2 B: local source-alias premise, no accepted transport

**This is an insufficient repair candidate.** It retains first-round B's runtime
unchanged and adds a test-only source theorem/audit. It cannot restore `[10,31]`
without unproved endpoint authority. Keep the unchanged actual-source lower gate;
do not select this package as a construction repair.

## Implemented scope

Source: `/tmp/sfcc-stage3-r2-b`, based on first-round B.
Flat patch applies to immutable `/tmp/sfcc-stage3-base`.
Compared with first-round B, only `shared_twisted_proof.rs` and
`exposure_b_tests.rs` change; the new proof is `cfg(all(test, feature="serde"))`.
No runtime endpoint, curve, source membership, tolerance or guard changes.
No new dependency, evaluator, export option or fixture.

`attachment_zero_locus_b(native, field, lo, hi)` reuses existing checked
`round_twisted_source`, `twisted`, `source_restrictions`, `profile_branch` and
`lathe_lower` mathematics. It requires actual immutable source occurrence/path
binding, identity represented transforms for the native and competitor leaves,
strict extrusion-cap exclusion, an actual convex axis-aligned selected profile
edge, a fixed intrinsic branch sign, and strict inner-lathe separation above the
round-union radius. The existing subdivision cap remains 127 visited boxes.
Unsupported source, transform, arithmetic, branch or source restriction returns a
named refusal.

## Precisely what is proved

Write `e` for the selected native twisted-side equation, `E` for the finite
extrusion field, `L` for the inner lathe and `U=roundMin(L,E,r)`.
On every accepted box, the checked profile/cap restrictions imply
`E=0 iff e=0`; no other polygon edge or cap can supply an extrusion zero there.
The lathe restriction gives `L>r>0`. For the round-min formula this implies
`U=0 iff E=0`: when `E<r`, the positive part of `r-L` vanishes and the formula
reduces to `E`; when `E>=r`, the output stays positive.
Consequently `e=0 iff U=0` on the box.

The native occurrence is an actual child of the bound round operator in the
same immutable root. Its extra zero-surface ancestor restriction is redundant
under that equivalence; the ancestors above `U` are identical. This is a statement
about mathematical zero-surface domains, not bitwise equality of floating-point
queries or equality of tolerance-thickened `domain_contains` decisions.

Intersecting these equal zero loci with the **same** compound carrier `D=0`
preserves their equality. The audit requires the identical common stratum registry
slot on both native and retained alias curves. It never replaces the generated
compound's actual coefficient/offset with an idealized chamfer formula, and never
uses `offset/weight == source radius` as a premise.

This is only a conditional zero-set equivalence theorem. It can be vacuously true
when no zero exists in the box. It does **not** prove existence, a unique common
intersection, connectedness of that intersection, a junction, ordered parameter
transport or correspondence of whole curves. It does not assert whole-field
equality or general transformed-source support.

## Actual source audit and controls

The audit runs during the original full feature compilation checker. It locates
unwired native/compound endpoints near the previously declared lower witness;
actual source roles come from source occurrences. It builds a bounded box spanning
the numerical endpoint and the recorded old junction, expanded by the unchanged
`8*curve_eps`, then attempts the independent zero-set theorem. This box is an audit
domain, **not** a proof that the numerical trace connects those points.

For each attempted box the receipt records source identities, parameter/end,
point, box, distance, theorem outcome/refusal, visited source boxes, intrinsic sign
and every retained field/common endpoint at the lower junction. The theorem itself
contains no fixture IDs or witness coordinates. The audit is observational and
uses the existing test witness selector.

The new test requires an actual unresolved attachment observation, at least one
accepted local equivalence box with a retained alias endpoint, and rejection of:
wrong native carrier, reversed source orientation, a box crossing unsupported
profile/cap regions, reversed bounds and an equal-valued but separately compiled
immutable source tree. The positive result must be measured by root; it is not
asserted as already executed here.

The receipt declares the unresolved blockers explicitly: B discarded the ordered
raw parameter frontier and has no source-junction certificate. Therefore no
transport is performed. `attachmentTransportAuthorized:false` is the stated
implementation limitation, not a tested general impossibility theorem.

## Root execution contract

Author ran static source inspection and rustfmt only; **no build, test or geometry
execution**. Source is frozen; `manifest.json` hashes all 159 inputs and the flat
patch. Use pinned Rust 1.99.0, fresh kernel package cache, positive test discovery,
offline/locked, no LTO, codegen16, features `serde,sfcc-profile`.

1. `junction_b_` — one new test. Set `SFCC_JUNCTION_B_RECEIPT`.
2. `exposure_b_controls_` — five unchanged controls.
3. `exposure_b_compiled_original_source_retains_required_continuation` — unchanged
   upper/lower gates, extended diagnostic receipt. Set `SFCC_EXPOSURE_B_RECEIPT`.

Build cap120s; complete focused campaign60s. Final test is expected to retain the
known lower-junction failure because runtime is unchanged. Preserve its receipt;
passing the new conditional equivalence test does not override the failure.

## Why no attachment implementation

Equal local support sets do not establish that an unresolved raw endpoint reaches
a particular retained junction along the same connected arc. In addition, the
retained alias endpoint currently inherits legacy numerical triple refinement,
not an independently checked source-junction certificate. Copying its corner ID
would transfer unproved authority. The exact new premise may help a subsequent
variable-radius branch/junction proof, but does not replace it.

No full mesh/component, native/WASM parity, transformed suite or production gate
was checked. Runtime remains the previously rejected B candidate.
