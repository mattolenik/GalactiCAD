# B: adaptive-face scope and typed Y-face point prerequisites

Selected frozen source for root execution: `/tmp/sfcc-alias-b-typed-reviewed-fixed`.
Parent: `/tmp/sfcc-alias-base` (the previous repeated-walk guard plus B's offset-aware
source premises). This candidate incorporates A's separately reviewed canonical-image
source certificate from `/tmp/sfcc-alias-a-authority-reviewed` verbatim, then adds
B's inventory and typed point-certificate diagnostics. It performs no contour,
point, graph, curve-range or incidence mutation.

The agent inspected and edited source and ran rustfmt only. Root alone runs builds,
source/curve queries, component reconstruction and tests. The status below separates
root-reported results from pending checks.

## What the actual inventory establishes

The source pair is selected through the original native/inner-round occurrences,
the shared generated chamfer carrier, actual embedded carrier descriptors and the
common source corner. Dense IDs are observations, not selection authority.

The initial corrected inventory records 161 faces containing the selected secondary
family: six contain both charts 46 and 66, and 155 contain only chart 66. There are
no chart46-only faces. Chart46's global range is [0,16] with corners [13,-1]; chart66
has range [0,40] with corners [13,29]. Global endpoint equality is false, so the
existing `transport_shared_arc` precondition cannot simply be reused or erased.

Selecting every point user of the complete chart66 family expands the primary
component to 360 leaves and 1,834 required faces, exceeding the unchanged 256/1,536
limits. This overbroad selection is not proof that every local repair exceeds caps.
The paired-only refinement derives all point users of the six paired faces from
actual FaceRecords, then recomputes consumers from all current octree leaves. Root
reports 205 leaves (six additional) and 1,031 required faces, within those caps.
No source/curve evaluations are added by either inventory.

The six paired faces are:

- [1,3398483,1]: the original Y face, approximately t46=3.56365, t66=2.90488;
- [0,3464275,1]: approximately t46=7.057, t66=3.075;
- [0,3530324,1]: approximately t46=11.983, t66=3.546;
- [1,3530324,1]: approximately t46=13.373, t66=3.904;
- [0,3596116,1]: approximately t46=13.713, t66=4.022;
- [0,3662165,1]: approximately t46=14.822, t66=4.672.

The expanded required set also contains the chart66-only frontier face
[1,3662165,1], used on side0 by cell [8,55,114,172]. This is a genuine interval/end
obligation. The physical/native curve46 ends without a registered end corner while
66 continues. Root's source probes identify inner-round activation near curve46's
end: the native field and inner-round parent no longer coincide there. Neither the
first face event nor the entire six-face selection permits deleting the rest of66
or blindly merging the complete [0,16] native range.

The actual original first FaceRecord has axis1, key3398483, length1 and three pins.
Its two alias pins have GLOBAL PointTable IDs35832/35833, not the private staged
IDs454/455 from the earlier cell capture. Its two actual consumers are
[7,25,58,86] on side0 and [8,51,115,172] on side1. The new inventory retains exact
lattice coordinates, rectangles, keys, parameter and position bits, segments,
consumption counters, direct faces, indirect users and old/expanded selections.

## Typed point-certificate prototype

`alias_typed_face_b::admit` uses A's source-bound certificate and the SAME primary
private Transport ledger. It requires:

1. The certificate and ledger borrow the current immutable source instance.
2. Exact slot/record axis, key and length; a valid lattice coordinate and positive
   in-bounds extent; bit-identical claimed and typed plane.
3. An unconsumed record and exactly one pin from each certified chart.
4. Actual PointTable bounds and the original `Faxis:key:chart:parameter` key for
   both retained pins; no proximity-only point binding.
5. The original f32 face-bin container, its hull and the actual adaptive rectangle.
   The original min-plus-extent rectangle is retained, and roots must also lie
   below the independently computed lattice-corner upper coordinate.
6. Physical and generated root enclosures derived independently from A's exact
   Y-coordinate inverse. Their transverse enclosures remain within the original
   rounding hull and strictly inside the adaptive face. The inverse relation fixes
   the normal coordinate to the exact original plane; it is not a numerical snap.
7. Both pins pass each original carrier's strict minimum curve-epsilon residual
   and ordinary-domain condition. No source-domain waiver is introduced here.
8. Each stored point and actual own query directly associate with BOTH root
   enclosures under the unchanged allowance. The proposed canonical stored point
   is directly checked against BOTH actual queries, avoiding a doubled allowance
   through an ideal root or intermediate chart.

The two own queries are charged before entry through A's `retained_main` API.
The diagnostic hook runs after primary source admission and records a distinct
`secondary_face_points_b` phase before ordinary rechecks. It does not run inside
GeneratedQueries and does not borrow that observer's reservation. Thus the added
queries are visible in the original 16,384 ledger; no cap or reservation changes.

`observe` applies this point gate to paired Y faces only, under a64-face diagnostic
bound. It derives opposite incident consumers from the actual octree and canonical
face map, rather than accepting supplied flags. Its certificate ranges extend from
the common source start to the actual face parameters; a proposed radial lower
bound is then admitted only by A's full source certificate. Failed source or face
conditions are retained as refusals in the diagnostic. X/Z faces remain unsupported
by this point gate; they need their own coordinate derivative/root proof.

This is a typed POINT prerequisite, not a prepared face rewrite or completed alias
transaction. The hook records its result but does not use it to mutate the geometry
or override the existing graph refusal. A passing point gate cannot authorize an
unproved arc interval, a partial overlap endpoint, altered frontier or missing
consumer. `publicationAuthority` stays false.

## Tests and execution status

Root reported the corrected inventory's two `alias_b_` controls pass and executed
its full read-only component capture. The paired-only inventory was also executed
by root and establishes the205/1031 scope above.

The final typed candidate has three `alias_b_` controls: those two metadata/source
selection controls plus a typed point test using the exact captured FaceRecord and
original target point IDs/keys/positions. The test reconstructs empty filler slots
to retain the original global indices; it does not claim a complete scene replay.
It requires a positive point certificate with exactly two additional charged
queries, and rejects wrong axis/key/length/plane, a foreign source instance and
missing provenance without additional charges.

Root must execute the final typed candidate with `SFCC_ALIAS_B_RECEIPT` set. The
combined source also includes A's three `alias_a_` controls, which should run after
this composition. A serde-only non-test compile ensures no test hook leaks into
ordinary builds. Then one bounded original-source component capture should record
`secondaryTypedFacesB`, the main-ledger charge, exact observed consumers and the
unchanged graph outcome. No typed success is claimed by this handoff before those
receipts exist.

Preserved failed attempts:

- `/tmp/sfcc-alias-b`: initial inventory compile failed because the parent module's
  one-parameter Result alias was used with two generic arguments. The separately
  frozen `-fixed` version names `std::result::Result` explicitly.
- `/tmp/sfcc-alias-b-typed-reviewed`: typed diagnostic compile failed because the
  tuple of `from_fn` arrays needed explicit `([f64;3],[f64;3])` annotation. The final
  `-fixed` copy adds that annotation without changing semantics. Earlier copies
  remain immutable.

## Files and integration boundary

B adds/changes:

- `alias_face_b.rs`: source-family selection and read-only face/consumer inventories;
- `alias_typed_face_b.rs`: typed Y-face point certificate, actual consumer lookup,
  bounded observation and captured-record corruption controls;
- `fixtures/alias-typed-face-b.json`: exact captured FaceRecord/pin/lattice input;
- `stage4_component_b.rs`: read-only inventory field in the existing round0 report;
- `shared_arc_plan.rs`: test-only diagnostic point-gate call using the same ledger;
- `private_arc_a.rs`: test-only diagnostic result recorder;
- `exposure_a.rs`: test-only B module registrations.

The composed A files (`alias_a.rs`, `alias_a_tests.rs`, its exposure registration,
transport visibility helpers and generated-scope reader) are inherited from A's
reviewed source; they are not a competing B proof. The complete changed-file SHA
list is `/tmp/sfcc-alias-b-files.json`; root's executed manifest is authoritative
for the final frozen copy.

## Remaining reconstruction obligation

A global native-retained/composite-omitted policy would be wrong here. The common
source curve continues in66 after46's native branch ceases to be active. A usable
repair needs the true activation/handoff, ordered correspondence on the supported
prefix, typed binding of all relevant face axes, and a consistent unchanged
frontier before publishing any graph change.

A plausible later integration uses the existing local shared-arc path: canonicalize
proved face ports while retaining both pin chart IDs/parameters, then reuse one
physical sampling with both checked curve memberships only on certified local
intervals. Global endpoint mismatch must not become a blanket rejection or a
blanket exemption. Every canonical stored node must be checked directly against
both own queries; GeneratedQueries alone observes own-query points and does not
supply that cross-chart retained-point authority.

The205-cell proposal is bounded, but its final single66 frontier and native46
activation remain unresolved. No contour rewrite, graph quotient, complete-component
acceptance, production change or native/WASM/GPU agreement is claimed here.
