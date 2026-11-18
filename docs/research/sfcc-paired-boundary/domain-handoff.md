# B: exact projected union of two incident cyclic fans

Selected fixed source: `/tmp/sfcc-paired-b-fixed`, based on the 212-input round35 source at
`/tmp/sfcc-fullfan-reviewed`. Changed-file hashes are in
`/tmp/sfcc-paired-b-fixed-changes.json`.

Only two files change: `cell_mesh.rs` adds a test/serde module declaration, and
`paired_geometry_b.rs` contains the checker and three controls. No production
geometry, source fields, options, limits or point tables are modified.

## API and binding contract

`paired_geometry_b::audit(boundaries: [&[usize]; 2], triangles: [&[usize]; 2], shared_edge: [usize; 2], points: &BTreeMap<usize, [f64; 3]>) -> Result<PairedDomain, &'static str>`

`PairedDomain::report()` exposes the checked geometry receipt.
`combine_error(&PairedDomain, source_bounds: &[f64], tolerance)` composes the existing
per-fan barycentric export bounds with separately supplied source bounds.

Triangle order is exactly first-patch triangles followed by second-patch triangles.
The report includes that flattened ID list, used point IDs/coordinate bits, patch
triangle counts, shared edge and resulting outer boundary. The parent must bind
those inputs to the actual source certificate, in that order, before claiming a
source/export result. The point map should be the used fan subset, at most 128
entries, retaining the original candidate/joined IDs. Passing the complete
1,114-point candidate map is intentionally outside the checker scope.

The caller must establish original key/position provenance before supplying shared
IDs. Coordinate-only welding is not authorized. A supplies the actual original
face and source-feature metadata; this checker establishes only geometric domain
and indexed-interface facts. C supplies one source certificate over the complete
concatenated input and a common X slab.

## Proof implemented

1. Each input must pass the existing `fullfan_geometry_b::audit`: exact cyclic fan,
   simple YZ boundary, strict kernel apex and embedded disk in working and rounded
   coordinates, with export orientation preserved.
2. The two used vertex-ID sets must intersect in exactly the declared edge's two
   endpoints. That edge must occur on both boundaries in opposite directions.
   Both fans must have the same projected winding. Different IDs may not collapse
   to the same projected vertex in either precision.
3. Every cross-patch triangle pair is checked in both precisions with exact
   `orient2d`. Strict vertex containment, proper edge crossings and nonconforming
   vertex-on-edge/collinear contacts refuse. A common full edge is allowed only
   when it is the declared indexed edge with opposite directed incidence. Shared
   endpoint contacts are allowed only under the already checked ID intersection.
4. Canceling the shared edge must leave one directed boundary cycle, with one
   incoming/outgoing edge per vertex and all boundary edges included.

The two independently embedded disks therefore meet exactly along the one common
edge and its endpoints, with disjoint projected interiors. Their union is an
embedded disk whose boundary is the checked single cycle. Its triangles cover
that joined domain without gaps or overlap. This does not assert that the domain
is the intended cell-trimmed source patch.

The error composition reuses the existing per-fan same-barycentric bound. It
expects one source bound per concatenated triangle, checks the original tolerance
for each patch and reports their maximum. It does not assume f64 and f32 projected
domains are equal. A common unique source root over this joined domain would make
the shared lifted edge agree, but source-root existence, common-slab identity,
source-feature correspondence and global publication remain separate obligations.

## Bounds and refusals

The checker accepts two cyclic fans, at most 64 boundary vertices/triangles each,
128 supplied/used points and 4,096 cross-patch triangle pairs per precision. These
are bounded local checks under the existing geometry policy, not a whole-program
allocation or RSS proof. No tolerance is used to turn a nonzero exact determinant
into a contact or identity.

A boundary fan with no interior apex, a non-cyclic triangulation, more than one
shared edge, a projection fold or an unsupported outside patch will refuse rather
than be guessed into this theorem. If actual capture exposes such a case, report
that discriminator before expanding the supported contract. A projected overlap
alone does not prove a 3D mesh error; it does rule out this common-X graph argument.

## Controls and execution

Root should run filter `paired_b_`:

- `paired_b_two_disks_share_one_edge_and_tile_union`: two embedded square fans,
  one common edge, one outer cycle, valid error composition and bound/count refusals.
- `paired_b_refuses_renamed_shared_vertex_and_wrong_shared_edge`: coordinate
  coincidence cannot replace shared provenance/identity.
- `paired_b_exact_cross_patch_contact_rejects_crossing_containment_and_t_junction`:
  directly exercises the exact cross-patch contact discriminator.

B performed static source inspection and rustfmt parsing/formatting only. No build,
test, field/curve evaluation or geometry replay was executed by B. Actual opposing
fan data were not yet available when this packet was frozen; the synthetic
controls are not acceptance evidence for that real interface.

## Remaining scope

Source-feature curve parameter transport is not proved, owner labels are not
assigned, and neither full-component ownership nor complete retained-outside
coverage is established. The actual same-stage neighbor and exact shared original
record still have to be reconstructed by A and supplied to the checker. Root must
execute the combined source/domain proof and preserve any refusal.

## Static formatting correction

The initial frozen source accidentally retained rustfmt stdout's filename header.
C identified it and the fixed copy removes only that non-Rust header. The geometric
implementation is otherwise identical. Any initial compiler failure must remain
recorded separately; the corrected source still requires root execution.
