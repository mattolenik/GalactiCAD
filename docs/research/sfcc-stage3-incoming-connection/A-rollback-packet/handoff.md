# A late-remake rollback control

Frozen source `/tmp/sfcc-stage3-r3-a-rollback`, parent `/tmp/sfcc-stage3-r3-a-final`.
The new module and hook are test-only; the only other change makes the existing
test-only resolver-disable scope callable by its sibling test. Production runtime
semantics are identical to A-final. No author build or geometry run occurred.

The hook is placed only at the actual emission remake call, after the original
admission/preflight has succeeded. A scoped flag forces the first actual admitted
emission to return None, once. It does not alter preflight and does not select a
fixture ID; the test separately asserts the captured original-source target pair
is [31,10]. This is an injected failure, not an observed natural refusal.

One compilation disables the resolver; the other enables it and injects the late
refusal. The test compares exact public geometry: curve kind/source pairs/ranges,
index points, endpoint corner IDs, native/closed/owner metadata, refine values,
chart metadata, three actual checked samples per curve, corner positions/incidence,
and unresolved branch paths. It also requires equal feature fingerprints, curve
counts and unresolved-trim counts, zero installed source charts, and exactly one
injection. A separate unwind test checks scope cleanup. The receipt is written
before assertions. When complete geometry is equal, the injected snapshot is
represented by an explicit reference to the baseline snapshot to avoid duplicate
large evidence; no field is omitted from the in-memory equality check.

Root command filter: `connection_a_rollback_` (2 tests).
Environment: `SFCC_CONNECTION_A_ROLLBACK_RECEIPT` set to a fresh JSON path.
Use pinned compiler, fresh kernel cache and nonzero discovery as before. The
existing120s build/60s focused limits apply. Broader A-final test reruns are not
required for this test-only observation unless the control exposes a defect.

No runtime repair is made in anticipation of a failure. If this control fails,
preserve the actual result and repair the demonstrated rollback path separately.
No complete component, native/WASM/GPU validation or production acceptance follows.
