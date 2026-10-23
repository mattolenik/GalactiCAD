# SFCC bracket and housing: diagnostic investigation

October 23, 2026. The complete original Manim models and saved production-tuning
WASM outputs are retained. This work expands the acceptance report and
investigates its failures; it does not change the meshing algorithm or relax
acceptance thresholds.

Open the [expanded acceptance report](../../.testresults/sdf-meshing/investigated-2026-10-23/report.md)
and [detailed investigation with evidence links](../../.testresults/sdf-meshing/investigated-2026-10-23/investigation/README.md).
Reports and binary/image evidence live under the ignored `.testresults/` tree;
copy the complete run directory to share them.

## Findings

| Area | Bracket | Housing |
| --- | --- | --- |
| Exact invalid output triangles | 6, all with coincident float32 corners | 180: 176 coincident-corner and 4 collinear faces |
| First malformed stage in native replay | Six nonzero-area feature-graph faces collapse during float32 conversion | Many faces already have zero area during cell construction; rounding adds others |
| Demonstrated geometric omission | Known dent/rib corner is 0.057258117 mm from the saved mesh, versus 0.02 mm feature tolerance | No such surface omission demonstrated by the sampled gap probes; full coverage is not established |
| Feature labeling | Several gaps remain distinct from the missed corner; native IDs 73/74 cannot be reliably joined to WASM | 11 of 40 gap spans are physically covered by straight mesh edges bearing other curve IDs |
| Missing curve | No whole compiled curve missing, but corner 18 and adjacent intervals are lost | Curve 75 has no labeled output chain; its sampled candidate geometry is within 0.004387 mm of the mesh |
| Meaning of unresolved-cell count | 96.93% first reject on conservative same-sign interval uncertainty | 85.77% first reject on the same uncertainty |

The triangle audit uses integer arithmetic on the exact float32 values. It does
not reject small valid faces using an area epsilon. Invalid-face coordinates,
vertex IDs, extents, incident feature IDs and exact-position connectivity are
included in each case's diagnostic JSON and report tables.

## Bracket: known feature information is discarded

At `(-3.297404376, 11.496906301, 2.209119397)` mm, compiled corner **18** joins
curves **13/43/45**. The existing WASM field diagnostic returns approximately
`1.8e-15`; exhaustive nearest-triangle measurement independently confirms the
0.057258117 mm miss in the actual saved output.

Actual WASM preparation accepts cell **(7,56,77,69)** without requesting a split,
despite all eight sampled corners being outside. A selected one-leaf worker
replay retains **three face pins but emits zero triangles**. The full original
prepared octree is retained as context; this is not a replacement toy scene.

The path is:

- [Corner exemption in the decision pipeline](../../gcad-wasm/kernel/src/sfcc/pipeline.rs)
  accepts the known corner.
- [Face contour construction](../../gcad-wasm/kernel/src/sfcc/face_contour.rs)
  returns no segments when boundary crossings are empty, even though feature
  pins are present inside the face.
- [Cell construction](../../gcad-wasm/kernel/src/sfcc/cell_mesh.rs)
  skips a cell with no gathered segments.

Native tracing repeats the same corner exemption in both refinement rounds.
The actual WASM checks corroborate preparation and empty local construction in
round 0; the saved final WASM mesh still omits the junction. Native whole-mesh
geometry differs slightly from WASM and is never presented as an exact replay
of that final execution.

The acceptance suite now retains this **full-model, source-pinned geometric
witness**. A feature label or a passing vertex residual cannot make it pass
unless the actual output surface comes within its 0.02 mm limit.

## Housing: different failure mechanisms coexist

All invalid faces are around the flange region, within
`[-10,-6.881299,11.501595]` to `[10,10,19]` mm. Ninety-six lie entirely on
`z=19`. Native preassembly has 150 exactly degenerate f64 faces and 188 faces
degenerate after f32 conversion. Matching source candidates implicate
cell-loop/corner/fallback construction as well as feature-graph construction.

Eleven straight gap spans have exact continuous mesh-edge coverage under
different IDs—for example expected curve 3 is covered by curve 12. These are
representation/labeling failures over those spans, not absent physical edges.
The full report lists each mapping. The source uses curve-specific face-pin
keys and rejects an already-present graph edge rather than combining compatible
memberships; these are concrete follow-up locations, not a completed proof of
one unique cause for every invalid face.

The missing curve-75 candidate is close to the saved surface at all 17 sampled
points. Native tracing at its midpoint reaches a depth-8 multi-curve cell and
uses a 12-triangle cell-loop fallback. Proximity to some mesh edges does not
prove the required connected sharp curve survives.

A hypothetical exact-position weld followed by invalid-face removal leaves
five nonmanifold edges. No blanket weld/delete repair was applied.

## Scope and next fixes

The report now displays passing topology and vertex checks alongside failing
triangle/feature checks, numerical events, unmet refinement criteria, quality
audit availability, phase timings and all feature issue ranges. User feedback
that housing/bracket look close is recorded separately from structural results.

Next work should preserve the known bracket corner by constructing its
face-interior contour, reconcile overlapping feature memberships, and make
corner/pin triangulation valid in final float32 coordinates. Those changes need
the original full models as regression gates. Improving broad exclusion bounds
is a separate task from repairing these demonstrated defects.

Existing WASM field/interval diagnostic APIs were used to check internal
consistency. No alternate CPU scene evaluator was added, and no independent GPU
field parity or global Hausdorff guarantee is claimed. Sampling limitations,
native/WASM differences, and ambiguous positional provenance are explicit in
the linked evidence. No visual QA or algorithmic repair was performed.
