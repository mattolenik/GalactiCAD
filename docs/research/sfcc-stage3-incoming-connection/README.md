# SFCC stage 3: incoming connection and attachment repair

The final source-chart candidate restores the missing lower-junction attachment
while retaining the required upper continuation in the original knob's complete
feature compilation. Every non-target source family is unchanged against its
same-binary, resolver-disabled parent. This is a bounded historical feature-graph
result, not a complete mesh or production acceptance result.

**Selected for Stage 4: A-rollback**, the reviewed A-final runtime with the added
late-refusal regression. Stage 3's local witness exit is satisfied; whole-component
and production exits remain open. The implementation is retained as an isolated
patch, not enabled in the main mesher.

[Fourth-agent decision](decision.md) ·
[Implementation plan](../../plans/sfcc-graph-correctness-implementation.md) ·
[Previous junction premises](../sfcc-stage3-junction-revision/README.md).

Three agents implemented independent approaches. Root executed their frozen
candidates serially with the pinned toolchain, and a fourth agent reviewed the
connected source, mathematical premises, failure paths and saved evidence.

## The connection that needed repair

The missing native/compound representation is raw curve 235, with source pair
`[31,10]` in this fixture. Its original classification interval is
`[0, 0.24267782426778242]`. The old final numerical cutoff excluded the genuine
junction at the raw start. The previous round established both the junction's
source location and a conditional local equivalence with an alias, but neither
fact established an incoming parameterized connection.

The new connection uses the actual immutable source occurrences and coefficients.
Let R be the cylinder radius and r_i<R the incoming radius associated with the
checked positive endpoint. The canonical source interval uses

`rho(s) = R + (r_i - R) s`, for `0 <= s <= 1`.

The selected groove offset edge determines height as an affine function of radius.
The twisted profile side supplies a fixed intrinsic coordinate v and the branch
`u(s) = sign * sqrt(rho(s)^2 - v^2)`. Rotation by the source twist produces the
spatial curve. Strict source restrictions hold over the whole interval: profile
and groove-edge validity, competitor separation, finite caps and inactive other
ancestors. The cylinder is inactive on the open incoming arc by construction and
active at its junction endpoint.

This replaces an uncertified numerical prefix with a justified source chart. It
does **not** prove that the old Newton map was continuous or monotone. The raw
curve ID and original range remain as explicit reparameterization provenance.
The generated compound's rounded affine coefficients are separately bound and
associated with the ideal source equation; exact equality is not assumed.

## Candidate A: explicit source chart

A stores a source-derived chart on the first remade interval. Successful queries
are checked against interval-enclosed source coordinates, the original carrier
residual threshold and the existing displacement envelope. The independently
associated corner is returned exactly at the start; the stored join matches both
the new chart and the old evaluator at that point. Tangents, indexing bounds,
projection containers, clone comparison, fingerprinting and storage accounting
include the new query semantics.

The continuous ordering claim concerns the **ideal source parameterization**.
Actual returned points have bounded association, and the tested query events are
ordered. This is not a claim of strict order for every rounded output, or of
success for every possible floating-point query. Refused certified queries report
failure and return no substitute geometry through the best-effort API.

Before changing a run, the resolver conservatively refuses a proposed attachment
whose source pair is already represented at that destination by an ordinary
resolved run. This does not certify the old representation. It prevents an
unnecessary repair from colliding with legacy deduplication. A complete remake
preflight precedes mutation, and a later unexpected refusal restores the old
unwired truncation rather than deleting the run.

The admitted source family is deliberately narrow: the existing binary ancestor
class, identity/coaxial frames, the selected profile/lathe conditions, zero groove
axial position, and an original open raw-start interval within one knot span.
Unsupported inputs remain unresolved. Runtime admission contains no fixture IDs
or witness coordinates.

## Competing approaches and defects caught by review

**B: certified chord.** B bounds the entire source connector against a straight
chord using an outward second-derivative bound and endpoint/rounding error. On the
actual interval, its uniform source-to-chord bound is `1.23793e-8` mm, below the
unchanged `4.74582e-8` mm curve tolerance. It also bounds every original interpolation
seed, rather than inferring continuous coverage from samples. Its checked chord
queries have non-strict represented height order and exact endpoint joins.

Both initial runtime candidates passed the old upper/lower gate but admitted an
unnecessary symmetric `[31,7]` connection. Legacy sampled dedup then discarded its
certified query representation in favor of an ordinary trace. The new preservation
gate exposed this loss; a passing target count did not establish retained authority.
Both final revisions conservatively decline that already represented attachment
before mutation. No duplicate edge was restored and no proof was transferred on
the strength of sampled overlap.

B-final subsequently passed all 13 focused tests, but connected-code review found
a remaining failure path: `remake_curve` can return `None`, and the emission caller
continues without retaining the original run. This is a preservation defect even
when the ordinary witness does not trigger it. Its isolated failure-injection
experiment records the behavior separately; it is not labelled a naturally
observed failure on the original model.
That forced refusal changes 76 curves to 75 and removes one of the target source
family's two runs, while the unresolved count remains 83. The preservation
assertion fails. The matching A late-refusal control passes: it restores all 76
original curves, their exact compared geometry and fingerprint, and publishes no
certified chart or false attachment. Both scope-cleanup controls pass.

**C: height-pinned projection.** C holds a monotone represented height fixed while
solving the two carrier equations in XZ. Its 33 actual incoming-interval queries
and refusal controls pass. It remains a test-only alternative without source
admission or attachment. Its controls also demonstrate that pointwise residual
and displacement checks do not imply ordering, and that the old interpolation
expression can reverse by one ulp. Neither counterexample is misrepresented as an
observed reversal of the original knob's Newton queries.

## Measured original-source outcome

| Observation | Resolver-disabled adaptive parent | Final A |
| --- | ---: | ---: |
| Required upper interval represented | Yes | Yes |
| Lower required source-pair memberships retained | No | **Yes, all five** |
| Curves | 76 | 76 |
| Corners | 40 | 40 |
| Unresolved trims | 83 | 83 |
| Unwired ends | 77 | 76 |
| Source families changed by connection resolver | — | Only `[10,31]` |

The selected lower corner remains at the exact old coordinates. Its required
memberships are `[10,15]`, `[10,31]`, `[15,30]`, `[15,31]` and `[30,31]`.
The final chart is curve 45 in this compilation; dense IDs are observations, not
the proof's identity mechanism. The symmetric `[7,31]` family and every other
non-target family's compared geometry, ranges and corner positions remain
bit-identical. The remaining unresolved counts are retained, not reclassified as
success.

This comparison is against the adaptive-probe parent used by these experiments.
It does not erase the broader differences from the older 81-curve/77-corner
baseline, nor establish that those collateral changes are acceptable in production.

## Validation and reproducible evidence

| Frozen packet | Build | Focused execution | Result | Review disposition |
| --- | ---: | ---: | --- | --- |
| A-rollback | 13.687 s | 3.458 s | **12 tests pass**, including original-source gate and late-refusal preservation | Select for bounded Stage 3 witness |
| B-final | 13.720 s | 6.039 s | 13 existing focused tests pass | Reject: caller-side refusal can delete a run |
| B-refusal | 13.789 s | 2.418 s | Required injected-refusal preservation fails; cleanup passes | Executed counterexample to B acceptance |
| C | 13.729 s | 1.385 s | Eight controls pass; unchanged lower-attachment gate fails | Retain query-order premise only |

Counts include reused controls and are not independent reconstruction-success
counts. These are feature-only diagnostic times, not export-performance results.
Every build used pinned Rust 1.99.0, offline/locked, no-LTO/codegen16, with a fresh
task-owned kernel cache and nonzero test discovery. The unchanged limits were
120 seconds for each build and 60 seconds for each focused campaign. No job timed
out. Root verified post-execution source hashes and independently restored every
executed source from its flat patch against the common captured baseline.

The final A test-only revision leaves its normal connection and original-source
receipts exactly equal to A-final. The reviewer independently checks the source
and binary hashes; proof scope and rejection reasons are in the decision.

| Artifact | Purpose |
| --- | --- |
| [Consensus decision](decision.md) | Selection, rejected alternatives, proof limits and Stage 4 invalidation boundary |
| [Summary](summary.json) | Separate local witness, component and production verdicts |
| [Selected patch](A-rollback-packet/candidate.patch) | Flat, reproducible experimental implementation plus regression controls |
| [Selected runtime handoff](A-final-packet/handoff.md) | Source chart, query contract, bounds, identity and conservative admission |
| [Rollback-test handoff](A-rollback-packet/handoff.md) | Injected late refusal and exact preservation comparison |
| [Connection receipt](A-rollback/connection-A.json) | Same-binary baseline, changed family, installed chart, checked events and trim inventory |
| [Original-source gate](A-rollback/repair-B.json) | Upper continuation and all lower source memberships pass |
| [Rollback receipt](A-rollback/connection-A-rollback.json) | Exact original geometry retained after forced late refusal |
| [Chord alternative](B-final-packet/handoff.md) | Uniform source/chord bound and stronger represented-height order |
| [Chord-bound receipt](B-final/connection-B.json) | Whole-interval source bounds and actual checked queries |
| [B refusal counterexample](B-refusal/connection-B-refusal.json) | Explicitly injected whole-run deletion, with failing preservation assertion |
| [Pinned-height prototype](C-packet/handoff.md) | Alternative query contract and arithmetic/order controls |
| [Restoration checks](preservation.json) | Executed-input reproduction and unchanged A normal receipts |
| [Execution runner](run.py) | Toolchain, watchdogs, cache cleanup, receipt paths and discovery checks |

Earlier A, A-checked, A-audit and B packets/receipts are retained. A-transactional
was frozen but superseded before execution; it is not passing evidence. Native
binaries remain in the local `.testresults` experiment directory, not in Git.

To reproduce, restore the captured Stage 1 source, apply the selected flat patch
once, and run the archived runner with a fresh output label and these filters:
`connection_a_`, `exposure_b_controls_`, `exposure_a_frontier_`, and
`exposure_b_compiled_original_source_retains_required_continuation`. The runner
sets the separate normal and rollback receipt paths. Do not substitute a current
production checkout for the captured baseline and assume the old proof transfers.

## Next: validate the whole affected component

Freeze the selected source and re-establish the component's inputs before the
bounded reconstruction. Feature ranges, corner incidence, fingerprints, indexing
geometry, query semantics and inline storage have changed. Historical chart IDs,
the 198 typed-face certificates, 396 pin bounds and old memory totals cannot be
assumed applicable without matching their actual inputs.

The next three-agent validation should independently cover f64/f32 geometry and
contacts; topology and outside interfaces; and complete source intervals,
memberships and query authority. A fourth reviewer reconciles those inventories.
Run the complete selected component only after those prerequisites are ready.
Record its next refusal if it does not close; the original private graph guard
has not been rerun or shown to pass by this feature-only campaign.

Production remains unchanged. Current-HEAD integration, native/WASM equivalence,
transformed-family tests, complete torture models, later blend handoff and general
multi-sheet reconstruction remain open. No browser or visual acceptance was run.
