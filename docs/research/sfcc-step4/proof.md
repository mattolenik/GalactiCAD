# Step 4 preservation argument

Baseline: accepted Step 3, `f804044d8c960acea3b3f8735678eecffa31952d`.
Selected implementation: competitor B, without combining A's preparation context
or C's face-pin index. This argument concerns behavioral preservation, not an
extension of the numerical-exclusion or local-coverage theorem.

## Exact arithmetic identity

For the supported hard discovery branch, write a primitive's arithmetic input as
`K = (shape tag, dimensions, sign, pos[3], s, t[3], R[9])`. Equality compares the
**bits** of every floating field, including signed zero. Sphere dimensions have
one entry and box dimensions three. Distinct shape variants never match. No
normalization, tolerance, ID, transform re-orthogonalization or algebraic rewrite
is involved. NaNs can compare bit-equal, but no invalid result populates a memo.

The connected implementations of `valid_discovery_primitive`,
`discovery_interval_over_box`, `interval_over_box`, `valid_parameters` and the
checked primitive enclosure read only these fields and the query center/half
extents. `index`, `strata` and ancestor path do not affect their arithmetic or
eligibility. For a fixed represented query, equal keys therefore execute the same
validation and outward arithmetic with the same operands, branch decisions,
operation order, fallback and endpoint bits. This includes represented rotation
matrices; no exact-orthogonality assumption is introduced.

The implementation does not replace intervals with wider conservative bounds:
sharing returns the exact original result. Direct interval APIs and numerical
exclusion code remain unchanged.

## Fixed-region postorder traversal

`zero_owners_over_box` validates its actual center and half extents before
allocating a fresh `Option<(&Leaf, (f64, f64))>`. Every recursive call receives the
same copied center/half values and the same memo. The root and remembered leaf
are immutably borrowed; their fields cannot change during traversal in safe
Rust. No region key is needed because the memo cannot outlive this single query.

Induct on the original postorder traversal. On a miss, the old validation and
interval code executes at the old branch. Only success stores a result. On a
hit, key equality and fixed query prove that the skipped operations would have
succeeded with identical endpoints. In either case the current **original leaf
reference** is appended, the original scratch maximum is observed, and its
original min/max ancestors fold and truncate the entries in the old order.
Thus the interval, retained occurrence sequence, first error and every ancestor
path remain unchanged. A successful value may survive truncation or an opaque
sibling because neither changes the primitive calculation or fixed region.

Opaque branches still validate their original subtree, append `Opaque`, and
return their original full interval. Their descendants never enter the memo;
no checked result is substituted into legacy opaque arithmetic. An empty or
invalid later subtree still rejects at its old position. Min/max cannot mask
invalid arithmetic by encountering a cache hit elsewhere.

## Completed primitive visibility

After owner discovery, `check_discovery` starts a second fresh
`Option<(&Leaf, u8)>`. All owners use the same immutable probe, fixed corner
positions, and deterministic enclosing edge/face boxes. A record is stored only
after the old corner, corner-sign-change, same-sign-edge and same-sign-face
checks **all succeed**. Any uncertainty, arithmetic error or split decision
returns before storing the failing primitive.

A hit proves that all skipped checks would succeed with the same eight sign
bits. It still appends `(current_original_leaf, bits)`. Opaque markers still set
the original flag. Consequently the pointer-based original-tree sign fold sees
exactly the old occurrence sequence, including duplicate and opposite-ancestry
owners, and preserves its original first diagnostic reason. An opposite sign
never hits an equal-sign record. Ownership and computation sharing are separate.

There is no diagnostic-producing successful branch being skipped. Profiling
counts for executed interval operations decrease intentionally; logical node,
candidate, pending-entry and sign-fold counts do not.

## Lifetime and integration

Both memos are call-local stack values containing borrowed references and scalar
results. No heap allocation, exported field, worker payload, persistent region
map, global/thread-local state or public unchecked entry point is added. Public
leaf mutation after a call, a changed query, another export, nested recovery,
cancellation and independent worker execution each start with empty records.
There is no suspension point within either synchronous check. The existing
resumable/worker drivers reach the same checked functions.

The rest of the mesher receives identical decisions and original occurrences.
Feature compilation, face geometry, local coverage, witness snapshots, complete
crease-membership checks, planar-flip transport, quality withdrawal and worker
receiver reverification are untouched. Finite cross-version tests compare their
actual outputs; they supplement this local equivalence argument rather than
proving all possible exports.

## Work and space

On a successful traversal that reaches N consecutive exactly equal supported
primitive occurrences, one cell interval serves the run. If visibility checking
also reaches and successfully checks those retained occurrences, one completed
visibility calculation serves that run. Every occurrence the original traversal
would reach is still visited and represented; an error or early return preserves
the original visited prefix. Traversal, candidate storage and sign folding remain
O(N) in a successful N-occurrence run. A comparison examines at most 20 floating
fields and a shape tag. Unique or interleaved primitives usually evict the
single remembered value and pay comparison/branch overhead without reuse.

The cell record contains a borrowed leaf plus two endpoints, the visibility
record a borrowed leaf plus a sign byte; their source storage is bounded and
neither allocates. The phases are consecutive. Recursive owner traversal passes
one extra mutable reference per recursive call, so existing O(depth) stack use
still matters. Exact compiled frame sizes, peak RSS and allocator bytes were
not measured. No wire payload grows. No scene-size cache or retained capacity
is introduced. This is deliberately limited sharing, not a general memo table.

Counters 20/22/23/24/30 now mean executed interval computations. Counters
19/21/27/28 still measure original logical traversal/candidates/scratch/sign
walk. Duplicate tests retain those logical assertions and require reduced
arithmetic counts; no geometric or coverage assertion is weakened.
