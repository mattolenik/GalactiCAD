# Manim torture-model acceptance inventory

Milestone 1 implements the first three steps of the
[acceptance plan](../../../docs/plans/sdf-meshing-acceptance-suite.md).
It exports the five original scenes once each, then renders the retained mesh
and GPU SDF from four fixed cameras. It does not claim full geometric acceptance.

From the repository root:

```sh
make acceptance-tests
```

This `.PHONY` target builds the application, then runs all five cases and writes
the Markdown report. For subsets or strict exit status, use the runner directly
after `make build`: `node --import tsx scripts/sdf-meshing-acceptance.mts --help`.

The runner starts/refreshes the dedicated agent devserver with `scripts/agentcli`.
It requires the existing Chromium/WebGPU setup, ImageMagick, and project
dependencies (including the blazediff CLI). It does not use the interactive
browser. Run after builds/tests finish if timing matters.

Options: `--out .testresults/sdf-meshing/UNIQUE-RUN`, `--case bracket` (also
housing, knob, mess1, mess2), and `--strict`. Existing run directories are never
overwritten. Exit 0 means the report completed, 2 means a harness/infrastructure
failure, and strict mode returns 1 for unaccepted meshes. A row can contain a
mesher failure while the report itself completes successfully.

Read `report.md` in the output directory. Copy the whole directory to preserve
its image links. JSON records contain effective settings, world cube, source and
mesh hashes, raw SFCC diagnostics, image identities and hardware information.
Every image has a metadata sidecar. The server binds a capture to one browser;
a different tab becoming ready cannot steal its artifact.

The configuration uses production SFCC geometry settings and no simplification.
The raw artifact bypasses the `renormalizeTriangles` post-pass because it
duplicates vertices while retaining old feature-edge indices. Images render a
separate `flatFaceNormals` copy, matching the production viewer and historical
Manim shading. Every triangle corner remains at exactly the same position;
the original indexed mesh and feature identities remain untouched. Image
metadata records the normal mode. The first inventory's direct interpolation of
raw normals was a display regression and must not be used as a like-for-like
comparison with earlier Manim images.

Timings are single samples. Export wall time excludes image generation, audits,
and build/transfer overhead; the latter is recorded separately. No high-SSIM
threshold is used to declare a mesh correct. Concrete SFCC failures stay `FAIL`;
otherwise the first inventory remains `INCOMPLETE` until independent coverage
checks and human review exist. `outsideScope` is not itself a failure.

The full runner has external export/capture timeouts and a run budget. A timed-out
WASM worker is cleared by restarting the isolated agent context, rather than
silently retrying the export at lower quality. Earlier completed artifacts remain.

Focused harness checks:

```sh
node --import tsx --test test/acceptance/sdf-meshing/*_test.mts
```

These test verdict honesty, artifact identity, duplicate-export rejection,
cross-tab session retention, and server-side timeout behavior. Later milestones
add independent feature/coverage checks, calibrated visual thresholds, repeated
timings, transform/worker/configuration matrices and baseline comparisons.
Visual interpretation remains manual.

## Detailed diagnostics and saved-run analysis

New captures also run an exact zero-area audit on the stored float32 geometry,
list defective triangle IDs/coordinates, inspect feature-chain connectivity,
and test physical edge coverage for axis-aligned gap endpoint segments. A
diagnostic exact-position weld/drop experiment is reported separately; it does
not modify the exported mesh. The full bracket has a source-pinned dent/rib
junction witness measured against every valid output triangle. Source changes
require a new reference rather than silently retaining stale expectations.

To enrich an existing run without exporting or rendering again:

```sh
node --import tsx scripts/sdf-meshing-diagnostics.mts \
  .testresults/sdf-meshing/INPUT_RUN .testresults/sdf-meshing/NEW_RUN
```

The Markdown report separates visual agreement, topology, triangle validity,
feature labeling, refinement uncertainty and geometric witnesses. Per-case
sections retain every existing failure counter, phase timings, curve issue
range, settings, and links to the full defect records. A hypothetical welded
edge-incidence result is not a manifoldness or repair certificate.

For opt-in investigation of a saved bracket/housing case, the native example
`gcad-wasm/kernel/examples/sfcc_failure_diagnosis.rs` uses the existing profiling
observer and checks the saved settings against its supported defaults. Its
results are explicitly labeled native; it checks whether its geometry matches
the saved WASM mesh before any attribution is interpreted. See the
[bracket/housing investigation](../../../docs/research/sfcc-bracket-housing-investigation.md)
for findings and the exact scope of the additional WASM checks.

## Independent regional GPU checks

`make acceptance-tests` also runs source-pinned GPU sign-bracket scans for the
bracket junction and housing loft/flange/internal-bore regions. The original
surface/feature budgets remain 0.01/0.02 mm. Each applicable case writes
`gpu-coverage.json` (root brackets, GPU normals, triangle queries, residuals,
projection ambiguities and crease evidence) and `gpu-corruptions.json`
(reproducible damage to copies of the captured mesh). These checks do not certify
global coverage or turn unresolved exports into accepted meshes. They do not
use the SFCC CPU/native field as their reference.

Offline regression tests include the checked-in GPU bracket counterexample;
they need no ignored historical run directories. Run the focused harness tests
with `node --import tsx --test test/acceptance/sdf-meshing/*test.mts` after the
normal application build. See the
[measurement definitions and limits](../../../docs/research/sfcc-gpu-regional-coverage.md).
