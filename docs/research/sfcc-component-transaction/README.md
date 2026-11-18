# Complete affected-component reconstruction succeeds; publication remains blocked

**The private transaction reconstructs all 205 affected cells and 1,031 required
faces, producing 1,775 triangles.** All seven consumers of the secondary shared
prefix complete, including opposite consumers and the activation cell. The
component passes indexed topology, working/exported winding, self-contact and
original frontier-binding checks. All **1,929 generated query events** validate.
The reviewed source passes **43 distinct focused tests** and a non-test library check.

This advances beyond the two isolated local replays. It does **not** establish
safe publication or general SFCC correctness. The candidate has no certified patch
owners on any of its 1,775 triangles, matching-stage outside contacts remain
unchecked, and production code is unchanged.

[Fourth-agent review](decision.md) · [Activation milestone](../sfcc-inner-activation/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## Measured result

| Check | Reviewed result |
| --- | --- |
| Selected cells / required faces | 205 / 1,031 |
| Changed face records | 204: 198 primary plus six secondary |
| Secondary consumers visited / completed | 7 / 7 |
| Triangles | 1,775 |
| Allocated / used vertices | 1,114 / 1,109 |
| Indexed edges / boundary edges | 2,883 / 441 |
| Frontier face records | 827 |
| Original frontier bindings and oriented boundary segments | Match; zero binding failures |
| Duplicate faces / nonmanifold edges / misoriented internal edges | 0 / 0 / 0 |
| Invalid vertex links | None |
| Working f64 / exported f32 orientation and self-contact | Pass |
| Final curve-interval memberships | 508 |
| Checked primary events | 1,864 |
| Generated events attempted / successful / postvalidated | 1,929 / 1,929 / 1,929 |
| Generated reservation / unused slots | 2,048 / 119; no refund |
| Total query ledger | 8,413 / 16,384 |
| Complete original-scene diagnostic, including preparation | 32.193 seconds / 120-second cap |
| Focused campaign | 43 tests, 33.674 seconds / 60-second cap |
| Live state | Preserved; no publication API invoked |
| Certified patch-owner labels | Absent on all 1,775 triangles |
| Full acceptance / publication | False / blocked |

The runtime-selected primary pair is 20/39 in this witness; the secondary pair is
46/66. Earlier historical prose sometimes used 20/33. The implementation selects
source roles rather than hardcoding those historical IDs.

## What changed

A prepares the complete secondary face inventory, proves all six actual paired
records, and merges their point identities into the existing private transaction.
It binds the activation to the actual lattice cell and face-derived parameter
brackets. It then computes the closure of every changed point's face consumers;
this is how the original 199-cell scope expands to 205 cells. Original live faces,
points, feature curves and global parameter ranges remain immutable.

The secondary plan is rebound to the actual private meshing view. That view is
created by the existing primary-alias omission. The secondary proof checks its
source selection, original chart metadata, shared root identity and unchanged
physical/generated event enclosures. The request records the derived view's own
fingerprint. It does not waive source identity because the global fingerprint
changed after the deliberate primary-view edit.

B reuses the existing closed-incoming and activation checks. It binds each
consumer's exact original nodes, parameters and cell box, forces planned consumers
through the feature graph, and requires all seven to complete. The original common
corner is included in the first consumer. Every shared incoming edge retains both
parameterizations; native 46 ends locally at the event and composite 66 continues
to the unchanged original frontier. Other curve-66-only faces are outside this
sharing authority. No global native tail is removed.

C checks the emitted edges against each supplied, source-qualified local window.
Its exact indexed paths reject gaps, overlaps, disconnected equal-parameter nodes,
duplicate memberships and missing endpoint bits. Incoming native/composite edges
must coincide geometrically while retaining both identities. At activation there
must be one incoming dual edge and one outgoing composite-only edge. These are
feature-edge coverage checks, not a theorem about the intervening surface patches.

The constructor retains its original query audit, primary full-range coverage,
face consumption, frontier immobility and orientation checks. The new whole-mesh
checker adds cross-cell indexed topology and self-contact checks in both working
and rounded coordinates. The contact helper already checks exported predicates
when testing working geometry, so a refusal there is not labeled exclusively f64.

Preparation and reconstruction operate on private state. Request scopes restore
on ordinary exit and unwind; failed sharing cannot silently fall back into a
successful component. The generated log is still finished and postvalidated when
the secondary scope or a consumer refuses. The executed original-scene diagnostic
proves the live input digest is unchanged. This is discardable private preparation,
not testing rollback of an implemented production commit operation.

## Critical review found and closed an incomplete-proof path

The first composition reconstructed the same component successfully, but D found
a guard bug independent of this six-face witness. The typed observer could return
a top-level refusal with a successful prefix of rows; preparation inspected only
the rows. It could therefore treat an incomplete observation as authority.

The selected revision now:

- Rejects any top-level or per-row refusal.
- Independently enumerates paired records across all three axes.
- Rejects ambiguous paired pins and unsupported Z-face pairs explicitly.
- Requires exact equality between the intended inventory, certified face set,
  independent source-family inventory and installed changes.

Negative controls cover refused prefixes, incomplete/duplicate inventories,
unsupported axes and ambiguous pins. The fresh reviewed run has **identical point
payloads, triangles, sorted interval memberships, generated query records and
ledger charges** to the earlier composition. Tightening the guard did not change
the successful witness. See the [preservation summary](summary.json).

The bounded consumer revision also avoids cloning the whole plan per graph and
removes duplicate geometry arrays from its diagnostics. A repeated visit invalidates
completion. Its 512 KiB serialized report cap fails closed; that cap describes the
consumer report, not the complete component receipt or total allocator memory.

## Query and storage claims remain limited

All existing numerical tolerances and resource limits remain. Generated validation
and post-graph phases both record 1,929 total and validated events, with the ledger
equation satisfied and zero exhausted reservation. The 119 remaining generated
slots are only about 5.8% headroom. A larger fixture may still refuse; no increase
or implicit refund is authorized by this success.

The primary transport's `maximumRequest=2` statistic is not a universal bound on
secondary inverse work. The secondary searches retain their separate 64-request
and 64-iteration guards. Ledger charges include reservations and validation and
must not be presented as the number of actual geometry queries or field evaluations.

The existing staged layout reservation is 18,972,568 bytes. Additional conservative
request-layout terms bring that subtotal to 18,993,659 bytes before the separately
accounted source view. These terms use the existing checked ledger and the same
64 MiB policy. They cover retained plan/vector layouts, not all diagnostic JSON,
checker BTree allocations or the dual contact-index workspace. An allocator-complete
working-memory bound for the new checker remains open. This result must not be
called a measured or proved 64 MiB RSS bound.

## Why the remaining surface-ownership gate matters

A valid indexed mesh with the expected boundary is not sufficient to establish
that it represents the intended implicit surface. It can still select the wrong
surface branch, miss an interior sheet or fill a region whose source operation is
not exposed there. Vertex residuals, normals, curve correspondence and a lack of
self-intersections do not settle those questions.

All 1,775 candidate triangles currently lack `PointTable` patch-owner labels.
Inspection of `fan_from_stratum_vertex` explains why: patch authority is recorded
only for the supported local-edit path after its disk check. The fallback fan does
not receive it. Simply copying graph stratum IDs onto those triangles would turn
an unproved hypothesis into metadata; it would not establish ownership.

The [round34 follow-up](../sfcc-patch-ownership/README.md) adds a crucial qualification:
this frozen fixture has `qualityTriangulation=false`, which bypasses that path even
for supported carriers. The first cylinder fan is supported; 823 of the 1,775
triangles use that supported carrier. Missing labels alone do not establish that
all fans have unsupported geometry. The follow-up keeps the option unchanged and
checks actual composed-source regions instead.

The existing receipt's conservative publication reasons predate the new checker
and still bundle vertex links/frontier with unchecked metadata. Read the separate
results precisely: indexed component vertex links and original frontier bindings
now pass. Retained-outside topology/contact, complete old-metadata transport and
continuous two-dimensional source ownership remain open. No matching-stage outside
triangle mesh exists at this diagnostic barrier, before ordinary cell meshing.

## Execution and reproducibility

Root ran builds and geometry serially. A/B/C worked on isolated copies; D reviewed
the combined source, found the incomplete-proof issue and checked the final saved
results. The compiler and ten audited library hashes match the pinned Rust 1.99.1
baseline. Cargo stayed locked/offline, with no LTO and 16 codegen units.

| Frozen packet | Executed result |
| --- | --- |
| C-check | Five checker controls pass; its initial contact-refusal label is corrected in the composition |
| B-check | 23 tests pass; the broad `component_b_` filter also ran the older component observer, transparently recorded |
| Combined | 32 tests and library check pass; complete private reconstruction succeeds in 32.294 seconds |
| Reviewed | 43 tests and library check pass; complete private reconstruction succeeds in 32.193 seconds with the strengthened inventory guard |

The B filter overlap was corrected for subsequent campaigns by selecting the
consumer namespace and exact request test. Counts overlap across packets and are
not additive. Test-harness exit success alone is not mesh acceptance; the full
receipts separately record construction success and publication refusal.

| Artifact | Purpose |
| --- | --- |
| [Consensus](decision.md) | Independent review, correction and accepted scope |
| [Selected complete receipt](Reviewed/component-attempt.json) | Actual cells/faces, geometry, all query records and remaining gates |
| [Summary](summary.json) | Counts and checked preservation after the review fix |
| [Transaction handoff](transaction-reviewed-handoff.md) | Atomic preparation and exact inventory guard |
| [Consumer handoff](consumer-handoff.md) | Required request/consumer completion and inherited source checks |
| [Validation handoff](validation-handoff.md) | Indexed coverage, topology/contact checks and their limits |
| [Restoration verification](preservation.json) / [receipt index](receipt-index.json) | Input and binary hashes, including locally retained raw outputs |
| [Runner](run.py) | Bounded build, test and component commands; secondary transaction opt-in |

Restore and verify the 199-input [round32 selected source](../sfcc-inner-activation/README.md),
then apply [Reviewed-packet/candidate.patch](Reviewed-packet/candidate.patch).
The selected source has 202 inputs. All four executed patches target that same
base and **must not be stacked**. Each patch was restored into a fresh directory
and every input hash verified. Large repeated receipts, raw build logs and binaries
remain under `.testresults/sfcc-critical-repairs/e4-invalid-construction/round33-component/`
with hashes in the receipt index.

## Next milestone: establish surface ownership and outside compatibility

1. **Identify and justify the surface patches.** Inventory the source-stratum
   hypotheses for the emitted fans, preserving source occurrence and operator
   ancestry. Begin with the first unsupported fan. Derive a positive bounded
   condition establishing the relevant surface branch, its exposure, a regular
   local parameterization and coverage of the intended disk. A polygon chord need
   not lie exactly on the zero set: ownership must include its approximation bound,
   not impose a false exact-zero requirement on triangle interiors. Reject or
   subdivide regions where uniqueness, separation or operator activity is unproved.
2. **Check the unchanged outside mesh at the same construction stage.** Obtain the
   complete relevant outside geometry using conservative spatial bounds, preserve
   original frontier positions/parameters and check contacts plus joined vertex
   links in working and exported coordinates. Later postprocessed output is not a
   substitute. Missing outside triangles keep this exit open.
3. **Close metadata and memory obligations.** Verify retained protected intervals,
   source memberships and ownership through the proposed replacement. Account for
   the new checker/diagnostic working allocations under the existing policy or
   replace them with a bounded design. Preserve the 2,048 generated-slot cap and
   report any exhausted budget as a refusal.
4. **Integrate only after those exits pass.** Freeze the current production baseline,
   port the selected repair, and run native/WASM/GPU parity and full-model/transform
   preservation. No browser or visual QA was performed in this milestone.

Use the plan's same three-agent/fourth-review model: A challenges and implements
source-patch authority, B handles matching-stage outside geometry/interfaces, and
C independently audits metadata, allocation bounds and adversarial controls. D
reconciles their evidence before selecting the next bounded experiment. The first
unsupported ownership witness is the next mathematical discriminator; it is not
permission to relabel all 1,775 triangles.
