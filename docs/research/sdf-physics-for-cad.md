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

### Simplest feasible CFD — where to start (vacuum / dust-collection example)

**The honest physics.** A representative target — dust collection, shop vacuum, air pulled toward a
low-pressure source around obstacles — is *incompressible* (Mach ≈ 0.05, drop all compressibility) but
*turbulent*: a 4″ duct at ~20 m/s is Re ≈ 130,000, and even the ~1 m/s hood-face capture flow is
Re ≈ 7,000. Turbulence is what makes "real" CFD expensive. **The reframe that saves you:** design work
is *comparative* ("is hood A better than B", "where does flow stagnate"), not *certification*, so a
qualitatively-right, quantitatively-loose solver is enough — which drops the bar dramatically.

**Feasibility ladder:**

| Tier | Solver | Effort | Answers | Misses |
|---|---|---|---|---|
| **0** | Potential flow (`∇²φ = 0`, `v = ∇φ`) | small — one linear solve, no time-stepping | where air comes from, capture reach, streamlines bending around obstacles | separation, wakes, dead zones, pressure loss (predicts *zero* drag) |
| **1** | LBM + LES (lattice Boltzmann + Smagorinsky) | medium — explicit GPU compute, bounce-back walls | above **plus** recirculation, wakes, dead zones, *relative* pressure loss | wall-accurate numbers (needs fine near-wall grid) |
| **2** | Incompressible Navier–Stokes + RANS (k-ω SST) | large — implicit pressure solve, turbulence transport, y⁺ meshing | real engineering numbers (pressure drop, capture velocity) | ≈ rebuilding OpenFOAM |

**Start at Tier 0 — and it is not a toy for this use case.** Potential flow assumes incompressible +
inviscid + irrotational, so velocity is the gradient of a scalar satisfying Laplace's equation (same
math as steady heat conduction / electrostatics). Recipe on this stack: (1) voxel-tag the scene by
`sign(φ)` → solid/fluid — **uses only the sign, so robust on non-true fields, no redistancing**; (2)
solve `∇²φ = 0` on fluid cells with `∂φ/∂n = 0` at walls (Neumann), the **vacuum as a sink**, open room
boundaries as far-field — a red-black Gauss–Seidel or geometric-multigrid Poisson solve in a WebGPU
compute shader; (3) `v = ∇φ`, trace streamlines and render `|v|` as a capture-velocity heat map. The
ACGIH *Industrial Ventilation* hood-design standard uses exactly this (point/slot sink + potential-flow
capture contours), so for the *reach* question it is the established engineering approximation, not a
hack. **Its one blind spot:** no viscous wake, so it shows capture but **not** the stagnant dead zone
behind a bluff obstacle where dust settles — it tells you *reach*, not *dead spots*. Dead-zone hunting
is the signal to climb to Tier 1.

**Cheap win — dust as particles.** Given any velocity field (Tier 0 or 1), advect passive tracers
`dx/dt = v(x)` from the workpiece to see where dust goes / whether it reaches the vacuum; add gravity +
Stokes drag for heavier dust (**one-way coupling** — flow moves dust, dust does not affect flow — correct
for dilute dust and nearly free). Turns an abstract streamline plot into a visceral capture demo.

**Climb to Tier 1 (LBM)** when you need dead-zone/recirculation maps or *relative* pressure-loss between
duct shapes (Tier 0 predicts zero loss and is useless for that). LBM is the natural GPU/voxel/SDF fit —
explicit, local, Cartesian grid, solid walls are just **bounce-back on sign-tagged cells** (the report's
GPU-LBM method, tagging by SDF sign instead of ray-casting an STL); add an **LES Smagorinsky** subgrid
model for the high Re. Tier 2 (RANS) is the endgame only if the feature must emit trustworthy numbers.

**Build vs. borrow.** For one-off "is this part good," free tools (OpenFOAM, SimScale free tier,
SolidWorks Flow) give better numbers with zero solver-dev effort. Building CFD *into* galacticad is worth
it only for what they cannot do: **interactive, in-editor, live-updating flow tied to the parametric SDF**
— drag the duct wall, watch streamlines and dust capture update live. The value prop is *fast comparative
feel*, not *certifiable accuracy*; framed that way, Tier 0 + particle advection is already a shippable
first cut.

### Moving boundaries & fluid-structure interaction (valves, flaps, hinged parts)

Moving geometry is not an extension of immersed-boundary CFD — it is the **mainstream** use, and the
static case above is the simplification. Peskin invented IBM in 1972 for **heart-valve leaflets** —
moving flaps in blood flow — precisely so the grid would not have to be regenerated as the boundary
moved. Two of the cited methods already do this: **CFD-DEM** (CMAME 2023) has particles that translate
**and rotate** through a *fixed* Eulerian grid, re-classified each step "by testing the signs of each
mesh node… without mesh intersection tests"; **sdfibm** validated 100-particle sedimentation. The
template is: **the fluid grid stays fixed; the solid SDF is re-located on it every step via the sign.**

- **Rigid motion is metric-free (kernel win).** A rotation+translation of a true SDF is still a true
  SDF (isometry preserves `|∇φ| = 1`), and galacticad leaves already evaluate in body-local coords via
  `inv_apply_point`. Moving a rigid valve/flap to pose `M(t)` is just composing `M⁻¹` into that
  transform — exact at any pose, and it does **not** re-corrupt the field. (A genuinely *deforming*
  flap re-inflates the gradient like the twist/loft cases → redistance per step.)
- **Moving-wall BC.** No-slip becomes `u_fluid → u_wall = v + ω × r`, not `→ 0`; get `v, ω`
  analytically from the pose rate and the wall normal from the normalized gradient.
- **Re-tag + narrow-band redistance per step**, amortized — only re-band when the interface has moved
  ≳1 cell; cost is `O(band cells)`, not the whole domain.
- **Fresh / dead cells — the real numerical headache.** A cell that flips from solid to fluid
  ("uncovered"/fresh) has no valid history; naïve handling causes **spurious force oscillations**.
  Mitigate by extrapolating velocity/pressure into fresh cells or using a diffuse/fractional
  (VOF-style) interface so cells transition gradually instead of flipping binary.

**Prescribed motion vs. two-way FSI:**

- **Prescribed** (known valve schedule / flap angle vs. time) → one-way, easy: drive the pose, run the
  fluid.
- **Two-way FSI** (flap moves *because* the fluid pushes it) → integrate fluid traction over the
  immersed surface into force and torque, `F = ∮ (−pI + τ)·n dS`, `M = ∮ r × (σ·n) dS` (normal `n`
  from the gradient), update the body, move the SDF, repeat. Beware **added-mass instability** — a
  light body in a dense fluid needs *strong* (sub-iterated) coupling.
- **Usually 1-DOF.** A valve/flap is typically a rigid body on a hinge or slide, so its state is a
  single number (angle or travel) solved from torque balance about the hinge. This is a *mechanism
  DOF* — solved on the CAD/constraint side (§5's gap), not as an SDF query.

**The hard corner — full seating (`gap → 0`).** As a valve closes, the fluid film becomes sub-cell and
enters the lubrication regime; brute-force CFD fails. Handled with modeling hacks (minimum-gap clamp,
porous-media leakage across the seat, or switching to a lumped model near closure). Seating is also a
**contact event**, so CFD hands off to the collision/contact machinery of §1–§2 at the seat while flow
governs the gap up to closure. Combined FSI-plus-contact (check valves, seals) is a research frontier.

**The upside SDFs give here.** When a valve seals and **splits the fluid domain into two disconnected
chambers** (or reopens and merges them), that is a topology change — catastrophic for a conforming
mesh, but on a fixed grid it is just sign changes. Pinching/merging/splitting of the fluid region is
free; this is the structural reason moving-boundary flow was implicit/immersed from the start.

| Moving-boundary cost (galacticad) | Cost | Notes |
|---|---|---|
| Evaluate moving rigid SDF at any pose | cheap, exact | `inv_apply_point` composition; no re-corruption |
| Wall normal + wall velocity | cheap, exact | normalized gradient + analytic pose rate |
| Re-tag + narrow-band redistance / step | moderate, recurring | amortize: only when interface moves ≥1 cell |
| Fresh/dead cell reconstruction | hard (numerics) | source of force oscillations; diffuse interface helps |
| Two-way FSI stability | hard (numerics) | added-mass → strong coupling for light bodies |
| Full seating / `gap → 0` | hard (modeling) | min-gap clamp / leakage model / hand to contact solver |

### Branching manifolds & backpressure — 1D resistance networks + Murray's law

For a tube that branches progressively to distribute flow while limiting **backpressure**, the right
tool is *not* a field CFD solver — it is a **1D hydraulic-resistance network** on the graph, which is
both cheaper and more accurate for the pressure-drop question. Key reframe: **backpressure is an
irreversible *loss* quantity** (wall friction + junction/bend losses), so **potential flow is useless
here** — it predicts zero loss (d'Alembert). Field CFD (LBM+LES) can compute backpressure directly but
is wall-shear-dominated → sensitive to near-wall resolution → *loose* absolute numbers unless finely
resolved, and expensive across all branches at once.

**The resistance network (primary tool).** A branching tube is a resistor network under the
hydraulic-electrical analogy — pressure↔voltage, flow `Q`↔current, resistance↔resistance; junctions
enforce `ΣQ_in = ΣQ_out` (mass) and pressure continuity (Kirchhoff). Per-segment resistance:

- **Laminar (Re < ~2300):** Hagen–Poiseuille `ΔP = 128 μ L Q / (π D⁴)` — linear in `Q`, one linear
  solve. Note the brutal **1/D⁴** sensitivity.
- **Turbulent (Re > ~4000, the likely regime):** Darcy–Weisbach `ΔP = f·(L/D)·(ρv²/2)`, `f` from
  Colebrook/Haaland — `ΔP ∝ Q²`, nonlinear, solve iteratively (Hardy–Cross / Newton). Still ms-scale
  for thousands of segments.
- **Junctions/bends/area changes:** minor losses `ΔP = K·(ρv²/2)`; in a manifold the **junction losses
  usually dominate** and are what you optimize.

The solve yields, directly: **total inlet backpressure** for a prescribed flow *and* the **flow split**
among branches (distribution balance) — both optimization-loop-cheap.

**Design optimum — Murray's law.** For distributing flow to many outlets, progressive branching beats
alternatives because parallel paths + growing total cross-section drop velocity (losses scale `v²`).
The optimal taper is Murray's law `r_parent³ = Σ r_daughter³` (minimizes network resistance, holds wall
shear constant across generations — why vasculature/lungs/trees branch this way). Refinements: it also
gives the **optimal bifurcation angle**; the cube exponent is the *laminar* result — **turbulent**
networks follow a diameter exponent closer to **~2.3** (generalized Murray). The optimizer's job: taper
toward Murray (regime-correct exponent), tune junction angle/blend to cut `K`, read backpressure + flow
balance off the 1D solve.

**SDF connection (galacticad).** Two links make this native: (1) **the SDF hands you the network** —
extract the medial axis/skeleton → graph (centerlines, connectivity, lengths), and for a true SDF **the
field value at the medial axis *is* the local inscribed radius**, so `r(s)` (the key input to every
resistance law) comes straight out of `φ`. *Caveats, per the fidelity section:* the medial axis is
unstable to surface wiggles (use tube-aware thinning), and `φ`-as-radius is exact only in true regions
— off in blend bands and near junctions (where the skeleton is messiest anyway; junctions get
3D-resolved regardless). (2) **The 1D model localizes where 3D is needed** — junction `K`-factors for
custom geometries aren't tabulated, so 3D-resolve a *single* junction (LBM+LES) to extract its `K` and
plug it into the fast network. Multiscale: 3D-resolve the uncorrelated components, 1D-network the
assembly.

**3D's role here** is *not* the primary backpressure engine: (a) calibrate junction `K`-factors
(one at a time, well-resolved, cheap), and (b) diagnose flow **maldistribution** (starved branches) and
junction **recirculation** that 1D can't see.

Recommended pipeline: skeleton + `r(s)` from the SDF → 1D resistance solve (Poiseuille/Darcy) →
optimize diameters toward Murray + branch angles under equal-distribution constraints → calibrate
custom-junction `K`s with localized LBM+LES → optional full-tree LBM to validate/inspect
maldistribution (not in the inner loop). This is a graph solver over a skeletonized SDF with 3D used
surgically — far more optimization-friendly (hundreds of topologies/sec at the 1D level) than field CFD.

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

- **Collision & rigid-body "push" simulation is the low-hanging fruit.** Penetration depth ≈ `φ`,
  contact normal = `∇φ`, push-out `p = x − φ·∇φ`. A PBD/XPBD-style solver over sample points on each
  body, using the Minkowski-difference reduction for body/body, is the well-trodden path — and it is
  GPU-friendly, matching the WebGPU stack. Design for a **static-collider SDF queried by moving
  bodies** (the iMSTK limitation): SDFs don't rigidly transform cheaply. **Caveat:** those textbook
  identities assume a *true* (Eikonal) SDF; galacticad's fields are bounded/Lipschitz, not exact — see
  the fidelity section below for how each identity degrades and the corrected forms to use.
- **CFD is plausible but is a background-grid project, not a "solve on the SDF" project.** Stand up a
  Cartesian / LBM fluid grid and use the SDF purely as the immersed boundary (sign test for cell
  classification + `∇φ` for wall normals). **sdfibm** is the reference architecture. Don't expect
  certification-grade drag numbers without validation work.
- **Structural analysis via FCM** is the realistic "FEA without meshing" route and is *designed* for
  arbitrary geometry input — but budget for small-cut-cell conditioning problems.

---

## Foundational substrate & build order — start here

The single most foundational thing — the atom every approach above sits on top of — is:

> **Sample the scene SDF onto a background Cartesian grid, and sign-classify each cell inside/outside.**

A "voxelize the scene into a signed field buffer" pass. Everything else is a layer on top of that
one buffer. It is the *first step* of every field method (all three CFD tiers, FCM, moving-boundary
re-tagging, particle advection) — exactly what sdfibm/GenSDF/CFD-DEM mean by "the SDF sign-test
classifies cell occupancy, replacing mesh-intersection tests."

| Approach | What it needs from the foundation |
|---|---|
| Potential flow (Tier 0) | grid + sign-tag (solid/fluid cells + wall faces) |
| LBM+LES (Tier 1) | grid + sign-tag (bounce-back on solid cells) |
| RANS Navier–Stokes (Tier 2) | grid + sign-tag + boundary cells |
| FCM / FEA | grid + sign-tag (the inside/outside indicator α = point membership) |
| Moving boundaries / FSI | *re-sample* the same grid at each new pose |
| Particle advection (dust) | reads velocity field on the grid; sign detects wall hits |
| Collision / contact | grid as broad-phase spatial acceleration (queries φ/∇φ at points) |

**Why it's the right place to start on galacticad's fields:** this layer is **sign-only**, and the
sign is the part of a bounded/non-true SDF that is *exactly correct* (see the fidelity section below).
So the foundation has **zero fidelity caveats** — no redistancing, no Newton projection, no Lipschitz
worries. All the caveated machinery (metric distance for wall stencils, penetration depth,
closest-point projection) lives in layers *above* this, and only for the subset of methods that need
it.

**Most of it already exists.** Three pieces, two done:
1. **Point evaluation of φ and ∇φ** — ✅ `Leaf::f` + analytic `normal` in the kernel (the expensive part).
2. **Grid sampler** — the new piece: scene SDF + bbox + resolution → per-cell φ in a 3D buffer via one
   WebGPU compute dispatch (embarrassingly parallel, reuses `Leaf::f`, ~a couple hundred lines).
3. **Sign + narrow-band classification** — per cell `sign(φ)` → {solid, fluid, boundary}, flag cells
   whose sign flips across a neighbor (the band); this is the indicator every field method consumes.

The **SFCC octree already does this shape of work** (sign-classified, surface-refined sampling;
`prune_to_box` / `rebuild_octree_from_leaves` / band logic). The physics foundation is its simpler
cousin — a **uniform dense lattice** (CFD/LBM stencils want regularity). Start uniform-dense because
it is simplest; borrow the octree's band-refinement later as an optimization (the "forest-of-octrees"
trick the GPU-LBM paper uses).

**MVP + validation (do this before any solver exists):** `sampleSceneToGrid(sdf, bbox, N) → φ buffer`
→ `classify → per-cell tag + boundary-cell list`, keeping analytic `normal(p)` for BCs. Validate by
checking the sampled zero-crossing matches the SFCC mesh surface — render the sign-tag mask overlaid
on the mesh; if the tagged boundary hugs the mesh, the sampler is correct. Self-contained and testable.

**The one exception:** the 1D branching-manifold solver is a graph, not a grid, so it does not consume
the voxel buffer directly — but it still rides on piece #1 (skeleton extraction samples the field;
`φ` at the medial axis = tube radius), and in practice the skeleton is extracted *from* the sampled
grid anyway.

**Build order that maximizes reuse:** grid sampler + sign-classification first (validate against the
mesh) → then the cheapest useful consumer to prove it end-to-end (a Laplace potential-flow solve for
the vacuum case, or FCM cell-tagging — both sign-only, no new fidelity work) → metric-distance layers
(redistancing, projection) only when a specific method demands them.

---

## Fidelity on galacticad's bounded (non-true) SDFs

Everything above implicitly assumes a *true* SDF (`|∇φ| = 1`, `φ` = exact Euclidean distance). The
galacticad kernel does **not** produce true SDFs — but it produces the *favorable* kind of non-true
field: a **bounded Lipschitz field with a known constant**, not arbitrary non-metric values. Grounded
in `kernel/src/sdf.rs` and `kernel/src/primitives/smin.rs`:

- **Leaves are true SDFs.** `f = sign·s·shape(Rᵀ(p−t)/s − pos)` is a *uniform* similarity (single
  scalar `s`), which preserves `|∇f| = 1`. Non-uniform scaling — the worst metric-breaker — is not in
  the model.
- **Hard union = `min`** → exact outside, only a bound in interior overlaps. **Intersect/subtract =
  `max`** → conservative *underestimate* near the seam, exact away from it. Both stay 1-Lipschitz.
- **Smooth booleans underestimate, provably.** The `smin_is_below_hard_min` test asserts
  `smin(a,b) ≤ min(a,b)`; round-seam displacement is `(√2−1)·r`. Inside blend bands `|∇φ| < 1`, so
  depth reads low.
- **The two *expanding* ops (`|∇φ| > 1`) are tracked.** `Leaf::local_lipschitz` returns `√(1+(kρ)²)`
  for the twisted extrude and morphing loft, `None` (= exactly 1) otherwise. The kernel already knows
  where and by how much the field lies.
- **Normals are analytic and normalized** (`smin_grad_weights` → "callers normalize… only the ratio
  matters"), so direction is correct even where magnitude isn't.

**Governing principle: sign and normal survive; metric distance does not.** Techniques needing only
inside/outside or the surface normal work as-is; techniques needing accurate distance *magnitude*
degrade — but conservatively, and fixably.

| Technique | Needs | Verdict on galacticad's fields |
|---|---|---|
| Boolean collision (point-in-solid) | sign only | **Excellent, as-is** — sign exact under min/max/smin/uniform-scale/warp. |
| Contact normal | `∇φ/\|∇φ\|` | **Good** — analytic, normalized, blended (better than FD). Ambiguous only at hard creases, which SFCC/feature-catalog already localizes. |
| Penetration depth | `\|φ\|` magnitude | **Degraded but conservative** — accurate on isolated primitives & shallow single-surface contact; *under*-reads inside fillets/rounds and near subtract seams. XPBD iteration absorbs it. |
| Closest-point projection | `p = x − φ·∇φ` | **Naive formula breaks** (`\|∇φ\|≠1`). Use normalized Newton step `p = x − φ·n`, iterated 2–4× (more in blend bands). |
| Rigid push (translate) | normal + depth | **Works** — slightly soft where fillets are the contact surface; solver iteration compensates. |
| Rigid rotate (torque) | contact *point* → moment arm | **Gated by the projection** — accurate with iterated projection; biased with single-step. |
| Raycast / sphere-trace (CCD, GJK-free) | step ≤ `φ/L` | **Works, but must divide by `local_lipschitz`** — naive stepping by `φ` oversteps twisted/loft geometry. Infra already exists. |
| CFD immersed boundary | cell tag + normal + wall *distance* | **Feasible with a redistancing pass** — sign tagging robust as-is; wall-interpolation distance needs a metric field, so fast-march/sweep the background fluid grid from the zero-set (as sdfibm/GenSDF do). |
| FCM / FEA | inside/outside indicator | **Robust, zero changes** — adaptive quadrature needs only point membership = sign. Non-trueness is invisible to it. |

**What to actually do:**

1. **Lean on the sign** — broad-phase collision, FCM, VOF-style CFD tagging are all exact.
2. **Never single-step-project** — replace `x − φ·∇φ` with iterated `x − φ·n`; this one change fixes
   contact-point → depth → moment-arm in blend bands.
3. **Route raycasts through `local_lipschitz`** — use the divisor the kernel already computes instead
   of assuming 1-Lipschitz.
4. **Redistance only for CFD** — FCM doesn't need it; contact solving tolerates conservative depth.
5. **Fillets are the trap** — smin bands are simultaneously where bodies most often touch and where
   `|φ|` under-reads most; if contacts feel mushy, iterate the projection or locally redistance the
   patch (not a bug).

Net: uniform-similarity transforms + tracked Lipschitz + analytic normals put galacticad in the
sphere-tracing-friendly regime (Quilez / Media Molecule *Dreams*), not the metric-hostile one. Most
report techniques port with normalized normals + Newton-iterated projection; CFD is the only one that
wants a genuine redistancing step.

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
