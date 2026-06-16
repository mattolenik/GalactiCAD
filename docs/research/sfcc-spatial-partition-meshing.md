# SFCC spatial-partition parallel meshing (tax-free, for large meshes)

Design for the one parallelism route that escapes the WASM shared-memory atomics
tax: instead of threading inside one `+atomics` module (rayon — measured
net-negative, M6d), run **N independent, normally-built, non-atomics WASM
instances in plain Web Workers**, each meshing a spatial region, merged on the
main thread. No SharedArrayBuffer, no COOP/COEP, no nightly/build-std.

**Status:** design only. Justified by a real, recurring pain: large single-mesh
export time (twisted-l-500 / heavy-blend class). NOT worth it for small meshes —
the copy+merge overhead loses there, same as rayon's pool overhead did.

Prereqs banked: this rests entirely on the determinism work already shipped —
`canonicalEdgeRoot`, integer-keyed points (`crossingKey`/`interiorKey`), the
keyed `PointTable` dedup, and the `(level,key)`-sorted leaves. Without those the
partition seams would crack; with them they stitch byte-exactly.

---

## Core principle: partition the DOMAIN, never the CSG

The CSG tree is **replicated whole** into every worker (it's tiny — the scene
description). What's split is *which chunk of 3-space each worker turns into
triangles*. The field `f(x,y,z) = full_csg_tree(x,y,z)` is the **same function**
in every worker.

So there is no "CSG after subdivision" to reconcile — the booleans were never
cut. A `subtract` whose tool solid lives mostly in region B is still evaluated
correctly in region A's worker, because A holds the entire tree and the tool's
SDF is defined everywhere. Two regions meshing a shared union surface agree
because they compute the *identical* `f`. Partitioning is purely "who
triangulates which box," never "who owns which operator."

---

## Phase split: keep the global/coupled phases serial, parallelize the heavy ones

The SFCC pipeline is S1 compile → S1b feature set → S2 octree → S3a contour →
S3b cell-mesh → S4 assemble. Two of those phases are inherently global and must
stay serial; they're also the cheaper ones. The expensive phases (contour +
cell-mesh) are per-cell and parallelize cleanly.

**SERIAL (main):**
1. `compile_cpu_sdf` + `compile_feature_set`. Feature compilation is **global** —
   a boolean seam curve can cross any region boundary, so it must be computed
   once over the whole model.
2. `build_octree_feature_aware`. The **2:1 balance ripple is global** (a deep
   cell forces neighbors to refine, propagating across any partition line).
   Building the octree once sidesteps that coupling entirely.

   Output: the full octree (leaves + per-level maps), the feature set, the SDF
   tree.

**PARTITION:** split the *surface* leaf cells (the ones that produce triangles)
into N groups by **Morton / Z-order chunks** — equal cell-count per group (load
balance) and spatially compact (minimizes shared-boundary surface → less halo,
smaller merge). Naive octant split is worse (uneven surface density).

**PARALLEL (N plain Web Workers):** each worker receives `{ sdf_tree,
feature_set, cell_group, halo }` and runs `contour_all_faces` + `mesh_all_cells`
over its group, emitting a partial mesh whose vertices carry **global** point
keys. Each worker is the normal `--release` non-atomics build → full speed, no
tax.

**MERGE (main):** concatenate partial meshes; dedup vertices by global point key;
run S4 (`drop_coincident_triangle_pairs`, `drop_debris_components`,
`flip_sliver_triangles`, `check_manifold`) on the union; emit via `PointTable`.

What's parallel = the phases profiling showed dominate (contour + cell-mesh).
What's serial = octree + features (cheaper, and global anyway) + merge.

---

## The boundary problem — and why SFCC stitches it exactly

A leaf cell in group A shares faces with cells in group B along the partition
surface. For the merged mesh to be watertight those shared faces must be
contoured *identically* and their triangles share the *same* edge.

The mechanism (all from the banked determinism work):
- **Global lattice** → a boundary face has the same `(axis, faceKey)` and its
  edge crossings the same `crossingKey` in both workers.
- **`canonicalEdgeRoot`** → the iso-crossing on a boundary edge is *byte-identical
  regardless of which worker computes it* (proven: 0.0 drift either direction).
- **Keyed `PointTable`** → the merge dedups shared boundary vertices *exactly* by
  integer key; identical positions collapse to one vertex.

So each worker simply contours **all faces of its own cells** (boundary faces get
contoured twice — once per side — but produce bit-identical crossings/segments),
meshes its own cells, and the merge collapses the duplicate boundary vertices.
No coordination protocol; the determinism does the stitching.

**Why the halo is still needed — for octree *structure*, not the field.** Each
worker can sample `f` anywhere (it has the whole tree), but to contour a boundary
face *consistently* it must know whether the neighbor cell across the seam is
refined finer (a T-junction / hanging node, within one level by 2:1 balance). The
**halo** = the neighbor groups' boundary leaf cells (their levels/keys), a subset
of the global leaf set. It lets each worker resolve the shared face's
sub-division the same way its neighbor does. Boundary *feature* cells (a feature
curve or corner straddling the seam) likewise resolve consistently: the feature
set is global and the pin/corner points on the boundary match by key.

---

## Determinism of the result (any N == serial)

The merged mesh must be bit-identical regardless of worker count / partition, so
the existing double-run guard still holds. It does, by construction: each cell's
mesh is deterministic and globally keyed; the union of cells is the same *set*
independent of how it was partitioned; canonicalizing the merge (dedup by key →
sort verts/tris by key) yields a result identical to the serial run. Gate:
`meshes_equivalent(serial, parallel_N, pos_eps=0)` for N ∈ {1,2,4,8}.

---

## Payoff, and the honest ceiling

- **Tax-free:** message-passing (`postMessage`/transferable `ArrayBuffer`), no
  SharedArrayBuffer → **no atomics tax, no COOP/COEP, no nightly/build-std.** Each
  worker is the optimized stable build. This is the whole point — it parallelizes
  the *entire* heavy pipeline at full per-op speed, unlike rayon which ran the
  whole module ~2× slower.
- **Amdahl:** if contour+mesh ≈ 60–70% of total, N=4–8 → ~2–3× realistic, capped
  by the serial octree+features+merge and the copy/merge overhead.
- **Overheads (the ceiling):** serializing `{sdf, feature_set, cell_group, halo}`
  into each worker (the feature set is the bigger copy — curves/corners/strata);
  and the merge's key-dedup of 100k+ verts + manifold audit (serial, O(V+T)).
- **Regime:** pays only for **large** meshes (compute ≫ copy+merge). On small
  meshes the overhead dominates and it loses — same boundary the rayon attempt
  hit. So: gate it on mesh size / cell count, default off for small exports.

---

## Risks / open questions

- **T-junction consistency at seams** — the halo must be exactly enough for each
  worker to resolve boundary-face subdivision identically to its neighbor. Get
  this wrong → cracks. Mitigate by minimizing boundary surface (Morton chunks)
  and a unit test that diffs every boundary face's segments A-vs-B.
- **Feature honoring across seams** — corner-cell wedge fans / edge-cell pin
  routing for a cell *on* the boundary: assign each such cell to exactly one
  group (lowest-keyed owner) so its fan/routing is emitted once; the boundary pin
  points still match by key.
- **`drop_debris_components`** (union-find) is inherently global → runs on the
  merged mesh, serial. Cheap; fine.
- **Load balance** — surface cells cluster; partition the *surface* leaves, not
  all octree cells, and balance by count.
- **Copy cost of the feature set** — if it dominates for small N, consider a
  compact serialized form or transferables.

---

## Effort / slices

Large, multi-fork. Each slice committed + gated (determinism any-N==serial +
SSIM-vs-serial + speedup on a large mesh):

1. **Separable pipeline** — ensure `build_octree` returns the octree and
   `contour`+`cell_mesh` accept `(octree, cell_subset)` (the Rust phases are
   already mostly factored this way).
2. **Leaf partition + halo** — given the global octree, produce N
   `(cell_group, halo)` sets (Morton chunks over surface leaves).
3. **`mesh_cell_subset` entry point** — contour the subset's faces (incl. its
   boundary faces) + mesh its cells → partial mesh with global keys. Native test:
   union of all subsets' partials == serial mesh (bit-identical).
4. **Merge** — key-dedup + S4 audits on the union; manifold + determinism gate.
5. **JS orchestration** — N plain Web Workers each loading the non-atomics wasm,
   receiving `{sdf, feature_set, cell_group, halo}`, returning `{verts, tris}`;
   main partitions + merges. Behind a `sfccPartitions=N` flag.
6. **Measure** — large-mesh export time vs single-thread; confirm the tax-free
   win materializes (the per-op speed is full, unlike rayon).

Note (vs the parent's perf scorecard): this is the *only* parallelism avenue not
yet ruled out — rayon (atomics tax), generic pruning (build cost), and constant-κ
were measured net-negative; the analytic blend cert (position-aware) is the lone
in-pipeline win. Spatial partitioning is the structural route, language-agnostic,
worth building only when large-mesh export time is the binding constraint.
