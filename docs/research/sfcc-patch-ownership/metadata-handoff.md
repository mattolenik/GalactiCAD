# C: exact retained-metadata transport with no new checker heap workspace

The frozen source is `/tmp/sfcc-ownership-c`, based on the 202-input round33
Reviewed source. C performed static inspection and edits only. Root owns all
builds, tests, scene/curve evaluations and component reconstruction.

## Changed files and integration

- `gcad-wasm/kernel/src/sfcc/retained_metadata_c.rs`: new audit and four controls.
- `gcad-wasm/kernel/src/sfcc/private_arc_a.rs`: test+serde module declaration only.
- `gcad-wasm/kernel/src/sfcc/shared_arc_plan.rs`: final constructor audit, before
  moving the maps/records into `PrivateReceipt`, active only for the secondary plan.

Exact source hashes are in `/tmp/sfcc-ownership-c-changes.json`.
A owns cell-mesh ownership recording and B owns the outside probe; neither file
is modified by C. A's reset/take-report hooks are not added here so this packet
can compile independently. Root can insert those during composition.

The API is `retained_metadata_c::audit(Inputs) -> Result<Receipt, &'static str>`.
Inputs borrows the actual live/private tables, original/staged required records,
existing required/needed sets, canonical equivalences/map, primary chart pair and
original pin-parameter pairs. It reuses the actual constructor state rather than
rebuilding a map from floating-point proximity or saved decimal coordinates.

## Established predicates

1. The canonical map is injective on canonical original IDs. Its targets exist,
   canonicalization is one-step/idempotent, and every needed point has a mapped
   private point. The private point's position, normal and provenance key equal
   the canonical original bit-for-bit.
2. Every staged face retains its exact identity, length, interior-cycle bit and
   counter-vector lengths. Its directed segments equal the original ordered
   segments after the authorized mapping and removal of collapsed zero segments.
   No additional segment may appear.
3. Every original pin has its exact expected staged counterpart. Primary alias
   relabeling is allowed only to the physical primary chart and the bound original
   parameter pair; all other chart IDs and parameter bits remain unchanged.
   No staged pin may be invented or duplicated. This independently detects a
   differing-parameter pin being silently discarded by point/chart-only dedup.
4. Every supplied original protected edge touching the needed set retains mapped
   protection; its endpoints must both be available and cannot collapse. Every
   supplied original curve membership retains its chart and oriented parameter
   bits, including when private point numbering reverses the edge orientation.

The receipt counts original/canonical/merged keys, unkeyed points, faces, pins,
collapsed segments, protected edges and curve memberships. The last two can be
zero at this pregraph stage; a zero result must not be described as evidence for
nonexistent old records or for later postassembly metadata. The four synthetic
controls deliberately include nonempty old protection and membership.

This proves record transport under previously authorized equivalences, not their
source justification. It does not prove that an old protected edge is realized
as an emitted edge, permit interval splitting without additional evidence, or
establish any surface-patch ownership. Source curves and all live metadata remain
immutable. The final generated-query audit is already complete before this hook;
this checker attempts zero field or curve queries.

## Resource contract

The audit body performs no dynamic allocation. It uses borrowed collection
iterators, scalar counters, fixed arrays and a fixed-size return struct. In
particular it does NOT call `PointTable::curve_intervals`, which returns a newly
allocated vector; it scans `identified_edges()` borrowed slices and handles
orientation explicitly. Pin comparison and canonical-map injectivity use bounded
nested iteration instead of additional maps/sets. Existing point/face/pin/interval
limits are retained; scoped old-protection work also refuses above 2,048 entries.
Serialization of the fixed receipt happens in the caller and is outside the
allocation-free audit claim. Worst-case iteration is quadratic in the bounded
map and membership counts and stays under the existing campaign/component time
watchdogs; no measured performance claim is made by C.

This eliminates new checker heap workspace for this metadata gate. It does NOT
close the existing JSON, ownership-recorder, outside-probe, BTree topology or dual
GrowingIndex allocator accounting. Those workspaces still need audited storage
terms or bounded redesign before an allocator-complete 64 MiB claim. No RSS claim
is made, and the private limit is not increased.

## Requested controls

Run filter `metadata_c_` (four cheap tests):

- Exact positive transport with an explicit merged alias, canonical key/normal
  preservation, removed zero segment and reversed private interval orientation.
- Rejection of changed normals/keys and one-ULP pin-parameter drift.
- Rejection of lost protection, wrong interval orientation and invented pins.
- Rejection of a noninjective canonical map and reversed directed contour segment.

Then run the selected full component to obtain non-vacuous actual point/face/pin
counts and the explicit old-protection/interval counts. Do not infer that synthetic
metadata controls establish a new successful component result.

## Independent challenges to A/B

Patch labels are authority metadata, not mere graph tags. Copying a selected
stratum ID onto fallback fans cannot settle two-dimensional branch exposure or
coverage. A's recorded source hypotheses must remain distinct from any theorem.

A first same-stage outside consumer can expose a real incompatibility or establish
that one interface, but cannot establish all outside contacts. B reports a
separately charged observational query scope; its cost must not be hidden inside
the component's 119 unused generated slots or used to claim a full replacement
fits the original single reservation. Unknown/unreconstructed outside consumers
must keep publication blocked.
