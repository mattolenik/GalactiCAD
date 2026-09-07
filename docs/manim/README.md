# SFCC explanation animation

The [animation source](sfcc_illustration.py) accompanies the [implementation explanation](../sfcc-meshing-algorithm.md). Its captions describe the September 7, 2026 implementation, including displaced field branches, raw differential composition, local feature graphs, bounded triangle refinement and known completeness gaps.

The 2D drawings are schematic slices and simplified contouring examples, not recordings of the kernel's internal decisions. In particular, a point in a slice can depict a 3D crease; it does not establish that the 3D feature is a corner. The Python field helpers construct these illustrations; the exporter does not call them.

The 3D PNGs come from the application scenes in [scenes/](scenes/). They show saved SDF, solid mesh and wireframe outputs, not a completeness certificate. See the [feature-preservation results](../plans/sfcc-feature-preservation-results.md) for the implementation revision, validation and asset regeneration record. Historical triangle counts were removed because counts and validation results must come from the actual export being discussed.

## Reproduction

Run from the repository root, with the Manim environment at `docs/.venv-manim`:

```sh
# Rebuild the video using existing PNGs; no application rendering.
make -C docs/manim sfcc-illustration.mp4

# Regenerate all scene variants and crops (shell-only target).
make -C docs/manim pngs

# Regenerate PNGs and then render the full video.
make -C docs/manim all
```

The PNG target requires the app/agent devserver dependencies and ImageMagick. It stages the complete set before replacing assets. The video target writes `sfcc-illustration.mp4`; Manim caches intermediate animation clips under `media/`. Pass `NOCACHE=1` to bypass clip caching. Video rendering checks execution, not caption layout or visual fidelity; visual QA remains manual.

The [feature-preservation results](../plans/sfcc-feature-preservation-results.md) document what the regression tests establish and what remains open. In particular, stairs/columns region coverage, general nested region transitions, GPU normal composition and complete analytical-curve-to-mesh-chain correspondence remain limited. Recorded curve intervals now survive refinement and worker transport, and the compiled-chain audit reports remaining gaps explicitly.
