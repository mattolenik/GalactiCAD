# C compact revision

Source `/tmp/sfcc-stage3-r2-c-compact`, parent `...-c-buildfix`; same diagnostic
queries and verdicts, no runtime or capture-selection change. Two initial build
failures and the oversized capture must remain preserved as rejected attempts.

The C-buildfix observation run wrote 1,048,028 bytes and correctly failed the
unchanged 512-KiB capture cap. It captured 165 queries and 1,009 probe attempts.
Minifying alone would still exceed the cap (595,018 bytes). This revision writes
the probe attempt objects as arrays under one fixed eleven-field schema, then
minifies JSON. Every original field and every attempt is retained.

Top-level receipt now has `encoding`, `attemptFields`, and `evidence`; the latter
is the prior receipt with each flank's `attempts` converted to rows. The included
`expand.py INPUT OUTPUT` restores the original dictionary representation. The
Rust test independently expands its just-produced receipt and asserts exact
canonical JSON byte equality against the unencoded report before writing. It
then applies the same 512-KiB cap and all existing observation assertions.

A static transformation of the saved oversized receipt yields 438,859 bytes.
The independent Python expander reproduces exactly its canonical JSON hash
`ff53b4b2baf5e8d9cd3d20b13e1754885374e3523d9569bd5c0f6fe2040059f6`.
See `old-capture-roundtrip.json`. This is a saved-data self-check, not a fresh
geometry run. Source manifest is frozen after rustfmt; root still must build
and run the same filters/environment from the original C handoff.

The oversized receipt already reports the missing [31,10] raw curve235 stopping
at an unknown midpoint after frontier [0.015167364016736401,
0.007583682008368201]. Its compound31 flank exhausts (26 source-domain rejections,
7 opposite-separation rejections, 1 normal disagreement), while native10 has a
positive flank. The carrier point itself passes domain checks. Normal gap is
0.11751746516454614 there. This is sampled diagnosis, not source-equivalence or
endpoint-authority proof. The raw234 end50 and raw235 start0 also share an unknown
query at the old lower junction; raw302 [31,30] starts about0.000146364 away.

Passing the observation/encoding tests still leaves B's actual lower-preservation
regression failing; no repair acceptance follows. No agent build, geometry run,
whole component, native/WASM or GPU validation performed.
