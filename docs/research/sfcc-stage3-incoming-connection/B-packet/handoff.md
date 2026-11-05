# Connection candidate B: certified short chord and conditional attachment

Frozen source `/tmp/sfcc-stage3-r3-b`, based on adaptive-probe B plus the reviewed
A source-location helpers. Common patch baseline `/tmp/sfcc-stage3-base`.
Author performed static inspection and rustfmt syntax checks only. Root must run
build and geometry controls; no passing result is claimed here.

## Implemented connection contract

The source certificate admits only one original open traced knot span starting
at an actual raw endpoint. The requested range is the original classification
interval, retained separately from the final numerical cutoff. Source/native,
round-field, finite cylinder and common compound occurrences are all bound to
the same immutable tree and actual traced carrier copies. The compound's two
operand pointers, equal represented weights and rounded offset are checked.

A candidate corner proposes a location but does not supply authority. The reviewed
source junction theorem independently binds its location to the actual selected
profile, groove edge and cylinder branch. The incoming ideal source connection is
parameterized by lambda from zero at that junction to one at the checked interior
height. Its radius is R + lambda*D with D strictly negative; therefore the cylinder
is strictly inactive on every open incoming point. Source profile, groove closest
edge and inactive ancestors are checked over the whole interval. The generated
compound's offset/weight differs from the ideal source radius only by an explicitly
bounded recorded amount; exact equation equality is not assumed.

For intrinsic u=sqrt(rho^2-v^2) and twist theta=k*y+constant, the Euclidean second
derivative bound is |u''|+2|k*u'|+k^2*rho, with u'=rho*rho'/u and
u''=-(rho')^2*v^2/u^3. Outward interval arithmetic bounds this on the whole source
interval. Endpoint association plus M*height_span^2/8 bounds the complete chord,
not only sampled queries. The original raw interpolation seed span gets a separate
uniform bound using the same chord theorem and its interpolation rounding bound.
Both bounds must fit the unchanged curve_eps; no tolerance is widened.

## Runtime consumption

The resolver runs after candidate collection, with at most 64 actual proof
attempts. Unsupported/failed ends stay unresolved. On successful proof it extends
only that raw end to its original endpoint and records the independently validated
candidate ID. It never uses ordinary nearest-candidate authority for that end.
The raw interior join is inserted as a new knot during remake. The proof's exact
corner/join samples and original carrier copies must match before installation.

Only that first/last remade knot span uses the checked chord query. Its evaluation
is a+fraction*(b-a), clamped componentwise to the represented endpoint interval;
height is monotone by construction. Every successful query must still satisfy
both actual carrier residual/domain checks. Failed certified queries return None;
the best-effort point_at path returns NaNs for this span instead of silently
substituting a different query. Ordinary traced intervals retain Newton behavior.
Chord tangents, including axis-plane-crossing tangents, use the represented chord.

The private traced payload retains two optional certified-end tolerances. Clone
equality, owned-storage accounting and feature fingerprint include this state.
The proof is carried through the original-end splitting path. A later remake of
an already certified curve refuses rather than silently dropping its query
semantics. Full component/later resampling obligations remain to be tested.

## Tests and root execution

Build pinned Rust1.99.0, no-LTO/codegen16, offline/locked, serde,sfcc-profile.
Clean task-owned kernel cache; require nonzero discovery. Existing120s build and
60s focused campaign bounds apply. Suggested order:

1. `connection_b_original_prefix_` and `connection_b_rejects_` (2 tests): original whole-source compile, uniform connection
   receipt and installed ordered queries, source/branch/container/refusal checks.
   Set `SFCC_CONNECTION_B_RECEIPT`.
2. `junction_b_` (1 retained local-equivalence theorem test, now observes the
   endpoint whether wired or unwired). Set `SFCC_JUNCTION_B_RECEIPT`.
3. `exposure_b_controls_` (5 unchanged negative/authority controls).
4. `exposure_b_compiled_original_source_retains_required_continuation` (original
   unchanged upper/lower preservation gate). Set `SFCC_EXPOSURE_B_RECEIPT`.

5. `connection_b_preserves_every_admitted_query_authority_after_dedup` is an
   additional required gate. Legacy sampled dedup can erase a symmetric certified
   prefix in favor of an ordinary representation. This gate must fail if any
   admitted endpoint loses its query authority; no duplicate edge is retained and
   no whole-arc equivalence is inferred. Such a discard increments unresolved
   diagnostics. A target upper/lower pass cannot excuse this collateral failure.

The actual preservation gates must pass before selection. Its assertion is not
weakened. New tests also reject zero allowance, reversed/non-end containers,
nearby wrong junction height, wrong orientation, equal-but-separate immutable
source occurrences, shifted raw seed geometry and a later unproved remake.

## Limits

This is a narrow identity/coaxial source family, not general transformed CSG or
arbitrary incoming-arc reconstruction. The proven source connector and emitted
short chord are distinct, with explicit fidelity bound. The untouched rest of the
arc and collateral source families still need the planned component review.
No build, geometry, full component, native/WASM or visual validation was executed
by the author. Failed admission remains unresolved; neither a compile nor a test
pass alone makes this a production-ready mesher.
