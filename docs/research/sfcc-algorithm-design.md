# Stratified Feature-Conforming Contouring (SFCC)

*A novel SDF→mesh algorithm design for CAD applications, synthesized from a verified
literature survey. Hard requirements: exact sharp-feature preservation (no roundover,
including unclassifiable corners) and guaranteed 2-manifold watertight output. Design
only — no implementation.*

**Status:** research note / algorithm design · **Date:** 2026-06-09

---

## Provenance

This note was produced by a fan-out deep-research run: 5 search angles, 23 primary
sources fetched, 114 claims extracted, 25 adversarially verified by 3-vote panels
(2/3 needed to kill a claim) — **23 confirmed, 2 killed**. All survey findings below
rest on claims verified verbatim against primary-source PDFs with unanimous 3-0 votes
unless noted. Killed claims are recorded as **guardrails** at the end.

One claim ("MDC's sharp-feature handling is entirely QEF-based with no feature
taxonomy") died with all three verifiers abstaining (API failures); it is treated as
unverified and **not relied on** — statements about MDC here are conservative.

**Coverage caveat:** the verified evidence base concentrates in the 2001–2013
grid-contouring lineage. Sources from the 2014–2026 angles (NDC, FlexiCubes,
occupancy-based DC, CGAL restricted Delaunay) were fetched but their claims mostly
fell below the verification budget, so the gap analysis could understate recent
progress — particularly on intersection-free embeddings and Delaunay manifoldness
guarantees. See Open Questions §7.

---

## 1. The verified landscape

The literature splits into two camps whose failures are *complementary, not
conflicting* — which is exactly why a hybrid is well-posed.

### 1.1 Feature-exact methods (no manifoldness proof)

| Method | What it proves | Verified gap vs. requirements |
|---|---|---|
| **Dual Contouring** (Ju et al. 2002) | Exact per-edge Hermite data + QEF placement reproduces "a wide class of polyhedral shapes" exactly, *without any explicit feature test* | Provably non-manifold for MC-ambiguous sign configs; adaptive rule guarantees only *closed* (edges in an even number of polygons — possibly 6+). Exactness presumes exact Hermite data, well-conditioned normals, ≤1 feature per cell; regularized/clamped QEFs degrade it — consistent with our observed corner roundover |
| **Extended MC** (Kobbelt et al. 2001) | Feature reconstruction via per-cell normal-cone classification + SVD | The paper *itself* documents classifier fragility: heuristic two-threshold test (θ_sharp ≈ 0.9, φ_corner ≈ 0.7); edge-vs-corner rank imposed a priori (smallest singular value zeroed); reading classification from singular-value magnitudes "is a very unreliable criterion since the singular values not only depend on the angles between the normals but also on their distribution" — i.e. **cell-local spectral corner detection is ill-posed**. MDC's LINE/CORNER snapping inherits this lineage |
| **Cubical Marching Squares** (Ho et al. 2005) | Crack-free on adaptive octrees *by structural invariant* (every face segment shared by exactly two components from the two neighboring cells); inter-cell independence (GPU-friendly); per-face 2D feature sampling removes EMC/DC's inter-cell dependency | Argues only crack-freeness — zero occurrences of "manifold" or "watertight" in the paper. Its face-feature *sampling* is heuristic (normal-cone), the known weak point in reimplementations |
| **MergeSharp** (Bhattacharya & Wenger 2013) | Documents DC/EMC's second structural failure: when the sharp feature doesn't intersect the generating cell (common off-axis), clamping the QEF vertex creates notches/cut corners; not clamping creates fold-back triangles | Conclusions verbatim: "Our algorithm does not guarantee that the output isosurface is a manifold" — the fix lineage trades one hard requirement for the other |

### 1.2 Manifold/topology-guaranteed methods (no feature exactness)

| Method | What it proves | Verified gap vs. requirements |
|---|---|---|
| **Manifold DC** (Schaefer, Ju, Warren 2007) | Strongest manifoldness in the lineage: closed 2-manifold even under adaptive simplification. **Proposition 1**: cluster collapse is safe when the collapsed patch has Euler characteristic 1 and intersects each cell-face's four edges 0 or 2 times (sufficient not necessary; genus-preserving; efficiently checkable bottom-up) | Authors concede (Sec. VII): "Though the surfaces we produce are topologically manifold, they may still contain intersecting polygons" — topological manifoldness ≠ geometrically valid embedding. Feature placement inherits the EMC-lineage QEF/classifier machinery |
| **Dual Marching Cubes** (Schaefer & Warren 2004) | Mesh size insensitive to thin-feature dimensions because the dual grid adapts to features of *f*, not of the contour (thin-walled CSG room: 440 polys vs. 17K DC, 67K MC); features without a classifier via Garland-QEF + Lindstrom pseudo-inverse | Manifoldness claim rests solely on applying plain MC tables to cube-equivalent dual cells — no ambiguity handling, no manifold tables, no repair. **A falsifiable, unproven assertion** |
| **Plantinga–Vegter** (2004/2007) | PL approximation *isotopic* to the true zero set, via interval bounds on f and ∇f driving octree subdivision — exactly our input model | Requires f smooth with 0 a regular value; explicitly "does not apply" to Lipschitz-but-not-C¹ surfaces — i.e. fails precisely at the sharp features min/max CSG creates. The paper notes relaxing the normal-variation condition "seems feasible" — the opening SFCC exploits |
| **Varadhan et al.** (SGP 2004) | Two local checkable criteria — **complex cell** (no sign-change-free surface intersections, no double edge crossings, no ambiguous configs) and **star-shaped** (surface restricted to each voxel/face is star-shaped) — are *sufficient* for MC-extracted surfaces to be homeomorphic to the exact isosurface, on adaptive octrees with crack patching. Checkability demonstrated for Booleans of polyhedra and low-degree algebraic primitives | Implements extraction with heuristic feature-sensitive EMC; manifold output is an empirical report ("in all our reconstructions"), not a theorem. Subdivision provably fails to terminate at tangential primitive contact. Excludes Dual Contouring (violates the sign-preservation property the homeomorphism proof needs) — **the topology guarantee composes with primal extraction only** |

---

## 2. Gap analysis

**No surveyed method satisfies both hard requirements simultaneously.**

- Feature-exact methods fail manifoldness — DC: non-manifold ambiguous configs; EMC:
  classifier fragility + fold-backs; CMS: crack-free only; MergeSharp: explicitly
  non-manifold.
- Manifold methods fail feature exactness — MDC: classifier-inherited roundover +
  conceded self-intersections; DMC: unproven manifoldness; Plantinga–Vegter:
  smoothness precondition; Varadhan: composes only with heuristic EMC, dies at
  tangencies.

The two failure causes are *disjoint in what they constrain*:

- **Feature exactness fails for informational reasons** — cell-local classification
  from SDF samples is ill-posed (EMC's own analysis). Exact analytic feature data
  fixes it. DC 2002 already proved exact data + per-cell placement suffices for exact
  sharp geometry; the failure was always *sourcing/classifying* the data per cell.
- **Manifoldness fails for structural reasons** — missing assembly invariants and
  per-cell disk topology. CMS + Varadhan already proved face-shared segments +
  per-cell disk patches suffice for closed homeomorphic assembly; the failure was
  they never fed exact feature data into it.

One constrains *vertex positions*, the other *connectivity invariants*. That is why
they compose.

This also explains our codebase's pain points precisely: MDC line-snap can hard-snap
LINE/CORNER vertices it classifies, but the classifier inherits EMC's ill-posedness,
so unclassified corners keep roundover — and feeding extra Hermite normals into the
QEF can't help (confirmed no-op) because the failure is informational, not
least-squares conditioning.

---

## 3. The proposed algorithm: SFCC

**Stratified Feature-Conforming Contouring** — a primal, per-cell, certificate-driven
contouring method. Feature topology comes from the CSG tree *symbolically* (never
from a classifier); features are pinned exactly where they cross octree faces;
manifoldness is inherited from structural assembly invariants plus interval-certified
per-cell disk topology.

### 3.1 Data structures

1. **CSG tree** with per-node interval/Lipschitz evaluators for f and ∇f.
2. **Trimmed FeatureGraph** G = (corner points C; feature segments E as analytic
   parameterized curves with endpoints in C). E contains both primitive-native sharp
   edges *and* boolean intersection curves {f_i = f_j = 0} for primitive pairs
   adjacent under a CSG node, each trimmed against the tree by certified
   point-membership classification. Each segment carries its two adjacent **smooth
   strata** (identified primitive surface patches).
3. **Adaptive octree** whose leaves carry certificates:
   - *stratum-incidence set* — interval enclosure of which segments/corners the cell
     can touch;
   - *MC-compatibility certificate* — Varadhan complex-cell + star-shaped tests (or a
     Plantinga–Vegter small-normal-variation surrogate), evaluated **per smooth
     stratum** using the single active primitive's smooth gradient — restoring the
     smoothness precondition away from features;
   - *feature-separation certificate*.
4. **Half-edge mesh** keyed by exact shared octree faces.

### 3.2 Stages

**S1 — Feature compilation (symbolic).** Enumerate, trace, and trim feature curves
from the CSG tree; compute exact corner points where curves meet. Primitive-native
edges come from primitive definitions; boolean seams are the loci {f_i = f_j = 0}
trimmed by the tree.

**S2 — Certified refinement.** Subdivide the octree until every leaf satisfies:
- (i) it touches at most **one** feature segment, or one corner plus its incident
  segments;
- (ii) each touched segment crosses each cell face **at most once, transversally**
  (interval Newton on the curve–face intersection);
- (iii) per-stratum MC-compatibility holds (complex-cell + star-shaped, or
  normal-variation);
- (iv) *degeneracy guard*: past depth D near a suspected tangency, switch to an
  ε-resolution policy — declare contact, locally merge strata, re-certify — instead
  of looping (addresses Varadhan's proven non-termination at tangential contact).

**S3 — Stratified per-cell meshing (primal, CMS-style).** Compute all face data
**once per octree face**, shared by both incident cells: edge iso-crossings plus
**exact feature-curve crossing points** (the CMS face-feature, but analytic — not
normal-cone sampled). Then per cell:
- *Smooth cells* triangulate their face-segment loop as a disk.
- *Edge cells* split the in-cell patch into two strata sides attached to a feature
  polyline sampled **on the analytic curve** between its pinned entry/exit face
  points (in-cell by construction; chord error certified via curve Lipschitz data).
- *Corner cells* emit the **exact corner point** and fan each incident stratum wedge
  around it — arbitrary corner valence; **no classification step exists to fail**.

**S4 — Certification and assembly.** Verify every interior face segment is used
exactly twice with opposite orientation (closedness — the CMS invariant); every
per-cell patch is a disk (guaranteed by S2 certificates). Together these yield a
closed 2-manifold homeomorphic to the exact boundary via the Varadhan argument.
Optional *embedding check*: confine each cell's triangles to the cell plus certified
curve-chord envelopes (targets MDC's conceded self-intersection gap). Failed cells
refine and re-mesh **locally** — inter-cell independence makes this cheap.

**S5 — Optional manifold-safe decimation.** MDC Proposition-1 clustering on smooth
regions only; feature chains locked.

### 3.3 Stated deltas over prior work

| vs. | Delta |
|---|---|
| **MDC** (ours included) | Exact analytic feature loci replace LINE/CORNER classification + QEF snapping — unclassified-corner roundover is eliminated *by construction*, not by a better classifier |
| **EMC / DC** | No normal-cone or spectral classifier; no QEF, hence no out-of-cell minimizer and no clamping dilemma (notches vs. fold-backs) |
| **CMS** | Heuristic 2D face-feature sampling replaced by exact curve–face intersections; a manifoldness argument added on top of its crack-free invariant |
| **Varadhan** | Exact feature stratification replaces heuristic EMC; ε-degeneracy policy for their proven tangency non-termination |
| **Plantinga–Vegter** | Interval certification applied per smooth stratum (where the CSG SDF locally equals one primitive's C¹ SDF), extending their guarantee around the non-smooth feature set |
| **DMC** | Its feature-of-f sizing reused only as a refinement oracle for thin features; contouring stays primal |

### 3.4 Why requirement 1 (feature exactness) holds

Every feature vertex and every face-crossing point lies *exactly* on an analytically
defined feature curve or corner of the CSG tree. Feature edges appear as explicit
mesh edge chains with zero roundover. There is no cell-local classifier — the
verified ill-posedness of spectral/threshold classification is **bypassed, not
solved** — and no QEF whose minimizer can escape the cell.

### 3.5 Why requirement 2 (manifoldness) holds

- *Closedness* is structural: the shared-face-segment invariant (CMS) guarantees
  every interior segment bounds exactly two patches.
- *2-manifoldness* follows from per-cell disk patches + identical face intersection
  patterns: homeomorphism to the exact boundary (Varadhan), which is a 2-manifold for
  valid CSG solids.
- *Thin features* are protected because the complex-cell criterion forces refinement
  until sheets separate, with DMC-style feature-of-f sizing keeping that refinement
  economical.
- *Decimation* preserves manifoldness and genus by MDC Proposition 1.

Note the proof obligations: the composition holds only where the published theorems'
preconditions hold (manifold exact boundary, no tangential contact, smoothness away
from the stratified feature set, terminating refinement).

---

## 4. Expected failure modes

1. **Exact / near-tangential primitive contact** — refinement blow-up; the ε-policy
   changes topology by declared contact. A deliberate, logged decision, not silent.
2. **Genuinely non-manifold exact boundaries** (e.g. two cubes meeting at an edge) —
   out of scope by theorem preconditions; must be detected and reported, not meshed.
3. **Incomplete FeatureGraph silently degrades exactness** — a missing seam curve
   means that feature falls back to smooth-cell treatment. Mitigation: an interval
   audit flagging high-normal-variation cells with **no assigned feature**. Directly
   relevant given the rotation-transform feature-culling bug we root-caused.
4. **Intersection curves without closed form** (quadric–quadric and worse) need
   certified numerical tracing, not symbolic solutions.
5. **Loose interval bounds on deep CSG trees** cause over-refinement; cost is
   unvalidated on TypeScript/WebGPU.
6. **Slivers near pinned face points** need feature-aware quality improvement that
   must *never move feature vertices off their loci* (interacts with the
   iso-simplicial §4.1-style improvement pass).

---

## 5. Open questions to validate before/while implementing

1. ~~Does our FeatureGraph include **boolean intersection curves**?~~ **Answered
   (2026-06-09): no — primitive-native edges only.** The FeatureGraph
   (`src/scene/feature-graph-buffer.mts`) has no seam representation; CSG only
   *trims* features (stage 4 alive/dead in `src/feature-graph/feature-graph-stages.mts`),
   never creates them. Boolean seams exist only as per-voxel point samples tagged by
   the shader CSG operators (`src/shaders/hg_sdf.wgsl` `op*Mid`) and per-cell
   post-hoc normal-clustering inference in the exporters
   (`src/export/shrec/mdc-cell-features-cpu.mts`) — the cell-local-heuristic pattern
   SFCC eliminates. S1 must therefore add: analytic/certified-traced intersection
   curves (voxel seam tags usable as tracing seeds for owner pairs), CSG trimming of
   those curves, and **seam–seam corner points** — which nothing computes today and
   which likely account for the residual unclassified-corner roundover, since
   boolean-created corners can never appear in a primitive-native FeatureGraph.
   Remaining sub-question: can completeness be audited automatically
   (interval-flagging cells with high normal variation but no assigned feature)?
2. Can the Varadhan star-shaped/complex-cell certificates (or a Plantinga–Vegter
   normal-variation surrogate) be evaluated efficiently **per smooth stratum on GPU**
   for deep CSG trees — and how loose do interval bounds get before over-refinement
   dominates cost?
3. What ε-degeneracy policy at near-tangencies best preserves watertightness while
   producing CAD-acceptable topology (declare-contact merge vs. forced separation)?
   Can guaranteed termination be recovered via the BSP-style subdivision along
   primitive supporting planes that Varadhan et al. sketched but never developed?
4. Can global **self-intersection freedom** (the gap MDC explicitly concedes) be
   proven for the stratified primal scheme via per-cell containment + curve-chord
   envelopes, or does it need a certified post-hoc check with local re-refinement?
   How do 2014–2026 methods (occupancy-based DC, restricted Delaunay with feature
   protection) compare on this axis? *(The under-verified part of the survey.)*

---

## 6. Guardrails — claims the verifiers KILLED (do not act on these)

- ✗ **"MDC's sharp-feature handling is entirely QEF-based with no LINE/CORNER vertex
  taxonomy."** Died 0-0 (all three verifiers failed/abstained). MDC *does* classify
  vertex types — do not cite it as classifier-free. Treated as unverified throughout
  this note.
- ✗ **"MergeSharp's 3×3×3 cube-merging guarantees sharp-feature vertices are well
  separated, avoiding degenerate quads / wrong ordering / notches."** Killed 1-2. The
  merging *mechanism* exists but the separation *guarantee* as stated does not hold —
  do not rely on MergeSharp-style merging as a correctness argument.

---

## 7. Sources

Verified load-bearing (claims confirmed 3-0 against primary PDFs):

- Ju, Losasso, Schaefer, Warren — *Dual Contouring of Hermite Data*, SIGGRAPH 2002. <https://www.cs.rice.edu/~jwarren/papers/dualcontour.pdf>
- Schaefer, Ju, Warren — *Manifold Dual Contouring*, IEEE TVCG 2007. <https://people.engr.tamu.edu/schaefer/research/dualsimp_tvcg.pdf>
- Kobbelt, Botsch, Schwanecke, Seidel — *Feature Sensitive Surface Extraction from Volume Data* (Extended MC), SIGGRAPH 2001. <https://www.graphics.rwth-aachen.de/media/papers/feature1.pdf>
- Schaefer, Warren — *Dual Marching Cubes: Primal Contouring of Dual Grids*, 2004. <https://www.cs.rice.edu/~jwarren/papers/dmc.pdf>
- Bhattacharya, Wenger — *MergeSharp*, CGF/EuroVis 2013. <https://onlinelibrary.wiley.com/doi/10.1111/cgf.12088>
- Ho, Wu, Chen, Chuang, Ouhyoung — *Cubical Marching Squares*, Eurographics 2005. <https://www.csie.ntu.edu.tw/~cyy/publications/papers/Ho2005CMS.pdf>
- Plantinga, Vegter — *Isotopic meshing of implicit surfaces*, The Visual Computer 2007. <https://link.springer.com/article/10.1007/s00371-006-0083-6>
- Varadhan, Krishnan, Sriram, Manocha — *Topology Preserving Surface Extraction Using Adaptive Subdivision*, SGP 2004. <http://gamma.cs.unc.edu/RECONS/topology.pdf>

Fetched but under-verified (claims fell below the verification budget; inform the
open questions, not the design's correctness arguments): Boissonnat–Oudot restricted
Delaunay; Cheng et al. PSC Delaunay refinement (SODA 2007); CGAL Mesh_3; feature-aware
DC variants (TOG 2019); occupancy-based DC (SIGGRAPH Asia 2024, via verifier
citations); NDC (arXiv 2202.01999); FlexiCubes-adjacent (arXiv 2308.05371,
2505.04590, 2506.09579); CSG boundary-evaluation sources (IMR 2019; CAGD 1999).
