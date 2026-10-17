# Candidate A: immutable discovery preparation

This candidate changes repeated work, not numerical exclusion or local acceptance. It borrows the original CSG tree in a private per-export `DiscoveryContext`, records one entry for each hard sphere/box occurrence and each opaque scope, and prepares the query-independent interval coefficients once. The ordinary culling APIs still validate their actual leaf and query on every direct call. No global state, advisory leaf-ID key, approximate equivalence or sharing of distinct ownership occurs.

## Identity and lifetime

The context owns a flat DFS sequence and borrows its root for its entire lifetime. Rust's shared borrow prohibits mutating any public `Leaf` field while the context exists. The root field and sequence are private; the accessor is read-only. A new scene, changed parameter, independent worker, direct discovery call or serial recovery constructs a new context. Multiple contexts can coexist without mutation or shared cache state. Serial recovery within one context sees the same immutable tree. No cancellation state is retained in a global cache.

The sequence contains every original signed hard occurrence, including duplicate IDs and duplicate geometry, and one entry per opaque subtree, in original traversal order. Query recursion still walks the actual original min/max tree. It consumes exactly one preparation entry at each original terminal visit. All original ancestor truncation and sign-fold operations remain in place. There is no merging of ownership or changes to scalar evaluation, feature compilation or carrier identity.

## Preparation cannot move a rejection

Preparation computes pure booleans and optional coefficient values, without returning an error to the caller. Eligibility errors are read only when the original DFS reaches that occurrence. Empty combiners, malformed opaque subtrees, invalid query boxes and leaf interval errors still return at their former query branches. An early return does not leave cursor state behind: each query owns a fresh slice iterator. The eager preparation of a later invalid occurrence therefore cannot displace an earlier first decision. Profile counters 31–33 deliberately observe preparation/reuse separately; existing counters 0–30 retain their meanings and counts.

An opaque ancestor remains opaque. Descendant discovery eligibility is not imposed on it; only its former `valid_parameters` result is retained. Its legacy interval and scalar behavior are unchanged.

## Arithmetic equivalence

The represented field and outward-operation contract are exactly those of Step 2. This change is common-subexpression reuse over constants, not an algebraic rewrite. Every multiplication, sum, outward rounding, square root, clamp and signed endpoint reversal retains its operands and order within the expression computing that value.

For affine enclosures the cached values are the three `Interval::point(pos[a]).mul(s)` results and the scaled primitive dimensions. They depend only on the borrowed leaf. For the radial sphere enclosure the cache retains the actual-matrix Gram-defect factors, rotated-position intervals, translated center intervals, residual norm and scaled radius. The query still independently constructs each world-coordinate interval, near/far norms, scaled radial range and final subtraction. No orthogonality assumption is added.

An absent prepared radial metric has the same causes as an original query-independent failure. A query-dependent metric failure still falls through to the affine enclosure. The affine data are retained independently, so one failed route cannot destroy the other. Query coordinates/half extents are checked on every use, including point and degenerate face/edge queries. Overflow, nonfinite values and subnormal operations remain on the same conservative paths.

Moving a pure computation before an unrelated query computation can execute it on a call that would previously have returned earlier. It cannot turn `None` into success or hide a failed dependency: each route still requires every value needed by its original expression. Tests compare frozen-baseline interval endpoint bits, not just zero-exclusion classifications.

## Integration and cost obligations

The shared production `PipelineContext` and standalone feature-aware octree each own one preparation context. Public `discovery_guard` constructs a fresh context; direct CSG/pruned interval APIs remain validating. Original local-coverage verification, cleanup transport, worker rechecks and diagnostic branches are untouched.

Retained state is O(number of terminal discovery scopes), freed with the context; there is no region-result cache and no growth with cell count. The current entry representation stores both optional affine and radial coefficients even when one is absent. Its measured size/capacity and ordinary-path preparation overhead must be reported before choosing this candidate. Native timings cannot establish WASM speed.

This is a bounded performance proposal, not an expanded coverage theorem. The coarse three-sheet geometry remains incomplete and explicitly unresolved; unsupported scopes and quality withdrawals remain unchanged.
