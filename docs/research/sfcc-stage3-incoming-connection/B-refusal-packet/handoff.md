# B refusal counterexample: test-only injected construction failure

Frozen source `/tmp/sfcc-stage3-r3-b-refusal`, derived from untouched B-final.
No runtime repair or acceptance assertion is changed. A test-only hook forces
exactly one actual admitted-certificate remake to return None. It records the
raw source pair, full discarded run interval, endpoints and connection proof.
The real caller then follows its existing plain-continue failure path.

The control compiles the original source three times in one binary: resolver
disabled parent B, ordinary successful B-final, and B-final with the injection.
It records complete affected-family snapshots and curve/corner/unresolved counts.
The required assertion is a necessary preservation condition: the original
source family must retain at least its pre-resolution number of runs. If an
entire run disappears, the assertion fails; passing that count alone would not
establish full geometric preservation. The assertion is expected to fail here.
A separate scope-unwind test ensures the injection cannot leak into another run.

This is a deliberately forced failure-path control, not evidence that this
failure occurred naturally in the original witness. Its relevance is that the
runtime has legitimate new remake-refusal branches but currently handles them
by silently deleting the run instead of preserving old state or refusing the
whole construction.

Root execution: pinned toolchain/profile as before, fresh kernel cache cleanup,
positive discovery, 120s build and 60s focused budget. Run
`connection_b_refusal_injection_` (2 tests). Set SFCC_CONNECTION_B_RECEIPT to any
path in the evidence directory; the actual report is written beside it as
`connection-B-refusal.json`. Expected result: preservation FAIL, scope cleanup PASS.
No agent build or geometry execution was performed.
