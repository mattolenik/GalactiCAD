# SFCC critical repairs after the bracket/housing investigation

Status: implementation underway, October 23, 2026. Baseline commit:
`5566520` (`Add SDF meshing acceptance diagnostics`). Milestone 1's construction
and focused native/WASM checks are implemented; see the
[corner repair record](../research/sfcc-corner-repair.md). The
[first candidate acceptance run](../../.testresults/sdf-meshing/2026-10-24T01-04-11-157Z/report.md)
retains all five original cases and all remaining failures. Milestone 2's
[membership repair](../research/sfcc-feature-overlap-repair.md) and
[five-model campaign](../../.testresults/sdf-meshing/2026-10-24T01-45-13-111Z/report.md)
preserve all four available meshes' geometry while restoring the eleven housing
memberships. Milestones 3–5 remain pending.

Evidence: [investigation](../research/sfcc-bracket-housing-investigation.md),
[acceptance report](../../.testresults/sdf-meshing/investigated-2026-10-23/report.md),
and [acceptance-suite plan](sdf-meshing-acceptance-suite.md).

## Goal and priorities

Repair demonstrated loss of geometry and malformed output on the complete
transformed Manim models. Keep their sources, tolerance settings, export domains,
and simplification settings fixed. Local reproductions supplement these models;
they do not replace them as acceptance gates.

| Order | Problem | Baseline evidence | Required outcome |
| --- | --- | --- | --- |
| 1 | Known corner disappears during construction | Bracket corner 18 is 0.057258117 mm from output; accepted cell has three pins and zero triangles | Preserve the junction and its incident surface/feature structure within 0.02 mm |
| 2 | Coincident feature geometry has inconsistent identity/membership | Eleven housing gap spans have physical edges with other curve labels | One compatible geometric representation retains every applicable curve interval |
| 3 | Triangulation produces invalid final coordinates | Bracket: 6 zero-area faces; housing: 180; housing weld/drop leaves 5 nonmanifold edges | Zero invalid faces on these two models, with valid topology and preserved features |
| 4 | Coverage checks can miss defects despite good images/topology | Bracket is closed and visually close while missing a junction | Independent GPU witnesses and targeted interior/crease checks detect the repaired failure modes |
| 5 | Conservative exclusion dominates unresolved counts and costs | Native first reasons: 96.93% bracket and 85.77% housing are same-sign interval uncertainty | Improve exclusion only where a conservative argument and measured benefit support it |

Steps 2 and 3 interact: establish shared geometric identity before making
triangulation depend on it. If step 2 exposes a zero-area face, retain that failure
until step 3 repairs the construction. Do not relax the validator to obtain an
intermediate pass. Step 5 must not delay the geometry repairs.

## Shared rules and baseline preparation

- Preserve the existing report and raw meshes. Reports under `.testresults/`
  are ignored artifacts; retain/share the complete directory, not only Markdown.
- Promote necessary investigation assertions into checked-in tests using the
  original YAML/fixture machinery. Recompute local records from the full scene;
  do not depend on an ignored prepared-worker binary to run a regression test.
- Track each repaired obligation separately from overall acceptance. Existing
  unrelated failures and Mess 1's 180-second timeout remain visible.
- Use actual WASM output for release gates. Native traces locate mechanisms but
  do not establish identical WASM behavior; native/WASM curve IDs 73/74 already
  disagree for bracket. Match evidence by geometry/provenance when IDs differ.
- No blanket coordinate welding, deleting bad triangles, increasing global
  depth, or enlarging tolerances as a substitute for construction correctness.
- No new CPU scene evaluator. Additional reference sampling uses the existing
  GPU scene evaluation. Existing native/WASM diagnostic APIs remain internal
  consistency checks, not independent references.

## 1. Preserve the known bracket corner

**Contract.** A recognized visible corner is a construction obligation. Equal
signs at the eight cell corners and no face-boundary crossings do not prove the
absence of an interior face contour. Accepting a corner is safe only when the
mesher can construct its incident patches or report that obligation unresolved.

Start with the actual failure at `(-3.2974043758686875, 11.496906301499829,
2.2091193968483966)` mm. The baseline accepted cell is `(7,56,77,69)`, with
incident curves 13/43/45. Cell IDs may change after a fix; the geometric witness
and full source hash are the stable regression target.

1. Add a failing actual-WASM regression for the missed junction, plus a local
   invariant detecting accepted visible corner/pin obligations that produce no
   surface. Preserve the complete octree context in selected-cell diagnostics.
2. Trace oriented stratum incidence through `face_contour.rs`,
   `cell_mesh.rs::mesh_cells_subset`, and `pipeline.rs::decide_cell`. Determine
   the actual face-interior arcs required by the three pins. Do not simply join
   three points into a triangle: their existence does not prove their pairing,
   winding, visibility, or the absence of another contour.
3. Construct the supported local contour from existing feature/stratum data.
   Adjacent cells must consume the same canonical shared-face record with
   opposite boundary orientation, including coarse/fine and worker boundaries.
4. Make ambiguous construction request bounded refinement through the existing
   failure/refinement path. At the limit, retain an explicit unresolved feature
   obligation. Removing silent success is necessary but does not complete the
   bracket repair if its geometric witness still fails.

**Exit gate:** actual final WASM mesh is within 0.02 mm of the corner; all three
incident curve ends connect to the reconstructed junction; local edge and
triangle-interior checks support the incident patches. The emitted patch has
nonzero area, correct shared-face use, and no new open/nonmanifold edges,
nonmanifold vertices, or local self-intersections. The baseline witness must
fail on the old mesh. A nearby unrelated triangle alone cannot satisfy the gate.

**Tests:** full bracket, targeted shared-face/coarse-fine cases, and actual
serial/worker paths. Inspect housing for collateral changes before merging this
milestone. New unsupported configurations stay explicitly unresolved.

## 2. Reconcile overlapping feature identities

**Contract.** A geometric vertex or edge can carry multiple feature memberships.
Membership identity is distinct from geometric identity. Equal rounded
positions alone are insufficient evidence that two sheets or features coincide.

1. Trace the eleven proven housing spans back to their strata, parameter ranges,
   face-pin keys, and graph edges. Determine which are duplicate descriptions
   of the same visible feature and which require a richer incident-patch model.
2. Define compatibility using proven common geometry, visible incident strata,
   endpoint correspondence and orientation. Start with the demonstrated straight
   spans; ambiguous curved overlaps retain an explicit unsupported result.
3. Reuse one canonical vertex/edge only for compatible coincidences. Subdivide
   partial overlaps at their interval endpoints. Preserve each curve's parameter
   range and direction; do not copy one curve's parameterization onto another.
4. Replace `mesh_feature_graph`'s unconditional duplicate-edge rejection only
   where this compatibility contract holds. Carry memberships through point
   tables, worker merge, assembly edits, output metadata and chain validation.
   Check existing transport support before changing any serialization format.
5. Treat housing curve 75 separately. Nearby ordinary edges do not establish a
   crease. Test ordered connectivity, endpoint incidence, adjacent patch normals
   and continuous interval coverage within the declared sampling limits.

**Exit gate:** all eleven diagnosed spans retain the expected memberships on
valid physical edges, without relaxing chain validation. Reversing orientation,
partial overlaps and worker ordering preserve the result. Closely separated
sheets remain distinct. Curve 75 either gains demonstrated sharp-chain coverage
or remains a separately reported open defect with a specific construction cause.

## 3. Make construction valid in final float32 coordinates

**Contract.** Valid f64 working geometry is not enough: the shipped float32 mesh
must have distinct corners and nonzero area for every triangle. Conversely,
small but nonzero triangles must not be rejected by an arbitrary area epsilon.

1. Audit the first defective stage separately: bracket feature-graph faces that
   collapse on conversion versus housing faces already degenerate in f64.
   Record responsible cells, patches and point provenance, not only final IDs.
2. Normalize duplicate loop vertices and compatible corner/pin identities before
   triangulation using step 2's contract. Preserve boundary constraints and
   memberships. Repair corner fans/patch triangulation where a proposed center
   lies on a boundary edge or creates collinear output faces.
3. Validate candidate patches in their eventual float32 coordinates before
   accepting them. Reuse existing robust predicates where sufficient; ensure
   the decision handles near-collinearity and tiny representable valid faces.
4. If a candidate fails, try a constrained local retriangulation with the same
   boundary. If safe construction cannot be established, refine or report an
   unresolved patch. Do not silently remove triangles from a closed surface.
5. Verify that assembly, refinement, flips and serialization cannot reintroduce
   the defect. Place the common validation at the appropriate shared boundary
   and preserve enough provenance to identify any later offending operation.

**Exit gate:** bracket and housing each have zero exact invalid output triangles;
edge incidence, winding and vertex links remain valid; local intersection tests
pass; steps 1/2 feature obligations still hold. In particular, the housing result
must not reproduce the five nonmanifold edges from hypothetical weld/drop.
Targeted quantization tests include points that collapse to one f32 value,
collinear fans, and tiny valid triangles. No global deletion/weld repair is used.

## 4. Strengthen independent coverage on the repaired regions

Extend the acceptance suite's planned measurement lane, using existing GPU batch
sampling and geometric mesh queries. First cover the bracket junction, housing
flange/curve 75 and neighboring internal passages, rather than implementing a
universal coverage certificate before these repairs can ship.

- Generate surface witnesses independently of compiled feature labels, with
  explicit root brackets, sample spacing, ambiguity and numerical allowances.
- Measure surface-to-mesh distance and mesh-to-reference residuals at vertices,
  edges and triangle interiors. Label field residual separately from distance.
- Add ordered crease samples and checks on incident patch normals; proximity to
  any edge is insufficient. Include reverse/internal views and cross-sections
  where they expose otherwise hidden geometry. Visual acceptance remains manual.
- Prove the checks detect deleted junction patches, bridged gaps, lost feature
  labels and smoothed creases by corrupting copies of real captured meshes.

**Exit gate:** the old bracket omission and deliberate regional corruptions are
detected; repaired regions pass their declared empirical thresholds. Sampled
coverage is never reported as a global Hausdorff or multi-sheet guarantee.

## 5. Reduce uncertainty and cost after correctness

Group `same_sign_root_interval` cells by subtree/operator and locate where bound
tightness is lost. Use their full complex-model contexts. Consider tighter local
interval composition or bounds over transformed subtrees only after identifying
the dominant cause. A box-only theorem is not the milestone.

For each proposed exclusion rule, state the enclosure assumptions, preservation
under the actual transform/CSG operators, and why zero can safely be excluded.
Construct counterexamples around thin sheets, grazing contacts and same-sign
hidden components. A favorable sample histogram cannot prove exclusion safety.

**Exit gate:** conservative justification plus adversarial tests; unchanged or
improved geometry/feature obligations; measured reductions in unresolved work
and export time on original scenes. Ambiguous cells remain unresolved. Use the
acceptance plan's alternating baseline/candidate repetitions for performance
claims, with no concurrent builds or export campaigns. Mess 1's timeout remains
a resource failure until it actually completes within the recorded budget.

## Execution and review

Implement one numbered milestone at a time in a reviewable commit. At each step,
run the relevant focused native and actual-WASM tests, the acceptance checker
tests, and `make build`. Use targeted bracket/housing exports during iteration;
after an accepted candidate for each geometry milestone, run
`make acceptance-tests` once across all five unchanged models. Preserve original
and candidate reports with per-metric deltas; do not rerun the full campaign for
documentation-only changes.

Compare geometry, feature obligations, topology, numerical events, triangle
counts, export times and worker recovery. Existing unrelated failures can remain,
but a new failure blocks the milestone. A single timing sample can flag a cost
change; use repeated measurements before claiming a regression or improvement.
Substantial additional tessellation must be explained by restored geometry and
reviewed, not hidden by an aggregate quality score.

Release gates use production settings and actual WASM serial/worker exports.
Focused tests additionally vary worker partition/order and a small deterministic
set of rigid transforms on the full models. Require geometric obligations,
not identical triangulations across lattices. Reuse the suite's capture owner;
multiple agents, if requested later, must not run competing browser/timing jobs.

First implementation deliverable: the bracket junction regression, a shared-face
construction repair, and a report showing the 0.057258117 mm miss reduced below
0.02 mm with incident features and topology preserved. This is a concrete bounded
repair; general multi-sheet reconstruction remains outside its completion claim.
