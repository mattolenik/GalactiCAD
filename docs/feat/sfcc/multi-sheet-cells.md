# SFCC: multi-sheet cells (coarse cells, fine edges)

Status: implemented behind `PipelineTuning::multi_sheet_cells` (kernel default
off, GUI default off). See [export options and defaults](export-options.md).

## The problem

Face contouring reads only the lattice corner signs of a cell, so a cell can
carry one sheet of surface. A wall thinner than the cell is invisible to the
corners (both faces of the wall between two corners of the same sign), and the
only remedy the octree had was to split until the cell was thinner than the
wall. On the bowl sample (0.6 mm walls, 183 mm scene) that puts the entire
wall, flats included, into 0.36 mm cells: ~700 k surface cells, 1.4 M
triangles, for a surface that is 32 planar facets per band. The cell size was
set by thickness, not by curvature.

## The change

A featureless cell may keep several sheets. The cell stays at the level the
curvature criteria chose; its twelve edges are sampled at the finest lattice
spacing (the lattice already runs `SHEET_EXTRA_DEPTH` = 2 levels below the
refinement ceiling), and face contouring, which already discovers interior edge
samples by midpoint bisection, sees every crossing of every sheet. Pieces:

1. **Detection (decision pass, `refine_criteria::sheet_decision`).** For a
   featureless cell, sign changes between consecutive finest-spacing samples
   along the twelve edges give the crossing set. Outcomes:
   * an edge carries two or more crossings, or the corners agree but edges
     cross → candidate multi-sheet cell. It is **kept** when (a) the field
     normals at all crossings lie in the curvature cone by *orientation*
     (|n·n′| ≥ cos θ: a wall's two faces point opposite ways), and (b) on every
     face the crossings pair, the way contouring will pair them (step 3), into
     same-facing pairs. A forced opposite-facing pair means a sheet ends inside
     the cell — the bowl's 0.6 mm rim top is too narrow for most coarse edges
     to hit — and the cell splits like any curved cell (normal depth limits,
     plus the interior sign witness at the ceiling);
   * same-sign corners, no edge crossing, interval straddles zero → below the
     *sheet floor* (`depth_max − SHEET_EXTRA_DEPTH`, at least `depth_min`)
     split as before; at the floor, probe the 27 child-corner points and, if
     they agree with the corners, **keep as unresolved** (nothing is contoured,
     the cell is reported). This stops the empty shell around a thin wall,
     whose loose intervals straddle zero, from refining to the ceiling and
     dragging the wall cells after it through 2:1 balance;
   * mixed corner signs with at most one crossing per edge → the existing
     criteria, except that the sampled tree-normal cone of carrier-less cells
     also compares orientation (`SmoothCriteriaOptions::orientation_cone`).
     Without that, a cell whose boundary falls inside the wall samples both
     wall faces, reads 180° of "curvature" and splits; on the bowl this was
     the difference between 488 k and 87 k triangles.
2. **Seeding (apply pass).** A kept multi-sheet cell and a floor-stopped cell
   are tagged `degenerate` (unresolved: no local coverage certificate). Every
   unresolved featureless leaf below the lattice floor gets its twelve edges
   sampled into the shared cache so the face walk finds the sub-edges.
   Workers re-seed the same set from the tags
   (`SfccOctree::seed_unresolved_sheet_edges`), so serial and partitioned
   contouring agree. The decision codec carries the verdict byte.
3. **Pairing (`contour_face`).** With a wall crossing a face there are four
   boundary crossings and the run rule's pairing depends on the face centre
   landing inside the wall. On faces with four or more crossings and no
   stratum tags, the boundary-adjacent enter/exit pair whose field normals
   agree best is paired and removed, repeatedly; adjacent removal keeps the
   pairing non-crossing for any number of parallel sheets.
4. **Meshing.** Several loops per cell were already legal; each is
   triangulated as a disk (quads stay two triangles), except along creases
   (step 5).
5. **Untagged creases (`face_contour::split_at_creases`, `triangulate_loop`).**
   Coarse cells make the facets of a faceted surface visible: the bowl's
   corner arcs are 8 planar facets per 90° (11.25° creases), its fillet
   profile is piecewise linear (5.6°), and under the taper none of these
   creases is a feature curve. Below the curvature cone a crease crosses
   cells, and the disk triangulation bridges it (the jagged "diamond"
   triangles on the corner verticals; the rim's 90° edges were chamfered the
   same way). The fix keeps the cells and follows the crease instead:
   * per face segment, the in-face tangent lines at its two crossings meet at
     a point; when that point is on the surface (within 8× the root tolerance)
     inside the face, the segment is routed through it as a *crease point*.
     On a smooth surface the tangent lines meet off the surface and nothing
     changes. A segment that crosses several creases (fillet strips 1.33 mm
     apart) is halved at an in-face surface point, up to three times, keeping
     the halves only if one finds a crease. A meet within 5% of the finest
     step of a segment end tags that end; one just past the face boundary is
     pinned to it;
   * a cell loop with two crease points whose chord lies on the surface (and
     not along a cell face) is cut along that chord and each side triangulated
     separately, recursively, so every triangle stays in one facet; when the
     creases meet inside the cell (a facet corner) the loop fans from the
     least-squares meet of its tangent planes. Every crease-path result must
     face the field gradient, otherwise the loop falls back to the plain disk,
     then to whichever loop-vertex fan does not fold.
   Crease points are keyed by face and segment ends (partition-stable) and
   tagged in `PointTable::creases`, which is local to the table that contours
   and meshes the faces.
6. **Decimation** (`decimate.rs`) additionally refuses a collapse that turns a
   surviving triangle's normal more than 2° off the field gradient at its
   centroid (unless it was already that far off): the centroid test alone let
   collapses across 5.6° creases through.

## Measured (exact bowl sample, depth 5/8, native, no decimation)

| | Triangles | Time | Closed |
|---|---|---|---|
| before | 1,416,084 | 82 s | Euler 2 |
| multi-sheet cells | 86,552 | 42 s | Euler 2 |

No holes on any probed face; the rim keeps its pre-existing one-cell bevel.
Coarser cells cost chord accuracy on curved surfaces: the largest probe
distance on the outer wall rose from 0.08 mm to 0.27 mm at the default 18°
curvature cone (a smaller cone refines the arcs further).

With crease points (step 5), on the edited bowl (1.2 mm wall, 160 mm width;
`bowl_exact.rs` prints the "normals" lines: area whose face normal is more
than 1° off the field gradient at the centroid):

| | Triangles | Off-normal area below rim / rim top | Flipped |
|---|---|---|---|
| multi-sheet, no crease points | 79,992 | 12.5% / 32.3% | 65 slivers |
| + crease points | 112,202 | 0.22% / 0.33% | 0 |
| + decimation 0.05 mm (then-GUI default) | 1,716 | 2.6% / 2.9%, 95% of it under 2° | 0 |

The rim probes now sit on the surface (max 0.00 mm, was 0.48 mm with 89
misses). Through the wasm path with the captured GUI tuning the bowl goes from
5,170 to 1,692 triangles. The tapered hollow-box test
(`kernel/tests/thin_sheet.rs`) drops from 14,380 to 8,170 triangles (6,862
before crease points) and its off-normal area from 7.2% to 0.09%; it asserts a
one-third cut and under 0.5%.

## Limits

* Kept multi-sheet cells and floor-stopped empty cells are reported as
  unresolved cells (`validation.ok` is false for the scene, as it already was
  for every taper scene). They carry no local coverage proof.
* A closed component that fits inside a floor-level cell without touching any
  of its edges or its 27 child-corner points is not found. Before, such a
  component was found if it was larger than about twice the ceiling cell. The
  exposure is components between ~0.7 mm and ~1.5 mm at the default depths, in
  scenes where discovery is opaque (lofts, blends, warps).
* Sheets thinner than the finest lattice spacing (0.18 mm at depth 8) are still
  invisible, as before.
* Cells with feature tags, or whose faces carry stratum-tagged crossings, keep
  the old path; scenes made of plain sphere/box primitives go through the
  certified box-discovery check first, which splits multi-root edges before
  detection runs (the untapered hollow box is unchanged).
* Detection walks 12·stride samples per candidate cell. Misses go to a
  value-only walk cache (`Sampler::walked`, capped at 7.3 M entries, freed after
  the build) that later
  decisions and the apply-pass edge seeding reuse; it never marks a sample
  present, so contouring is unchanged. On the bowl this cut the octree build
  from 26.4 s to 11.1 s (docs/sfcc-performance-analysis.md, November 2).

## Default policy

Both native and GUI defaults are off. The initial GUI rollout enabled this mode
while native fixtures retained the earlier empty-shell refinement; that split
made default comparisons misleading. The November 3 options audit aligned the
GUI with native. Explicit saved settings remain enabled until reset.

The performance results above still describe their recorded configurations.
They do not establish complete coverage or preserved feature obligations on the
five original torture models. Those checks are required before default-on;
see [export options and defaults](export-options.md).
