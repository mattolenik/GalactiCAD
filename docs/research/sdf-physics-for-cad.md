# Physics against Signed Distance Fields, for CAD

> Deep-research report — 2026-07-04
> Method: 5 search angles → 22 sources fetched → 103 claims extracted → 25 adversarially verified (24 confirmed, 1 refuted, 3-vote panel, ≥2/3 refutes to kill).

**Research question.** What kinds of physics simulation can be done directly against
signed distance fields (SDFs) that are relevant to CAD? Specifically: (1) physical/geometric
constraints and constraint solving; (2) collision detection and contact resolution against SDF
geometry; (3) rigid-body dynamics — moving one object so it pushes, translates, and rotates
others, with penetration depth and contact normals from SDFs; (4) fluid dynamics / CFD
simulated against an SDF scene without meshing (LBM, SPH, level-set, immersed boundary) — is
it feasible and used in practice? And: does FEA fundamentally require a mesh, or do SDF/meshless
methods exist?

---

## Bottom line

SDF-based physics is real, in production, and directly relevant to CAD/engineering across **every
sub-question except geometric-constraint solving**.

| Sub-question | Verdict | Confidence |
|---|---|---|
| 1. Geometric/assembly constraint solving on SDFs | **Evidence gap** — no source does this; constraints appear only as *contact* constraints | — |
| 2. Collision detection & contact resolution | **Yes, mature & shipping** (PhysX 5, PBD library, CAD-journal algorithms) | High |
| 3. Rigid-body push/translate/rotate | **Yes** — penetration depth + normals + moments straight from the field | High |
| 4. CFD without a body-fitted mesh | **Yes, feasible & in practice** via SDF immersed-boundary (sdfibm, GenSDF, CFD-DEM) | High |
| 5. Does FEA need a (conforming) mesh? | **No** — Finite Cell Method runs FEM on non-conforming grids over CAD/voxel geometry | High |

---

## 1. Collision detection & contact resolution — mature, in production

The strongest part of the answer.

- **NVIDIA PhysX 5** uses SDFs as its collision representation for *dynamic, non-kinematic
  triangle-mesh rigid bodies* — a path that exists **only** in the GPU collision pipeline. It is
  how Unreal/Omniverse/robotics get arbitrary non-convex mesh collision without convex
  decomposition. The identical statement holds across PhysX 5.1–5.5, so it is a stable feature,
  not deprecated.
- **Macklin, Erleben, Müller et al., "Local Optimization for Robust Signed Distance Field
  Collision" (ACM I3D 2020)** — the keystone. SDFs are "a popular shape representation for
  collision detection" for "query efficiency, and the ability to provide robust inside/outside
  information." Testing a *point* against an SDF is trivial; the contribution is extending it to
  *continuous surfaces* (triangle elements) via a **per-element local optimization** that finds
  closest points between the SDF isosurface and mesh elements — accurate contact for sharp
  point-face pairs and smoothly-varying edge-edge contact, across rigid, cloth, **and** deformable
  bodies. Macklin also authored PhysX/FleX/Warp, tying the technique directly to production.
- **PositionBasedDynamics** library (Bender et al., open source) does collision against arbitrary
  triangle meshes by converting them to **cubic SDFs** — a concrete, usable reference
  implementation.

**Confidence: high.** Multiple independent primary sources + shipping engines.

**Limitation observed:** iMSTK's PBD rigid bodies explicitly *cannot* use an SDF as their geometry,
because "SignedDistanceField and ImageData … can't be rigidly transformed." I.e. the practical
pattern is a **static-collider SDF queried by moving bodies**, or an SDF regenerated per-pose — not
a rigidly-transformed SDF instance. Worth designing around.

---

## 2. Rigid-body dynamics — push, translate, rotate — yes

Exactly the "move an object and have it push/rotate others" scenario. The math is clean:

- **Core identities** (textbook, used across the papers): at a surface point ∇φ **equals the
  outward normal**; |∇φ| = 1 (the Eikonal property); the closest-point projection is
  `p(x) = x − φ(x)·∇φ(x)`; and body/body collision **reduces to a point/body query** via the
  Minkowski difference / configuration-space obstacle `C = A ⊖ B` — the distance from the origin to
  ∂C is the **penetration depth** (if inside) or **separation distance** (if outside). Penetration
  depth *and* contact normals fall straight out of the field.
- **Lopez-Adeva Fernández-Layos et al., *Computer-Aided Design* (2024)** — an algorithm computing
  **both** minimum distance and penetration depth between two convex bodies from their SDFs, as a
  convex optimization solved with the ellipsoid method, benchmarked against GJK/MPR. *Caveat:
  proven for convex bodies.*
- **Springer, *Computational Mechanics* (2025)** — reformulates contact detection between rigid
  bodies (each its own SDF) as unconstrained minimization over a derived "Gap Distance Field"; the
  closest contact point is found by projecting SDF gradients and the common-normal condition falls
  out naturally. *Caveat: 2D convex superelliptical.*
- **SDF-enhanced CFD-DEM, Lai/Zhao et al., *CMAME* (2023)** — the most complete rigid-body story.
  Each intruding grid node carries a **normal force `Fₙ = −∂w/∂x`** (derivative of an
  energy-conserving contact potential w.r.t. relative translation) **and a moment `Mₙ = −∂w/∂θ`**
  (w.r.t. rotation), plus a Coulomb-friction-capped tangential force. Summing over intruding nodes
  gives full **translational + rotational** dynamics for irregular particles. This is the real
  "push and rotate" mechanism.
- **DiffSDFSim** (arXiv 2111.15318) — *differentiable* rigid-body dynamics with implicit SDF shapes,
  computing contact points even for non-convex shapes. Relevant for gradients through the
  simulation (design optimization, inverse problems).
- **Two-way fluid–rigid SPH coupling** (Waseem & Hong, MDPI *Mathematics* 2026) — real-time in
  Unity via "SDF coupling": weakly-compressible SPH evaluates rigid geometry as SDF primitives on
  the GPU, applies penetration correction + velocity response, and accumulates **impulse *and*
  torque** per body via lock-free atomic CAS. Demonstrates translate+rotate, but is a
  game-graphics demo with only 3 analytic primitives — its CAD relevance is extrapolated.
  **Confidence: medium.**

**Confidence: high** for the mechanism (identities + CMAME + CAD-journal + Springer).

---

## 3. Fluid dynamics / CFD against an SDF — yes, feasible and in practice

You don't need to mesh the *solid*. The dominant approach is the **immersed-boundary method (IBM)**:
solid represented as an SDF, fluid solved on a background grid.

- **sdfibm** (Zhang, *Computer Physics Communications* 2020) — the single most on-target result. An
  **open-source** discrete-forcing IBM solver built on **OpenFOAM** (~200 GitHub stars; validated on
  flow-past-cylinder, Taylor–Couette, 100-particle sedimentation). The solid is an SDF; a "pyramid
  decomposition" computes accurate solid volume-fraction fields on arbitrary unstructured fluid
  meshes. Key line: *"SDF removes the need of intersection test between the solid and fluid mesh, or
  the discretization and re-sampling of the shape."*
- **GenSDF** (*SoftwareX* 2025) — an MPI-Fortran SDF generator built specifically for IBM CFD: "Since
  IBM does not require the grid to conform to the object," the boundary is located on a Cartesian
  grid via the SDF. Input is an arbitrary triangulated (OBJ) *surface* mesh sampled onto the grid.
- **SDF-enhanced CFD-DEM** (CMAME 2023, above) does fully-resolved fluid-particle coupling on a fixed
  Eulerian grid where an **SDF sign-test classifies cell occupancy**, replacing conventional
  mesh-intersection and avoiding remeshing.

### Two important caveats

1. **"Meshless" is loose.** These methods eliminate the *body-fitted / conforming* mesh, but a
   **background fluid grid persists**, and the geometry input is frequently a **triangle surface
   mesh**. The *solid* need not be meshed; the fluid domain is still discretized.
2. **Meshless-embedding CFD ≠ SDF-based.** A 2026 GPU lattice-Boltzmann solver (Jaber, Essel &
   Sullivan, CPC 2026 / arXiv 2512.01251) embeds geometry into an octree Cartesian grid with **no
   body-fitted mesh at all** — but does it via **ray-cast solid voxelization** of an STL, using
   **zero** signed-distance fields (link-length q-distance tables, not a volumetric SDF). So
   "immersed boundary / meshless" and "SDF" are related but **not** synonymous; LBM in particular
   often skips the SDF.

**Confidence: high** that SDF-IBM CFD is real and used.

---

## 4. Does FEA fundamentally need a mesh? — No (not a conforming one)

- **Finite Cell Method (FCM)** — Schillinger & Ruess, *Archives of Computational Methods in
  Engineering* (Springer, 2015). FCM is an **embedded / fictitious-domain FEM**: a simple **unfitted
  structured grid** of higher-order basis functions, with geometry captured by **adaptive quadrature
  points** and weak enforcement of unfitted boundary conditions. It "eliminates the need for
  boundary-conforming meshes" and "can operate with almost any geometric model, ranging from
  **boundary representations in CAD** to **voxel representations from medical imaging**."
- **Nuance:** FCM is mesh-*based* but not boundary-*conforming*. It removes conforming-mesh
  *generation* — the hard, brittle CAD→FEA step — not all discretization. Documented weaknesses:
  cut-cell quadrature discontinuities and **ill-conditioning of small-support cut elements** (matters
  for accuracy/certification).
- Truly meshfree solid methods (Element-Free Galerkin, RKPM) exist too, but were not covered by the
  surviving claims here.

**Confidence: high.** Peer-reviewed review by the method's own developers.

---

## 5. Constraint solving — the gap

**No surviving source addresses SDF-based geometric/assembly constraint solving** (mates, joints,
parametric/dimensional constraints). Constraints show up *only implicitly* as **contact constraints**
inside collision/contact resolution — e.g. PBD/XPBD `distance ≥ 0` inequality constraints, or the
smooth-minimum-distance interior-point formulation in arXiv 2108.10480 (LogSumExp smooth min-distance
used directly as an inequality collision constraint in optimization-based rigid-body dynamics).

This is a **genuine evidence gap, not a confirmed negative** — but it strongly suggests SDF physics
in the literature is about *contact*, and the parametric-constraint layer of CAD is still solved
symbolically/numerically on the B-rep/sketch side, not on the field.

---

## What this means for a from-scratch SDF CAD kernel (galacticad)

Given galacticad already has SFCC/kernel SDF infrastructure and analytic gradients (analytic normals,
no finite differences — per the SDF-lighting-perf notes):

- **Collision & rigid-body "push" simulation is the low-hanging fruit.** Penetration depth = `φ`,
  contact normal = `∇φ`, push-out = `p = x − φ·∇φ`. A PBD/XPBD-style solver over sample points on each
  body, using the Minkowski-difference reduction for body/body, is the well-trodden path — and it is
  GPU-friendly, matching the WebGPU stack. Design for a **static-collider SDF queried by moving
  bodies** (the iMSTK limitation): SDFs don't rigidly transform cheaply.
- **CFD is plausible but is a background-grid project, not a "solve on the SDF" project.** Stand up a
  Cartesian / LBM fluid grid and use the SDF purely as the immersed boundary (sign test for cell
  classification + `∇φ` for wall normals). **sdfibm** is the reference architecture. Don't expect
  certification-grade drag numbers without validation work.
- **Structural analysis via FCM** is the realistic "FEA without meshing" route and is *designed* for
  arbitrary geometry input — but budget for small-cut-cell conditioning problems.

---

## Open questions the research could not close

1. Is there mature SDF-based **geometric/assembly constraint** solving, or is it inherently a
   B-rep/sketch-solver concern?
2. How do direct-SDF penetration/normal queries extend to **arbitrary non-convex** bodies? The
   strongest direct-query method (CAD 2024 ellipsoid algorithm) is convex-only; the Springer method
   is 2D convex superelliptical.
3. Are SDF-IBM CFD and FCM FEA **accurate enough for certification** (drag, stress, fatigue) vs.
   traditional body-fitted solvers — especially given FCM's small-cut-cell ill-conditioning?
4. Does anyone run FEA-type structural analysis **directly on a CAD-generated SDF** (neural/PINN
   solvers, or meshfree Galerkin over the implicit domain), rather than SDF being used only for
   collision/CFD embedding?

---

## Refuted claim (did not survive verification)

- *"In the CMAME SDF-CFD-DEM method, arbitrary particles are represented purely as SDFs plus a
  surface-projection function, and collision is a node-to-surface intrusion test with contact point
  and normal derived from the SDF and its projection."* — **Refuted 1-2.** The paper's contact
  force/moment machinery (§2, Finding above) *is* confirmed; only this specific node-to-surface
  intrusion-detection *description* should not be relied upon.

---

## Sources

### Primary — collision & rigid-body
- Macklin, Erleben, Müller et al., *Local Optimization for Robust Signed Distance Field Collision*, ACM I3D / PACM CGIT 2020 — https://mmacklin.com/sdfcontact.pdf · https://dl.acm.org/doi/10.1145/3384538 · https://www.researchgate.net/publication/350340158
- NVIDIA PhysX 5 — Rigid Body Collision (SDF collision) — https://nvidia-omniverse.github.io/PhysX/physx/5.4.0/docs/RigidBodyCollision.html · (5.1) https://nvidia-omniverse.github.io/PhysX/physx/5.1.0/docs/RigidBodyCollision.html
- Lopez-Adeva Fernández-Layos et al., direct SDF distance + penetration depth for convex bodies, *Computer-Aided Design* 2024 — https://www.sciencedirect.com/science/article/pii/S0010448524000125
- Non-conformal contact via Gap Distance Field (superelliptical bodies), *Computational Mechanics* (Springer) 2025 — https://link.springer.com/article/10.1007/s00466-025-02666-6
- PositionBasedDynamics library (cubic-SDF collision) — https://github.com/InteractiveComputerGraphics/PositionBasedDynamics
- iMSTK PBD model (SDF-can't-be-rigidly-transformed limitation) — https://imstk.gitlab.io/Dynamical_Models/PbdModel.html
- Smooth-min-distance inequality collision constraint in optimization-based dynamics — https://arxiv.org/pdf/2108.10480

### Primary — SDF/immersed-boundary CFD
- sdfibm: SDF-based discrete-forcing IBM in OpenFOAM, *Comput. Phys. Commun.* 2020 — https://www.sciencedirect.com/science/article/abs/pii/S0010465520301594
- GenSDF: SDF generator for IBM CFD, *SoftwareX* 2025 — https://www.sciencedirect.com/science/article/pii/S2352711025000846
- Lai/Zhao et al., SDF-enhanced fully-resolved CFD-DEM (forces + moments), *CMAME* 2023 — https://www.sciencedirect.com/science/article/abs/pii/S0045782523003195
- Jaber, Essel & Sullivan, GPU LBM with ray-cast voxelization (no SDF — boundary case), *CPC* 2026 / arXiv 2512.01251 — https://www.sciencedirect.com/science/article/pii/S0010465526001372
- Effective geometric algorithms for immersed-boundary CFD, *ASME J. Fluids Eng.* 2019 — https://asmedigitalcollection.asme.org/fluidsengineering/article/141/6/061401/380473

### Primary — FEA without a conforming mesh
- Schillinger & Ruess, *The Finite Cell Method: A Review*, *Arch. Comput. Methods Eng.* (Springer) 2015 — https://link.springer.com/article/10.1007/s11831-014-9115-y

### Primary — differentiable / neural-SDF & fluid-rigid
- DiffSDFSim: Differentiable Rigid-Body Dynamics with Implicit Shapes — https://arxiv.org/abs/2111.15318
- Neural-SDF physics (recent) — https://arxiv.org/abs/2408.09612
- Two-way fluid–rigid SPH "SDF coupling" (Unity), MDPI *Mathematics* 2026 — https://doi.org/10.3390/math14111845
- XPBD collision response vs. static SDF (MGPBD) — https://arxiv.org/html/2505.13390v1
- Meshfree FEA background — https://arxiv.org/pdf/2401.07823

### Background
- SDF basics (VDB) — https://www.get-vexed.com/post/vdb-sdf-basics
