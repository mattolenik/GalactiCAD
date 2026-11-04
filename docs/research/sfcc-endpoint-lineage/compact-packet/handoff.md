# B lineage capture: checked source references under the unchanged cap

Frozen source: `/tmp/sfcc-graph-lineage-b-compact`, copied from root's executed
syntax-corrected `/tmp/sfcc-graph-lineage-b-buildfix`. Earlier frozen sources and
the incomplete capture are preserved. This is the specifically reviewed
representation correction, not a larger capture budget or a geometry change.

The retained incomplete run contains32 `refine_transition.source` payloads that
root and the fourth reviewer matched exactly to preceding `raw_received.data`
records by actual raw-list index. They account for approximately181KiB of repeated
source data. That observation does not recover events missing after the old cap.

## Correction

For a selected raw curve's refinement event:

1. Construct the same existing bounded `source_record(curve)` metadata.
2. Require the active raw context's ID/pair to match the actual curve.
3. Find exactly one earlier `raw_received` event at that context's raw-list index.
4. Compare its entire data value with the just-built source record, exactly.
5. Only on equality replace the duplicated payload with
   `{"reference":"raw_received.data","rawIndex":...}`.

Missing, ambiguous or mismatched data marks the capture incomplete. This does not
assume canonical tags identify the stored carriers: the compared source record
includes the actual stored carrier descriptors and refinement bits. Nonselected
external-origin refinement records retain their full inline source data. No new
pointer/lifetime registry or general interning layer exists.

All other event fields, selected window, structural bounds, iteration/query
behavior and512KiB cap remain unchanged. Formatting/metadata comparison adds no
field, carrier, projection or geometry query. The temporary source record is
still bounded and is dropped after comparison. `trim.rs` and `feature_curves.rs`
are byte-identical to the executed syntax-corrected source; only the observer
module and its additional test changed. The earlier syntax fix remains intact.

## Controls and root execution

The new control expands a selected reference and compares the complete original
refinement event, including every scalar/point/parameter/reason field. It also
checks missing and changed source records become incomplete, and external-origin
source data stays inline and exact.

Filter `endpoint_lineage_b_controls` now selects five authored controls. The
single capture filter remains
`endpoint_lineage_b_original_feature_compile_is_observational`, with fresh
`SFCC_ENDPOINT_LINEAGE_B_RECEIPT`. No new environment variable is needed.

Root should use pinned Rust1.99.0 and the unchanged120-second diagnostic build,
then controls followed by the separately approved one60-second feature-only
capture. The capture still performs one unobserved baseline feature compilation
and one observed compilation; there is no octree or mesh export. Before interpreting
new lineage, expand reference payloads from the raw events and compare the retained
old prefix after normalizing process-local root labels by sharing identity.

Author validation: static diff/hash checks and pinned rustfmt parsing only. No
build, test or feature/geometry evaluation was performed. The full candidate patch
is relative to executed Stage1; `representation-correction.patch` isolates changes
relative to the executed buildfix source. Its manifest records both bases.

The complete source lineage may still exceed a bound. If it does, preserve the
new incomplete receipt; do not increase the cap, change the event window or
reinterpret missing data as a completed capture.
