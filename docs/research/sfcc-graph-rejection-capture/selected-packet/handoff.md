# Stage1 B, corrected after fourth review

Frozen source `/tmp/sfcc-graph-stage1-b-reviewed`. Original frozen B remains untouched at `/tmp/sfcc-graph-stage1-b`. The full patch is relative to restored Round18; `review-corrections.patch` isolates this review's changes. [Original scope/return-site inventory](initial-b-handoff.md) still applies except for the corrections below.

All added caller hooks, graph observer declarations/uses, the observer module, and appended stratum/FieldRef source accessors are now compiled only under `all(feature="serde",any(test,feature="sfcc-profile"))`. Serde-only production has none of these hooks/types/accessors. Test-only hooks remain inside the existing test module and require serde.

Rejection operands are `FnOnce()->Value` closures. `Capture::finish` checks `active` before invoking them, including empty-loop rejection. The occupied-edge branch snapshots only its already-computed boolean to end the mutable map-entry borrow before passing the complete map to the observer. No additional geometry/query call or predicate change occurs.

The input loop bound first checks at most64 loops and then uses checked addition of entry counts. New-cell notification clears both context and prior graph capture before recording the cell. A later cell that never attempts a graph therefore cannot retain an earlier failure. Graph context still clears its previous record, while `Capture::begin` writes a fresh pre-call snapshot for each attempt.

Added/strengthened controls:

- exact512KiB serialized success and512KiB+1 refusal;
- actual point/key serialization preserving a high-bit64-bit numeric key, negative zero, a NaN payload and an adjacent-to-one binary64 value through JSON round-trip;
- inactive finish never invokes its operand closure;
- actual degree-one graph guard run inactive and active, same rejection/no triangles/no point-count change, active receipt names point0 and neighbor1;
- a real successful graph attempt followed by a disconnected-path failure in the same diagnostic scope, with fresh success/failure state;
- failure followed by a new cell with no graph attempt clears both records;
- retained read-only query-index and abandoned-scope controls, plus actual empty-loop/path-node guards.

Root execution: pinned Rust1.99.0 paths, existing no-LTO/codegen16 diagnostic profile. Build once within120seconds, then run filters `graph_b_` (six tests), `modeled_feature_paths_connect_two_boundary_loops_without_caps` (one test), and `correlated_` (six retained controls), serially within the60-second focused campaign. Six existing receipt envs remain required. No new environment variable. If selected, the original private diagnostic uses its unchanged filter/env and120-second preparation-inclusive limit. New result is `admissionAndQueryEvidence.graphCaptureB`.

Author ran only static inspection, pinned rustfmt parsing and source/hash checks. Removing observation-only statements and restoring rejection macros to `return false` reproduces the baseline graph function's non-whitespace tokens exactly. The prefix of `strata.rs`/`field_branches.rs` remains unchanged. No build, test execution, source preparation, geometry query, export or render occurred.

Complete standalone replay is not claimed. The capture may explicitly refuse its structural/serialized bounds; a nested helper None/Err still requires its own focused discriminator if it is the actual first failure. Diagnostic storage is separate from the unchanged64MiB private reservation/16KiB native ledger.
