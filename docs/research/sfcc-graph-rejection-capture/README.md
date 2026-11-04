# SFCC private graph rejection: executed capture

Stage 1 of the [implementation plan](../../plans/sfcc-graph-correctness-implementation.md)
is implemented and mechanically validated. The original knob fails the actual
`vertex_degree_lt_two` guard: **point 633 has only neighbor 620**. Point 633 is
the newly inserted `corner:27`; point 620 is the retained boundary pin on chart 20.
This identifies the executed mesher assumption. It does not establish whether the
source requires a continuing crease or permits this terminal configuration.

## Executed result

| Observation | Result |
| --- | --- |
| Cell | `[7,36,79,29]` |
| Classification | Corner 27, no selected feature curve, nondegenerate |
| Graph entry condition | Curved incident corner; one distinct pin curve |
| Boundary | One loop, eight vertices and eight boundary edges |
| Feature path | One edge `620–633`, chart 20, incident strata 10/15 |
| Terminal incidence | Corner 27 retains only `(chart 20, end 1)` after alias removal |
| Graph degrees | Point 633: 1; point 620: 3; all other graph vertices: 2 |
| Private points | 633 at entry; 634 at rejection; `corner:27` absent before entry |
| Graph-local queries | Six successful chart-20 attempts, run-wide indices `[40,46)` |
| Private outcome | Whole component rejected; eight fallback triangles not accepted |
| Live digest | `5f3600b1ef212fb0`, unchanged |

The feature interval runs from the captured pin parameter
`403ec575c721f0be` to chart 20's endpoint `403f000000000000` (31). The graph has
nine vertices and nine edges: the eight-edge boundary plus a single interior
feature edge ending at corner 27. The independent degree reconstruction agrees
with the actual guard operands.

All **35 compared historical fields** match Round 18 exactly, including the full
consumer inventory, all 198 typed-face certificates/396 pin bounds, all 46
generated queries, 9,950 charged queries, the 19,865,723-byte reservation, the
mesher failure summary and the live-state digests. This comparison excludes the
new observations and changed provenance fields. The added capture did not alter
any of these observed outcomes.

## Implementation and independent review

Three agents supplied independent alternatives/audits; a fourth reviewed them:

- [A](A-packet/handoff.md): narrow local-state capture, with a more limited
  pre-call key-map record and a mislabeled native-band descriptor. Not selected.
- [B](B-packet/handoff.md): bounded pre-call point/key state and actual caller
  classification, plus graph-local query ranges. Selected after corrections.
- [C](C-packet/handoff.md): counterexamples to relying on the old post-return
  snapshot, numeric JSON precision analysis and observation requirements.
- [Selection decision](decision.md), [corrected B handoff](selected-packet/handoff.md)
  and [independent executed-result review](result-review.md).

The selected patch labels all 16 direct graph-failure exits, recording operands
after the original predicate fails. It adds no field/curve queries or geometry
rules. Observation is compiled only for serde-enabled tests/profiling, and
inactive observation does not materialize operand JSON. Existing scope state
holds at most the current graph record and clears it on each new private cell.
Structural bounds precede collection; a bounded writer enforces the 512 KiB
serialized-detail cap. The actual compact capture is 127,936 bytes.

## Source, validation and reproduction

The temporary Round 18 checkout had disappeared. Root restored the
[archived overlay](../sfcc-e4-prototype/README.md) on E3 and verified all 155
recorded source/configuration hashes. The original Homebrew Rust 1.99.0 compiler
remained installed at `/opt/homebrew/Cellar/rust/1.99.0_1/bin`; its commit and LLVM
version match the historical record, as do all ten audited standard-library
files. No compiler migration or storage-policy change was needed.

| Check | Result |
| --- | --- |
| Restored baseline build / six retained controls | Pass; 15.793 s / 5.326 s |
| Selected diagnostic build | Pass; 13.153 s, 120-second cap |
| Six observation tests + one real graph control + six retained controls | 13 pass; within the 60-second campaign cap |
| Serde-only library check, observation compiled out | Pass; 5.090 s |
| One original-scene private capture | Completed in 18.127 s, preparation-inclusive 120-second cap |

Times are execution records, not benchmark or speedup evidence. The original
scene test passed because it captured the refusal honestly; mesh construction
still failed.

To restore the selected implementation, first restore E3 plus Round 18 exactly,
then apply [selected-packet/candidate.patch](selected-packet/candidate.patch).
The selected packet manifest SHA256 is
`396d712b35b9cf70793509055afc6fdb8af83a9e7a6934bddef580e86d0ad82e`.
[Executed manifest](executed/manifest.json) records all 156 source inputs and
the actual compiler/profile. [Binary receipt](executed/binary.json) records the
executed test binary hash. No production source patch was applied.

The archived [runner](run-diagnostic.py) and [historical comparator](compare-historical.py)
retain the exact commands and watchdog behavior. They contain this workspace's
paths; use a fresh job label and restored source directory for a new run, never
overwrite the saved evidence. Run the three focused filters before any new
original-scene capture. The existing receipt answers the stage-1 question;
another whole-scene capture is unnecessary merely to inspect the same guard.

## Evidence limits and next step

[Complete receipt](executed/private-receipt.json),
[historical equality comparison](executed/historical-comparison.json), and
[independent mechanical summary](mechanical-summary.json) preserve the evidence.

`complete: true` means the declared capture schema was not truncated.
`completeReplayEstablished: false` remains correct: source feature geometry and
all PointTable patch/protection state are not serialized. Stage 2 must show which
dependencies the observed failing path actually reads and reconstruct those
dependencies before claiming an exact local mesher replay.

Coordinates, normals, parameters and point keys are lossless strings in the new
capture. One source identity still uses numeric `usize::MAX` as its leaf-index
sentinel; decode the raw receipt with integer-preserving Rust/Python, and encode
that sentinel as a string/hex in any future JavaScript-facing replay fixture.
The older enclosing receipt also contains numeric u64 bit patterns. Ordinary
JavaScript `JSON.parse` is not lossless for those integers.

The next package establishes the endpoint's source obligation and a failing
regression. It must distinguish a missing continuation from a legitimate terminal
crease or incorrect classification. Neither deleting the feature edge nor
accepting the corner fan is justified by this capture. Component reconstruction,
full-model correctness, release-WASM validation and production acceptance remain
open; the main runtime remains at `421f5a9`.
