# Lineage candidate C: identity audit and minimum observation contract

C rejects the strategy “log the raw pair and final endpoint, then call the gap a
trim failure.” The source has several identity/parameter transformations between
those observations. The selected capture must join them explicitly. This packet
is an independent source/saved-data audit; `candidate.patch` is intentionally
empty. No production patch, native test or new field evaluation is proposed.

Source `/tmp/sfcc-graph-lineage-c` remains byte-identical to the executed Stage 1
base `/tmp/sfcc-graph-stage1-b-reviewed`. The inherited exact replay and local
source proof are accepted context, not new results of this audit.

## Concrete identity boundaries

1. `compile_feature_set` combines native curves, ordinary seams, chamfer seams
   and branch-pair traces into one raw vector. It then canonicalizes each curve's
   `adjacent_strata` through an alias map. The raw vector position, its curve ID,
   pre-canonical source pair and post-canonical pair are distinct observations.
   A Geom::Traced also stores cloned carrier values; merely recording the outer
   `adjacent_strata` does not expose every source reference used by its queries.
2. `TrimmedRun.curve_idx` indexes that raw vector, not the final curve list.
   `trim_curve` can return several runs, merge a closed wrap pair or return none.
   Subsequent interior candidate cuts split each run again. Record the run identity
   and its raw parameter interval before and after those cuts.
3. Candidate insertion chooses the **first** existing point within the merge
   tolerance, otherwise appends a point. It does not choose the closest or verify
   source membership at insertion. A selected endpoint can therefore inherit a
   candidate originating from another raw curve or a native corner. A
   selected-pair-only observer must retain that selected candidate's origin.
4. `nearest_candidate` later chooses the strictly closest admissible candidate;
   its callback checks the selected raw curve's carriers. Projection of that
   candidate onto the source can overwrite the run's raw `t0`/`t1`.
5. For a traced curve, `remake_curve` samples raw parameters
   `[t0, floor(t0)+1, ..., t1]`, overwrites endpoint coordinates with the selected
   candidate positions, and calls `make_traced_curve`. That constructor assigns
   a **new** parameter interval `[0, samples.len()/3 - 1]`. Final `t_max = 31`
   therefore does not identify raw parameter 31 or a raw trace step cap.
6. The emitted pre-dedup ID is `out.len()`. Duplicate elimination later renumbers
   survivors with `curve.id = unique.len()`. A log taken only at `out.push` cannot
   assume it has observed final charts 20/33.
7. Corner incidence is cleared and rebuilt from deduplicated curves. Unwired
   non-surviving corners are removed, and a second remap changes candidate IDs to
   final corner IDs. Pre-compaction candidate 27 need not be final corner 27.

The companion `identity-counterexamples.json` contains exact structural examples:
a raw span 2.25..5.75 remakes as 0..4; retained pre-output index 2 becomes final
curve 1 after an earlier duplicate is dropped; candidate 8 can become corner 1.
These are consequences of the actual source rules, not observations of the knob's
unknown lineage. The real mappings must come from the selected execution.

## What the existing saved data does and does not say

The compiled receipt has **16** curves whose recorded pair is 10/15 or 30/15
(in either order). Only final curves 20 and 33 have a recorded endpoint
bit-identical to corner 27. Other same-pair curves have recorded knot heights as
high as about 2.6959, but lie on different spatial branches. Pair identity and a
y-range alone cannot associate them with the failed endpoint.

The full inventory is in `saved-lineage-controls.json`, decoded with integer
precision from receipt SHA256
`6acd91cc9a04c34ac394bf669ec1d54ba487ab4ad8ed18559a9b7e894c4a3543`.
It records exact endpoint bits and indexed-knot ranges. These ranges are not
asserted to bound every projected continuous query, and a different carrier
combination representing related geometry is not excluded. This audit does not
prove that no other compiled trace covers part of the missing interval.

Existing `diagnosis::features("raw_before_trim", ...)` and `"after_trim"` hooks
record only the stage, stratum count and adjacent-stratum lists. They are useful
entry points, but their current event payload cannot establish parameter or
endpoint lineage. The generic diagnostic limit counts events, not payload bytes;
adding unbounded curve dumps would not inherit a valid byte limit.

## Distinguish absence, uncertainty and endpoint movement

`trim_curve` maps `curve_point_status` as follows:

- `Ok(true)` → alive;
- `Ok(false)` → dead;
- `Err(())` → false **and** sets the unresolved flag.

A bool-only classification log would conflate a claimed dead region with a
numerically unresolved one. Keep the original tri-state and the resulting bool
without re-running the predicate. Record whether `segment_exposure::trim` took
its early return; the witnessed final curves are traced, but the observation
should not silently attribute an alternative path to sampled trimming.

`bisect_transition` returns the last known-alive parameter, either after the
parameter-distance threshold or after 40 iterations. Record the initial bracket,
executed midpoint decisions, final bracket, returned parameter and actual stop
reason. Bind the existing `param_distance` result if it must be logged; do not
call it again, since it can invoke curve queries.

`refine_transition` is a closure with two searches: direct triples and, if no
candidate succeeds, alternate incident-branch triples. It chooses the closest
validated result within `max_distance`, otherwise returns the seed. The search
radius differs between raw traced ends (`max_chord_error * 0.1`) and interior trim
transitions (`probe_delta * 4`). The final endpoint can therefore differ from the
trim classifier's boundary. Keep that distinction. “Returned seed because no
admissible triple survived” is an actual aggregate reason; it is not evidence of
a genuine source junction.

The source proof's short positive interval and the numerical smaller-probe
counterexamples do not identify which of these events ran first for chart 20.
If the raw traced span is already short, record that and target its tracer stop
reason next. If trimming cuts a longer source, identify the actual status and
flank/domain/normal failure, then verify whether refinement or merging subsequently
moves the endpoint. If only final remaking loses it, do not blame the earlier trim.

## Minimum selected capture

Use a narrow opt-in scope around the existing `compile_feature_set` invocation.
All data must be borrowed/copied from actual execution; observation never calls
`point_at`, `project`, field/normal/domain functions, or an acceptance predicate.

The minimum join chain is:

| Stage | Required linkage/data |
| --- | --- |
| Source/raw assembly | Raw-vector index, raw curve ID, canonicalization mapping, source occurrences/carrier identity, kind/native flag, original range and stored sample bits |
| Trimming | Raw index and run index; original tri-state classification results; selected transition bracket; existing reason/operand record from the executed flank path; raw output interval |
| Transition refinement | Same raw/run/end identity; actual seed, search radius, selected result or seed fallback; selected supporting IDs and already computed acceptance result |
| Candidate insertion/merge | Proposed point and origin; returned candidate ID; inserted versus reused; reused candidate's original source/native-corner origin |
| Interior splitting | Parent run identity; executed accepted cut/candidate IDs; split raw intervals |
| Emission/remake | Split-run identity; selected c0/c1, projected adjusted raw span; endpoint overrides; pre-dedup output ID; resulting range/sample count/endpoints |
| Duplicate handling | Pre-output ID → retained final curve ID, or discarded duplicate and actual retained witness |
| Corner compaction | Candidate ID → final corner ID or dropped; final curve endpoint IDs and complete incident lists |

Record source/geometry rather than assuming IDs survive transformations. For
comparison against the captured feature graph, the final check must identify both
charts 20/33 and corner 27 after all remaps, using exact recorded endpoint bits and
source membership. If selecting near-endpoint detailed events, predeclare a
spatial window large enough to include the selected refine radius and retain a
summary of every stage needed to detect a missing join. A skipped/capped event in
that chain makes attribution incomplete.

If a candidate logs only `trim_curve` entry/exit and final output, it can show a
trim-stage change but cannot identify the exact executed dead predicate or exclude
later endpoint movement. Conversely a dense flank log with no final remap chain
cannot show those probes created corner 27.

## Observational equivalence and limits

The existing feature fingerprint is necessary but **not sufficient** for complete
output equality. Its curve record hashes id/kind/closed/range/wrap/adjacent-strata
and index polyline; it omits `native`, `owner_node_id`, `corner_start/end` and
traced refinement settings. Corner incidences are hashed separately but do not
prove a potentially inconsistent curve endpoint field unchanged.

Compare explicit recorded curve/corner outputs in addition to the fingerprint:
IDs, native/owner flags, source pair, range/wrap, all indexing samples, endpoint IDs,
corner positions/strata/ends and traced refine settings. Avoid recursively
formatting/cloning shared source graphs. Static removal of observation code should
retain the original computational token order, including short circuits. A
full-input off/on comparison may differ in process-local addresses/run IDs; state
those exclusions explicitly rather than dropping all source identity checks.

Further requirements for D:

- No eager operand materialization when the observer is inactive. Gate additions
  to tests/profiling so serde-only production does not allocate diagnostic state.
- Preserve `.all`, `.any`, `&&` and `||` short circuits. Log attempted checks only;
  filling in an unexecuted domain/normal operand requires a new query and is not
  observational. Do not sort live candidates, raw curves or run lists.
- Bound raw/sample/event counts before copies, use checked accounting and a
  streaming serialized cap. Store exact floating bits/large integer sentinels as
  strings. A capacity refusal must leave the feature compiler running unchanged
  but mark capture incomplete; it must not silently drop only inconvenient events.
- Use one active scope with take/drop/unwind cleanup. Counter and cap state must
  not leak into another compilation. Do not retain full JSON once per curve.
- Controls should cover inactive scope, active no-output-change, truncation,
  early drop, exact bit round trips and a mapping with duplicate removal/corner
  compaction. The actual feature capture must retain the old fingerprint and all
  explicit final outputs it claims unchanged.

One selected feature-only capture under the existing 60-second root budget is
sufficient if all links are complete. No octree, private mesh, browser, full export
or extra raw-source evaluation is needed merely to gather these existing values.

## Validation and scope

C read the connected compilation, tracing, trimming, curve construction and
fingerprint implementations; decoded saved JSON with integer precision; checked
exact endpoint matches and structural remapping examples; and hashed source
anchors. Every runtime file remains byte-identical to the immutable baseline.
`source-anchors.json` records the inspected function/file hashes and locations.

No Rust build/test, feature compilation, SDF/curve query, octree, export or new live
capture ran. There is no C execution filter or receipt variable: those are not
applicable to this intentionally empty patch. The actual upstream loss remains
unlocated; this packet is a falsifiable capture contract, not a new causal claim.
