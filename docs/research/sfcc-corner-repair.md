# SFCC bracket corner construction repair

Milestone 1 of [the critical repair plan](../plans/sfcc-critical-repairs.md).
Baseline: `5566520`; the original diagnosis is in
[the bracket/housing investigation](sfcc-bracket-housing-investigation.md).

## Construction change

The bracket junction is above a shared octree face whose boundary has no sign
crossings. Three modeled feature pins lie strictly inside that face. Their
incident carrier pairs determine a closed contour that the previous early return
omitted. The new bounded path requires unique two-endpoint carrier incidence,
a single simple directed cycle, face-restricted carrier projection, visible root
samples, and negative-on-left orientation. Unsupported incidence is not paired
by proximity. Both adjacent cells consume the same canonical face record,
including the actual coarse/fine interface.

The neighboring cell has two boundary loops connected by the modeled feature
curves. The existing feature graph now accepts all oriented boundary loops and
uses those retained curves to subdivide the surface into patches. It still
requires every boundary edge once and every modeled feature edge twice.
Independent caps are forbidden when this new interior face contour cannot be
connected; the cell requests bounded refinement or remains explicitly unresolved.
A visible tagged corner producing no surface similarly becomes a failed cell.

This second change is essential. Merely restoring the face contour produced a
false separate ten-triangle bubble, while passing the corner-distance and mesh
manifold checks. The full-model component assertion rejects that candidate.

## Geometry checks and their scope

New multi-loop patches retain the existing 0.01 mm surface displacement budget,
float64/float32 checks, carrier/domain checks and full-root field visibility.
Their local triangle pairs are checked with the existing exact intersection
predicates. Feature subdivision also respects that surface budget and retains
the existing 16-point-per-arc cap.

A sample on a modeled curved boundary uses its retained oriented `CurveInterval`
as its reference. Orthogonal projection of a chord onto one carrier can leave
that carrier's trimmed patch: the diagnosed rib/sphere chord projected 0.0011595
mm outside the root surface even though its exact modeled seam is visible. The
new reference checks both adjacent carriers/domains and the full root; it does
not search for an arbitrary nearby curve. Interior and ordinary boundary samples
continue using the existing strict carrier projection checks. No acceptance
threshold was enlarged.

These visibility and displacement samples are empirical checks. They do not
prove that another hidden contour is absent or provide a global Hausdorff bound.
The accepted face construction covers a bounded single-cycle configuration;
untagged unsupported discovery configurations remain outside this repair.
Independent GPU reference coverage belongs to milestone 4.

## Regression checks

`gcad-wasm/fixtures/sfcc-bracket-junction_test.mts` uses the complete original
Manim source, checks its hash, and uses the production acceptance cube
`[-25.2,-19.2,-25.2]`, size `50.4`. It checks the actual junction vertex, all three
incident curve ends, component count, topology, exact local triangle validity,
and sampled triangle-interior exporter-field residuals. It also exercises a
rigid axis rotation, actual worker partitions merged in reverse order, and raw
partition neighborhood edge incidence before serial recovery.

Native unit checks cover solid/cavity orientation, hidden carriers, ambiguous
incidence, coarse/fine opposite consumption, missing-corner refinement,
feature-driven connection of two loops, missing paths, hidden reference samples,
and displacement rejection. The native trace remains diagnostic evidence;
actual WASM output is the release gate.

## Actual WASM results

The baseline corner-distance regression fails at 0.05725811700047605 mm.
The false-bubble candidate fails the one-component regression. The repaired
original and rigidly rotated complete models pass the focused release checks.

| Measurement | Original baseline | Repaired original | Repaired 90° axis rotation |
| --- | ---: | ---: | ---: |
| Corner-to-mesh distance, mm | 0.0572581170 | 0.0000000470796 | 0.0000000476486 |
| Actual junction vertex distance, mm | Absent | 0.000000117739 | 0.000000117739 |
| Incident curves at the junction | Absent | 3 | 3 |
| Triangles incident to the junction | 0 | 6 | 6 |
| Max sampled incident-triangle field residual, mm | Not applicable | 0.0000119073 | 0.001485529 |
| Connected components | 1 | 1 | 1 |
| Triangles | 109196 | 108548 | 108426 |
| Exact invalid triangles | 6 | 6 | 6 |
| Feature parameter gaps | 54 | 46 | 40 |
| Disconnected curves | 8 | 4 | 3 |

Edge incidence, vertex links and shared-face consumption pass in all repaired
runs. The original model's unresolved count remains 59713 and feature fallback
cells decrease from 38 to 32. The lower triangle count comes from connecting
modeled multi-loop patches in six formerly fallback cells; it is not triangle
deletion. Curves 43 and 45 lose their diagnosed gaps entirely; curve 13 loses
its junction-end gap and retains its separate far-end gap. IDs here describe
the original lattice, not the rotated compilation.

The two-worker run also passes the raw junction-neighborhood edge-incidence and
opposite-orientation checks before merge. Reverse-order merge returns the same
original-model measurements, with `serialRecovery=true` reported explicitly.
This is not evidence that distributed re-refinement is implemented.

Validation: `make build`; 184 native library tests; 14 acceptance checker tests;
three actual-WASM full-model tests. Housing and the complete five-model
collateral assessment are recorded by the acceptance campaign. Overall bracket
acceptance still fails on the six pre-existing invalid triangles and remaining
feature/refinement obligations; this milestone does not relabel it a global pass.

## Five-model collateral review

The [complete campaign](../../.testresults/sdf-meshing/2026-10-24T01-04-11-157Z/report.md)
retains all five models and original settings. Housing's vertices, triangles and
feature metadata are byte-identical to the baseline. Knob's three geometry
artifacts are also byte-identical; its newly reported failed cell is a diagnostic
change, not an output-geometry regression.

Actual WASM round-0 knob leaf `(7,22,43,76)`, tagged with corner 60, emits no
points, face segments or triangles and reports one failed cell when selected
with the complete 92688-leaf context. All eight corner samples are positive.
Nevertheless, an existing-WASM-field sign bracket strictly inside that cell
finds a root at `(-10.077725899,-6.003252101,2.943723126)` with residual
`6.66e-16` and minimum distance to a cell face `0.00721193` mm. Its distance to
the unchanged output is `0.00987128` mm, within the configured tolerances. This
supports reporting an unconstructed local obligation; it does not establish an
additional distance-tolerance failure. Actual corner coordinates and the final
refinement round's leaf identity are not exposed by these APIs. Native knob
compilation differs and did not reproduce the failed leaf; it is not used to
attribute the WASM corner.

Mess 2's two native final failed cells contain their corners strictly in their
interiors, with no construction events. The corresponding positions have the
same field values in actual WASM and identical before/after mesh distances:

| Native cell / corner | Position, mm | WASM field | Before and after mesh distance, mm |
| --- | --- | ---: | ---: |
| `(8,150,103,160)` / 12 | `(2.153230912,-2.257488693,6.607421205)` | `7.54e-11` | 0.00983397147 |
| `(8,162,186,111)` / 123 | `(3.693639680,7.834449538,0.761355069)` | `4.44e-16` | 0.03080147592 |

The latter candidate has no wired incident curves or strata; its sampled field
neighborhood is not regular in all tested tangent directions. It remains an
unresolved known-corner obligation, not a claim of a missing smooth surface
patch. Neither witness became farther from the output. Separately, the changed
Mess 2 region replaces 56 triangles with 38; four existing-WASM-field samples
per triangle give maximum residual `0.01384716` mm before and `0.000209182` mm
after. These are empirical exporter-consistency checks, not independent GPU or
global coverage proofs. The new failed-cell counters therefore remain visible;
no validator was weakened to suppress them.

[Collateral evidence](../../.testresults/sdf-meshing/2026-10-24T01-04-11-157Z/investigation/collateral/README.md)
contains exact saved-mesh hashes, selected-worker receipts, the complete knob
prepared context, native failed-cell attribution, and actual-WASM witnesses.
