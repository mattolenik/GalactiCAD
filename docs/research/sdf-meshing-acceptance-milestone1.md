# SDF meshing acceptance: first torture-model inventory

Implemented and exercised October 23, 2026, from `df365cc` plus the recorded
working changes. The first three steps of the
[acceptance plan](../plans/sdf-meshing-acceptance-suite.md) are complete.

Run the full process with:

```sh
make acceptance-tests
```

The `.PHONY` target builds the application and invokes the five-case runner.
The runner starts the dedicated agent server, captures the original Manim
sources, exports each once, renders retained meshes from four cameras, compares
images and writes a portable Markdown report under `.testresults/sdf-meshing/`.
It does not operate the user's interactive browser.

## Report and measured outcomes

Open the [expanded diagnostic Markdown report](../../.testresults/sdf-meshing/investigated-2026-10-23/report.md).
It contains clickable SDF/solid/wireframe/difference images, per-view metrics,
full SFCC diagnostics, source/configuration records and artifact hashes.
The [bracket/housing follow-up](sfcc-bracket-housing-investigation.md) explains
the demonstrated defects and distinguishes them from label/uncertainty reports.
The output directory is ignored by Git; preserve/copy the whole directory when
sharing the report. Re-running the target creates a new timestamped directory.

The initial report rendered raw shared vertex normals directly, bypassing the
flat-face-normal display pass used by the production viewer and historical
Manim captures. This introduced a display regression at sharp contours. The
corrected report renders a separate flat-normal copy of each saved mesh; all
704,892 triangles across the four available meshes have bit-identical corner
positions. No meshing was repeated, and the original export times, validation
failures, and Mess 1 timeout below are unchanged. The
[original report](../../.testresults/sdf-meshing/milestone1-final-2026-10-23/report.md)
is retained as evidence of the capture mistake, not a like-for-like historical
display comparison. See the
[display correction checks](../../.testresults/sdf-meshing/milestone1-flat-normals-2026-10-23/validation.json).

| Original model | Triangles | Export time, single sample | Invalid triangles reported | Unresolved cells | Acceptance |
| --- | ---: | ---: | ---: | ---: | --- |
| Bracket | 109,196 | 24.160 s | 6 | 59,713 | FAIL |
| Housing | 126,192 | 36.318 s | 180 | 17,352 | FAIL |
| Knob | 185,924 | 94.943 s | 4,588 | 48,609 | FAIL |
| Mess 1 | N/A | 180 s export limit reached | N/A | N/A | TIMEOUT |
| Mess 2 | 283,580 | 29.435 s | 17,959 | 30,077 | FAIL |

All four completed exports returned `ok=false`; the report preserves those
failures. Mess 1 retains its fresh SDF reference and timeout evidence. The
isolated worker context was restarted, and Mess 2 subsequently exported and
rendered successfully as a measurement operation. No reduced-quality retry was
used. Complete report generation finished with exit 0 in about 413 seconds;
overall mesher acceptance remains **NOT PASSED**. `--strict` makes unaccepted
meshes a nonzero exit outcome.

There are 49 fresh SDF/mesh/wireframe images, 16 difference images and their
thumbnails: 16 complete view triplets across the four emitted meshes, plus the
timed-out case's SDF hero image. Every completed image pair includes SSIM and
pixel-difference measurements; no image score is treated as a correctness proof.
The initial inventory remains available separately as development evidence;
the linked final run uses the corrected timeout reporting.

## Capture contract and integration

- A single retained mesh supplies every solid/wireframe view. Browser sessions
  are pinned across requests; a newly ready tab cannot substitute another scene.
- Actual vertex/index/feature bytes, counts and SHA-256 digests are saved. Each
  image has source, mesh and camera identity, dimensions and a PNG digest.
- The SFCC adapter retains raw `ok`, unrounded conversion timing, actual worker
  count, normalized tuning, serialized scene and actual sampled-bounds cube.
  Console text is not the measurement API.
- Original meshing settings and tolerances are unchanged, and simplification is
  disabled. The display-only flat-normal vertex-duplication pass is explicitly
  bypassed only for raw artifact storage to preserve original SFCC vertex/feature
  identities. A separate display copy applies the production flat face normals;
  image metadata records that mode without changing the stored geometry.
- The regular PNG render endpoint remains available. Structured acceptance
  operations use the dedicated agent server and the same serialized bridge.
- Startup waits for a live server PID and browser readiness. Stale PID files
  remain available for orphan-browser cleanup until the new server replaces them.
- The image wrapper accepts a successful low-SSIM result with exit 1, allowing
  poor matches to retain their metrics and diff PNGs.
- Export/capture watchdogs operate outside the synchronous WASM worker. Partial
  records persist, and timeouts are distinct from harness/infrastructure failures.

## Validation

Application `make build` passed. Seven focused harness tests passed, covering
session retention, blocked RPC timeout, artifact hashing, duplicate/stale export
rejection, verdict honesty and the five-model view manifest. Seven existing
actual-WASM validation tests passed. The final five-case run exited 0 with the
four FAIL / one TIMEOUT acceptance outcomes above.

An independent artifact check verified source/scene/mesh/PNG/camera hashes,
triangle counts against saved buffers and SFCC stats, equal 1200×1000 dimensions,
all 16 matched view triplets, and every report link. See the
[validation record](../../.testresults/sdf-meshing/milestone1-final-2026-10-23/validation.json)
for log hashes and exact checks.

The Make target and its documentation were added at the user's request while
the final capture was running. Their capture-start snapshots are retained in
the report's provenance directory. All other recorded source hashes and the
WASM artifact match the captured run. The target's `.PHONY` declaration,
build dependency and full-run recipe were checked with a Make dry run; the
measured run used that same runner after a successful application build.

No meshing algorithm was changed. Visual interpretation remains manual.
Independent full-surface coverage, calibrated image thresholds, foreground
masks, feature witnesses for every model, repeated timing and stress matrices
remain later milestones. The existing failed mesh diagnostics are now visible
in one reproducible report; this milestone does not resolve their causes.
