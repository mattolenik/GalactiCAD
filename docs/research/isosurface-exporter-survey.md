# Mesh Exporters vs. the Isosurface-Extraction Literature

*A research synthesis comparing this project's four SDF→mesh exporters to the academic
literature on sharp-feature-preserving isosurface extraction, and proposing concrete
cross-pollination improvements.*

**Status:** research note · **Date:** 2026-06-03

---

## Provenance

This note was produced by a fan-out deep-research run: 20 primary sources fetched, 95
claims extracted, 25 adversarially verified by 3-vote panels (2/3 needed to kill a
claim) — **21 confirmed, 4 killed**. Findings below are anchored to confirmed claims;
points marked *(engineering judgment)* are extrapolations, not literature claims. The
four killed claims are recorded as **guardrails** so future readers don't re-introduce
the errors the verifiers caught.

The four exporters (as built in this repo) and their shared infrastructure:
- All source sharp features from a shared **FeatureGraph** (explicit corner points +
  crease segments, CSG-survival-filtered).
- All place vertices via **QEF** (quadratic error function) solves.
- All run a shared **crease-split** post-pass re-deriving per-face-group normals at ~30°.

---

## 1. Each exporter mapped to its lineage

| Exporter | Closest lineage | What newer work supersedes / augments it |
|---|---|---|
| **MDC** — GPU manifold DC (WGSL, 5 passes, uniform grid) | Ju et al. 2002 *Dual Contouring of Hermite Data*; Schaefer/Ju/Warren 2007 *Manifold Dual Contouring* | Inherits the manifold guarantee but **not** intersection-freedom (verified). Augment with Ju & Udeshi intersection-free placement; CMS as a face-based alternative. |
| **SHREC** — DC + MergeSharp relocation + CSG-seam handling | Wenger/IJK MergeSharp; Ju 2002 QEF | The **tangent-agreement seam heuristic (cos 15°) is the weakest link**, superseded in principle by **exact mesh arrangements** (Cherchi/Attene) that represent intersection curves *exactly as mesh edges* rather than inferring them. |
| **FlexiCubes** — non-ML QEF port + narrow-band | Shen et al. 2023 *FlexiCubes*; Schaefer/Warren QEF | The port **discards the 21 per-cube weight DOFs and the differentiable loop** — exactly the levers the paper credits for feature quality. These weights can be set *analytically* from the SDF. |
| **Iso-Simplicial** — Marching Tetrahedra in adaptive octree, multi-level QEF | Marching Tetrahedra; Schaefer/Warren *Dual Marching Cubes*; adaptive octree contouring | Augment subdivision with **curvature/normal-variation gating + a force-fine mask near features** (OpenVDB `VolumeToMesh` / Kobbelt 2001), and a **restricted-QEF residual γ** sliver-elimination test. |

### Guardrails — claims the verifiers KILLED (do not act on these)

- ✗ **"Nielson's DMC uses octrees / feature-adaptive refinement / QEF vertices."**
  Killed 0–3. Nielson's DMC is *primal contouring of a dual grid* with the same
  separating properties as Marching Cubes; the octree + QEF story belongs to
  **Schaefer/Warren's** later, separate DMC. Keep the two DMCs distinct.
- ✗ **"FlexiCubes = 8 β vertex weights + 12 α edge weights."** Killed 1–2. The count
  (8 + 12 + 1 = 21) is right but the **Greek labels are swapped**. Correct:
  **8 per-vertex weights (α)** for the dual-vertex centroid, **12 per-edge weights (β)**
  for crossing interpolation, **1 γ** for quad splitting.
- ✗ Two further over-broad characterizations of Nielson DMC / Schaefer-Warren DMC
  topological behavior were killed; treat secondhand summaries of those two papers
  with caution and prefer the primary PDFs.

---

## 2. Concrete, actionable improvements (ranked by ROI)

### A. Drop-in **Probabilistic Quadrics** for every CPU QEF solve — *highest ROI*

Confirmed (Trettner & Kobbelt 2020, CGF): probabilistic quadrics treat inputs as
anisotropic-Gaussian-uncertain, have **closed-form** plane/triangle forms, **minimize
via a 3×3 linear solve ~50× faster than SVD**, and are *superior specifically for
isosurface extraction* — "more uniform triangulations, more tolerant to noise, while
still maintaining feature sensitivity."

**The clean hook (engineering judgment, mathematically grounded):** the probabilistic
*plane* quadric for a plane with mean normal `n̄` (isotropic normal variance σ_n²) through
mean point `p̄` (position variance σ_p²) has expectation

```
A = n̄ n̄ᵀ + σ_n² I
b = (n̄·p̄) n̄ + σ_n² p̄
```

So `A` gains a **+σ_n² I** term — which is *exactly the Tikhonov regularization the code
already applies* in `sym3SolveTikhonov` — and `b` gains **+σ_n² p̄**, biasing the
minimizer toward the data points rather than a distant mass point. Two consequences:

1. The regularization becomes **per-plane and data-driven** (σ_n from the actual
   gradient disagreement at each edge crossing — which SHREC already computes for its
   bevel-gradient substitution), instead of one global λ chosen at solve time.
2. Because the σ_n² I term makes `A` **guaranteed positive-definite**, you can replace
   the iterative Jacobi eigendecomposition + pseudo-inverse with a **direct 3×3
   Cholesky solve** — this is where the ~50× vs SVD comes from.

- **Targets:** SHREC's serial MergeSharp relocation and FlexiCubes CPU QEF — pain
  points *(c) serial speed* and *(a) coarse-grid rounding* simultaneously.
- **Home:** the shared `Sym3` path in `src/export/shrec/svd3.mts`; `fc-features.mts`
  point/line constraints stay as zero-noise (infinite-confidence) quadrics that already
  add into the same `Sym3`.

### B. **Exact CSG intersection curves as hard QEF constraints** (replace SHREC's tangent heuristic)

Confirmed (Cherchi/Attene exact mesh arrangements): exact methods compute intersection
curves *exactly as mesh edges*, then classify inside/outside. The principle transfers
without doing full mesh booleans: for a CSG seam between operands `f` and `g`, the seam
is the analytic curve `{f = g = 0}`, evaluable directly from the SDF tree.

- **Targets:** *(f) arbitrary-dihedral seams*, *(a)*, and indirectly *(e)* — an
  analytically-derived curve is **transport-robust**, immune to the FeatureGraph
  rotation/packing bug.
- **Sketch:** at seam cells, instead of corner-voxel tangent agreement (cos 15°),
  Newton-project the cell center onto `{f=0} ∩ {g=0}` (two SDF evals + their gradients →
  a 2-plane intersection line) and inject that line as the existing crease constraint
  `ATA += w·(I − t⊗t)`. Makes SHREC's seam path geometric rather than probabilistic.

### C. **Adaptive per-cube QEF regularizer λ** (replaces fixed `qefRelCutoff`/Tikhonov)

Confirmed (Chen et al. 2022, via FlexiCubes supplementary): start λ = 0.01, **double
until the solution lands inside the cube**, cap 1e6 — good vertices *and* guaranteed
in-cell placement (topology safety). The paper calls it "too time-consuming for a
gradient-based loop" — but this project is **not** in a gradient loop, so the objection
doesn't apply.

- **Targets:** *(a)* rounding + *(d)* topology. Applies to FlexiCubes `qefRelCutoff`,
  SHREC `relCutoff`, even MDC (bounded 6–8 iterations in WGSL).

### D. **Analytic FlexiCubes weights** — recover the discarded DOFs without ML

Confirmed: classic isosurface algorithms "lack the degrees of freedom for high-quality
feature-preserving meshes"; FlexiCubes' 8 α + 12 β + γ are that lever and quantitatively
help (Edge Chamfer Distance 0.42 vs DC-Hermite 3.82 at 128³). The ML loop *learns* them;
with an analytic SDF you can *compute* them.

- **Sketch:** set the 12 per-edge β from crossing sharpness (gradient-magnitude ratio
  across the edge); set the 8 per-vertex α from FeatureGraph-corner proximity; fire the γ
  quad-split when two creases cross a cell so the diagonal aligns to the crease (already
  partially done via diagonal-flips in `fc-stitch.mts`).

### E. **Curvature-gated + masked refinement** for Iso-Simplicial

Confirmed (OpenVDB `VolumeToMesh`): Kobbelt-2001 feature-sensitive extraction
(tangent-plane intersection = a normal QEF), **normal-variation-gated adaptive merging**,
and a **boolean adaptivity mask** that forces fine meshing in chosen regions.

- **Targets:** *(b)* narrow-band/coarse pass missing thin features and *(a)*. Generalizes
  the existing `signchangeGated`: gate subdivision on second-difference normal variation,
  and force max depth in any cell a FeatureGraph corner/crease touches — features can
  never be merged away.

### F. **MDC intersection-freedom** (correctness gap)

Confirmed: Manifold DC guarantees a closed 2-manifold (the two local conditions
`χ(Sv)=1` and 0-or-2 face-edge intersections) **but explicitly does not prevent
self-intersecting polygons** within a cell. For CAD output (downstream booleans, 3D
printing) this matters. Add the Ju & Udeshi intersection-free test as an opt-in
post-check, or clamp multi-vertex cells when the QEF residual implies crossing.

---

## 3. Is a 5th exporter justified?

**Yes — Cubical Marching Squares (CMS) is the standout candidate.** Confirmed (Ho et al.):
CMS decomposes 3D contouring into **independent per-face 2D marching squares**, where the
per-face table **detects sharp features and resolves topological ambiguity locally**, is
**crack-free under adaptive resolution by construction**, and achieves **lower average
geometric error than both DC and Extended MC**.

Why it complements the existing four rather than duplicating them: all four current
exporters are QEF-dual and depend on the **FeatureGraph** as the feature oracle — so the
rotation/packing bug (pain *e*) degrades *all of them simultaneously*. CMS **self-detects
sharp features per face from the local SDF**, giving a FeatureGraph-*independent*
robustness fallback. It is also the only primal-dual hybrid not already present.

**Runner-up: Schaefer/Warren Dual Marching Cubes** (primal-on-dual; dual vertices at
features of the *implicit function*, carrying position **+** a scalar value). Confirmed
killer property for pain *(b)*: captures thin walls/tubes **without subdivision** — the
paper's room is **440 polys (DMC) vs 17K (DC) vs 67K (MC)**, mesh size *insensitive to
wall thickness*, needs only grid-vertex gradients (not full Hermite).

**Recommendation:** Do not start with a 5th exporter. Land **A (probabilistic quadrics)**
and **B (exact seam curves)** first — drop-in, hit three pain points, and de-risk the
FeatureGraph dependency. *Then* prototype **CMS** as the FeatureGraph-independent fallback
if robustness insurance against bugs like *(e)* is wanted.

---

## Sources (all verified primary)

- Ju, Losasso, Schaefer, Warren 2002, *Dual Contouring of Hermite Data* — https://www.cs.rice.edu/~jwarren/papers/dualcontour.pdf
- Schaefer, Ju, Warren 2007, *Manifold Dual Contouring* (TVCG) — https://people.engr.tamu.edu/schaefer/research/dualsimp_tvcg.pdf · https://www.cs.wustl.edu/~taoju/research/dualsimp_tvcg.pdf
- Schaefer & Warren, *Dual Marching Cubes: Primal Contouring of Dual Grids* — https://www.cs.rice.edu/~jwarren/papers/dmc.pdf · https://www.researchgate.net/publication/4099304_Dual_marching_cubes_Primal_contouring_of_dual_grids
- Nielson 2004, *Dual Marching Cubes* (IEEE Vis) — http://vis.computer.org/vis2004/dvd/vis/papers/nielson2.pdf
- Ho et al., *Cubical Marching Squares* — https://www.cmlab.csie.ntu.edu.tw/~robin/courses/gm07/present/cms.pdf
- Trettner & Kobbelt 2020, *Fast and Robust QEF Minimization using Probabilistic Quadrics* (CGF) — https://onlinelibrary.wiley.com/doi/abs/10.1111/cgf.13933
- Shen et al. 2023, *FlexiCubes: Flexible Isosurface Extraction for Gradient-Based Mesh Optimization* — https://arxiv.org/abs/2308.05371 · https://nv-tlabs.github.io/flexicubes_website/flexicubes_suppl.pdf · https://research.nvidia.com/labs/toronto-ai/flexicubes/
- *Dual Contouring: The Secret Sauce* — https://www.researchgate.net/publication/2566215_Dual_Contouring_The_Secret_Sauce
- Cherchi et al., exact mesh arrangements — https://www.gianmarcocherchi.com/pdf/mesh_arrangement.pdf · https://dl.acm.org/doi/10.1145/3550454.3555460 · https://arxiv.org/html/2405.12949v2
- OpenVDB `VolumeToMesh` (Kobbelt 2001 feature-sensitive extraction) — https://github.com/AcademySoftwareFoundation/openvdb/blob/master/openvdb/openvdb/tools/VolumeToMesh.h
- Tangency-aware low-res recovery (*Reach for the Spheres* family) — https://arxiv.org/abs/2202.01999
