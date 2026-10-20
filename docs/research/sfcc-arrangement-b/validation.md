# Candidate B validation and limits

Baseline: 04d889f911ba6c89981752df02cc2ad7a67ddc0f. Sources and final matching
artifacts are pinned in source-manifest.json. No commit, push, browser, rendering
or visual QA was performed by this candidate. The coordinator owns the final
application build and consensus gate.

## Final exact source gates

- Native Rust 1.99 release, offline jobs1, serde+sfcc-profile:208 library tests;
  seven new arrangement integration tests; six coverage-obstruction tests;
  eleven diagnosis tests; six discovery tests. All 238 passed, no ignores.
- Native default/no-feature library:178 tests passed, no ignores.
- Matching Rust 1.96 release+simd128 WASM, Node 26.11.1, all fixture files ending
  `_test.mts` **and** `_test.mjs`:39 passed, no failures/skips/cancellations.
- New real-worker cases include enclosed components, cavities, holes, thin
  walls, signed zero-only rejection, and wasm32 envelope integers that would
  otherwise truncate to valid values, including the inherited embedded prepared
  leaf-count field. Each corruption case uses a separate
  worker instance.
- Frozen three-sheet target: native serial/resumable and raw 1/2/4/8 worker
  groups, forward/reverse order, canonical oriented all 8 vertex-field geometry
  and complete validation; WASM additionally compares feature intervals through
  real Node Worker instances. No serial recovery masks the coarse construction.
- Independent exact Fraction facet oracle: twelve complete nonoverlapping
  outward cuboid facets, area 400, volume 288, two separate targets. Nine
  operand-order/duplicate/grid-phase variants also pass. Oracle negative
  controls reject a missing triangle, an equal-area duplicate overlap and
  reversed orientation.
- Actual 2:1 construction interfaces are asserted in the native core test;
  the old three-root edge remains distinct. One and two closed components can
  lie wholly in one actual production cell, producing 12 and 24 triangles.

Exact logs are outside the patch under /tmp/sfcc-arrangement-b-*:
`final-profile.log`, `final-default.log`, `final-wasm-build.log`, and
`final-wasm-tests.log`; copies are included beside this document.

## Earlier broader checks, precisely distinguished

A pre-final precursor passed 207 library tests and 51 integration tests covering
new construction, coverage, discovery, cancellation, feature preservation,
transforms, spatial partitions and real kernel worker boundaries. The subsequent
changes tightened the production trigger, allocated unique feature run IDs,
removed redundant target bookkeeping, bounded the scope walk, and checked new
wire integers. Final focused/native/default and all-WASM gates above ran after
those changes. The earlier 51-test matrix is not mislabeled as a final-source
broad native gate.

Existing native parity tests that lack optional external TypeScript oracle files
do not establish those absent comparisons. Actual matching WASM fixtures and
the separate analytic target oracle are the relevant cross-boundary evidence.

## Behavior and resource accounting

The unchanged prepared manifest has 106 leaves, of which 72 retain the old
one-sheet/refinement degenerate flag. The complete new construction certifies
all 106 cells, with 848 final triangles and2 closed components. Final unresolved,
failed and degenerate construction counts are0. Original decision tags remain
available; the terminal diagnostic snapshot describes the repaired filling.

The derived graph has 152 elementary crease intervals. These are graph segments,
not a claim of 152 distinct geometric sharp edges. Every elementary endpoint is
represented as a derived graph vertex; this can constrain quality remeshing
more than a future maximal-curve representation. Quality stages remain enabled
and exercised. Unproved geometry/metadata changes withdraw cell certificates.

Prepared bytes: 5144. Full opaque arrangement partials, including repeated
manifest and per-cell snapshots:

| Worker count | Total bytes |
|---:|---:|
|1|193922|
|2|203204|
|4|219788|
|8|251736|

Per-part sizes and complete final WASM geometry are in coarse-wasm.json.
The construction repeats bounded target/feature work in workers and receiver;
it is intentionally a correctness-first candidate. No speed improvement is
claimed. Healthy exports only scan existing degenerate flags and retain all
legacy fast-path geometry and validation. The final short baseline/candidate
healthy-path sample used a coordinator-held
quiet window, matched warmups, and five alternating samples per version. Raw
samples are in fast-path-cost.json. Median milliseconds, baseline→candidate:
single box 56.151→56.394 (+0.43%); 16 duplicates 2038.529→2062.894 (+1.20%);
clipped intersection 13.446→13.879 (+3.22%). Exact ordered vertex bits, triangle
indices, feature interval bits and validation match. This short sample shows
small measured overheads and is not a general speed claim. The 25.73-second run
stayed within its 45-second deadline. The timing-only duplicate case uses 16
identical boxes; the
coordinator stopped the planned 256-box timing because that shared control was
unexpectedly expensive, before B collected any timing sample. Existing 256-box
correctness/budget controls remain unchanged. This is a declared cost limit,
not favorable-result selection.

## Development failures and refinements

The first enclosed-pair fixture used decimal 0.3±0.1, whose true endpoint sums
are outside the declared represented-endpoint domain. The supported positive
fixture uses dyadic coordinates; an explicit decimal negative remains. A first
adjacent-f64-gap fixture similarly had an unrepresentable opposite endpoint;
the corrected fixture preserves the adjacent-plane gap with exact endpoints.
Neither correction loosened the arithmetic checks.

Testing found that a disk-shaped target alone does not imply the old mesher
succeeds: tiny disjoint objects had disk pieces but old degenerate cells. The
production trigger now uses actual degenerate flags; the standalone complete
constructor retains its full target checks. An experimental debris bypass was
removed after confirming existing closed-component preservation suffices.

Coordinator review tightened signed-zero normalization, original path work
accounting, lattice/key validity, active patch orientation, feature-set run-ID
lifetime and new wasm32 wire conversions. Intermediate compiler/helper issues
and an immediately detected bookkeeping assignment were fixed before the final
matching gates. Pre-final package/source records are preserved separately and
are not acceptance artifacts.

## Deliberate limits

Only hard signed identity-transformed aligned boxes with checked represented
endpoints are in scope. Primitive planes on cell boundaries, inexact f32 carrier
planes, collapsed f32 coordinate order, zero-only strata, nonmanifold contacts,
and bounded-work exhaustion are not certified. No default depth/tolerance was
raised. General curved CSG and transformed boxes retain their prior paths.

Production fallback activation currently requires an existing degenerate leaf.
It does not yet repair every possible nondegenerate legacy meshing failure.
The standalone construction can represent such targets, but extending the
activation contract is a separate change. No stronger guarantee is attached to
legacy successes that do not enter the fallback.

## Shared decoder regression

A final trust-boundary audit found the inherited prepared-leaf decoder could
truncate its embedded u64 leaf count on wasm32 before allocation. The prior
matching package accepted leaf_count+2^32 in an otherwise valid new manifest;
the isolated regression failed specifically at manifestLeafCount, preserved in
leaf-count-before.log. The shared decoder now checks usize conversion, checked
48-byte row multiplication and exact remaining payload size before allocating.
The final gates listed above all ran after this fix. The coordinator can carry
this independent decoder fix into another selected geometry candidate.
