# A: actual fan gate inventory and composed-source projection discriminator

Frozen source: `/tmp/sfcc-ownership-a-fixed`, based on round33 Reviewed (202 inputs).
Root alone compiles and runs all tests or geometric evaluation. I performed source
inspection, fixture extraction and static syntax checking only.

## Scope and correction to the earlier interpretation

The saved first actual fan is the cylinder stratum 15, with six triangles in cell
[7,25,58,86]. Its captured option is `qualityTriangulation=false`, while its carrier
is supported by `supports_local_edits`. Thus the absent label is initially an
option-gated path, not evidence that this carrier is unsupported. The legacy disk
path itself uses finitely sampled checks; enabling it would still not prove
continuous source ownership. No option or label is changed here.

## Files

- `kernel/src/sfcc/cell_mesh.rs`: preserves the original fan implementation behind
  a wrapper that records entry/output hypotheses without new field/curve queries.
- `kernel/src/sfcc/ownership_a.rs`: bounded inventory and focused actual-fan probe.
- `kernel/src/sfcc/exposure_a.rs`: declares the source-bound helper module.
- `kernel/src/sfcc/ownership_source_a.rs`: interval source restriction for the
  negative-X cylinder graph on supplied YZ rectangles.
- `kernel/fixtures/ownership-first-fan-a.json`: compact extraction of the actual
  first six-triangle fan, exact point bits and original options from the round33
  receipt with its SHA-256 retained.

Integration APIs: `cell_mesh::ownership_a::reset()` before the candidate generated
scope, `take_report()` immediately after candidate cell reconstruction. Taking the
report disables the recorder, preventing a later outside probe from contaminating
it. Recording additionally requires the existing secondary request and generated
query scopes. The inventory has caps of 4096 fans/triangles, 128 source/gate rows,
64 first-fan boundary points and 128 first-fan triangles; overflow is explicit.
It does not allocate a growing full-geometry trace.

Root test filter: `ownership_a_` (two tests). Set `SFCC_OWNERSHIP_A_RECEIPT` to save
the focused composed-source report. These tests do not alter the meshing algorithm.

## Mathematical claim

The source helper rebinds the actual full operator ancestry and primitive
occurrences through existing registered source APIs. It requires the exact
supported source frames and coaxial centers. It parameterizes the selected
cylinder sheet by

`X = centerX - sqrt(radius² - (Z-centerZ)²)`.

A strictly positive radical excludes the opposite sheet and supplies a regular
graph. Outward-rounded inverse-twist coordinates and finite-profile/cap checks
establish the actual native finite side field E. The competing lathe's finite
meridian branch is proved strictly beyond the inner-round radius, so I=E on the
admitted rectangle. The groove's finite meridian distance d, cap cutter and outer
round are independently bounded. On this graph the cylinder field C is exactly
zero, with its finite cap inactive.

When E<=0 and d>=chamferRadius throughout the rectangle, the full composed source
is identically the cylinder field there. This is a positive continuous source
exposure statement on the admitted graph rectangle, not an inference from samples.
When E or the chamfer diagonal has a strictly positive lower bound, the full field
is positive on the graph and that projection cannot be an ownership map there.
The ordinary outer sphere has sign +1; root caught my initial -1 binding typo before
execution. The margin formula already assumed +1 and the bad sign would refuse,
not accept a false region. Root also caught one missing parenthesis; fixed source
parses under rustfmt (formatting differences only).

The focused test examines 42 outward enclosures of exact dyadic barycentric YZ
points of the six actual triangles, plus up to six small graph rectangles whose
four corners are proved strictly inside the corresponding linear triangle chart
with exact orientation predicates. It requires at least one exposed open rectangle.
Each accepted rectangle has a complete branch/dominance proof; their union is
NOT claimed to cover the fan. The existing strict bounds and 64-region cap remain.

## Limits

No entire fan or component ownership is granted. In particular, the tests do not
prove that the emitted triangle boundary maps to the correct curved trim boundary,
and do not yet bound graph-to-chord displacement. A positive composed field at an
exact projected fan point disproves that chosen graph projection's ownership; it
does not prove no nearby valid approximation or curved-boundary transport exists.
No patch labels are assigned, no new general CPU scene evaluator is introduced,
and no production or publication path is changed. All field restrictions reuse the
existing interval proof machinery and are diagnostic only.

An optional graph-to-triangle-plane displacement extension exists in an unexecuted
scratch copy but is deliberately excluded from this frozen packet until the basic
actual source discriminator is executed and reviewed.
