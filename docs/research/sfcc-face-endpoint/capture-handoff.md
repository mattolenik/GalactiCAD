# Round 37 B: second original contour segment and emitted incident fans

Frozen candidate: `/tmp/sfcc-second-b`, based on the 215-input round36 selected source `/tmp/sfcc-paired-proof-fixed`.

Only changed file: `gcad-wasm/kernel/src/sfcc/outside_b.rs`.
SHA-256: `8b6d70080588081e1cc3e461f98d9cb94673e2617fdbf2a692d2151040319b99`.
The machine-readable list is `/tmp/sfcc-second-b-changes.json`.

## Smallest capture change

Root identified that `orientationCaptureA` already contains complete first-cell graph point payloads, source identities, every patch-output event and its new points, and the successful emitted graph triangles. The final candidate reuses that existing bounded capture. An initially drafted extra observer/shared_arc_plan channel was discarded before execution; those two files are byte-identical to the parent.

Set `SFCC_SECOND_B=1` together with existing `SFCC_PAIRED_A=1`, `SFCC_OUTSIDE_B=1` and the original component transaction opt-in. Existing behavior and receipt fields are unchanged when the new flag is absent. No geometry, source options or query behavior is changed.

The new normalization:

- Requires complete orientation/pregraph capture, exactly one graph point snapshot and one unresolved-free success event.
- Binds captured hexadecimal point bits to final candidate positions, rejecting absent, conflicting or nonfinite payloads.
- Verifies each captured source identity against the actual immutable feature strata (including same-process root identity).
- Requires ordered patch-output triangle starts, returned-success flags, complete new points, bounded fan/point counts and exact concatenated equality with the successful graph output.
- Requires every fan's oriented triangle triples in the final candidate and every used point bound to its final position.
- Produces the existing paired-fan record format, so no new main capture channel or source evaluator is introduced.

The second segment is derived from the actual two-segment FaceRecord, not hardcoded from stratum labels. It must be the unique other oriented segment, share only the existing feature pin with the first segment, and bind the original cell side. The actual record is `[0,3464532,2]`; expected candidate traversal is private `39→40` and outside traversal `40→39`, subject to runtime validation.

## Output for C and root

The existing `outsideB` report gains:

- `insideTargetFanCaptureB`: normalized original first-cell fan capture, or an explicit incomplete/refusal object.
- `secondSegmentB`: complete binding or explicit refusal.

On success `secondSegmentB` contains `insideFan`, `outsideLocalFan`, `outsideJoinedFan`, `sharedEdgeCandidateOrder`, `sharedEdgeOutsideLocalOrder`, `sharedEdgeOutsideOrderJoined`, the original segments/pins, both actual consumers, source fingerprint and candidate memberships touching the second edge. The outside joined fan shares the existing candidate-plus-keyed-outside ID space; the outside-local fan remains explicitly separate. Existing outside curve memberships and checked outsideToJoined mapping remain available.

Both selected fans must be actually emitted, their point bits must match final meshes, and their source identities and cell boxes must match actual inputs. The first binding and outside query/orientation/consumption validations must have succeeded. The normalizer does not require matching stratum IDs. Static parent evidence shows the candidate-side second fan has hypothesis 39 and four triangles, while the outside fan has hypothesis 31 and six triangles; runtime must establish those facts again.

## Controls and execution

Focused filter: `second_b_` (two tests).

- `second_b_other_segment_requires_exact_two_segment_shared_pin_inventory`: positive reversed-side cases; rejects wrong orientation, missing/duplicate segments and unrelated endpoints.
- `second_b_orientation_point_payload_rejects_missing_and_nonfinite_bits`: exact bit parsing and malformed/nonfinite payload rejection.

Retain `paired_a_`, `outside_b_` and existing source/domain controls in the final composition. Root runs the actual component attempt to establish the positive second-fan binding.

I performed static source inspection, edits, hash verification and a rustfmt parser pass only. No build, test, field/curve evaluation or geometry execution was run by B. The rustfmt stdout was redirected to `/tmp` and never copied into source, avoiding the prior filename-header artifact.

## Scope and limits

This is capture/provenance evidence, not source ownership, projected-union acceptance or a whole-face theorem. All caps remain: at most 128 capture events/fans, 1,024 captured graph points, 64 boundary nodes / 128 triangles per fan, and existing candidate/outside geometry and 512 KiB outside diagnostic limits. The new map/copies are bounded observations; this does not close allocator-complete memory accounting.

No matching-stratum assumption, new sampling, tolerance expansion, curve-query reservation or publication is introduced. C must separately check all four incident sectors, including the shared endpoint's link and a single common source proof where applicable. A handles ideal feature49 constraints and original parameter correspondence.
