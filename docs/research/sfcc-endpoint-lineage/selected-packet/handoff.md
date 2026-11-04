# B lineage capture: fourth-review corrections

Frozen source: `/tmp/sfcc-graph-lineage-b-reviewed`. Original B remains frozen at
`/tmp/sfcc-graph-lineage-b`. [Original handoff](initial-b-handoff.md) describes the
capture; this packet makes only the requested source-identity, bounds and stop
reason corrections. No build/test/geometry execution has occurred by the author.

Raw-curve and captured transition-source records now include
`storedTracedCarriers`: the actual stored `TracedData.sa/sb` IDs, bounded occurrence
and domain/branch descriptors, and all three refinement values as exact bit strings.
This is the same data returned by `traced_carriers()`, accessed immutably to avoid
cloning source state. Canonical `adjacent_strata` tags remain recorded separately;
they are not presumed to equal the stored carrier IDs. Non-traced curves record
null stored-traced data. A failed source descriptor makes the capture incomplete.

All integers above JavaScript's exact integer range in these descriptors are
recursively encoded as `u64:` hexadecimal strings, including branch/partner paths
and the leaf-index sentinel. Floating values remain exact bit strings. Shared-root
address labels are explicitly process-local. A separate `source_record()` helper
adds this data only to captured raw/transition records: the off/on equality
snapshots still compare their prior address-independent values, not allocation
addresses from separate compilations.

Before final JSON collection, the observer checks at most512 corners/remap entries,
4096 input curves,64 selected curves,8192 total selected indexing words,128 entries
per corner's stratum/incidence list, and4096 aggregate corner entries. Checked sums
refuse overflow. This precedes the selected-curve vector and final serialization.
The existing512KiB compact-receipt cap is unchanged.

Bisection now records the number of actual midpoint classifications and which
existing stop branch executed: `parameter_distance_below_corner_merge_quarter` or
`iteration_cap`. Counters are observation-only; the original `param_distance`
expression is evaluated exactly once per loop as before.

Four authored control tests (filter `endpoint_lineage_b_controls`) cover the
original lazy logging/caps/cleanup, actual stored-carrier IDs versus deliberately
changed canonical tags and nested sentinel precision, descriptor-cap refusal,
pre-collection final bounds, and both actual bisection stop branches. The one
original-source capture test/filter remains
`endpoint_lineage_b_original_feature_compile_is_observational`, with fresh
`SFCC_ENDPOINT_LINEAGE_B_RECEIPT`. It still writes its receipt before assertions.

Root should build once within120seconds with pinned Rust1.99.0 and the existing
no-LTO/codegen16 `--offline --locked --release --features serde,sfcc-profile --lib`
configuration. Run the four controls first, then the single capture within the
existing60-second focused campaign. The capture contains two feature compilations
(one unobserved equivalence baseline, one observed), never an octree or mesh export.

Static observation stripping restores the immutable base's trim token stream;
the geometry-query call sequence remains unchanged. Original feature-curve source
is an exact prefix before appended test-only accessors. Pinned rustfmt parsing
passed. `candidate.patch` is relative to the executed Stage1 base;
`review-corrections.patch` is relative to frozen original B.

Execution, actual lineage completeness and causal interpretation remain pending.
Caps can still produce an explicit incomplete record; no window/cap enlargement
or geometry repair is authorized by this handoff.
