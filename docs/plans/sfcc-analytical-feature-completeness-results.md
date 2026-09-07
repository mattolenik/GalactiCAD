# SFCC analytical-feature audit results

> Historical audit checkpoint. Composite subtraction and branch/curve-identity work have since advanced; see the [implementation results](sfcc-feature-preservation-results.md) for the current scope and remaining gaps.

Audit against `4368b444`, September 7, 2026. This records implemented corrections,
independent controls, and unresolved findings. It does **not** certify analytical
completeness, and the entire implementation sequence in the companion plan is
not finished.

## Corrections implemented

| Finding | Correction | Evidence |
| --- | --- | --- |
| Full and pruned `grad` mixed child unit normals, discarding derivative magnitudes. | Both derive their final direction from the existing raw field differential. | Nested soft-union zero-surface fixture; central differences converge at steps 0.01, 0.001, 0.0001. Previous direction error was about 1.7086 degrees. |
| The raw soft-union differential independently differentiated `min` and `abs` at equality, choosing inconsistent sides. | Differentiate the smooth polynomial using its actual operand weights. | Equal, opposing sphere derivatives cancel; the raw stationary point remains singular and the unit-normal API returns zero. |
| WASM paired evaluation normalized at every round blend and replaced every non-round blend with its nearest child. | Preserve raw derivatives through paired evaluation; use the shared differential for all six modes; normalize at the public boundary. | Direct WASM scalar/paired/pruned comparisons for union, intersection, subtraction, operand reversal and three-child selection, plus actual bracket/housing scene serialization. |
| SIMD binary blends reordered operands, unlike scalar binary evaluation. This matters for the existing asymmetric periodic formulas. | Preserve source order for binary blends; keep nearest-two selection for larger unions. | The WASM matrix includes both operand orders and both columns mappings. |
| Lifted primitive branches omitted polygon nearest-segment boundaries and other displaced interior creases. | Add finite-segment profile carriers for extrusion and loft, box face branches, cylinder radial/cap branches, cone mantle/base branches and lathe finite-edge branches. | An inward chamfer offset of a square extrusion previously missed an expected edge by 0.60000018 mm. The corrected test requires less than 0.002 mm. Additional independently derived inset rims cover box, cylinder, cone and lathe. |
| Worker feature fingerprints omitted corner-to-curve-end incidence. | Hash incidence along with corner geometry and incident strata. | Changing only one incident endpoint now changes the fingerprint. |

Finite-segment carriers retain clamped endpoint regions: a segment-interior to
endpoint transition is smooth away from the segment itself. These transitions
must not automatically become creases. The outward-offset negative control
checks that a smooth join does not acquire a fictitious curve.

Loft enumeration overrides one active profile at a time, avoiding a Cartesian
product of all profiles and ancestor choices. Its partner profile remains
piecewise. This improves coverage but does not establish a globally smooth
formula for every lifted carrier or resolve every coincident junction.

## Independent references and the bracket outlier

`kernel/tests/analytical_completeness.rs` contains independently specified scalar
derivative, inset-edge, smooth-join and small-loop controls. The expected inset
locations are derived from the operator equations, not copied from compiled
curves. Twisted extrusion, loft, reversed winding and chamfer/soft/round inward
offsets are exercised. Existing branch-seam tests cover ancestor survival,
similarity transforms, nearby components and the actual bracket arcs.

`audit_field_samples` exposes the **existing** native kernel differential for
diagnostics through WASM. It returns scalar values, raw derivatives, scalar unit
normals, paired results and pruned paired results. It is not used as a new
rendering/export sampling backend. The application-side GPU control uses
`IsoSampleBatch` and the generated WGSL scene field, without viewing images.

For the nested-soft control, effective radii are explicitly retained as 0.8 and
0.7. The serialized sphere translations are f32-rounded by the application.
GPU scalar central differences at steps 0.01 and 0.002 agree with the native
reference within 0.0001 in derivative-vector norm. The GPU normal itself differs
by **1.11304 degrees**. It is reported separately, not accepted as the derivative
oracle. `hg_sdf.wgsl` still composes unit directions; `SDFResult.g` is a stepping
estimate, not a raw derivative magnitude. Fixing that contract across shader
operators remains open; no shader behavior was changed in this slice.

The old bracket scan reports 884 normal transitions and one gap of 0.00372373 mm
at `(-7.052082621,9.4,5.263836678)`. Direct projection onto the nearest carrier
pair agrees with the curve projector, so this is not a closest-point iteration
failure. More importantly, the scan changes surface crossings:

| Lateral sampling offset | Separation of the two sampled surface points |
| --- | --- |
| 0.001 | 0.05314162 mm |
| 0.00001 | 0.05276242 mm |
| 0.0000001 | 0.05275900 mm |
| 0.000000001 | 0.05275896 mm |

The separation does not converge to zero. This invalidates the old scan's
classification of that transition as a local crease. The scan's fixed 0.15 mm
depth-jump rejection was insufficient. Do not raise its curve-gap threshold or
add a feature at this point. A general three-axis/rotated GPU coverage scanner
with continuity tracking remains unimplemented; the 884-point result must not
be described as 884 independently confirmed creases.

## Primitive and transform inventory

| Accepted family | Native features and displaced branches checked | Remaining limitations |
| --- | --- | --- |
| Sphere | Native smooth surface; nested blend derivative controls. | Center is singular; no general singularity certificate. |
| Box | Native exact edges/corners; inward displaced face intersections. | Full exposed-curve/mesh-chain correspondence not independently checked for every composition. |
| Cylinder | Native circles; inward radial/cap rim. | Axis/medial singularities and arbitrary blends remain unresolved. Filleted/chamfered cylinders retain their explicit bridge rejection. |
| Cone | Native base circle/apex; inward mantle/base circle. | Apex and axis singularities; no exhaustive off-surface region certificate. |
| Extrusion | Native edges, cap/side, twist clamps; new finite-segment regions; positive smooth endpoint control and negative inset controls. | Degenerate/self-intersecting input profiles, all concave medial configurations and every high-valence junction not checked. |
| Loft | Existing equal/differing topology native paths, height regions and caps; new per-profile finite-segment regions. | Simultaneous profile switches still leave internally piecewise carriers; exhaustive differing-topology inset matrix not checked. |
| Lathe | Native profile rings and axis conventions; new finite-edge supporting fields and inward rectangular-profile rim. | Axis contacts, concave profile branch junctions and degenerate profiles not completely classified. |
| Translate/rotate/positive uniform scale | Existing similarity/ancestor regressions; actual serialized bracket and housing paired derivatives. | New inset controls do not cover every primitive/transform Cartesian combination. Nonuniform/nonpositive scale remains rejected. |

## Operator-region findings still open

Hard min/max routing and the six blend differential modes have scalar/pruned
regressions. WASM paired tests exercise the public union/intersection/subtraction
mapping, including ColumnsI. These establish differential agreement at sampled
points; they do not establish feature enumeration.

**Stairs:** for two boxes whose local fields near the origin are `a=x`, `b=z`,
with `r=1`, `n=4`, expected step-corner lines include
`(x,z)=(0.25,0.75),(0.5,0.5),(0.75,0.25)`, with `y` varying through the interior.
They lie exactly on the scalar zero set. The nearest compiled curves at their
midpoints are about 9.25–9.51 mm away. There are no explicit staircase formula
region carriers. This is a confirmed representation gap, not a seed-density
problem. Correct scalar/SIMD stair evaluation does not fix it.

**Columns:** with `r=1`, `n=3`, let
`cr=sqrt(2)/(4+sqrt(2))`, `a=0.5`, `b=0.5-cr*sqrt(2)`. Across `b±1e-8`, the
current scalar formula changes from about **+0.10819418** to **-0.15300968**.
The raw modulo introduces a finite jump that changes sign. A continuous zero-set
carrier model cannot simply treat it as an ordinary crease. The kernel mirrors
the application formula; deciding and implementing continuous operator semantics
or explicit discontinuity handling must precede claims of complete columns
meshing. The periodic-count input domain also needs explicit validation.

Reproduce both findings with the repository diagnostic source:

```sh
cargo run --offline --release --manifest-path gcad-wasm/Cargo.toml \
  -p gcad-kernel --example analytical_feature_audit
```

The example prints coverage gaps and continuity diagnostics rather than making
missing coverage a passing unit-test assertion.

Nested chamfer partner selection and nearest-two multi-operand selection can
still make a lifted carrier piecewise. Existing and new tests cover particular
arcs; explicit partner-region identities and junction handling remain open.
No associativity invariant was imposed on multi-operand blends.

## Numerical discovery and mesh preservation

A represented radius-0.03 circle is found as one closed component at seed
spacings 0.25, 0.4 and 0.7 and two center phases. Existing tests retain nearby
components and bracket junction incidence under different seed spacings. These
controls do not demonstrate a new fixed-grid loss, so no speculative adaptive
seed algorithm or tangency-threshold reduction was introduced. Tiny tangential
contacts, cusps and arbitrary high-valence junctions remain unresolved. The
grid's distance-like rejection is not a general interval exclusion certificate.

The assembly source audit confirms protected-edge checks in sliver flipping,
transfer to split child edges during surface refinement, and serialization/remap
through worker merge. Existing tests cover a beneficial flip blocked by a crease
lock and worker payload preservation. Fingerprint incidence is now tested.

The remaining structural gap is that protected edges store endpoint pairs,
**not analytical curve identity**. Surface refinement can choose a nearby curve
by endpoint/midpoint proximity. Therefore the current system cannot provide the
plan's complete semantic chain provenance from expected arc through face pin,
cell patch, cleanup and final mesh. Existing bracket tests measure proximity to
mesh edges; they are not proof of the correct protected chain. No continuous
embedding or global self-intersection certificate was added.

Serial recovery remains allowed in the bracket worker-equivalence test. Equality
after recovery validates the returned mesh, not independent distributed success.
`validation.status=passed` retains its documented topology, face-consumption,
vertex-residual and unresolved-work meaning. Analytical feature completeness is
not checked by that status.

## Validation and performance

Validation logs and before/after feature-compilation measurements for this run
are retained in `/tmp/sfcc-completeness-audit/`. Visual QA remains manual.
The full offline native release suite passes **206 tests**. `make test` passes
**357 application/WASM tests**, with no skipped application tests, and includes
`make build` validation. The strict housing flange-rim regression remains
unchanged. Historical optional native parity fixtures still have their existing
soft-skip behavior; the new native controls need no external fixture.

Exploratory feature-compilation medians (three runs, same native release profile,
same serialized scene and resolved-tolerance diagonal 90) are below. The baseline
uses an isolated source snapshot of `4368b444`. Background builds and rendering
were active, so these are workload observations, not a controlled performance
gate or an end-to-end export benchmark.

| Scene | Before / after seconds | Candidate pairs before / after | Curves before / after |
| --- | --- | --- | --- |
| Bracket | 1.205 / 1.325 | 201 / 228 | 153 / 153 |
| Housing | 3.382 / 3.368 | 2134 / 2213 | 149 / 149 |
| Mixed 1 | 49.896 / 51.486 | 412 / 498 | 3006 / 3010 |
| Mixed 2 | 2.784 / 1.450 | 169 / 194 | 330 / 330 |

The new primitive branches add candidate pairs without increasing the bracket
or housing curve count in these runs; this is consistent with their being
primarily inset-field coverage corrections, not a general cure for all sample
scene artifacts. Mixed 1 remains expensive before and after these changes. Raw trace correction
bails include hidden supporting extensions; they are not counts of exposed
missing features. Field-query totals and peak memory were not instrumented in
this slice. No geometry or numerical budgets were raised to obtain these results.

`make -C docs/manim pngs` completed successfully and regenerated **all 60 PNGs**
(SDF, solid mesh, wireframe and crops for all ten scenes). A stalled first agent
session was restarted; the successful full retry supplies every final asset.
Pre-existing working-tree PNGs were preserved in
`/tmp/sfcc-completeness-audit/preexisting-assets/` before regeneration.
No video was rendered and no automated visual QA was performed.

## Remaining delivery work

The broader plan remains active work, not a completed completeness certificate:

1. GPU surface continuity tracking in three axes and rotated frames, with semantic stage provenance.
2. GPU derivative/normal contract correction and more primitive singular/degenerate controls.
3. Explicit periodic regions; resolve columns discontinuities and count validation.
4. Nested partner-region identity and simultaneous profile/junction coverage.
5. Conservative discovery handling for demonstrated singular or unseeded cases.
6. Analytical identity on protected edge chains, independent chain coverage and embedding checks.
