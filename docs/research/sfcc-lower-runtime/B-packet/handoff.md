# B: independent lower-event completeness discriminator

Source: `/tmp/sfcc-lower-runtime-b`, copied from the common combined source
`/tmp/sfcc-lower-runtime-base`. B does not install a runtime handoff or change any
acceptance predicate. Root alone runs builds, tests and geometry; no such work was
performed by this agent.

## Changed files and execution

- `gcad-wasm/kernel/src/sfcc/exposure_a.rs`: registers a test-only module.
- `gcad-wasm/kernel/src/sfcc/lower_runtime_b_tests.rs`: three independent controls.

Root should run filter `lower_runtime_b_` with `SFCC_LOWER_RUNTIME_B_RECEIPT` set.
The first test writes the receipt. The tests deliberately characterize the
predecessor, so the assertion that old admission accepts the incomplete lower
corner must not be blindly retained as a passing test after new completeness
checks are installed.

## Independent source roles

The fixture identifies the correlated native/alias/cylinder source through the
existing source selector and HelixBranch identity. The old coordinate witness
locates a candidate corner, but the lower source certificate must bind there.
The compound chamfer stratum is identified with `connection_compound` against
the actual hard/groove/owner nodes, not its historical dense ID.

The test-only discriminator requires four physical roles:

1. native or its proved field alias against the cylinder;
2. native or its field alias against the actual compound chamfer;
3. cylinder against that compound chamfer;
4. the independently source-bound lifted pair.

It checks all declared ends matching each role for valid backreferences, complete
stratum lists, embedded carrier/source identity and actual own-query agreement
with the corner under the unchanged allowance. The lifted pair additionally
uses the retained lower source certificate identity. Aliases are not mistaken
for extra physical rays. Conversely, deleting an earlier physical ray must not
be excused just because the new lifted pair is present.

This gate remains a test discriminator. It does not establish every interval's
source identity, install an ordered replacement, prove an open neighbourhood
radius or authorize mesh publication.

## What the controls distinguish

`lower_runtime_b_natural_missing_ray_passes_old_full_admission` verifies that the
naturally compiled lower corner lacks the required lifted ray while both old
`endpoint` and complete `private_arc_a::admit` accept the declared inventory. The
independent required-role discriminator rejects it as missing `lifted`. The old
raw endpoint remains farther from the corner than the original allowance. This
is evidence of a missing source-completeness condition, not an assertion that the
old mesher publishes an invalid component (it later refuses the graph).

`lower_runtime_b_metadata_only_attachment_does_not_close_actual_query` changes
only the raw curve's corner backreference and the corner's end/stratum lists.
The feature fingerprint changes, but the actual endpoint query is bit-identical.
The independent discriminator refuses `endpoint_mismatch`, and the existing
endpoint gate also refuses. This rules out treating a metadata edit as a source
connection repair.

`lower_runtime_b_complete_star_requires_previous_physical_rays` independently
removes cylinder/chamfer and both native/chamfer representations. The required
role discriminator refuses each removal. These corruptions are synthetic controls;
the predecessor's naturally missing lifted ray is separate evidence.

## Runtime review obligations shared with A

A's gate must derive this full physical inventory from the source independently
of optional lower-chart metadata. Deleting a chart's lower certificate must not
restore the old incomplete admission. The private view intentionally omits one
native alias; the source graph must preserve original ends, but a physical-star
check must not invent an extra physical role for that alias.

Metadata-only closure is inadequate. A source chart must preserve the actual raw
join exactly, use its checked ideal association, and terminate exactly at the
existing associated source corner. Successful source membership alone is not an
actual query, residual, cell-bound or graph certificate. The same qualified lower
membership must reach every upper-qualified consumer, including all three sampler
liveness uses. Source identity and range/curve binding must survive clone, index,
fingerprint and storage auditing. Failed late proposals must preserve the entire
old curve and corner, not only counts.

## Scope

No runtime changes, cap changes, new SDF evaluator, refund, performance claim or
component acceptance are made by B. Tests are unexecuted by this agent; root's
saved execution receipts are authoritative. Static review of A is reported
separately as its source becomes available.

## Root execution and initial A review

Root reports all three B controls pass in
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round29-lower-runtime/B/`.
The receipt confirms the naturally missing fourth ray passes old complete
admission. The B source remains frozen after that execution.

Static inspection of A's in-progress lower transaction identified three integrity
obligations, communicated to A and root:

- Reject one raw curve proposed for two distinct existing corners; merely avoiding
  duplicate corner IDs does not prevent double attachment. A's current source now
  refuses a duplicate proposed curve before committing any proposal.
- Retained membership and event completeness must verify the original unchanged
  range, last-span binding and nonclosed curve state, not only ID/source/corner.
  A's current source includes these checks and a malformed-range control.
- Replacing the stored knot at the left join with its projected own query can
  change the preceding, supposedly untouched interpolation span. Require bitwise
  equality to the original stored knot (or preserve it separately); projection
  idempotence alone does not prove that equality. This correction is pending A's
  final source at the time of this handoff.

Root and B also requested explicit bounds and duplicate/malformed checks on the
nested original corner end and stratum lists before cloning them. The outer curve
count alone does not bound an adversarially oversized nested Vec. These changes
need to be included in A's final frozen tests/review; B's baseline packet does not
implement them.

The proposed whole-image enclosure within the endpoints' expanded AABB is only
an installation filter. It does not prove every canonical point is within the
per-parameter interpolation seed's displacement allowance. A retains the actual
per-query projection-box check; no universal numerical query-totality claim should
be made from the weaker installation enclosure.
