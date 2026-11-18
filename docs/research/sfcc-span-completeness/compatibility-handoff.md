# C: exact retained-height membership and integration obligations

Status: compile-ready isolated candidate at `/tmp/sfcc-spancomplete-c`. I performed static inspection and a rustfmt parser check only. Root must run the two `span_complete_c_` tests; no numerical result is claimed before execution.

## Files and integration

Three files differ from the 218-input round37 selected source:

- `gcad-wasm/kernel/src/sfcc/predicates.rs`: one test/serde-only exact dyadic meridian-level predicate, reusing the existing backend.
- `gcad-wasm/kernel/src/sfcc/exposure_a.rs`: `span_complete_c` child-module declaration.
- `gcad-wasm/kernel/src/sfcc/span_complete_c.rs`: controls and the actual source-bound discriminator.

Hashes are in `/tmp/sfcc-spancomplete-c-changes.json`. Other agents own their helpers; C changes no A/B implementation. Set `SFCC_SPAN_COMPLETE_C_RECEIPT` to retain the actual result. Filter `span_complete_c_` selects two tests.

## Exact predicate and source binding

For the actual finite exterior groove segment, put

- `dr = r1-r0`, `dy = y1-y0`;
- `wr = R-r0`, `wy = (Y-centerY)-y0`;
- `D = dy*wr-dr*wy`.

The predicate returns the exact sign of `D²-r²*(dr²+dy²)`. All represented inputs are converted individually to exact dyadics before subtraction or multiplication. No rounded intermediate product or difference supplies the sign. Level must be finite and positive, and the represented segment must be nondegenerate.

The test first rebuilds the original source, checks its fingerprint and actual original pin, calls the existing feature49 endpoint source binder and binds the same full CSG ancestry, positive physical chamfer radius, cylinder radius and identity-frame negative groove leaf. `meridian_bound` independently proves the actual finite exterior nearest segment at `(rho=R,Y=retainedY)`, with positive distance and positive finite-projection/nearest margins. Only after those premises are established does squared line-distance sign describe the actual positive groove distance relative to the physical feature level.

This is the physical level `r`, not the generated compound's `offset/weight`. The existing physical/generated distinction remains.

The control uses a 3-4-5 segment with exact distance3 and checks equality plus both adjacent binary64 Y values, translation, endpoint reversal and malformed inputs. The actual test writes its result before asserting the expected nonzero sign. A zero sign would refute this proposed nonidentity discriminator and must be retained honestly.

## Why this matters, and what it does not say

Every recorded vertex on the consumed three-edge chain has the same retained Y bits. The test derives that chain from original candidate memberships and the explicitly outside-local memberships through `outsideToJoined`. It independently derives the supplied disk's boundary from triangle incidence. Its feature nodes are40,647,1116,1117; outer feature nodes647 and1116 are fixed by the prior star transport. Point40 is interior and was moved by that prior correspondence, so it is explicitly excluded from the conclusion about fixed outer targets.

If the exact sign is nonzero, no point at cylinder radiusR and retainedY can satisfy the ideal physical groove level. The old source graph preserves Y, and the round37 star map fixes its outer boundary. Hence its fixed outer targets at647/1116 cannot already be exact ideal curve49 points. This is a concrete compatibility obligation when adopting A's ideal arc targets.

This does **not** establish a tolerance violation, a material displacement, mesh invalidity or failure of A's independent arc/chord approximation. The arithmetic sign gives no distance magnitude. The earlier numerical association may remain excellent. A new ideal-arc correspondence can be valid if the required outer-boundary transport is supplied and checked; it cannot silently inherit the previous outer-boundary-fixed map.

The checker adds one fixed-degree exact predicate and no additional own-curve or scene-point query after source compilation. The standard fixture compilation is not claimed to be zero work. No tolerance, cap, production geometry or publication path is changed.

## Independent A/B review notes

A was asked to retain point40's already proved **physical fixed-X face-feature root**, not replace it silently with a nearby fixed-Z ideal point. Intersecting or even numerically equal interval images alone is not an identity proof; using the same registered source constraints and face-plane bits plus uniqueness establishes the same ideal point.

Corner647 requires closed source exposure. The old strict native-below-cylinder halo cannot certify its exact native/cylinder/groove event. A can use a correlated exact endpoint and a proved derivative/order argument into the arc. Finite ordered numerical queries do not prove continuity/totality of every raw Newton parameter value.

B's initial code has the correct structural split. For C>0, the hard intersection and subsequent max-family ancestors preserve positivity, so no source zero is possible. On C<=0, its source restrictions cover rho up toR and Z through the full cylinder-root enclosure, with convex native interior and native-chamfer negativity checked. It may then extend a synthetic reduced function to the remaining face for monotonic/root-count reasoning; that continuation must not be described as actual groove equality where the finite branch is unproved. Its positive-Z derivative and strict lower/upper signs, plus an interior branch transition, can establish one complete contour if all strip checks execute successfully. No static blocker was found in that argument.

If naive inverse-twist interval boxes exhaust the128-check cap, checked derivative signs can sharpen coordinate extrema: on this admitted angular range, `u_Y=k*v`, `u_Z=sin(theta)`, `v_Y=-k*u`, `v_Z=cos(theta)`. Their signs must be proved over the region before corner values replace interval extrema. No sampling-only exclusion is justified.

## Remaining contract

Keep these verdicts separate:

1. Ideal feature arc exists and is exposed, including true endpoint closure.
2. Actual consumed queries/vertices associate to it, with ordered intervals and original guards.
3. Entire mesh chords meet their original approximation contract.
4. The true original face intersection is complete, not only its captured contour list.
5. Any new arc/face correspondence is compatible with the existing two-dimensional graph and all incident boundary targets.

Success of1–4 does not automatically supply5. Broader source ownership, outside coverage, allocator accounting, production integration and native/WASM/GPU parity remain open.
