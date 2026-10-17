# Candidate C: share immutable face-pin parameter lookup

Baseline: accepted Step 3, `f804044d8c960acea3b3f8735678eecffa31952d`.
This candidate changes lookup cost, not the geometric theorem or acceptance rule.

`canonical_parameter` previously scanned every pin in every face map for every
crease endpoint and retained a parameter only when all pins with the exact same
`(point_id, curve_id)` had identical `f64::to_bits()` values. The corner-key checks
then reconciled that value with the compiled curve endpoint. The latter checks,
curve domains, complete membership validation, target maps and all subsequent
proof steps are unchanged.

The index represents that same fold. A key with no occurrence is absent. A key
whose nonempty occurrence set has one distinct 64-bit value stores that value.
A key with two or more distinct values stores the existing conflict error.
Once conflicting, further entries cannot erase the error. This operation is
order-independent. In particular positive and negative zero remain different;
equal NaN payload bits remain equal; different NaN payload bits conflict. No
new finite check or geometric interpretation is applied during aggregation.
That is necessary for exact behavioral equivalence, even though production
coverage applies further finiteness and curve constraints elsewhere.

Building an index does not report conflicts. Only lookup of the queried key
reports the same error as the original scan, at the original call site. Thus
an unrelated corrupt pin cannot reorder the first rejection. Exact `usize`
point and curve identities are both part of the key, and each duplicate pin is
examined. This shares calculation without merging ownership or occurrences.

## Scope and lifetime

`CoverageFaces` exclusively borrows the existing three face maps. Its fields
are private; its callable interface exposes immutable records, exact parameter
lookup, and the existing consumption-counter increment. It offers no mutable
map or pin access. The only cell-meshing mutation is still the original
`consumed_fwd`/`consumed_rev` increment after a valid loop. These counters never
participate in the index. Thus the pins and source identity cannot change while
that context is used. The lazy `OnceCell` is initialized on the first actual
crease parameter request, so spheres, outside-scope scenes, and failed box
checks before a crease request do not build an index.

`mesh_cells_subset` creates one context before processing its subset and drops
it on return or unwind. Every call, partition, group, subsequent recovery and
export creates a fresh context. Master `reverify_transport` first reconstructs
and validates all face records from the worker data, then creates its own
context and verifies all represented cells. No serialized cache is trusted.
There is no global cache, advisory scene ID key, retained cross-call capacity,
shared worker state, or cancellation cleanup protocol. Safe Rust borrowing
prevents concurrent edits to the source maps during verification. An allocation
failure retains the ordinary allocator/process behavior; no new geometric
success or uncertainty fallback is introduced.

The old direct uncached verifier remains a test oracle; all public meshing
entry points create their own context and retain the same validation. Direct
interval and discovery APIs are not modified. Within the module the cached
verifier is only invoked with the maps belonging to that same context.

## Cost model and limits

Let F be face-record count, P total pins including duplicates, U unique
`(point,curve)` keys and K actual crease endpoint queries during the call. The
original scan does O(K(F+P)) work. The candidate lazily does O(F+P) construction
and expected O(K) hash lookups, retaining O(U) entries. Hash collision worst-case
is not advertised as constant time. U is at most P, already bounded by the
current call's existing face data; capacity is recorded separately from U.
No map allocation occurs when K=0. Numeric interval/scalar work, local witness
payloads and worker wire format are unchanged.

Profiling appends counters 31..35: index builds, input pin visits, lookups, peak
unique entries and peak HashMap capacity. Existing 0..30 counters keep their
meanings. The quality benchmark converts the longer fixed counter array to a
Vec only for JSON serialization. Profile execution is diagnostic, not timing
support. Whole-export benefit and ordinary-case variation require matched
release measurements; this cost argument alone is not a speed claim.

The optimization does not repair missing coarse sheets, broaden local coverage,
reduce quality certificate withdrawals, provide complete worker partition
ownership, prove an f32 embedding, or establish global termination/accuracy.

## Connected caller audit

| Entry or stage | Index creation and validity |
| --- | --- |
| `mesh_all_cells` / `mesh_cells_sequential_groups` | Each existing subset call creates a new context; preceding face contouring is complete. Group boundaries intentionally do not retain caches. |
| `mesh_cells_subset` | Six `record` calls share that call's context. `gather_segments` gets only immutable records. The sole former mutable face access is now `consume`; its same counters, indices, branch and increment remain unchanged. |
| Public worker mesh partition | Existing partition meshing reaches `mesh_cells_subset`; the context is worker-local stack state and is never serialized. |
| `reverify_transport` | All reconstructed pins, identities and conflicts are checked before exclusive borrowing. One fresh context serves actual merged witnesses; rebuilding snapshots remains unchanged. |
| Recovery, repeated export, cancellation | A returned or unwound call drops the context; another call cannot access it and builds its own context if needed. Existing cancellation and recovery tests remain required. |
| Direct certificate tests | `verify` calls the identical verifier with no index. Those tests still exercise full direct scans and all ordinary checks. No public unchecked API is added. |
| Discovery, numerical exclusion, primitive evaluation | Unchanged functions and callers, no cache reads, no changed order or outward arithmetic. |
| Cleanup, flips, quality stages, serialization | Unchanged operations and witness data. This candidate creates no new transport capability or proof claim. |

The test-only comparison calls both verifier routes against the complete real
sphere and clipped-box local-cell data, comparing the full result including
error strings. A separate adversary matrix compares exact parameter results
for repeated keys, unrelated conflicts, signed zero, subnormal, infinity and
NaN payloads, proves consumption changes leave lookups intact, and checks that
new contexts see edits made after the old context is dropped. This is finite
regression evidence supporting the elementary fold equivalence above.
