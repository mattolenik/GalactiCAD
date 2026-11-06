# Closure B: positive source membership is not a transported handoff

Frozen source `/tmp/sfcc-closure-b`, parent `/tmp/sfcc-upper-b`, common flat-patch
baseline `/tmp/sfcc-stage3-base`. No main files changed. New proof/consumer code is
compiled only for serde-enabled tests. No builds, tests or geometry were executed
by the author; root owns those serial executions.

## Implemented contract

B imports the reviewed UpperCertificate unchanged and adds a typed closure
consumer. It binds the actual incoming native/alias source branch, the complete
full-scalar outgoing interval and the actual lifted Child(0/1) descriptors under
the outer owner. The two lifted fields must share their immutable builder root;
their owner/target paths and selected partners are exact. Native and lifted
builders legitimately own separate root copies, so bounded structural equality
binds both to the actual runtime tree. Dense IDs and equal sampled values are not
substituted for these checks.

The source certificate retains the finite profile/cap and ancestor inequalities
proved in the preceding round. A **CanonicalClosure** point is generated only at
an admitted phi in [0,phi_max], using the interval image and a checked numerical
association. Its actual lifted and complete-root normalized residuals must meet
the original incoming curve_eps. Discovery ownership may still be false; the
native_band predicate is unchanged.

A **ConsumedClosure** additionally requires an existing chart with the correct
source pair, exact embedded-carrier/registry binding, an in-range parameter and
its own successful checked query. That actual result must match the same canonical
phi within the unchanged source association allowance. It cannot be manufactured
from a nearby input point. An existing trace that starts above activation cannot
inherit a phi=0 endpoint merely because the source theorem supplies one.

Both types provide only point-membership evidence. Neither grants an interval,
continuous numerical map, connection or handoff certificate. The canonical source
curve may be ordered while the old numerical parameterization is not established
as such. The prototype deliberately introduces no implicit conversion to complete
private admission.

The endpoint membership helper also requires an explicit incoming native, incoming
alias and outgoing lifted incident inventory. It rejects missing or repeated
incidents, omitted incident strata, mismatched endpoint backreferences, failed own
queries, wrong source/branch association and unsupported extra constraints. A
failed ordinary lifted ownership test can be replaced only by THIS incident
curve's successful consumed closure event. It never accepts a point-only token or
silently skips the source check. Even helper success remains endpoint membership
and inventory evidence, not proof of the intervening parameterized intervals.

## Current integration boundary

No current runtime consumer or feature graph has been changed. In particular,
complete admission still must run and is expected to refuse until a real handoff
is constructed. The necessary consumers are:

- `shared_arc_plan::endpoint`: validates corner constraints, incident source union,
  own endpoint queries and required outgoing coverage. A corner.strata list alone
  is not an exhaustive obligation inventory.
- `shared_correlated_gate_c::attempt`: independently checks outgoing endpoints and
  associates them with the incoming helix branch.
- `private_arc_a::check_other_point`: checks each actual retained event, its source
  memberships and original projection container.
- `shared_arc_plan::construct_private`'s generated-other-source path: checks newly
  generated query results and must use the same qualified membership contract.

The later implementation needs a registered canonical chart/connected-prefix
proof, complete required incident coverage, and one consistent source-membership
helper through these paths. Closure membership alone must not be used to make a
fabricated native-only endpoint pass. Chart metadata must survive remaking,
cloning, identity/fingerprint and private source-view remapping, with source
binding retained rather than only a dense chart number. This B prototype holds a
borrowed immutable feature set, creates no persistent chart metadata, and therefore
introduces no new clone-owned storage payload or serialization format.

## Tests for root

Use pinned Rust1.99.0, offline/locked, no-LTO/codegen16, serde,sfcc-profile, fresh
kernel cache and positive test discovery. Build120s, focused60s remain unchanged.

1. `closure_b_` — three new tests, with `SFCC_CLOSURE_B_RECEIPT` set to a new path.
   The first writes the actual-source receipt before assertions. It compares
   canonical activation/near-activation/interior membership with the unmodified
   discovery predicate, requires a source-associated own query on the recovered
   outgoing trace, and rejects its detached endpoint as a phi=0 event. The other
   tests reject invalid phi/source/descriptor/branch/registry and missing/omitted
   incident-source data. None modifies the compiled graph.
2. `upper_a_` — two imported continuous-source controls, now on corrected B's
   operator runtime; set `SFCC_UPPER_A_RECEIPT`.
3. Retained lower filters `connection_a_`, `exposure_b_controls_`,
   `exposure_a_frontier_`, `exposure_b_compiled_original_source_retains_required_continuation`.
4. `stage4_c_complete_source_admission_gate` remains the unchanged mandatory gate,
   with `SFCC_STAGE4_SOURCE_C_RECEIPT`. A failed gate is not hidden by a passing
   closure-membership test.

The actual expected distinction is positive canonical source closure but no
existing consumed raw endpoint at activation. Root execution determines that
outcome; author performed no geometry queries. The receipt labels both handoff
and ordered-prefix authority false and records actual admission separately.

No clipping, outgoing interval installation or private-admission extension was
implemented in B. Full handoff, component, native/WASM, transformed-family and
production validation remain open. The main risk is mistaking a valid endpoint
membership token for an ordered connected interval.
