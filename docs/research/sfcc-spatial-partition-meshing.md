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

---

## Outcome — built the substrate, measured the ceiling, NO-GO (2026-06-16)

Slices 1–4 were implemented in the Rust kernel (the in-process substrate, all
proven equivalent to serial by `gcad-wasm/kernel/tests/spatial_partition.rs`; the
serial shipping path stays byte-identical throughout):

- **1** separable pipeline + shared-table partition — `bd0511ff` (byte-identical)
- **2** Morton/Z-order load-balanced leaf partition — `afb5d58a` (canonical-equiv)
- **3+4** separate-per-worker tables with halo-aware coarse-side T-junction
  contouring + the by-key merge into the shared S4/manifold gate — `d3d99e9a`
  (canonical-equiv)

Before building slice 5 (the JS Web-Worker layer — the only place a speedup
appears) we **measured the parallelizable fraction first** (phase wall-clock
timing, `3870b456`: `run_sfcc_pipeline_profiled` + `js_sys::Date::now`, timing-only,
mesh unchanged). `p = (contour + cell_mesh) / total`, in real wasm (single-thread
shipping `pkg/`):

| scene class | example | total | **p** | octree (serial) | Amdahl ceiling N=4 / 8 / ∞ |
|---|---|---|---|---|---|
| boolean+blend CAD | mech d7 | 4.5 s | **0.30** | 59% | 1.29× / 1.36× / 1.43× |
| boolean+blend CAD | mech d8 | 11.4 s | **0.30** | 62% | 1.29× / 1.36× / 1.43× |
| twisted extrude | polygon-twisted d10 | 0.77 s | **0.50** | 28% | 1.6× / 1.8× / 2.0× |
| twisted extrude | sfcc-twisted-L d8 | 0.26 s | **0.63** | 22% | 1.9× / 2.2× / 2.7× |

Ceilings are `1/((1−p) + p/N)`, **before** subtracting worker serialization
(clone sdf_tree + feature_set + octree + halo to N instances) and the serial
by-key merge of 90k–240k verts.

**The double-bind that kills it.** This design parallelizes contour+cell_mesh and
keeps the octree **serial** (global 2:1 balance ripple). But which phase dominates
is scene-dependent, and the two regimes are mutually exclusive in exactly the
wrong way:

- **Large meshes** (where worker overhead would amortize) are **octree-dominated**
  → ceiling ~1.3×.
- **High-`p` meshes** (twisted, ceiling ~2×) are **small/fast** (260–770 ms) → the
  serialize + spawn + merge overhead dominates and single-export goes *slower* —
  the exact failure the earlier TS web-worker offload hit (warm-up cost; abandoned
  2026-06-14).

No scene is both large (amortizes overhead) **and** high-`p` (good ceiling). So
slice 5 as designed loses universally.

**Why the premise didn't hold.** This doc assumed contour dominates (`faceContour
≈52%`, from *TS* profiling). In the Rust port the Illinois root-find + the
crossings memo made `axis_plane_crossings` cheap, so the octree's cost shifted to
**smoothCrit** (the ∇f cone over `.round()` blend bands). On the mech, octree is
~60% and smoothCrit-bound — which is also why the crossings memo gave ~0% there.

**Where the only worthwhile large-mesh lever actually is.** The octree *build*
dominates large meshes and is the phase this design keeps serial. Its *decision*
(`classify_cell_features` + smoothCrit certs) is per-cell-independent pure-read —
so the route with a real ceiling is a tax-free **cross-instance per-wave
scatter/gather of the decision** (not the meshing). That is a *different*
architecture than these slices provide; in-module rayon for it is dead (atomics
tax, measured separately). Not pursued here.

**Verdict: NO-GO.** Slice 5 not built. The substrate (slices 1–4) + phase timing
are committed, tested, and byte-identical, but unused.
