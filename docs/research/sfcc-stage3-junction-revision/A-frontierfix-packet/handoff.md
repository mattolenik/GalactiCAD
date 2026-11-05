# A bounded correction: preserve the original unresolved search container

This revision copies frozen A and changes only `trim.rs`. It does not alter the
source-junction theorem, numerical classification, endpoint authority, snapping,
compiled preservation gate, settings or fixtures. The original executed candidate
remains untouched.

The executed raw235 witness disproved the sufficiency of A's last bisection bracket
as search provenance: its initial alive/other pair encloses the source junction,
while successive unknown midpoints produce a final bracket that excludes it.
A resolver searching only the latter would be unable to recover that endpoint.

`TrimFrontier` now retains:

- `initial_alive`, `initial_other`: the original classification event bracket.
- `initial_other_status`: `Inactive` or `Unknown`; the alive side is known positive.
- `alive`, `other`: the final bisection bracket, separately.
- `other_status`: final inactive versus unknown status.
- `reason`: undecidable classification, work limit or midpoint stagnation.

All parameters remain in the original raw curve frame bound by `TrimmedRun.curve_idx`.
Their order identifies orientation. A closed run may shift its emitted `t0` by a
period, but retains both original raw search containers without translating them.
The small `join_wrapped_runs` helper is the actual runtime operation and the test
exercises it with independently generated first/last frontiers. Splitting continues
to carry original-end structures unchanged and creates no authority from the new
fields. No trace-history collection or public serialized state is added.

New adversarial controls demonstrate, in both directions, a true candidate at the
original bound outside the final unknown bracket. They assert that original state
and container remain available, including an initially inactive endpoint followed
by unknown midpoint classifications. The wrap control verifies both retained
original frames while the emitted run straddles the wrapped parameter origin.
The existing budget/stagnation control is updated to assert the additional fields.

Run the same frozen-A sequence, with `exposure_a_frontier_` now discovering three
controls. Total: eight controls plus the unchanged original-source gate expected
to fail lower-junction preservation. Existing receipt environment variables remain
`SFCC_JUNCTION_A_RECEIPT` and `SFCC_EXPOSURE_A_RECEIPT`.

Author performed static inspection and rustfmt only; root executes all checks.
This is still not an attachment repair: provenance enables a future bounded search
but neither proves that the source junction lies in every initial bracket nor
proves branch continuation from a numerical arc to that junction.
