# SFCC stage 4: component validation stopped at source admission

**The complete affected component has not been constructed or validated.** The
fresh source-admission test fails with `endpoint_missing`: both selected charts
still have unresolved upper ends. The conditional component attempt independently
reproduces that refusal before octree or mesh construction. No downstream geometry
or interface check is reported as passing.

The selected Stage 3 repair remains valid for its bounded local witness. Its twelve
controls pass again, and the exact pipeline context has the same feature fingerprint
as the selected Stage 3 result. This is the next unresolved source obligation,
not a failure caused by stale curve IDs or a changed toolchain.

[Consensus decision](decision.md) · [Implementation plan](../../plans/sfcc-graph-correctness-implementation.md) ·
[Selected local repair](../sfcc-stage3-incoming-connection/README.md).

## Actual first refusal

The old diagnostic required fingerprint `9875508341830920921` and charts `[20,33]`.
The new test-only locator uses the original immutable source occurrences, selected
profile side, fixed branch sign and previously established height window, with
checked own-curve events. It discovers current charts **20 and 38**, corresponding
to native/cylinder sources `[10,15]` and parent-field/cylinder sources `[30,15]`.
This locator does not substitute for complete-arc admission.

Both charts have parameter range `[0,31]`, lower corner 13 and upper corner `-1`.
Their checked upper ends differ:

| Chart | Source pair | Upper point, mm |
| --- | --- | --- |
| 20 | `[10,15]` | `(-6.7080399240680695, 2.6968636287115637, -8.464171570633368)` |
| 38 | `[30,15]` | `(-6.709748680177877, 2.696127486844445, -8.462817063416903)` |

Their observed separation is **0.00230140002841449 mm**. Both numerical carrier
and domain checks pass their accepted bands, but neither end has source-junction
authority. A bounded 0.08-mm indexed neighborhood lists only these two charts.
That is neither a completeness proof nor evidence that the physical crease ends
there. It does not authorize welding the unequal endpoints.

`private_arc_a::admit` calls `admission_query_reservation` first. That unchanged
gate requires the physical chart's endpoints to resolve to actual compiled corners.
The upper `-1` produces reason `endpoint_missing`, detail `admission reservation`,
before complete source transport, face/pin preparation or private construction.
The mandatory acceptance assertion fails after writing its receipt.

The current fingerprint is `5850573460878635130`, with 76 curves, 40 corners,
74 strata and 83 unresolved trims. Exact `pipeline::build_pipeline_context`
preparation reproduces the selected Stage 3 fingerprint and refinement bits;
no pipeline-context drift was observed.

## What was executed

| Work | Build time | Execution time | Result |
| --- | ---: | ---: | --- |
| Selected repair plus retained synthetic storage lifecycle | 14.737 s | 3.431 s | 13 controls pass: twelve repair controls and one lifecycle control |
| C source selection, cloning and source-only storage | 14.502 s | 0.826 s | Pass |
| C required complete-source admission | Same build | 0.807 s | **FAIL: endpoint_missing** |
| B-lifecycle topology and owned-request cleanup controls | 14.637 s | 0.019 s | Both pass |
| One conditional original-source component attempt | Same build | 0.674 s | Refusal captured before octree; **component not accepted** |

The attempt had a separate 120-second preparation-inclusive watchdog. It did not
consume that budget because admission failed early. A passing diagnostic process
means the refusal was captured honestly; it is not a passing component test.
These times are not mesh-export benchmarks.

Root verified all 164 selected source inputs and all ten audited standard-library
and hashbrown files against the recorded Rust 1.99.0 toolchain. Builds were
offline/locked, no-LTO/codegen16, with fresh task-owned kernel caches and nonzero
test discovery. Every executed diagnostic patch was independently restored and
checked against its recorded input hashes. A fourth agent reviewed source,
receipts and binaries without running geometry.

## Storage result and unavailable mesh evidence

The updated selected source's owned-clone reservation is **944,540 bytes**, including
the new traced-chart representation. Clone metadata, indexing state and checked
chart queries are preserved. Overflow and synthetic lifecycle controls pass.

That reservation supplies **zero staging bytes** and is explicitly source-only.
It does not establish that the actual source-plus-component reservation fits the
64 MiB policy. Actual component staging has not been constructed.

| Obligation | Current result |
| --- | --- |
| Source-based chart selection | Passed, including renumbering/ambiguity controls |
| Selected source clone/storage accounting | Passed for source-only scope |
| Complete source-arc admission | **Failed** |
| Fresh affected-component leaf/face inventory | Not reached |
| Typed face/root and pin certificates | Not reached; historical 198/396 results not reused |
| Actual combined private reservation | Not reached |
| Private cell meshing and original graph guard | Not reached |
| Component triangles, f64/f32 validity, winding and slivers | Not generated / not measured |
| Actual component edge/link and frontier checks | Not reached |
| Internal and retained-outside contacts | Not reached |
| Publication | Not permitted |

The old 199-leaf, 1,001-face component and 19,865,723-byte reservation remain
historical evidence. They are not fresh counts from this attempt. No empty geometry
or vacuous live-state check is substituted for an unavailable component.

## Independent agent work

**A: geometry readiness.** The read-only audit identifies existing exact degeneracy,
orientation and intersection helpers, so no new predicate framework was added.
It records their necessary finite/index-valid inputs and typed point-identity
mapping. Its source is unchanged and its patch is empty. No actual geometry
acceptance follows from that audit.

**B: conditional component capture.** The test-only harness prepares the exact
pipeline feature context, reidentifies source charts and checks admission before
building an octree. If admission later succeeds, it can capture private geometry,
required face consumers, typed frontier bindings and open-component edge/link
inventories. That success path is authored and compiled, but **unexercised** here.
Its small corruption controls pass. The final lifecycle revision also checks owned
capture cleanup and preserves an unrelated capture when acquisition is refused.

**C: source prerequisite.** The mandatory gate records complete selected ranges,
endpoints, source identities, checked nearby candidates, effective setup and the
source-only storage ledger. It preserves the feature state across refusal and
leaves the original admission rules intact.

Even after admission is repaired, the existing round0 barrier precedes ordinary
outside-cell meshing. It contains faces and points, not same-stage outside
triangles. Full contact closure will require complete relevant outside geometry
or a justified conservative exclusion for every omitted piece. Bare cell AABBs
are insufficient because projection and feature queries use expanded envelopes.
Comparing against later simplified output would mix pipeline stages.

## Next source-handoff milestone

1. Capture the current upper truncation frontiers using their actual source
   identities and raw parameter ranges. The old corner-27 fixture is not this
   current endpoint witness.
2. Establish the complete composed-field behavior through the upper transition:
   continuation, branch handoff or genuine termination. Check actual scalar blend
   equations and primitive/operator domains. Zero-locus equivalence of the native
   and parent fields cannot simply be extended to nonzero blend operands.
3. If continuation is required, construct or identify its outgoing representation
   and prove ordered connection, memberships and numerical association. If a true
   terminal is proved, establish its surface-patch topology and representation.
   Neither a nearby point nor an added corner ID supplies those obligations.
4. Rerun the unchanged complete-source admission, including subsequent transport
   and endpoint obligations. Only after it passes should the full component's
   faces, pins, storage and reconstruction be regenerated.

The next repair must preserve the accepted lower connection. Do not bypass the
endpoint gate, widen matching tolerances, shrink the obligation or manufacture a
corner to make this diagnostic proceed.

## Artifacts and reproduction

| Artifact | Purpose |
| --- | --- |
| [Consensus decision](decision.md) | Independently reviewed refusal, limits and next contract |
| [Summary](summary.json) | Separate source, component and production verdicts |
| [C preflight receipt](C/source-preflight.json) | Exact pipeline inputs, source identities, endpoints, refusal and source-only ledger |
| [C failed gate log](C/focused-1.log) | Required admission assertion remains failing |
| [Conditional component attempt](B-lifecycle/component-attempt.json) | Independently reproduced pre-octree stop |
| [Source and toolchain checks](source-toolchain-check.json) | Selected inputs and ten audited library files |
| [Patch restoration checks](preservation.json) | Reproduction of all executed inputs |
| [A geometry audit](A-packet/handoff.md) | Existing helpers, required geometry and outside-contact limits |
| [B harness](B-lifecycle-packet/handoff.md) | Conditional capture and lifecycle controls |
| [C source checker](C-packet/handoff.md) | Locator, full admission gate and storage controls |
| [Runner](run.py) | Pinned toolchain, fresh-cache builds, discovery and watchdogs |

Restore the captured Stage 1 baseline and apply the C or final B-lifecycle flat
patch in isolation. Each includes the selected Stage 3 implementation; do not apply
both or apply one directly to production. The handoffs list focused filters. The
runner's `component-attempt` mode invokes the single conditional original-source
test on an already built B-lifecycle job and refuses to overwrite its receipt.
Native test binaries remain local in `.testresults` and are not committed.

Stage 4 remains open. Production runtime is unchanged; current-HEAD integration,
native/WASM/GPU comparison, complete torture-model acceptance and visual QA were
not performed. No full-component validity claim is made.

The [subsequent upper-handoff investigation](../sfcc-upper-handoff/README.md)
proves local continuation and corrects an intermediate-chamfer evaluator defect,
recovering an outgoing feature in the isolated implementation. The independent
ownership/closure obstruction remains, and complete source admission still fails.
That result advances the source diagnosis without claiming this component was
constructed or validated.
