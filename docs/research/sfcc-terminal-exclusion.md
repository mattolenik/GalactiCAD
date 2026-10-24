# Checked terminal exclusion for complex SFCC models

Status: milestone 5 bounded implementation complete. Focused geometry/numerical
gates, the fixed performance campaign and final five-model acceptance campaign
are complete. Overall model acceptance remains failed.
The housing performance exit remains open because shared-host contention makes
its timing comparison inconclusive. This is a bounded real-field exclusion rule, not a proof that SFCC
reconstructs every surface, and not a bitwise GPU/CPU equivalence theorem.

## Diagnosis and chosen scope

The saved final native decisions from milestone 3 contain 57,880 bracket and
14,883 housing cells whose first reason was `same_sign_root_interval`. Their
full original transformed scene trees were replayed through the existing bound
API, without adding a scene evaluator. The profile groups every subtree by its
path and operator. Inputs and hashes are retained under
`.testresults/sfcc-critical-repairs/milestone5/profile/`.

The dominant bracket uncertainty lies beneath nested chamfers. Its cuboid's
coordinate box excludes zero in 51,720 cases where the circumscribed ball does
not. The corresponding housing cylinder counts are 5,070 and 1,710. These
operand counts overlap and are not root-level improvements. An independent
checked root counterfactual resolves 40,450 bracket and 2,167 housing decisions,
all with a strictly negative upper bound. No invalid query was counted as a
resolved cell. These are attribution counts on saved native cells, not a WASM
acceptance result or independent geometric ground truth.

The initial all-depth cull trial changed bracket triangles from 108,530 to
96,344 and housing from 125,954 to 121,162. Both retained zero invalid faces,
original topology, and unchanged compiled feature-chain outcomes, but removing
earlier empty neighbors also changes balancing and surface tessellation.
That trial is **not** the chosen policy: the user's crisp-contour requirements
make unexamined surface coarsening an unacceptable performance shortcut.

The selected policy consults the new rule only while creating leaves at the
lattice maximum depth, after the old bound is finite, ordered and inconclusive.
A failed legacy arithmetic query remains unresolved even if a partial real-field
upper bound could be established independently. This is an eligibility
restriction, not a use of old endpoints to justify the new enclosure. If a build
uses a lower refinement ceiling, this additional rule does not run. Earlier
subdivision decisions retain their prior policy. The intent is to remove
terminal cells without using tighter exclusion to justify coarser neighboring
surface patches. Final meshes still require comparison; this placement alone
is not a mesh-equivalence theorem. In the current builder, parent splitting
always calls balance ripple after the child-creation loop, including when some
children were excluded. A terminal child cannot itself split or initiate another
ripple. This explains why the narrower policy preserves earlier balance in this
implementation; callback and point-cache effects still need output gates.

## Mathematical contract

The input field is the real formula defined by finite represented primitive,
transform and operator coefficients. A primitive evaluates
`sign * s * phi(R^T(p-t)/s-pos)`, with `s>0` and `sign` equal to ±1.
No orthogonality of the represented matrix is assumed. The query box encloses
the complete represented octree cell through the existing `cell_enclosure`
path. Every new exclusion is obtained independently of legacy bounds.

Sphere and cuboid bounds reuse the existing checked affine/radial enclosure.
For a finite cylinder, homogeneity moves the positive scale into its dimensions:
`q = R^T(p-t) - s*pos`, `r'=s*max(r,1e-6)`,
`h'=s*max(h,1e-6)`. The clamp is part of the production primitive semantics.
Outward interval arithmetic encloses every coordinate of `q`. Absolute ranges
give radial bounds on `sqrt(qx²+qz²)` and axial bounds on `|qy|`. Write
`a=radial-r'`, `b=axial-h'`; then

`f = sqrt(max(a,0)²+max(b,0)²) + min(max(a,b),0)`.

Each term is enclosed using outward basic arithmetic, correctly rounded square
root and exact endpoint min/max. The scaled norm avoids avoidable squared
overflow; it does not assume a library `hypot` error bound. Signed leaves reverse
and negate endpoints as necessary. Arithmetic overflow/failure aborts the
checked query rather than being converted into an exclusion.

Unsupported but well-defined real leaves receive `[-infinity,+infinity]`.
They are not assigned a guessed Lipschitz constant. Malformed parameters abort
the query, including nonfinite inputs, nonpositive dimensions/scale, degenerate
opaque polygon edges, invalid lathe edges, and unsupported periodic blend
counts below one. This is intentionally stricter than some production fallback
formulas. The contract concerns real field values; it does not assert that
arbitrary extreme inputs execute without IEEE overflow in the evaluator.

Hard min/max are coordinatewise monotone, so endpoint min/max preserve the
enclosure, including one-sided infinite ranges. The supported blends are Round
and Chamfer. Their two-argument forms are symmetric and coordinatewise monotone:

- Chamfer is the minimum of `a`, `b`, and
  `(a-r+b)*FRAC_1_SQRT_2`, using the represented positive constant.
- Round is `max(r,min(a,b)) - norm(max(r-a,0),max(r-b,0))`.
  Below the radius the subtracted norm decreases as either argument increases;
  above it the surviving minimum is monotone, with matching boundary values.

For more than two children, the production evaluator blends the two smallest
values, not a left fold. Each order statistic is monotone in every child value.
Taking the two smallest lower endpoints and the two smallest upper endpoints
therefore encloses the selected pair even when its identity switches inside
the box. Evaluate those endpoint pairs with outward arithmetic. A lower
endpoint of negative infinity gives negative infinity; an infinite second
upper endpoint leaves the finite first endpoint unchanged. This avoids
indeterminate `infinity-infinity` arithmetic. Smooth maximum is the sign dual:
negate/reverse child ranges, apply the same construction, then negate/reverse
the result. Other blend modes remain unbounded after their descendants and
parameters are checked.

Consequently, by structural induction, the checked root range contains every
real field value on the query box. Strict `lo>0` or `hi<0` excludes a zero;
either strict bound suffices even if the other endpoint is infinite. A range
containing zero remains unresolved. A known solid under a smooth union
can establish a negative upper bound despite an unknown twisted or lofted
operand. It cannot establish that no unknown external component exists.
A thin shell, grazing contact, or same-sign hidden component remains unresolved
whenever its zero lies in the query. No histogram, corner-sign agreement, or
sampled residual is a proof premise.

## Validation and remaining limitations

The focused original/rotated/reverse-worker gates pass (eight actual-WASM
tests). Every captured vertex, triangle and feature-membership buffer matches
its milestone 3 control byte for byte. Both reverse-worker runs report
`serialRecovery=true`; these receipts do not certify unrecovered parallel
reconstruction. The final arithmetic-failure eligibility guard only narrows
the new rule; the timing campaign rechecks 14 exports of the final candidate binary and
14 baseline exports. All 28 samples match the four original milestone 4
meshes byte for byte.

| Original model | Baseline unresolved cells | Candidate unresolved cells | Triangles | Geometry and memberships |
| --- | ---: | ---: | ---: | --- |
| Bracket | 59,713 | 19,263 | 108,530 | All three buffers unchanged |
| Housing | 17,352 | 15,185 | 125,954 | All three buffers unchanged |
| Knob | 48,615 | 45,019 | 185,928 | All three buffers unchanged |
| Mess 2 | 30,083 | 30,083 | 283,524 | All three buffers unchanged |

The final native suite passes 245 tests; actual-WASM numerical tests pass 12;
the acceptance harness passes 23; `make build` passes. One older mixed-control
test froze the now-redundant leaf count. Its replacement preserves exact
pre-change output hashes, topology and status while requiring nonincreasing
leaf/unresolved counts. The hashes were captured using the preserved milestone
4 binary, not the candidate. Legacy interval-query implementations and their
existing arithmetic tests remain unchanged.

Unit tests cover represented nonorthogonal transforms,
the cylinder dimension clamp, thin double sheets, exact dyadic grazing contact,
a hidden component, nearest-pair changes, opaque descendants and Smax duality,
malformed descendants, overflow and subnormal rounding. Tests that sample the
existing native evaluator are internal formula consistency checks only.

The new rule does not repair existing bracket feature-chain failures, housing
GPU main-bore and crease failures, malformed knob/Mess 2 faces, or Mess 1's
resource timeout. Unsupported fields and unresolved cells remain explicit.

## Final five-model acceptance campaign

The [final report](../../.testresults/sdf-meshing/2026-10-24T08-17-05-970Z/report.md)
completed with harness exit 0. That means report generation completed, not that
the meshes passed. Bracket, housing, knob and Mess 2 remain FAIL; Mess 1 retains
its 180-second TIMEOUT. Each case has four view records. Bracket and housing
retain zero exact invalid output triangles; knob retains 4,582 and Mess 2
retains 17,953. The unresolved counts and triangle counts in the table above
match the final campaign.

All four available meshes' vertex, index and feature buffers are byte-identical
to milestone 4. Complete bracket/housing GPU regional records, excluding timing,
are also exactly equal to milestone 4, and all four corruption-check outcomes
are unchanged and detected. This preserves the measured defects: housing's
0.0132767 mm main-bore miss exceeds the 0.01 mm surface budget, its loft/chamfer
incident-normal check remains failed, and flange crease references remain
ambiguous. No sampled regional result is promoted to a global coverage proof.

The final report retains
[mesh comparisons](../../.testresults/sdf-meshing/2026-10-24T08-17-05-970Z/baseline-comparison.json)
and [GPU comparisons](../../.testresults/sdf-meshing/2026-10-24T08-17-05-970Z/gpu-baseline-comparison.json).
Runtime/source hashes did not change during the final campaign. Its single
browser timing sample is not used to claim a performance improvement.

## Recorded performance, including the inconclusive result

The fixed campaign ran in one Node process with one persistent release-WASM
instance per variant. Each primary model/configuration received one warm-up,
then five baseline/candidate pairs, reversing pair order on alternating pairs.
Only the synchronous `export_sfcc` call was timed; output copies, hashing,
rendering and audits were excluded. Hardware: Apple M1 Max. These are kernel
export measurements, not browser end-to-end times.

| Model | Measured pairs | Baseline median (range), seconds | Candidate median (range), seconds | Interpretation |
| --- | ---: | --- | --- | --- |
| Bracket | 5 | 25.830 (24.934–27.872) | 22.168 (21.241–24.492) | 14.18% lower median; candidate faster in all five pairs |
| Housing | 5 | 37.215 (37.023–106.416) | 46.684 (38.181–56.717) | Raw median is **25.44% worse**; causal performance comparison inconclusive |
| Knob | 1 | 111.883 | 99.318 | Limited collateral observation, no speed conclusion |
| Mess 2 | 1 | 32.818 | 30.955 | Limited collateral observation, no speed conclusion |

The collateral pairs had no case-specific warm-up; both instances were already
warm from the primary cases. They do not establish performance improvements.
All samples, including slow samples, are retained in
[the raw timing record](../../.testresults/sfcc-critical-repairs/milestone5/timings/alternating.json)
and [computed summary](../../.testresults/sfcc-critical-repairs/milestone5/timings/summary.json).

Bracket phase medians support the expected mechanism: octree apply rises from
1.146 to 1.429 seconds, while decisions fall from 13.392 to 10.969 seconds and
contours from 7.823 to 6.449 seconds. These separately computed medians are not
an exact additive decomposition of the total median.

Housing became severely variable during the run. Even its unchanged feature
compilation varied from 7.484 to 22.198 seconds in baseline and 7.584 to 14.471
seconds in candidate. A host snapshot recorded load averages 70.2/35.3/23.2
and about 437 MB free memory on a 64 GB host. The snapshot does not identify a
cause. Read-only process observations showed other active workloads; no unrelated
processes were changed. The benchmark process used about 517 MB RSS in one
snapshot. No concurrent build or export job was launched by this agent.

Conditions were not changed during the fixed campaign. Afterward, the agent
server was stopped but an orphaned gcad headless Chromium remained; its parent,
workspace and Puppeteer profile were verified before terminating only that
process. No old SFCC build/export jobs were identified. The host still showed
load averages above 20 and low free memory, so no further noisy timing repeats
were used to select a favorable result. The orphan cleanup does not retroactively
establish why timing varied.

The measured bracket benefit and reduced unresolved work support this bounded
optimization. **A housing speed improvement is not demonstrated**, and neither
collateral case has enough measurements for a speed claim. Milestone 5's broad
performance exit is therefore only partially met. A quiet-host repeat can resolve
that uncertainty without changing the exclusion rule or mesh-quality policy.

## Reproduction and provenance

- Baseline commit: `744222d111c5e1837a59f0a1436b72b4fcb3e41f`.
- Baseline WASM SHA-256: `6ee9190916936bc02951e4a151ba9eb6425a8f8f0d2eb3d7e248a03ac38aa7d2`.
- Candidate WASM SHA-256: `5641ec2c53537dde0786744037da5c1e1fe97a7922324502eb1246ea215dbd05`.
- Source snapshots, source hashes, command logs and timing scripts are under
  `.testresults/sfcc-critical-repairs/milestone5/provenance/`; baseline and
  candidate binaries are retained alongside them.
- The checked-in `sfcc_exclusion_profile` example consumes an acceptance
  `effective-config.json` and a native diagnostic `native-cells.json`. It calls
  existing bound APIs and reports subtree-path counts plus the checked root
  counterfactual. It is not an independent geometry reference.
- `final-gate-buffer-comparison.json` compares all eight focused receipts with
  their milestone 3 controls. `timings/summary.json` verifies every final-binary
  timing sample against the milestone 4 original buffers.

The first final acceptance campaign encountered `ENOSPC` while writing the
housing mesh. Its [incomplete report](../../.testresults/sdf-meshing/2026-10-24T08-11-20-819Z/report.md)
is retained as infrastructure-failure evidence, not a completed acceptance gate.
Only the `deps`, `build`, `incremental` and `.fingerprint` compiler-cache
subdirectories inside six completed, task-owned `/tmp/sfcc-*` Cargo targets
were removed. Binaries, examples, source, reports and baseline/candidate artifacts
were preserved. About 1.3 GB was available afterward; the approximately 141 MB
full-report campaign was restarted with the same frozen runtime. No mesher or
acceptance threshold changed in response to the disk failure. The [retry report](../../.testresults/sdf-meshing/2026-10-24T08-17-05-970Z/report.md)
completed successfully as a harness run with the same candidate binary. After
the retry, its newly orphaned headless Chromium was identified by start time,
parent, workspace and temporary Puppeteer profile and terminated. The older
persistent remote-viewer browser and unrelated processes were left untouched.

Artifacts under `.testresults/` are ignored by Git and must be retained as a
complete directory. Required numerical controls and their baseline hashes are
checked in under `gcad-wasm/fixtures/`; regressions do not require ignored binaries.
