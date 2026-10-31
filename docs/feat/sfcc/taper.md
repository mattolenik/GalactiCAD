# SFCC: the `taper` operator

Status: **implemented (v1 — field-conforming, not feature-conforming under the warp)**
Date: 2026-10

`taper(ratio, height, node)` is exportable through the SFCC (Rust/WASM) mesh exporter.
Previously any scene containing a taper node was rejected at the TS serializer with
`sfcc-rs: unsupported node "taper"`. The preview (WGSL) and MDC paths already supported
it; this closes the gap for the default exporter: **every taper scene the preview
renders now exports**, with the same field semantics evaluated in f64.

## What was built

### Wire format

- **TS** (`src/export/sfcc-rs/scene-bridge.mts`): `Taper` serializes to
  `{ kind: "taper", node_id, ratio, height, arg }`. The serializer fails fast on
  `ratio <= 0` or `height <= 0` (NaN-safe `!(x > 0)` guards, mirroring the Rust side).
- **Kernel** (`gcad-wasm/kernel/src/scene_bridge.rs`): a new `BridgeNode::Taper`
  variant. The bridge validates the same parameter domain and rejects degenerate
  tapers with the standard `UnsupportedNode` error (message names the node id and
  parameter).

### Evaluator (`CsgNode::Taper`)

New kernel tree variant `CsgNode::Taper { ratio, height, sim, child }` where `sim`
is the similarity accumulated **at the taper node** — the warp acts in its own frame,
so `rotate(taper(x))` tapers along the rotated axis. Math (`src/sdf/taper.rs`,
`src/sfcc/field_branches.rs::compose_taper_sample`) is the f64 port of the preview's
`taperPoint` / `sdfTaperFast` / `sdfTaperNormal`:

```
local = sim⁻¹(p);  s = 1 + (ratio−1)·clamp(local.y/height, 0, 1)
q    = sim(local.x/s, local.y, local.z/s)
F(p) = child(q) · min(s, 1)
∇F   = min(s,1)·R·[Jᵀ_warp·(Rᵀ∇child)] + child·∇c   (full chain rule incl. the
       nyCross y-term and the d·dc/dy correction term)
```

Because the correction `min(s,1)` is positive and child-independent, the warp
commutes **exactly** with hard union/subtract/intersect and with negation
(`taper(−f) = −taper(f)`); blends compose through it the same way the preview
composes them (the whole subtree is evaluated at the warped point). `Pruned`
(Lever-1) carries a mirrored `Taper` variant that prunes the child against the
warp image of the query region.

### Certification

- `interval_over_box` / `zero_owners_over_box` / the checked partial enclosure
  (`sdf/enclosure.rs`) map the query box through the warp into a conservative
  child-space box hull (s is monotone piecewise-linear in y, so clamped endpoint
  scales bound it; x/z and s vary independently, so the four `v/s` corner
  candidates bound each axis), then scale the child interval by the correction
  range `[min(s_lo,1), min(s_hi,1)]` with sign-aware endpoint pairing.
- Discovery's per-leaf corner-sign algebra probes leaf fields at world points,
  which is meaningless under a warp: `collect_zero_owners` collapses a warp
  subtree's entries to a single `Opaque` marker while keeping the mapped
  (still-excluding) interval. Opaque only forfeits that guard's sign theorems,
  never soundness — warped regions resolve through the ordinary field criteria
  (`tree.interval_over_box`, sampled normal variation), the same path blend
  bands already use.
- `interval_over_ball` for a warp routes through the ball's bounding cube (a
  conservative superset of the image).

### Features under the warp (the v1 contract)

Leaves under a taper are marked `warped` during the bridge walk (a ratio-1 taper
is the identity and does not mark them — its carriers stay exact). Marked leaves:

- get **no strata and no native curves/corners** (`build_leaf_strata` returns an
  empty list; `compile_native_features` skips them) — their unwarped carriers
  would describe the *child* surface and actively misguide projection/tracing;
- still count in the leaf indices, seam displacement, scene diagonal (inflated),
  and the tree view's world AABB (inflated by `(warp_scale−1)·halfdiag`, where
  `warp_scale` is the product of each ancestor taper's `max(1, ratio)`);
- receive no blend-chamfer/branch-pair analytic patches inside the warp
  (`blend_surfaces` contributes one field patch whose `FieldRef` ends *at* the
  warp node, sampling the correct warped field).

Warped regions refine by the sampled normal cone like blend bands do. With
`blendCurvatureRefine: false` (which switches the blend cone off) they fall
back to the regular `normalVariationDeg` cone instead of losing their only
criterion — otherwise curved warped walls mesh at whatever coarse level first
showed a sign change (`refine_criteria.rs`, detected through the warped
active owners at the cell center).

Result: **correct geometry everywhere** — the surface, signs, gradients, and
projection agree with the preview — but warped creases are resolved by octree
refinement down to the lattice rather than by feature carriers, and cells that
cannot resolve at `depth_max` are meshed best-effort and counted in
`stats.degenerate_cells` (validation reports `ok=false` while the mesh itself is
watertight; `manifold.ok` / `off_surface_vertices` are the meaningful gates).

## Validation

- `cargo test -p gcad-kernel`: warp field parity vs. the composed child, interval
  enclosures over rotated/scaled frames vs. sampled fields, negate/boolean
  commutation, pruned-view bit parity, owner-distance scaling, bridge JSON tests
  (rotated frames, subtract-under-taper, degenerate-parameter rejection).
- Gradient parity: `taper_derivatives_match_the_scalar_field_through_warps_and_blends`
  checks the analytic warp differential against central finite differences through
  nested warp → union → round-blend → rotated-frame scenes (same harness the blend
  modes use).
- End-to-end (`kernel/tests/taper_mesh.rs`): tapered prism (narrowing + widening)
  meshes closed (pipeline manifold report), deterministic across runs, and
  respects the mid-band width; `taper(subtract(box, cylinder))` (the bowl.gcad
  shape) carves the shrinking bore; `taper(round-blend union)` meshes.
- Preview parity follows from construction (same formulas, f64 vs f32); visual
  regression via `agentcli triangle`/`regress` when a taper testcase is captured.

## Shortcomings (known, accepted for v1)

### The bowl case (taper over thin-walled lofts) — resolved

`src/scene/samples/bowl.gcad` (`taper(180/170, 150, subtract(loft, loft))`)
first exported with horizontal strips of missing wall and, at depth 9, missing
patches on the corner arcs. Diagnosis on the exact scene
(`fixtures/bowl-taper.json`, probed by `kernel/tests/bowl_exact.rs`):

- The warp field is exact and the wasm build is bit-identical to native on
  this scene (same triangle count and Euler number at depth 8 and 9); the
  native-vs-wasm "knife edge" seen earlier was a hand-built approximation of
  the scene plus a different world cube, i.e. a different lattice phase.
- The wall is **0.6 mm on a 0.73 mm depth-8 step**. Where the slab threads
  between two lattice planes, every corner of a cell is outside: the cell
  refines to the ceiling, is kept degenerate, and contours nothing. The
  taper's widening drifts the wall through one lattice period every ~21 mm of
  height, so the misses read as horizontal strips (8.6 % of the outer wall,
  all on the flats, every hole cell with all 8 corners outside and its center
  inside). Where the slab crosses a cell edge whose two endpoints are both
  outside, face contouring joins the wall's two sides into a slit; those are
  the ~500 handles the Euler number reported on an otherwise closed mesh and
  the corner-arc defects at depth 9.
- Carriers would not have helped: the same-sign refinement path and face
  contouring see only corner signs with or without strata, and the carrier
  path on these 114-section lofts does not finish in 40 min.

**Fix (general, not taper-specific): the interior-sign witness.** At the
refinement ceiling, a featureless cell (no curve/corner tag) that still demands
a split is now tested for a sub-step sheet before being kept degenerate: an
edge midpoint, face center or cell center whose sign differs from all the
corners around it. Such a cell may split up to `SHEET_EXTRA_DEPTH` (2) levels
past `depth_max`; the pipeline's lattice is built that much deeper so it has
room (`octree.rs`, `pipeline.rs::build_pipeline_context`). Feature-tagged
cells keep the ceiling: their pin/corner certificates must stay consistent
with their neighbors' (refining one past a rib junction on the bracket scene
pinched a non-manifold vertex). Measured on the exact bowl at the
default depth 8, through the app's own export path: one watertight component,
Euler 2, zero off-surface vertices, no missing surface on the outer wall,
cavity wall, floor or underside, and the same topology with the lattice phase
shifted by half a step. Cost: ~1.4 M triangles and ~3 min natively (was
0.8 M / 2 min with the holes). Pinned by `kernel/tests/thin_sheet.rs` (a
hollow box with walls below the step, with and without a warp). Residual at
depth 8: the rim ring (0.63 mm wide, two uncarried creases) can be bevelled by
up to one cell (0.6 mm) where a lattice plane grazes the outer surface — one
~25 mm stretch of the 700 mm rim at the default phase, none at the shifted
phase. That is the v1 crease-at-lattice-resolution contract, not a hole.

**Cost structure and the decimation post-pass** (exact bowl, single-threaded;
wasm and native agree within 5%). Depth 7: 1.19 M triangles, 71.5 s — octree
decide 24 s, octree apply 17 s (the per-child `certified_empty` intervals for
every sheet split plus the witness samples), contour 21 s, cell mesh 2 s,
assemble 8 s — and ten slits (Euler −10), so it is not usable. Depth 8: 1.42 M
triangles, 82 s, closed. Depth 9: 2.93 M triangles, closed, rim bevel down to
0.17 mm (643 s before the fix below; not re-measured). Those times are after
memoizing the leaf parameter-validity scans that every interval query used to
repeat (16 µs → 2 µs per interval on this tree; depth 8 was 252 s before), see
docs/sfcc-performance-analysis.md, October 30 follow-up. The raw count is set by the wall, not by the flats: corner-sign
contouring needs a step below the thickness, so the whole 0.6 mm wall ends up
in 0.36 mm cells (~700 k surface cells, two triangles each) even though the
bowl is 32 planar facets per shell band. The kernel's decimation post-pass
(`decimate_tol_mm`, `decimate.rs`; GUI knob *Decimate tol*, default 0.05 mm)
takes them back out: depth 8 → **3 782 triangles**, closed (Euler 2), ~10 s of
field-checked collapses; depth 7 → 2 442 (its slits included). The app's
meshoptimizer post-pass (*simplify on export*) was measured first and rejected
for this job: at ratio 0.1 / error 0.001 it gives 142 k closed, below that it
pinches the wall (non-manifold edges by 0.05, Euler 5 at its 2.8 k floor), and
at a 0.02 mm absolute bound it stalls at 312 k — its area-averaged quadric both
under-reports a wall crossing through sliver triangles and over-reports noise
on them. Export time is a separate problem: the browser runs the serial
`export_sfcc`; the `sfccPartitions=N` flag parallelises only contour + cell
mesh, and the kernel's partitioned decision session (`sfcc_octree_begin`,
`sfcc_decide_partition`) is not called by the TS driver
(docs/sfcc-meshing-algorithm.md §7.2). Measured with `.agents/tmp/bowl-export.mts`
(`DECIMATE=<mm>`), `.agents/tmp/bowl-simplify.mts` and `BOWL_DECIMATE=<mm>` on
`kernel/tests/bowl_exact.rs` (the scripts are scratch, not checked in).

1. **No feature conformance under the warp.** Creases (the taper's own clamp
   creases at y=0/y=height, plus every child crease — box edges, cap rims,
   carve intersections) are meshed at lattice resolution, not traced exactly.
   Expect `degenerate_cells > 0` and `validation.ok == false` on taper scenes
   even though the mesh is watertight. On the default lattice this reads as a
   slightly rounded edge, not a defect in position.
2. **Conservative intervals near the band.** The box image through the warp
   over-approximates (hull of the image, independent x/s pairing), and for
   narrowing tapers the correction shrinks field values toward zero, so cells
   near warped surfaces refine deeper than their unwarped equivalents. Taper
   scenes cost more octree work; benchmarks not yet re-measured.
3. **Blend radii under a warp are approximated by the preview itself** — the
   preview applies one warp around the whole blend (effective radius `r·min(s,1)`,
   position-dependent). The kernel reproduces that exactly, so there is no
   *export vs preview* drift, but a *future* feature-conforming chamfer model
   under tapers will need to decide what radius the carrier uses.
4. **`grad_bound` under a warp is heuristic.** The advisory bound multiplies the
   child bound by `1/min(1, ratio)` and ignores the unbounded off-surface `∇c`
   term (far from the surface the bound is not tight; near the surface, where
   the refinement bands matter, the term vanishes with the value).
5. **`Leaf.warped` is set by the bridge walk only.** Trees built directly via the
   builder functions (`sdf::taper` in tests/examples) must set the flag manually
   (see `warp_all` in `taper_mesh.rs`); the evaluator does not derive it.
6. **Discovery treats warp subtrees as opaque**, so the primitive-visibility
   certificate does not cover warped surfaces; component/cavity discovery falls
   back to the field criteria (same guarantee level as blend bands).

## Todo — finishing the implementation later

- [ ] **Exact lowering: distribute the warp + scaled-section lofts (feature-conforming warped lofts).**
    The correction `min(s,1)` is positive and child-independent, so a taper
    distributes **exactly** over hard union/subtract/intersect (zero sets are
    identical). A taper over a Y-aligned `extrude`/`loft` leaf then lowers to a
    plain loft whose sections are pre-scaled by the clamped `s(y_slot)`
    (zero-set-exact to ~1e-4 mm for the bowl's 114-slot lofts) — full
    strata/features, no warp node. This restores the carrier machinery that
    rescues sub-lattice thin walls (the bowl's 0.6 mm wall). Caveat found in
    repro: the strata path on 100+-section lofts can OOM at coarse depths —
    the lowering must be paired with loft carrier-budget work. Implement in the
    TS serializer (it sees profiles + accumulated transforms); kernel unchanged.
- [ ] **Parallel export for thin-wall scenes.** Wire the resumable decision
    session + partition pool into `sfcc-rs-exporter.mts` (decide and contour are
    ~65% of the bowl's time and per-cell pure), and let a split decision carry
    its eight children's `certified_empty` bits so the serial apply stops
    re-evaluating loft intervals (~30% of the bowl's time).
- [ ] **Bespoke warped carriers (general case).** Add a `Tapered` stratum carrier
    wrapping an inner carrier — the in-band image of a vertical plane is a plane,
    a vertical cylinder a cone, a vertical crease a line — following the
    `Stratum::twisted_side` precedent (extrude-twist baked a warp into a leaf
    parameter + carrier instead of a tree node). Needs: warped plane/cone/line
    carrier algebra in `strata.rs`, feature-chain wiring for the clamp creases at
    y=0/height, and `classify_cell_features` support. This is the path to
    `degenerate_cells == 0` on warp scenes.
- [x] **Sub-step sheets** — the interior-sign witness above (holes and slits
    on walls thinner than the lattice step, at any depth). Sheets thinner than
    a quarter step still need a deeper `depth_max`.
- [ ] **Lowering needs loft-carrier performance first.** The exact lowering
    (above) restores carriers, but the carrier path on 100+-section lofts ran
    >40 min without completing on the full-size bowl even with the
    segment-local Lipschitz fix — carrier budgets/indices for tall lofts are
    the blocker to clear before the lowering can ship.
- [ ] **Tight warp intervals.** Replace the 4-corner image hull with the exact
    image interval per axis (x/s over [y0,y1] is monotone per sign region), and
    scale by the exact correction at the sampled y rather than the range when the
    box is inside one sign region. Cuts the extra refinement depth near bands.
- [ ] **Discovery through warps.** Let `check_discovery` warp its probe
    points/boxes per-warp-subtree so warped primitives can use the corner-sign
    theorems again (removes the opaque fallback and its extra refinement).
- [ ] **Partition-worker fixture.** Add a taper scene to
    `gcad-wasm/fixtures/smoke-export-sfcc.mts` once its reference-bin flow is
    regenerated for current scenes; verify `sfccPartitions=N` mesh equality.
- [ ] **Normals export parity check.** Run `agentcli compare`/`triangle` on a
    captured taper testcase (e.g. bowl.gcad) against the preview render and record
    the SSIM baseline here.
- [ ] **Performance re-measure.** Re-run `sfcc-quality-benchmark` with a taper
    scene; if the conservative intervals dominate, pull the tight-interval todo
    forward.
