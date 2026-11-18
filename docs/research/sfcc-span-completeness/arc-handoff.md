# A: consumed curve-49 canonical arc and numerical associations

Selected source: `/tmp/sfcc-span49-a-reviewed`, based on immutable round37 `/tmp/sfcc-face-endpoint` (218 input manifest). The initial `/tmp/sfcc-span49-a` is also frozen for root's first execution. The reviewed version adds only exact recorded tolerance-bit binding and corresponding negative controls. No production source changed.

## Files and integration

- `gcad-wasm/kernel/src/sfcc/span49_a.rs`: new child module of feature49_a, reusing its private source binder, exact interval feature images and arithmetic.
- `gcad-wasm/kernel/src/sfcc/feature49_a.rs`: child-module declaration only.
- `gcad-wasm/kernel/fixtures/span49-consumed-a.json`: compact actual metadata copied from round37's saved complete receipt.

Hashes: `/tmp/sfcc-span49-a-changes.json`. B independently appends a child declaration to feature49_a; root should combine the small declaration blocks, not overwrite one with the other.

Focused filter: `span49_a_` (three tests). Receipt: `SFCC_SPAN49_A_RECEIPT`. Public diagnostic API: `feature49_a::span49_a::certify_consumed(f, saved, lat, chord, surface) -> Result<Value,String>`.

No builds, tests, numerical source probes or geometry evaluations were run by A. Only source inspection, metadata extraction and rustfmt parsing/formatting were performed. Root owns execution and must preserve any refusal before choosing corrections.

## Actual consumed input

The three recorded feature edges form the ordered parameter chain `1116 → 1117 → 40 → 647` (parameter increases, canonical world Z decreases). The fixture contains four exact point payloads/parameters, three original interval records, and all 15 recorded generated-query events in that consumed window: 13 unique parameters, with repeated parameter bits required to have identical point bits.

Point40 uses the same physical/generated feature-and-X-face roots as round37: face `[0,3464532,2]`, original curve49 parameter and key. Point1116 binds original outside Z-face `[2,3464534,2]`, global point4608/outside-local5 and its checked joined mapping. Point1117 uses its retained Z. Point647 must be curve49's actual t_max/end-corner13, with original corner key, position, curve incidence and source-stratum inventory.

Face keys, original ranges/strata, parameter bits and exact recorded tolerances are checked before numerical admission. Physical/generated root images must lie strictly in their bound face rectangles where applicable.

## Closed source arc, including corner647

On the admitted source family, `rho=R` and the positive groove distance equal to the physical chamfer radius determine a constant physical Y. A separate generated family uses the actual compound offset/weight ratio. The source binding reuses the existing signed/frame/primitive/clamp/source-occurrence checks.

The native selected side must have exact cardinal normal `(0,1)`. At the terminal, local `v=v0z` and `u=+sqrt(R²-v0z²)` give E=0 and rho=R by correlation; the native/cylinder/groove Jacobian is bounded away from zero. Rotation at the exact source-determined Y gives a negative-X, positive-Z endpoint. The original corner/query association must subsequently match this source event under the unchanged allowance.

The canonical arc is `Z=Z_terminal+s*(Z_outer-Z_terminal)`, `s∈[0,1]`, with `X=centerX-sqrt(R²-(Z-centerZ)²)` and fixed Y. Sixteen exact dyadic fraction intervals cover the CLOSED arc in each coefficient family. Every piece checks finite native profile, cap restrictions, finite other/groove meridians, oriented coefficient identity, other-lathe inactivity, negative native derivative in Z, cut-cap/outer-round inactivity and cylinder/groove transversality.

The native field equals zero at the correlated terminal and decreases strictly with Z throughout the complete cover. Therefore E<=0, including the terminal, without borrowing a strict inactive epsilon halo. With C=0 and the admitted groove level, this proves physical source exposure on the physical arc. Generated restrictions and carrier zero equations are recorded separately; generated ideal points are not claimed identical to the physical crease.

There are exactly 32 source subdomains total, below the unchanged global128 piece policy. Failure of any piece returns a precise source refusal rather than an accepted prefix.

## Numerical bridge and whole-edge error

A fresh original-source Transport is bound. Each of the 13 unique recorded parameters is charged BEFORE evaluation, must reproduce the original point bits, satisfy the original domain/residual contract, and remain in its original projection tube. It associates DIRECTLY to both physical and generated target images under `min(primary allowance,8*curve_eps)`. No tolerance chaining or limits change is used. Ordered parameter and strictly reversed canonical-Z enclosures are checked for all consumed events.

Each physical edge corresponds to the canonical arc between its two source-bound endpoints. The cylinder graph has `|X''(Z)|=R²/(R²-(Z-centerZ)²)^(3/2)`. Its interval upper bound times `(ΔZ)²/8` bounds the complete arc's departure from the ideal endpoint chord. Add the maximum actual-to-ideal endpoint displacement, then the maximum endpoint f32 displacement. The result must satisfy BOTH the recorded surface tolerance and the existing half-chord limit. Whole physical/generated span images also remain in the original projection tube.

This is a finite-event association and canonical arc/chord theorem. It does not assert continuity, totality or exact ideal parameterization of the raw Newton `point_at_checked` map between recorded queries, does not cover the complete original curve49 range, and does not establish a common extension into all adjacent 2D source maps. No vertices or metadata are edited.

## Controls and expected refusal handling

- Actual three-edge/source/query/whole-chord positive discriminator, with receipt written before success assertion.
- Strict parameter/canonical progression rejects duplicate, stationary and reversed order.
- Corrupted interval parameter, malformed edge, changed shared pin, wrong outer mapping, absent shared point and changed tolerances reject.

Potential first-run conservative failures include whole-piece finite-profile admission, target-image/source association or whole-span tube containment. Do not raise limits or delete endpoint closure to get a pass. Root should report the exact gate; the proposed Source proof is not executed evidence until then.

## Executed schema failure and frozen correction

Root built A-check and observed `Err("bits")` in the positive test; two controls passed. The vertex records use `positionBits`, while captured query records use `pointBits`. The initial shared parser wrongly read the vertex field for query events. The corrected `/tmp/sfcc-span49-a-fixed` accepts a three-word point payload, and each caller explicitly selects its own schema field. It does not silently accept alternate keys. This changes no source algebra, allowance or query policy. Hashes are in `/tmp/sfcc-span49-a-fixed-changes.json`. Root must rerun the positive discriminator; A performed no execution.
