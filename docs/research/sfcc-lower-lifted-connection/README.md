# Lower lifted connection: source proof and query-cost audit

**The missing lower lifted branch has a source-derived, ordered replacement
interval with checked associations to the existing join and junction.** The source
has four physical crease rays near this event; the existing corner records only
three after aliases are removed. This establishes a repair obligation and a bounded
connection candidate. It does not install that candidate in the mesher.

**The query cap remains 16,384.** New observations identify fresh inverse queries
as the main charge, while repeated cached searches also waste CPU work. The same
component still fails its lower graph construction, then exhausts the query cap
after validating only 744 of 838 generated events. No fallback or partial candidate
is accepted.

[Fourth-agent review](decision.md) · [Previous upper closure](../sfcc-upper-closure/README.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md).

## What is proved about the lower source

Use the actual finite twisted-extrusion scalar E, finite-cylinder scalar C, and
subtractive groove scalar G. Let r be the chamfer radius and g=G+r. Source binding
checks the primitive occurrences, finite profile and cap restrictions, nearest
groove segment, inner round competitor, cap cutter and outer sphere. The source
uses the previously corrected full intermediate-chamfer evaluation.

Near the junction, those strict restrictions reduce the full scalar to

```text
F = max(E, C, w(E+g), w(C+g)),  w = represented 1/sqrt(2) > 0.
```

The coordinate map from position to (E,C,g) has a nonzero Jacobian. Strict source
margins at the event persist in some open neighbourhood. In these coordinates,
the four physical crease rays are exactly:

| Ray | Conditions |
| --- | --- |
| Native extrusion/cylinder | E=C=0, g<0 |
| Native extrusion/chamfer | E=g=0, C<0 |
| Cylinder/chamfer | C=g=0, E<0 |
| Lifted extrusion/cylinder | E=C=-g<0, g>0 |

Exact integer plane-pair enumeration independently checks this cone's four rays.
The other two plane pairs violate another defining inequality away from the
origin. This is a complete **local source arrangement**, not a claim that all
discovered feature records are complete or that this arrangement holds throughout
the failed cell. No explicit neighbourhood radius is computed.

The fourth ray has an explicit parameter a=E=C≤0:

```text
rho = R+a
v   = v0z+nz*a                    (nz is exactly +1 or -1 here)
y   = groove_y + edge_y + ((r+a)-nr*(rho-edge_r))/ny
u   = branch_sign * sqrt(rho²-v²)
```

Rotate (u,v) by the actual extrusion twist at height y. The groove's exterior
distance is r+a, so G=-r-a and both lifted diagonal fields vanish. The proof
encloses represented edge coefficients; it does not assume rounded stored normals
are exact. It reuses the existing outward interval and bounded Taylor-trigonometric
helpers. Sampled agreement with the existing native evaluator is a separate check.

The finite-source and ancestor restrictions are proved over the whole selected
parameter interval. Height has derivative (1-nr)/ny bounded away from zero, making
the ideal curve ordered and injective. Its source-coordinate Jacobian is, up to
orientation, nz*(u/rho)*ny, also bounded away from zero.

## Association with the actual failed representation

Source descriptors identify the lifted pair [38,39] in this capture. Their actual
embedded carrier definitions and immutable source-root identity must agree with
the certificate. Dense IDs and endpoint proximity only locate candidates; they
do not grant authority. A foreign coherent registry and mixed embedded sources
are explicit rejection controls.

The executed association selects chart 75 and its last raw span [12,13]. The
proposed replacement preserves the old parameter-12 join and reaches the source
event at existing corner 13:

| Quantity | Executed bound/value |
| --- | ---: |
| Canonical source interval a | [-0.04456486659936143, 0] |
| Existing join to ideal endpoint, upper distance | 2.9912748111471406e-9 mm |
| Existing corner to ideal source event, upper distance | 2.045130861584275e-13 mm |
| Unchanged association allowance | 3.796655370190979e-7 mm |
| Absolute height derivative, lower bound | 1.8685170918213265 |
| Absolute source-coordinate Jacobian, lower bound | 0.55384021996393 |
| Old numerical endpoint's source level a | -2.6321011903363e-6 |
| Old numerical endpoint to source event | about 1.65518607e-5 mm |

All eight source margins are strictly positive over this interval. The old endpoint
is associated with an interior point of the ideal continuation, but is farther
from the junction than the existing allowance. Relabelling it as the junction
would therefore fail the unchanged endpoint contract.

The existing corner has native/alias ends 20/39, native/chamfer representations
46/66 and cylinder/chamfer end 49. It does not contain the lifted end. Removing
representation aliases leaves three physical rays, contradicting complete incident
coverage of the proved local source.

The proof authorizes a **canonical replacement proposal**, not a claim that the
old Newton map is continuous or agrees with that curve at every parameter. Exact
stored joins, fallible own-query behavior, indexing bounds, tangents, source
ownership, incidence and rollback still need runtime integration. No such change
is included in this round.

## What the fresh query measurements establish

The observational packet changes counters and diagnostic output only. A fresh
component receipt matches the baseline in every pre-existing field after removing
process-local root addresses. It retains the same feature fingerprint, consumer
inventory, typed-face certificates, storage reservation, graph refusal, generated
queries and live digest. It does not reorder validation or refund reservations.

These are **phase increments**, not cumulative values:

| Phase | New cached-query consumes | External charges/reservations | Cumulative charge | Inverse iterations |
| --- | ---: | ---: | ---: | ---: |
| Bind original chart knots | 64 | 0 | 64 | 0 |
| Source admission | 0 | 80 | 144 | 0 |
| Original event transport | 1,097 | 0 | 1,241 | 1,111 |
| Original event rechecks | 0 | 0 | 1,241 | 1,111 |
| Typed-face checks | 6,557 | 0 | 7,798 | 14,790 |
| Required pins | 0 | 5 | 7,803 | 7,395 |
| Reserve generated queries | 0 | 2,048 | 9,851 | 0 |
| Generated-event validation before refusal | 6,527 | 6 | 16,384 | 13,615 |

Every recorded phase satisfies `charged = consumeAttempts + externalReserved`.
Final accounting is 14,245 actual cache-miss consumes plus 2,139 external charges:
80 conservative admission slots, 2,048 generated slots and 11 direct queries.
All consumes succeeded; failed attempts would still be charged by the same code.
The 16,384 cap refuses the next uncached own query before it is performed.

There are 112,263 query lookups, 98,017 cache hits and 38,022 inverse iterations.
Of 2,086 inverse calls, 1,175 require zero new queries. The largest request uses
20 new queries, well below the unchanged limit of 64. Thus this run is constrained
by the total cap, not the per-request cap. These counters measure curve-query
calls, not all field evaluations or equivalent CPU work.

The generated scope records 838 actual successful queries and ends cleanly. Its
2,048-slot reservation remains charged, including 1,210 unused slots. Post-meshing
validation completes only the first 744 events; the remaining 94, including the
event at which validation refuses, are explicitly unvalidated.

The earlier graph failure remains `path_nodes_lt_two` at cell `[8,51,116,172]`,
for chart 75 near corner 13. It precedes all generated-event validation. The final
returned reason is still `retained_point_own_query` / `TotalCap`; the new diagnostic
records both chronology and the incomplete prefix. Nine fallback triangles remain
discarded. The live digest stays `aa6ab69dfb79125d`.

### What to improve next without changing limits

First install the bounded lower source connection as a transaction, preserving
all existing ends and adding the required lifted interval and source memberships.
All relevant consumers need the same narrow source authority. Keep the existing
discovery ownership band; a global loosening is not justified. Require exact joins,
source revalidation, complete incident metadata and an injected late-failure
rollback control before another complete-component attempt.

For query costs, test a safeguarded height-interpolated inverse proposal inside
the already selected window before the existing bisection. Accept it only through
the unchanged actual own-query, source, container and three-dimensional distance
checks. Keep bisection as the bounded fallback. This targets new correspondences,
which dominate charged work. Recheck sequence ordering and every corruption/cap
control, since a different accepted numerical parameter is a new outcome.

A correspondence cache may separately save repeated CPU work: original rechecks
and required-pin mapping repeat 8,506 inverse iterations while adding no new
cached-query consumes. It should not be presented as the demonstrated solution
to total-cap exhaustion. A reservation refund remains unimplemented and unproved
as sufficient; any future reconciliation must retain every performed failed or
successful query and release unused capacity exactly once after callbacks stop.

Do not call a discarded candidate valid by returning the graph refusal earlier.
If diagnostic precedence changes, retain the first failure and explicitly state
which later validations were not run. Viable candidates still require all checks.

## Validation and reproducibility

The archived Rust 1.99.0 installation was absent before the first new build. Root
pinned the available Rust 1.99.1 (`58cf8f9c35b355199727627d07ae34a4e2846d67`,
LLVM 23.1.3), used a new cache and reran the accepted baseline. All ten previously
audited standard-library/hashbrown source files have unchanged hashes. The fresh
baseline component receipt is identical to the previous one apart from
process-local addresses. This is observed agreement, not universal compiler parity.

| Packet | Focused checks | Component execution |
| --- | ---: | --- |
| Accepted A-cell on Rust 1.99.1 | 26 pass | Same refusals; 32.546 s |
| A source proof | 12 pass, including 2 new source controls | None; no runtime caller |
| B independent fan/frontier diagnostic | 2 pass | None |
| B-associated source/actual-join proof | 31 pass, including all 26 baseline controls | None; no runtime handoff installed |
| C observational query audit | 29 pass, including all 26 baseline controls | Same refusals; 35.876 s |

Counts overlap across packets. Root ran all builds and geometry serially, with
locked/offline Cargo, no LTO, 16 codegen units and fresh kernel caches. Discovery
was nonempty. Build, focused-campaign and component budgets remain 120, 60 and
120 seconds respectively. The component budget includes preparation. The two
component timings are diagnostic executions, not a paired export benchmark.
B-associated and C also pass serde-only non-test library checks.

All four candidate patches restore the exact executed source hashes from the
previous selected A-cell source; all saved binary hashes match. These new patches
are **incremental against A-cell**, unlike the earlier flat Stage 1 packets.
Apply a single candidate to that documented parent. B-associated already includes
A; do not stack it with A. Combining source and audit candidates would create a
new candidate requiring validation.

| Artifact | Purpose |
| --- | --- |
| [A handoff](A-packet/handoff.md) / [patch](A-packet/candidate.patch) | Source theorem, identity controls and proof limits |
| [B handoff](B-associated-packet/handoff.md) / [patch](B-associated-packet/candidate.patch) | Independent fan and actual-join association |
| [Source receipt](B-associated-1991/lower-A.json) | Strict interval/source margins |
| [Association receipt](B-associated-1991/lower-B-association.json) | Checked old join, source event and canonical interval |
| [C handoff](C-packet/handoff.md) / [patch](C-packet/candidate.patch) | Observational ledger and lifecycle controls |
| [Fresh instrumented component](C-1991/component-attempt.json) | Original failure, query costs and unvalidated suffix |
| [Query summary](query-audit-summary.json) | Phase deltas and baseline invariance checks |
| [Toolchain audit](toolchain-check.json) / [baseline comparison](compiler-baseline-comparison.json) | Compiler change and observed preservation |
| [Restoration checks](preservation.json) / [runner](run.py) | Input hashes, binaries, commands and watchdogs |
| [Complete receipt index](receipt-index.json) | Hashes and local paths, including repeated baseline-control outputs |

Full local execution data and binaries remain under
`.testresults/sfcc-critical-repairs/e4-invalid-construction/round28-lower-connection/`.
The fresh uninstrumented component receipt remains there under `Baseline-1991`;
its hash and exact comparison are archived above. Repeated baseline-control
receipts remain local and are hash-indexed rather than duplicated here. Earlier handoffs explicitly
distinguish what agents had not executed; the root execution table is authoritative.

Production remains at `421f5a9`. Runtime lower attachment, complete component
construction, final f64/f32 geometry, interfaces/outside contacts, two-dimensional
patch ownership, transformed-source coverage and native/WASM/GPU/full-model
acceptance remain open. No visual QA was run.
