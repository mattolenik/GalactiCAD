---
name: sdf-mesh-diff
description: "Image similarity comparison via @blazediff/cli. Use to compare an SDF render against its mesh render (mesh quality vs source SDF), or two mesh renders against each other (regressions, quality jumps). Reports a similarity percentage; ≥99% near-perfect, ≥98% acceptable, ~95% closer, ~90% decent-with-artifacts, much lower indicates serious mesh problems."
---

# SDF / mesh image similarity diff

Use `@blazediff/cli` to get a percentage similarity between two PNGs. Common uses:

- **SDF vs mesh:** does the mesh render match the SDF (correctness / quality of mesh generation).
- **Mesh vs mesh:** detect regressions or measure quality jumps between mesh-pipeline iterations.

## How to run

```sh
npx @blazediff/cli hitchhikers-ssim <path/to/image1.png> <path/to/image2.png>
```

Parse the output for the line:

```
similarity: <percentage>
```

Example:

```sh
npx @blazediff/cli hitchhikers-ssim a.png b.png | grep -E '^similarity:'
```

## Interpreting the score

| Similarity | Meaning                                                     |
| ---------- | ----------------------------------------------------------- |
| 100%       | Fully identical images.                                     |
| ≥ 99%      | Near-perfect match — very likely correct.                   |
| ≥ 98%      | Acceptable deviation from correct, possibly good enough.    |
| ~95%       | Getting closer; meaningful improvement but not yet a match. |
| ~90%       | Decent but with visible artifacts.                          |
| < 90%      | Serious mesh-generation problems likely.                    |

The score is not a perfect proxy for correctness, but a large jump in similarity is a strong signal that fidelity improved and warrants a closer look. If the user gives a target percentage, treat that as the pass threshold instead of the defaults above.

## Typical workflow

1. Render the SDF reference and the mesh under test to PNGs (use existing render tooling — see the `devserver` skill for `/_agent/render`). Save into `.agents/testimages/` if you are writing them yourself.
2. Run `npx @blazediff/cli hitchhikers-ssim <sdf.png> <mesh.png>`.
3. Report the similarity percentage and what it implies (correct / regression / progress / artifacts).
4. For comparing two mesh runs across a change, render before and after with the same camera/testcase, then diff the two mesh PNGs.
