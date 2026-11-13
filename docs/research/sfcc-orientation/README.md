# SFCC orientation failure: inconsistent graph rotation and duplicate arc representations

**The failing triangle comes from a malformed patch walk.** The captured corner
rotation disagrees with boundary-port order. One resulting face traverses seven
feature edges in both directions; its fan produces seven opposite-winding duplicate
triangle pairs and eight nonmanifold edges. These defects all occur in the first
cell of the captured component.

The selected experimental correction rejects a repeated-vertex patch boundary
before triangulation. It passes **52 focused checks**, a non-test library build,
and a fresh component attempt that refuses this exact walk while preserving live
state. **This prevents false local acceptance; it does not repair the component.**
Completing the mesh requires a source-qualified identification of curves 46/66 and
their face ports, with checked correspondence over the entire affected intervals.

[Fourth-agent decision](decision.md) · [Previous runtime milestone](../sfcc-lower-runtime/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## Captured cause

The previous round reached triangle 11, `[636,455,633]`, in cell `[7,25,58,86]`.
The new observational capture retains the successful graph, rotation order,
chosen strata, projected fan points and emitted triangles. It adds no field or
curve evaluations. Every pre-existing component-receipt field matches the previous
run after excluding process-local root addresses.

The offending fan uses stratum 38 and center 636. Its carrier normal equals the
already sampled tree gradient at that projected center. The graph supplied this
20-entry boundary:

```text
453,455,633,632,628,629,630,631,454,456,
628,632,633,455,454,631,630,629,628,461
```

Vertex 628 is the existing corner. The walk repeats eight vertices and traverses
seven edges in both directions. Consequently the fan contains triangle 11 and its
exact reverse, triangle 22 `[636,633,455]`, plus six other duplicate pairs. A coherent
sum of triangle areas cannot certify each triangle: this fan's summed area vector
agrees with the reference while seven constituent triangles oppose it.

| Exact saved-mesh observation | First cell | Complete captured component |
| --- | ---: | ---: |
| Triangles | 30 | 1,700 |
| Duplicate-face groups | 7 | 7 |
| Edges with more than two incident triangles | 8 | 8 |
| Same-direction two-use interior edges | 0 | 0 |

The mesh is an open component; boundary edges are not automatically defects.
These counts do not establish contact or winding correctness elsewhere. Reversing
triangle 11 alone creates a same-direction adjacency on edge 455/633 and leaves
the duplicates and nonmanifold edges. It is not a repair.

### The rotation system is inconsistent with the disk boundary

The outer boundary orders the five represented radial ports cyclically as
`39,461,455,454,456`. The corner's angular sorting orders them as
`39,461,454,455,456`: the two nearly coincident ports are swapped.

| Radial representation | Corner-to-boundary path | Boundary port |
| --- | --- | ---: |
| Curve 46 | 628→629→630→631→454 | 454 |
| Curve 66 | 628→632→633→455 | 455 |
| Lifted continuation | 628→456 | 456 |
| Cylinder/chamfer | 628→39 | 39 |
| Native extrusion/cylinder | 628→461 | 461 |

Exact traversal of the captured half-edge permutation gives V=16, E=20 and four
face orbits including the exterior. Capping those orbits yields Euler characteristic
zero: the orientable **combinatorial rotation system** has genus one. This does not
claim that the CAD surface contains a handle. The supplied rotation fails to
represent the intended disk star.

Changing only the corner rotation to boundary order gives six face orbits and
Euler characteristic two. That topology-only counterfactual is still not an
authorized geometric repair: it retains five represented rays where the source
has four physical rays, including an artificial sector between the alias ports.
The doubled edges are not abstract graph bridges; their repeated traversal is a
property of this inconsistent face-orbit walk.

The existing incidence guard counts each feature edge twice but does not require
those two uses to belong to distinct simple patch faces. Its fan then assumes a
disk boundary. A required-ray inventory, edge-use counts and small positional
errors are therefore insufficient to establish a valid embedded arrangement.

## Independent source proof

B checks the actual finite primitives and enclosing operations over a box containing
both the working and f32 triangle coordinates. Strict margins establish the selected
finite extrusion edge, finite cylinder side, unique groove segment, inactive inner
round competitor, cap cutter and outer sphere. The local scalar reduces to

```text
F = max(E, C, w(E+g), w(C+g)),  g = G+r, w > 0.
```

E is the twisted extrusion field, C the cylinder field and G the subtractive groove
field. The four gradient intervals are enclosed throughout that box. For both
precision triangles, their represented-coordinate area vector has a strictly
negative dot product with **every** one of those gradient intervals. Positive
normalization and convex combinations at ties preserve that sign.

This is stronger than checking the sampled centroid gradient. Sampled points do
switch between native and native/chamfer branches near the crease, so a claim that
the entire triangle belongs to one smooth patch would be unwarranted. The cone
proof establishes the orientation conflict despite that switch. It does not assign
ownership to the triangle or establish a valid two-dimensional approximation.

The same source restrictions establish local equality between the native extrusion
field and its inactive inner-round parent. Curves 46 and 66 use those two
representations respectively, together with the **same compiled chamfer carrier**.
Their local supporting intersection equations therefore coincide. Their numerical
parameterizations and complete trimmed intervals have not yet been identified.

## The two numerical ports associate with one local source crossing

The captured points 454 and 455 have different bits and parameters. B derives a
unique crossing of the supported source branch on the captured Y-min plane, using
the groove's affine radial equation, the fixed native profile coordinate and the
selected untwisted branch sign. The full finite/source conditions are rechecked
on a box containing the root enclosure, both stored ports, both actual own queries
and the triangle. The cylinder is strictly inactive there.

| Direct association | Upper distance to physical source root |
| --- | ---: |
| Chart 46, port 454 | 1.2185321384891279e-11 mm |
| Chart 66, port 455 | 1.0494293679449649e-7 mm |
| Unchanged allowed distance | 3.796655370190979e-7 mm |

Each stored point and actual own query is checked directly against the root;
no chain of tolerances is used. Their stored/query coordinates also match bitwise.
The root enclosure is approximately
`(-9.35450180781844, -2.4943226517164696, 5.39066657410827)`.

Review corrected an exactness claim: the generated common carrier is
`Q = weight*H + weight*G + offset`. Its rounded offset need not equal `weight*r`
in represented-real arithmetic. The final packet separately encloses the physical
root and generated-carrier root. It bounds `offset/weight-r` by
[-2.2204460492503136e-16, 2.2204460492503136e-16], and their spatial separation by
2.1050578051203235e-13 mm. It does **not** claim the roots are identical. Both ports
are checked directly against both enclosures under the unchanged allowance.

The rectangle in this proof is the captured **cell-face** rectangle. It is not a
completed typed certificate for the adaptive FaceRecord's key, length and potentially
smaller rectangle. The actual staged record is separately preserved: axis 1,
key 3398483, length 1, with both ports and the tiny segment 455→454. Binding that
record and all its consumers is still required before rewriting any contour.
Uniqueness is local to the certified source region and branch, not a global claim
that the entire face has only one crossing.

The existing shared-arc transport requires matching endpoint vertex IDs before
reusing a sampled path. Ports 454 and 455 fail that necessary condition. Removing
the check would discard a trust boundary; the missing operation is a proved shared
face-port binding followed by checked interval transport.

## Selected correction and its limits

Five lines in the existing graph walk reject a patch polygon containing a repeated
vertex with `non_simple_patch_boundary`, before selecting its stratum or emitting
its fan. No angle is reordered, point merged, curve removed or triangle flipped.
All numerical and resource limits remain unchanged.

A simple disk boundary is a precondition of the current fan representation.
Rejecting a repeated-vertex walk enforces a necessary condition. Unique vertex IDs
alone do not prove geometric simplicity, visibility from a fan center or source
coverage. Slit and multiply connected domains would need a different supported
representation. This correction does not implement that representation.

In the fresh guarded component run:

- The exact 20-entry walk refuses at repeated point 628 in cell `[7,25,58,86]`.
- All 50 generated queries succeed and are validated; charge is 3,534, below 16,384.
- The cell's ten fallback triangles are discarded by the private caller.
- The component returns `private_graph_refused`; live digest `707005205ae34fd4`
  is unchanged.

No complete mesh is produced. The preceding run's completion of 199 cell meshes
and 1,167 event validations is not inherited by this earlier-refusing candidate.
This is a correction to false acceptance, not a successful reconstruction repair.

## Next implementation milestone

Establish one physical arc represented by both local charts, then update its shared
face and graph data transactionally:

1. Prove the **entire consumed cell intervals** of 46/66 correspond to the same
   regular source branch. The current small source box and shared endpoint do not
   prove this. Bind ordered canonical parameters, actual numerical own queries,
   interval images and unchanged residual/displacement allowances. Preserve both
   original parameterizations and unsupported portions outside the proved region.
2. Bind the exact adaptive FaceRecord, its root container and every incident
   consumer. Prepare a canonical port, segment chain and feature identities before
   mutation; re-enumerate affected cells if the second alias changes the component.
   Do not merge face vertices from proximity or source IDs alone.
3. Build the graph using the proved physical-arc equivalence before angular sorting.
   Preserve every required source ray and both chart identities. Check consistent
   boundary order, simple patch faces, directed edge incidence and rollback.
4. Rerun the complete affected component with all existing f64/f32, query, topology,
   contact and source-ownership gates. The new repeated-vertex guard remains enabled.

Use the established three-plus-review workflow: A independently tackles interval
correspondence, B typed-face/consumer closure, and C adversarial graph/topology
controls; the fourth reviewer selects the bounded transaction from their evidence.
The source equivalence must determine the graph change, rather than an angle-sorting
heuristic being used to assert equivalence.

## Validation and reproduction

The temporary workspaces had been removed. Root restored all 179 parent inputs
from committed patches and verified their hashes. The pinned Rust 1.99.1 compiler
and all ten audited library source hashes are unchanged. The restored baseline
passes 42 focused checks. Builds and geometry were run serially, offline/locked,
with no LTO and 16 codegen units. Budgets remain 120 seconds per build, 60 per
focused campaign/checker and 120 per component including preparation.

| Packet | Validation | Outcome |
| --- | --- | --- |
| A observation | 8 checks, non-test build, 31.100 s component | Same failure and pre-existing receipt fields; complete causal capture |
| A-guard | 52 checks, non-test build, 30.636 s component | Exact malformed-walk refusal; live state preserved |
| B initial | Compile fails | JSON macro syntax corrected in a separately frozen source |
| B-proof | 2 checks | Whole-box normal cone and local supporting-equation equality |
| B-face | 3 checks | Physical source point association; offset interpretation later corrected |
| B-offset | 3 checks | Separate physical/generated root enclosures and direct associations |
| C exact geometry checker | 0.096 s, self-controls pass | Duplicate/nonmanifold census; single-flip counterexample |
| C rotation checker | 0.046 s, self-controls pass | Actual and counterfactual half-edge orbit analysis |

Counts overlap across sources. The guard campaign includes existing successful
two-loop feature construction, planar constraint preservation and graph-capture
controls. Component timings are diagnostic measurements, not export benchmarks.

| Artifact | Purpose |
| --- | --- |
| [Consensus](decision.md) | Accepted scope, review corrections and remaining obligations |
| [A causal capture](A/component-attempt.json) / [handoff](A-packet/handoff.md) | Exact successful graph, patch selection and emitted fan |
| [Guard capture](A-guard/component-attempt.json) / [handoff](A-guard-packet/handoff.md) | New local refusal without relaxed checks |
| [Source normal proof](B-offset/orientation-B-proof.json) | Finite-source margins and normal-cone enclosures |
| [Source face association](B-offset/orientation-B-face.json) / [handoff](B-offset-packet/handoff.md) | Physical/generated coefficient distinction and both ports |
| [Observed adaptive face](alias-face-record.json) | Record needed for the next typed-face binding |
| [Exact geometry audit](orientation-C.json) / [checker](C-checkers/audit.py) | Duplicates, edge incidence and flip counterfactual |
| [Rotation audit](orientation-C-rotation.json) / [checker](C-checkers/rotation.py) | Face orbits and cyclic-order discrepancy |
| [Capture comparison](capture-comparison.json) | Observational invariance against the previous run |
| [Restoration checks](preservation.json) / [receipt index](receipt-index.json) / [runner](run.py) | Source/binary hashes, local evidence and execution |

Every patch is incremental against the previous round's Geometry-capture source.
Apply [A-guard](A-guard-packet/candidate.patch) for the selected guarded runtime;
it already includes A's observational capture. B variants are separate test-only
alternatives. No combined A/B kernel is claimed tested. Full repeated receipts and
binaries remain under `.testresults/sfcc-critical-repairs/e4-invalid-construction/round30-orientation/`.

Production remains at `421f5a9`. Complete interval/face equivalence, a usable repaired
component, later geometry and topology checks, outside contacts, two-dimensional
patch ownership and native/WASM/GPU/full-model acceptance remain open. No visual
QA or production integration was performed.
