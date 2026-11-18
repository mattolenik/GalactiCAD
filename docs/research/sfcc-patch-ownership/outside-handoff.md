# B: first actual retained-outside consumer, with no complete outside claim

The compile-corrected candidate is `/tmp/sfcc-outside-b-fixed`, based on the 202-input round33 Reviewed source. Only two files change:

- `gcad-wasm/kernel/src/sfcc/stage4_component_b.rs`: after successful candidate construction, an opt-in `SFCC_OUTSIDE_B=1` hook runs the observational probe and adds `outsideB` to the full receipt; includes the new child module.
- `gcad-wasm/kernel/src/sfcc/outside_b.rs`: bounded inventory, actual first outside-cell reconstruction, generated-query postvalidation, provenance-aware joining and contact/topology diagnostics.

Hashes are in `/tmp/sfcc-outside-b-changes.json`. The initial `/tmp/sfcc-outside-b` snapshot had a JSON macro compile error at the normal-bit array expression. Root preserved that failed build. Fixed changes only parenthesize the array before `.map(f64::to_bits)`; there is no geometry or guard change. The fixed module hash is `7c10d794098c9646a15fba2cca08f1ec51ed39a2f4473f4b9afc45bdad4a8b87`.

## Why the scope is one exact outside consumer

The accepted candidate spent 1,929 of its 2,048 generated slots. Borrowing a fresh outside budget and presenting it as if it were still the original transaction would be misleading. Root explicitly authorized a separate observational Transport ledger with the same 16,384 total and 2,048 generated reservation, not publication authority and not a replacement for the candidate's 8,413-charge ledger.

An outside cell's lattice AABB is not automatically a valid bound on all triangles its generators might emit. B therefore makes no exclusion claim for unmeshed outside cells. It enumerates all original leaves for actual face incidence, counts the complete face-adjacent outside ring and records whether that ring fits the existing 256-cell cap. It selects the lexicographically smallest original outside cell ID incident to a nonempty candidate frontier FaceRecord. The selection is deterministic and does not choose a convenient later postprocessed triangle.

Even if that witness succeeds, the module always reports incomplete outside contact audit and `publicationReady=false`. The complete relevant outside geometry, including cells not sharing a face, remains unproved. A first witness can establish a concrete incompatibility or a concrete local compatibility result; it cannot establish the whole outside gate.

## Exact original-stage reconstruction

The selected leaf is drawn from the same octree and source instance as the candidate, before ordinary cell meshing. Its required records are checked for axis/key/length identity, counter length and zero original consumption. Input points retain original positions, normals and keys; collisions with different payloads refuse. Protected edges and identified intervals retain exact memberships. An external protected/identified endpoint refuses instead of silently dropping metadata.

The probe copies only this consumer's required records and point payloads, keeps the original feature view, and invokes the actual `mesh_cells_subset`. It applies neither primary nor secondary quotient to the retained outside consumer. Original live faces and points are immutable, and before/after digests are recorded. A saved diagnostic scope prevents the outside observer from overwriting the successful main constructor's evidence.

The generated scope is always finished before postvalidation. `GeneratedQueries::finish` itself records all actual query attempts and cost information before returning success or an exhaustion error. The wrapper retains that isolated evidence, including failure paths. Successful queries are re-evaluated with charged original `point_at_checked`, require bit-identical own-query positions, and retain the same original source-domain/qualified-membership and strict residual checks. Failed generated queries and failed validations are explicitly listed; the loop continues auditing other observed queries. The reservation is not refunded.

## Interface and geometry checks

Outside/candidate vertex identity is reconciled only through matching original point keys and exact position bits. Equal coordinates with unrelated or unkeyed identities are not silently welded. Matching keys with different positions refuse. This avoids artificial contact failures caused by treating genuine shared frontier IDs as unrelated, while retaining provenance as a prerequisite.

The probe builds candidate contact indexes in working and rounded coordinates, then checks every emitted outside triangle against all candidate triangles through the existing exact-sign predicates and conservative broadphase. It separately reports original face-consumption validity and source-reference orientation in working/exported coordinates. A joined indexed topology report includes vertex links for the candidate plus this one consumer.

A partial joined vertex-link failure may be resolved by missing outside consumers and is not automatically a counterexample to the complete retained mesh. Outside internal mesher failures are baseline retained-cell failures, not evidence that this repair caused them. A candidate/outside contact reports an actual pairwise incompatibility but does not by itself identify which side is wrong. No general `compatible=true` or acceptance flag suppresses a failed orientation/consumption verdict.

## Bounds, controls and commands

The existing limits remain: selected cells256, required faces1536, per-witness faces24, pins1024, points/triangles4096, intervals2048, generated slots2048 and total query charges16384. Joined geometry also stays within 4096 points/triangles. The observational report has a 512KiB serialized cap; overflow is an explicit refusal, never a truncated pass. This does not claim that new JSON/maps/contact-index allocations have a complete 64MiB or RSS proof.

Root should run focused filter `outside_b_` (two cheap controls):

1. Shared identity requires the original key and exact position; coordinate equality alone does not grant it.
2. Two actual adjacent indexed triangles join without contact, while a transverse triangle is detected; complete outside acceptance remains false even for the positive fixture.

Then run the existing `stage4_component_b_original_source_attempt` once with `SFCC_COMPONENT_TRANSACTION_A=1` and `SFCC_OUTSIDE_B=1`, under the existing whole-attempt 120-second cap. Inspect `outsideB.inventory`, `queryAndGraphEvidence`, all validation/consumption/orientation verdicts and the joined result, not just test-harness exit status.

B performed static inspection, isolated edits and formatting only. No build, test, scene/curve evaluation or reconstruction was run by B. Root owns all execution. A's ownership observer must close or distinguish its candidate scope before this outside call so outside fans do not contaminate the 1,775-triangle inventory.
