# C: original-record provenance and the remaining extension

## Result and scope

The original face's complete discrete segment inventory is already available in
fresh original-stage replay. It is exactly two segments, not an arbitrary subset
selected by the compact fixture. I supplied a static checker that binds these
records, both emitted consumers, every endpoint's key and point bits, and the
complete incident geometry to the fixtures used by the mathematical tests.

This is discrete provenance, not source geometry. A fresh continuous face theorem
and A's ordered branch correspondence must still be composed with it. The existing
44-triangle correspondence does not adopt the entire face polyline:38 and39 remain
on its fixed outer boundary and their retained Z coordinates are outside the ideal
endpoint enclosures. B supplies a fresh checked obstruction. A standalone 1D map
cannot silently acquire authority as the existing 2D map's restriction.

## Files and execution

Base `/tmp/sfcc-adoption-integrated` was checked against all229 entries in
`docs/research/sfcc-boundary-adoption/Integrated/manifest.json`; all hashes matched.
The isolated `/tmp/sfcc-face-polyline-c` contains that unchanged manifested source.
No Rust implementation was changed by C. Rust error-handling/testing skill guidance
was read; no compiler, tests, source evaluations or geometry computations ran here.
Only script syntax was parsed.

New checker: `/tmp/sfcc-face-polyline-provenance-c.py`.

Run, serially under root:

```sh
python3 /tmp/sfcc-face-polyline-provenance-c.py \
  FINAL_COMPONENT_RECEIPT \
  SELECTED_SOURCE/gcad-wasm/kernel/fixtures/face-fans-c.json \
  SELECTED_SOURCE/gcad-wasm/kernel/fixtures/incident-union-c.json \
  OUTPUT_RECEIPT
```

The four paths are positional; the output receipt records the exact three input
SHA256 hashes. Root must additionally verify those two fixture files against the
selected source manifest. The checker reads receipts and compares integers,
strings, arrays and bits. It performs no continuous geometry or source queries.

It checks:

- Exactly one original face[0,3464532,2] row, no interior cycle, zero original
  forward/reverse consumption and exactly the two original segments.
- Original segments4072→4074 and4074→4073, one curve49 pin4074 at its recorded
  parameter, strata31/15, matching source fingerprints and pin provenance.
- The two exact opposite consumers, side1/selected[7,25,58,86] and
  side0/outside[7,26,58,86], both validated original-stage captures.
- Original global→outside-local→joined maps4072→0→38,4073→1→39,4074→2→40;
  matching original keyed point identities and all three position bit patterns.
- Entire captured polyline39→40→38; no omitted original segment can pass.
- Both chosen fans contain their shared edge once, with opposite directions in
  the actual emitted triangles; exact fan triangle/boundary arrays match the
  compact face fixture and source identities match the unique incident fan.
- All endpoint/fan point bits and all44-triangle incident cells, points and fan
  records match the selected incident fixture. Only process-local source pointer
  addresses are normalized.

Six adversarial controls reject duplicate original face rows, an extra segment,
a wrong joined map, a one-bit point mutation, a reversed emitted triangle and a
wrong source identity. The source-identity comparison/control was added immediately
before root's freeze message; root was notified to preserve the earlier five-control
receipt and execute the final frozen version once. No later changes were made.

## Why the live records support whole discrete coverage

In `outside_b.rs`, `paired_target` binds the first captured fan to the actual
candidate triangles and original FaceRecord. It scans every original segment,
requiring exact same-key and same-position association into the candidate; it
records the entire segment list and original pin metadata. It enumerates all
original leaves that consume that face and requires exactly two opposite sides,
one selected and one outside.

`other_contour_segment` requires `segments.len()==2`, a unique first segment and a
unique other segment sharing the selected pin but not the other endpoint.
`bind_second_segment` then repeats exact-key association and both actual fan
bindings, requires the outside direction to reverse the candidate direction, and
checks both fans against the final emitted triangles and source identities.

The outside replay copies original keys, positions, normals, protected edges and
curve memberships, requires originally zero face counters and verifies that the
result consumed every original segment exactly once on its side. The final
receipt's `secondSegmentB.complete` and `originalFaceConsumptionValid` are therefore
stronger than simply trusting that the fixture happens to list two edges.

The compact face fixture has no full original point table, so its own two-element
segment list is insufficient provenance in isolation. This checker closes that
specific binding using the freshly emitted complete original-stage receipt. It
does not repair any flaw in the original FaceRecord's geometric discovery; that
separate issue is addressed by the independent exhaustive source contour theorem
and the ordered whole-polyline map.

## Smallest next transport discriminator

The remaining problem has two distinct parts, which should not be conflated.

1. **Boundary endpoints.**38/39 are minimal-edge crossings with integer numeric
   keys27720370/27716258. `point_table.rs` defines these as latticeKey*8+axis; both
   are axis2 crossings. Inventory all original face/cell consumers of those exact
   keys before claiming a globally compatible boundary change. Reuse the candidate's
   already emitted triangles where possible; replay only genuinely missing
   consumers, with unchanged ledgers and caps. Do not infer ownership from exact
   floating closed-box membership.
2. **Curved branch interior.** Even after endpoint adjustment, an affine map on
   the existing mesh edge produces a straight projected segment. The chamfer
   branch has nonzero curvature; finite vertex relocation alone cannot make its
   entire image equal the exact projected source contour. A new continuous edge
   transport and its 2D extension must be proved.

A potentially smaller endpoint treatment than unconditional neighborhood growth:
38's two current boundary neighbors41/1114 have the same upper-face Y coordinate.
If interval bounds prove the ideal38 target stays strictly between them, moving38
along that straight boundary run can preserve the boundary set and its order,
even though the boundary parameterization changes. The degree/homeomorphism
argument can use an orientation-preserving boundary homeomorphism; it need not fix
every boundary point. This still requires agreement with all consumers sharing the
boundary.

For39, neighbor460 differs from Ymin by one ULP, whereas478 lies at Ymin. The ideal39
point may be strictly inside the current disk instead of on its boundary. That is
an unproved static inference here, not a numerical result. First evaluate exact
interval orientation tests against its adjacent triangles and the ideal enclosure.
If it is interior, no self-homeomorphism of this disk can send the old boundary39
there. The minimal original incident neighborhood must then change, or the target
map must use a different source-domain chart. Merely relaxing the boundary-target
check would be unsound.

For the curved chamfer branch, prefer a bounded local collar after admissible
endpoint motion. Let the intended projected edge be `(Y,z_*(Y))`, and let its
straight canonical-endpoint chord be `(Y,l(Y))`. Their difference
`d(Y)=z_*(Y)-l(Y)` vanishes at both endpoints. In a checked collar a map
`F(Y,Z)=(Y,Z+psi(Y,Z)*d(Y))`, with taper psi=1 on the chord and0 on the collar
boundary, would send the entire chord to the ideal curve. Sufficient obligations
include `1+d(Y)*partial_Z psi>0`, injective/fixed collar boundary, exact taper
continuity at triangle/collar joins, disjointness or compatible attachment to the
already adopted feature arcs, and a new uniform motion/error bound. The feature
join at40 needs a sector-compatible taper, not a generic tube that crosses the
feature edge. Protected-fiber containment must cover the whole curved image and
must use the same source graph/domain binding.

This is a proposal, not an implemented theorem. First test endpoint feasibility
and interval clearance under existing limits; reject if no adequate collar can be
certified. A general face-preserving source atlas would be much larger and is not
justified before this local discriminator. Do not reset the local source graph's
128/depth12 budget. The separate existing exhaustive face checker uses128/depth16;
retain that actual contract rather than accidentally claiming it used depth12.

## Limitations

No production code, tolerances, budgets or geometry changed. No new actual
FaceRecords were generated by C, and no tests or geometry were run by C. The
runtime record's source-family correctness, global coverage, and raw evaluator
behavior are not established by this provenance checker. Root's fresh bounded
execution and fourth-agent review remain required.

Final checker SHA256: `06f9d4dc1a73552f4ad523a46b95e71e6fbb5fb54063ef1c8028dcb0f04318b0`.
