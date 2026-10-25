# SFCC E4 isolated prototype — Round 18

This is a reproducible **experimental source overlay**, not an integrated runtime
repair. Its original-knob diagnostic passes the shared-face and storage gates,
then refuses `private_graph_refused` at cell `[7,36,79,29]`. The entire private
component is discarded. E4 and production acceptance remain open.

[Round 17 fourth-agent decision](round17-storage-controls/decision.md) compares
three competing storage approaches. [Round 18 independent review](round18-storage-integration/decision.md)
checks the selected integration and executed evidence. The
[execution summary](round18-storage-integration/summary.json) includes the actual
reservation, first failure and unchanged live-state digest. The
[complete captured receipt](round18-storage-integration/executed/private-receipt.json)
retains the original scene/options/lattice, certificates and local failure state.

## Restoring the exact source

Apply [round18.patch](round18.patch) to a throwaway checkout of
`3abea38c93679fff5e6e7c600b23d8a0f46974a6`. It includes all ancestral experimental
changes needed by this selected prototype; earlier temporary directories and
patch chains are not required. Do not apply it to the working production tree.

```sh
git apply --check /absolute/path/to/round18.patch
git apply /absolute/path/to/round18.patch
```

[Source manifest](source-manifest.json) records all 155 source/configuration hashes,
36 changed files, baseline hashes and patch hash. The patch was checked and applied
in an isolated directory; every resulting changed file matched the executed source
byte-for-byte. Unchanged source/configuration files matched the pinned baseline.
An independent fourth-agent [preservation review](preservation-review.md) also
reconstructed all 36 changed files from the pinned baseline and verified the
archived receipts. This packaging check did not rerun geometry. The original execution paths in
receipts and reviewer handoffs are historical provenance, not restore dependencies.

## Executed validation and reproduction limits

The captured native build used Homebrew Rust 1.99.0, commit
`b940084d7eb6a299eb4bfeb8e34901bc051e7ac4`, aarch64-apple-darwin, LLVM 23.1.2,
and bundled hashbrown 0.17.1. [Ownership provenance](std-ownership-provenance.json)
records the standard-library files relied on by the storage bound. The reservation
is specific to this audited representation and insertion-only index history;
it is not a universal Rust allocator or process-memory bound.

Build command, from the restored checkout (`--offline` requires the locked
dependencies already cached):

```sh
RUSTC=/opt/homebrew/bin/rustc \
CARGO_TARGET_DIR=/tmp/sfcc-e4-reproduction-target \
CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
/opt/homebrew/bin/cargo test --locked --offline \
  --manifest-path gcad-wasm/Cargo.toml -p gcad-kernel \
  --release --features serde,sfcc-profile --lib --no-run --message-format=json
```

Use the emitted test executable with `correlated_ --nocapture --test-threads=1`.
Set six distinct fresh receipt paths through `SFCC_CORRELATED_SELECTED_RECEIPT`,
`SFCC_TRANSPORT_A_RECEIPT`, `SFCC_PRIVATE_A_RECEIPT`,
`SFCC_INTEGRATED_FACE_RECEIPT`, `SFCC_STORAGE_A_RECEIPT` and
`SFCC_STORAGE_INTEGRATED_RECEIPT`. The captured campaign passed all six tests.
Use a 120-second process-group watchdog for the build and a 60-second watchdog
for the focused campaign, killing and reaping only the owned process group.
No browser, WASM, full export or production performance claim follows.

The separately bounded original-scene diagnostic used the filter
`private_a_original_knob_serial_round0_diagnostic --nocapture --test-threads=1`,
a fresh `SFCC_PRIVATE_A_RECEIPT` and `SFCC_PRIVATE_A_SOURCE_MANIFEST_SHA256`
set to the frozen integration manifest hash in the source manifest. Its
preparation-inclusive limit was 120 seconds; it finished in 23.604 seconds.
A passing test process means the expected capture completed, not successful mesh
construction. Do not rerun the full context merely to reproduce the already saved
refusal. The [integration handoff](round18-storage-integration/source-packet/handoff.md)
records the exact budgets and protected gates.

## Next discriminator

The eight fallback triangles are rejected, and the local snapshot is explicitly
post-return. It lacks the graph adjacency and precise internal rejection branch,
so it is insufficient for exact replay. The terminal endpoint may have degree one
after removal of its duplicate chart, but that is an unconfirmed hypothesis.

Keep the accepted source/root/storage gates fixed. Identify the executed graph
predicate and preserve its local operands and source incidence before deciding
whether the defect is missing feature continuation, incorrect classification or
graph handling. Accepting the fallback fan or deleting a constraint is not a repair.
Complete component geometry, f64/f32 validity, feature transport, links, contacts,
full-model gates and native/WASM agreement remain unvalidated downstream.
