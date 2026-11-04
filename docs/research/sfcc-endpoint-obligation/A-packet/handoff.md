# Stage 2 A — source-bound endpoint continuation discriminator

Frozen source: `/tmp/sfcc-graph-stage2-a`, based on executed Stage1 B-reviewed
`/tmp/sfcc-graph-stage1-b-reviewed`. Main runtime unchanged. This is a test-only
source proof/discriminator, not a meshing repair.

[Proof argument](proof.md) derives a small native-crease continuation past the
captured corner height. The surprising static finding is that the endpoint is
strictly before the outer round's activation region. It need not be treated as a
legitimate terminal crease or immediately solved as a lifted transition.

Five changed/added inputs: one test module under `shared_twisted_proof`, one small
captured fixture, its module declaration, and two appended test-only immutable
source-root accessors. All original runtime files remain exact byte prefixes;
no projection, graph, source extraction, interval arithmetic or memory guard is
changed. The test reuses `HelixBranch` and `BranchCertificate` for the supported
primitive/profile/inner-lathe correlation and adds explicit whole-ancestor
inactivity bounds from the actual source.

Root execution:

- Build the existing libtest target with pinned Rust1.99.0,
  `--offline --locked --release --features serde,sfcc-profile --lib`, diagnostic
  no-LTO/codegen16, under120seconds.
- Focused filter: `endpoint_source_a` (one test, one original feature compilation;
  no octree/private reconstruction/full export), under60seconds.
- Set `SFCC_ENDPOINT_A_RECEIPT` to a fresh root-owned path. The receipt is capped
  at64KiB and records exact source paths/coefficients, height/image intervals,
  inner-lathe/groove/cap/sphere margins, determinant bound, numerical-endpoint
  association distance/unchanged allowance, and control outcomes using hex bits.

A passing execution would establish the ideal represented-source crease survives
across and beyond this recorded endpoint within the failed cell. Its scope is
explicit: no floating-evaluator parity/GPU reference, no source continuation
through the later blend activation, no complete local mesher replay and no
localization of the upstream compiler defect. The primary captured graph replay
is a separate competitor's task; this discriminator supplies the geometric
obligation that a regression/repair must respect.

The authored negative controls reject an active-outer-round interval and an
inconsistent fixed branch. Source identity, old fingerprint, actual endpoint bits,
incoming height direction and cell containment are also asserted. Their outcomes
remain unexecuted until root runs them; any failed assertion is evidence, not a
reason to weaken the theorem or silently widen the interval/tolerances.

Author validation: exact rational arithmetic on saved coordinates; source/manual
proof review; pinned rustfmt parsing/formatting of the new module; patch/hash
construction. No builds, tests, feature preparations, field/curve queries,
octrees, captures, exports or renders were executed.
