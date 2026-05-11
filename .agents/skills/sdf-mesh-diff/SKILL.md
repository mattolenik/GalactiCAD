---
name: sdf-mesh-diff
description: "Image similarity comparison for SDF/mesh renders. Use `scripts/agentcli compare` (SSIM + pixel diff together — either alone is misleading), `agentcli triangle` (mesh vs SDF reference), or `agentcli regress` (batch compare). Falls back to `npx @blazediff/cli` for raw access. Similarity ≥99% near-perfect, ≥98% acceptable, ~95% closer, ~90% decent-with-artifacts, much lower indicates serious mesh problems."
---

# SDF / mesh image similarity diff

Compare PNGs from the agent devserver. Two complementary metrics matter:

- **SSIM** — structural similarity score (0–100%). Sensitive to small structural shifts.
- **Pixel diff** — count of pixels that changed + the percent of total. Sensitive to amplitude.

**Always use both.** SSIM alone fooled me in real work: a 96.99% SSIM "regression" turned out to be 0.05% pixel diff (1614 / 3.2M pixels) — i.e. nothing meaningful changed, just structural shift noise. Pixel-diff alone misses how *far* changed pixels moved.

`scripts/agentcli compare` reports both in one go and writes a diff PNG. **Prefer it over the raw `npx` calls** unless you need a flag the CLI doesn't expose.

## Common uses

- **SDF vs mesh:** does the mesh render match the SDF (correctness of mesh generation).
- **Mesh vs mesh (before/after):** detect regressions or measure quality jumps between mesh-pipeline iterations.

## Quickstart with `agentcli`

### One-off compare

```sh
scripts/agentcli compare a.png b.png
# ssim:        96.99%
# pixel diff:  1614 / 3188640  (0.05%)
# diff PNG:    /var/folders/.../mdiff.XXXXXX.png
# verdict:     CHANGED   (threshold 99%)
```

Exit code: 0 if SSIM ≥ threshold (default 99%), 1 otherwise. Diff PNG is **always** generated — open it; visual inspection beats numbers.

```sh
scripts/agentcli compare a.png b.png --diff-png /tmp/mydiff.png --threshold 95
```

### "Did my change move closer to the SDF reference?"

```sh
# After making a change:
scripts/agentcli triangle meshing/twisted-l-500 --tag post --baseline-tag baseline
# ssim mesh-vs-sdf  post:         89.24%
# ssim mesh-vs-sdf  baseline:     89.25%
# delta vs baseline: -0.01%
```

This is the comparison shape that catches "feels better visually but actually regressed". The `triangle` command renders both the SDF and the mesh fresh, then compares each tagged mesh to the SDF reference.

### Batch regression check across testcases

```sh
# 1. Capture baselines (before your change):
scripts/agentcli sweep meshing/twisted-l-500 meshing/polygon-twisted --tag baseline

# 2. Make code changes, then capture posts:
scripts/agentcli sweep meshing/twisted-l-500 meshing/polygon-twisted --tag post

# 3. Compare:
scripts/agentcli regress meshing/twisted-l-500 meshing/polygon-twisted \
    --baseline-tag baseline --post-tag post
# testcase                      ssim      pixels  verdict
# twisted-l-500               96.99%        1614  CHANGED
# polygon-twisted            100.00%           0  UNCHANGED
# 1 unchanged, 1 changed.   threshold = 99%
```

Exit code: 0 if all testcases passed threshold, 1 otherwise. Diff PNGs land next to the input files in `.agents/testimages/`.

## Interpreting the score

| Similarity | Meaning                                                     |
| ---------- | ----------------------------------------------------------- |
| 100%       | Fully identical images.                                     |
| ≥ 99%      | Near-perfect match — very likely correct.                   |
| ≥ 98%      | Acceptable deviation from correct, possibly good enough.    |
| ~95%       | Getting closer; meaningful improvement but not yet a match. |
| ~90%       | Decent but with visible artifacts.                          |
| < 90%      | Serious mesh-generation problems likely.                    |

The score is not a perfect proxy for correctness, but a large jump is a strong signal that fidelity changed and warrants a closer look. **Always cross-check with the pixel-diff count and the diff PNG** — a small structural shift can drop SSIM substantially without anything user-visible actually moving. If the user gives a target percentage, treat that as the pass threshold instead of the defaults above.

## What `agentcli` is doing under the hood

`agentcli compare` runs both blazediff modes and parses their output:

```sh
# SSIM (numeric similarity, always exits 0):
npx @blazediff/cli hitchhikers-ssim a.png b.png | grep -E '^similarity:'

# Pixel diff + diff PNG (exits 0 if identical, 1 if any pixel differs, 2+ on real error):
npx @blazediff/cli core-native a.png b.png diff.png
```

**Footgun if you call blazediff directly:** `core-native` exits with code 1 when the images differ, not just on real errors. A naive `if ! npx ...; then fail; fi` will treat every legitimate "they're different" run as an error. The `agentcli compare` wrapper handles this — `0` and `1` are both treated as success, only `2+` is a real failure.

## Typical workflow

1. **Render** the SDF reference and the mesh under test (`agentcli render` / `agentcli sweep`, or use the `devserver` skill for raw endpoint access).
2. **Compare** with `agentcli compare` (single pair) or `agentcli regress` (batch). Read both numbers; open the diff PNG.
3. **Report** what changed and what the score implies. Cite both SSIM and pixel-diff together — never just one.
4. **For triangle / "is the mesh faithful to the SDF" checks** use `agentcli triangle` instead of comparing two mesh PNGs.
