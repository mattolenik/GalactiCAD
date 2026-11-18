# Round 36 C: common source transport for two incident patches

Frozen source: `/tmp/sfcc-paired-c`, based on the 212-input round35 selected source
`/tmp/sfcc-fullfan-reviewed`. C changed only:

- `gcad-wasm/kernel/src/sfcc/paired_source_c.rs` (new wrapper and two controls)
- `gcad-wasm/kernel/src/sfcc/exposure_a.rs` (test/serde module declaration)

Hashes are recorded in `/tmp/sfcc-paired-c-changes.json`. C performed static
inspection and edits only: no builds, tests, field/curve evaluation or geometry
execution. Root owns all execution.

## Interface and proof scope

`paired_source_c::certify_pair(features, cylinder_id, points, patches, shared, tolerance)`
accepts `&BTreeMap<usize,[f64;3]>`, two borrowed flat triangle-index slices, and one
shared endpoint pair. It returns `Result<serde_json::Value,String>`.

The wrapper rejects nonfinite/missing point data, invalid or over-cap triangle
inventory, repeated triangle vertices, and any proposed shared edge which does
not occur exactly once in each patch with opposite directions. It never merges
points by coordinate proximity. Same ID means the same position because the
caller supplies one map; capture provenance must independently justify that map.

It concatenates inside triangles followed by outside triangles and calls the
existing `fullfan_source_a::certify` exactly once. This retains the global 128
piece-check limit and one common world-X slab. Two separately successful fan
certificates would not automatically provide a shared slab or a common uniqueness
argument, and are not used here.

If that call succeeds, every point of the common affine YZ edge belongs to both
closed projected domains. The common slab contains one full-source root at each
such point, so both source lifts have the identical root trace pointwise. This
is the mathematical shared-boundary statement supplied by C. It does not prove
the projected patches have disjoint interiors, form a joined disk or preserve
all other boundaries. B supplies the projected-union proof separately.

The receipt records the exact concatenated triangle IDs, used point bits in sorted
ID order, per-patch counts, opposite directed edge incidences and the original
source certificate. Its per-triangle bounds are in the same inside-then-outside
order expected by B's `combine_error`. The composing caller must check those input
identities before combining results.

## Actual source-feature distinction

The previously captured first-fan boundary intervals identify curves20/39 on edge
465↔647 and curve49 on edge40↔647. The target shared face-contour edge40↔38 has no
recorded curve interval there. Point40 lies at the intersection with curve49, but
that does not turn the entire shared face-contour edge into curve49.

The receipt therefore keeps `sharedSourceFeatureIdentityProved=false` and
`exactFacePlanePreservationProved=false`. The prior exact-X-plane counterexample
remains compatible with a common transported boundary; neither fixed face-plane
preservation nor source-feature parameter preservation is silently inferred.

The source proof is anchored at the actual first cylinder occurrence, but the
outside patch need not have the same selected graph hypothesis. The certificate
concerns the full composed source and may cross admitted max facets. Actual outside
hypothesis/source identities should remain in A's capture; no patch is relabeled.

## Root execution and integration

Focused filter: `paired_c_` (two inexpensive input/incidence controls).

The positive case must use A's actual outside capture. Construct the shared point
map only from A's checked original-key/position reconciliation, select the actual
outside fan incident to the original segment, and pass both exact triangle lists
with the unchanged surface tolerance. Record either the successful certificate or
its exact refusal. At this handoff, no positive paired result has been executed.

A's current source family may refuse a wider slab because a selected native side
is no longer nearest. Do not raise the piece limit or declare that a mesh defect.
A possible later alternative is a zero/sign-equivalent convex support-plane max:
inside a proven convex profile its signed distance is the maximum outward plane
field; outside, positive sign suffices since the hard-intersection zero requires
native<=0. Such an extension requires explicit convexity, cap/clamp and branch
checks, pruning only proved-negative contributions. It is deliberately not
implemented before an actual refusal demonstrates the need.

## Remaining gates

- Actual retained-cell reconstruction and source-proof execution are pending root work.
- B's exact projected union, working/export correspondence and error composition
  remain independent obligations.
- Source-feature endpoint/parameter transport, other interfaces, full component
  ownership, complete outside coverage and allocator accounting remain open.
- This is an experimental checker overlay; production code and geometry are unchanged.
