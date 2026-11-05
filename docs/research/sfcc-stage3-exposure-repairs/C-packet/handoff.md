# Stage 3 C — reject uncertainty-only and meshing-only repairs

**C does not propose a production geometry patch.** It supplies an independently
argued rejection of insufficient repairs, an authored original-source counterfactual
and the endpoint/interval obligations that any selected A/B repair must carry.
The actual continuing knob crease cannot be repaired solely by relabeling a failed
probe search or by changing the mesh degree guard.

Source: `/tmp/sfcc-stage3-c`, based on immutable `/tmp/sfcc-stage3-base` (the executed
Stage 1 source). Only `trim.rs` and one new test module differ. The change in the
existing function is a test-only, explicitly scoped hook: when enabled, an otherwise
resolved exhausted flank search returns `Err(())` instead of `Ok(false)`. With the
scope disabled, behavior is exactly the baseline. Non-test builds compile out the
hook and child module. No source, curve or mesh evaluator is introduced.

## Why unknown reporting alone cannot satisfy the repair contract

The current consumer in `trim_curve` maps both `Ok(false)` and `Err(())` to the
same boolean false; only `unresolved` bookkeeping differs. Its classification
sampling and bisection therefore take the same branches and return the same run
boundaries. `TrimmedRun` has no per-end uncertainty field. Every non-closed run
then creates endpoint candidates; subsequent snapping/remaking uses those endpoints
without a confidence distinction. A global validation failure does not undo the
already constructed local graph.

This gives an exact control-flow argument: let b map `Ok(true)` to true and both
other statuses to false. Replacing some exhausted-search `Ok(false)` outcomes by
`Err` preserves b at every query. All geometric constructors downstream receive
the same inputs. Merely changing this tag cannot supply the required interval.
It is better reporting, but not a geometric continuation repair.

The authored test `exposure_c_uncertainty_relabel_does_not_repair_original_compiled_endpoint`
checks this on the complete original knob source: one baseline feature compilation,
then one with the scoped counterfactual. It compares explicit curve id/kind/native/
owner/closed/wrap/range/strata/end-link/indexing values, stored traced-carrier IDs
and refinement scalars, all corner positions/strata/incidences and unresolved branch
paths. It also checks the original fingerprint but does **not** use that hash as a
substitute for these fields. Hidden geometry constructors and their inputs remain
unchanged by the control-flow argument; no claim of a recursive hidden-source
snapshot is made.

The expected counterexample is unchanged target curves 20/33 and corner 27,
ending below the required positive interval, while `unresolved_trims` increases.
The receipt is written before the decisive assertions. Passing means the
**insufficient repair is disproved**, not that C repaired anything. All assertions
remain unexecuted until root runs them.

## Concrete mathematical adversaries

These are analytic arguments, not executed CAD fixtures or new CPU reference
implementations. The original transformed knob remains the primary executable case.

### Every fixed finite displacement schedule has a missed-width example

For any smallest attempted displacement d>0 choose 0<w<d. The field

`F(x,y,z) = max(x, y, -y-w)`

has solid `x<=0, -w<=y<=0`. Its x/y crease is the entire line `x=y=0`. The
x=0 patch survives on the open strip `-w<y<0`; the y=0 patch survives at x<0.
At the crease, every x-patch probe at y=±delta with delta>=d lies outside the
surviving strip, while the other patch has a surviving flank. The carrier normals
are regular and perpendicular. The failed finite search does not establish that
the crease is absent.

Adding any fixed number of extra halvings only changes d, so another smaller w
repeats the counterexample. A search bounded by numerical resolution/work may be
useful, but exhaustion must remain undecidable unless separate source evidence
proves absence. Its stopping premise and the treatment of that state must be
explicit.

### Unknown cannot be treated as automatically alive

`F(x,y,z) = max(x, y, (x+y)/2) = max(x,y)`.

The third carrier is redundant. It vanishes on the same intersection line and
has a normal distinct from the x and y carriers, but no open portion of its own
plane survives: on `(x,y)=(a,-a)` with a!=0, F=|a|>0. A failed probe search for
that carrier cannot be promoted into a genuine adjacent patch merely because the
intersection point lies on the final surface. Forced-positive uncertainty would
invent wrong source incidence or duplicate feature labels.

### True terminal features remain legitimate

The surface graph `z=max(x,0)^2*|y|` is homeomorphic to a disk. Its crease at
x>0,y=0 terminates at the origin as the normal jump tends to zero. Thus a degree-one
feature endpoint is not universally a surface defect. The accepted knob source
proof specifically excludes this explanation in its checked neighborhood; it does
not justify changing all terminal features into continuing ones.

### Conditioning, proximity and provenance are distinct

For F1=x and F2=x+epsilon*y, their transverse determinant is epsilon. A residual
bound alone allows y uncertainty proportional to residual/epsilon. A continuation
method must refuse or remain unresolved when its rank/conditioning premise fails;
it must not use a large residual tolerance to bridge the ambiguity.

The curves `(t,+epsilon,0)` and `(t,-epsilon,0)` are distinct even when both lie
inside a coordinate merge tolerance. Equal or nearby geometry does not supply a
shared source occurrence or branch proof. Likewise a certificate for one source
root/branch cannot authorize another source copy or inactive/capped extension.

## Required uncertainty propagation audit

A selected repair that adds endpoint state must follow it through all consumers:

| Consumer | Required handling |
| --- | --- |
| `curve_point_alive` | Its current `unwrap_or(false)` is a lossy convenience view. Do not use it as an absence certificate or discard uncertainty needed by a new caller. |
| `trim_curve` classification and bisection | Unknown is not a dead bracketing side. Preserve uncertainty in the boundary decision; do not bisect an arbitrary reporting boundary into a geometric junction. |
| `TrimmedRun` and wrap merge | Carry start/end state with orientation; wrapping/swapping endpoints must carry the corresponding state. Unknown endpoints cannot be erased by merging a closed wrap pair. |
| Interior candidate splitting | New interior cuts and original run ends have different provenance. Copy the original outer-end state and separately justify any new internal endpoint. |
| `add_candidate` / `refine_transition` | Suppressing candidate insertion is not enough; accepting no triple and returning the seed does not certify a source junction. |
| `nearest_candidate` / adjusted remake span | BOTH endpoints are independently searched within `max(2*cornerMerge,2.5*probeDelta)`. An unwired uncertain end can otherwise snap back to an unrelated existing corner. Gate snapping, parameter replacement and coordinate override per end. |
| `corner_start/end`, dedup and incidence rebuilding | Do not reconstruct an authoritative corner from an uncertain end during remapping. The inverse `corner.curve_ends` relation must agree with each curve's fields. |
| Spatial corner index / cell classification / graph meshing | These read corner incidence directly. Global unresolved counts alone do not stop them treating an ordinary corner record as a construction constraint. |
| `feature_trace.unresolved_trims` / final validation | Retain the unresolved result end-to-end. A source-level improvement is not full-component acceptance. |

The ordinary point-level positive witness also does not certify an entire interval:
consecutive successful samples can straddle a hidden gap. The selected repair's
claim must distinguish numerical support from a continuous source certificate.
For this milestone, the separately proved source window provides ground truth,
but the actual compiled graph must preserve that interval with matching source
occurrences, fixed branch and ordered parameters. Final curve IDs may change;
the candidate must not hard-code runtime IDs/coordinates to pass the fixture.

## Controls and root execution

Root should build once with pinned Rust 1.99.0, offline/locked, diagnostic
no-LTO/codegen16, `--release --features serde,sfcc-profile --lib`, within120seconds.
Run `exposure_c_ --nocapture --test-threads=1` within60seconds with a fresh
`SFCC_EXPOSURE_C_RECEIPT`. Two tests are authored:

1. The actual-original-source uncertainty-only counterfactual and explicit output
   comparison (two feature compilations, no octree or mesh).
2. Scope cleanup after a deliberately caught unwind; no geometry evaluation.

The first test's receipt is capped at64KiB. It explicitly reports
`geometryRepairSucceeded:false`, `productionRuntimePatchProposed:false` and
`publicationReady:false`. Root should retain contradictory evidence if it fails,
not loosen the comparison to make the argument appear confirmed.

Author validation: source/caller inspection, exact control-flow/mathematical
arguments, pinned rustfmt parsing/formatting and source hash/diff checks only.
No build, Rust test, feature compilation, SDF/curve query, octree or export ran.
The analytic negative controls above are proof obligations for selected candidates,
not falsely advertised as executed regression tests.
