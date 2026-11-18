# Round36 A: actual retained opposite consumer capture

Selected source: `/tmp/sfcc-paired-a-reviewed`, over the unchanged 212-input
`/tmp/sfcc-fullfan-reviewed` base. Only `outside_b.rs` and `ownership_a.rs` change.
Exact hashes are in `/tmp/sfcc-paired-a-changes.json`.

No Cargo build, test, source evaluation or geometry execution was run by A.
`rustfmt --emit stdout` parsed both files successfully without changing them.
Root owns all execution.

## Selection and original-stage binding

Set `SFCC_PAIRED_A=1` along with the existing `SFCC_OUTSIDE_B=1`.
The existing outside probe then selects the unique actual opposite consumer of
face `[0,3464532,2]`, instead of the old lexicographically first nonempty outside
cell. The face/edge selector comes from the corrected first-fan boundary witness;
it does not authorize geometry by itself.

Before the outside work starts, the probe binds the actual main-request first fan:

- Original source fingerprint, expected first stratum hypothesis, cyclic boundary
  and triangle inventory match the frozen first-fan witness.
- Every captured fan point matches the final candidate point payload, and every
  captured fan triangle is present in the emitted candidate mesh.
- The actual FaceRecord slot, key and length match the witness.
- The original octree has exactly two oriented face consumers, exactly one selected
  by the candidate transaction. The face rectangle fits both integer lattice cell
  extents; the first fan's cell-box bits match the actual selected consumer.
- The original directed face segment maps to the candidate's actual boundary edge
  through exact point key plus position equality, respecting consumer orientation.
- The shared endpoint is an actual original pin with original `Faxis:key:chart:t`
  provenance; source curve range and adjacent-stratum identities are recorded.

On the intended witness, this should select retained cell `[7,26,58,86]`, opposite
candidate cell `[7,25,58,86]`, with candidate-oriented private edge `40→38` and
original edge `4074→4072`. Those are not claimed executed results yet.

## Reconstruction and capture

The prior outside reconstruction remains in use: exact original records, positions,
normals, keys and source features, no primary/secondary quotient in the outside
view, and the same native `mesh_cells_subset` call. No route is forced and no
geometry acceptance guard is bypassed. Internal outside failures remain baseline
retained-cell failures; they are not automatically attributed to the candidate.

A scoped extension of the existing fan observer captures all bounded outside fan
hypotheses, not just whichever fan happens to appear first. It restores the prior
observer on exit and unwind. The ordinary main observer's default output is
unchanged. The capture has at most 128 fan rows, each with at most 64 boundary
nodes and 128 triangles, within the existing 4,096 aggregate fan/triangle counters.
The existing complete outside-report cap remains 512 KiB and fails explicitly.
This is count/serialization bounding, not complete allocator or RSS accounting.

The selected outside fan must have the shared edge exactly once in the opposite
orientation, return successfully, and be unique. Its triangles must occur in the
actual final outside mesh; its captured point bits must still match that final
PointTable. Failed/fallback, unvalidated-query, orientation or original-face
consumption results refuse the paired binding. Exact-key and exact-position join
mapping gives it the candidate/joined point-ID space. No approximate welding is
introduced.

The captured pair is still evidence, not source-root or union authority. B/C must
check their geometry/source obligations, and whole-outside/publication flags remain
false even when this local capture succeeds.

## Receipt fields for B/C

Under the existing component receipt's `outsideB`:

- `pairedTargetA`: actual face, both oriented consumers, original segment/pin/source
  bindings, candidate edge order and candidate curve memberships incident to the
  shared endpoints.
- `pairedCandidateFanA`: existing candidate first-fan record, in candidate IDs.
- `fanCaptureA.pairedFans`: all actual outside fan hypotheses in outside-local IDs.
- `curveMemberships`: all final outside-local identified curve intervals.
- `joined.outsideToJoined`: exact provenance-aware ID mapping.
- `pairedFanBindingA`: either explicit refusal, or `complete:true` with
  `outsideLocalFan`, `joinedFan`, `sharedEdgeCandidateOrder` and
  `sharedEdgeOutsideOrderJoined`.
- `pairedFanBindingA.joinedFan`: source hypothesis/identity plus boundary, triangles
  and point-bit rows in joined IDs. It explicitly does not claim source ownership.
- `options`: original surface/chord tolerance bits, quality flag and existing
  polyline/project limits.

The original face rows, pre/post point payloads, graph evidence where the graph
route executes, all generated-query records and ledger costs remain available.
A nongraph native route still produces fan hypotheses through the scoped observer;
its original face records/points/options provide the reconstructible cell inputs.

## Query and state accounting

The existing separate observational Transport ledger and full 2,048 generated-slot
reservation remain. The 16,384 total, 64 request/iteration and geometry limits are
unchanged. `GeneratedQueries::finish` retains all attempted queries before later
postvalidation; the main candidate's diagnostic ledger is restored afterward.
Fan capture performs no field or curve queries. Live original faces/points stay
immutable and are checked by before/after digests.

## Controls to execute

Filter `paired_a_` selects four focused controls:

1. Paired observer restores prior state after unwind and ordinary finish.
2. Selected fan requires a unique exactly directed shared edge.
3. A fan missing from the actual emitted mesh cannot be bound.
4. A captured point that changed before final mesh cannot be bound.

Retain `outside_b_` and `ownership_a_` controls as appropriate. Run one selected
original-source component attempt under the existing 120-second cap after the
capture composition compiles and its prerequisites pass. Preserve any refusal;
do not loosen the selector or numerical limits merely to obtain the target data.
