# OpenSCAD → gcad Importer: Feasibility & Effort

*A feasibility and phased-effort assessment for an importer that converts OpenSCAD
`.scad` files into gcad's native SDF scene. Fuses a web deep-research run on the
OpenSCAD side with a codebase exploration of the gcad import target. Decision-oriented:
build/skip + phasing for the engineer who owns gcad.*

**Status:** research note / feasibility · **Date:** 2026-06-15 · **Branch:** `openscad-conv`

---

## Provenance

Two independent investigations, fused:

1. **OpenSCAD side — fan-out deep-research run.** 6 search angles, 20 primary sources
   fetched, 96 claims extracted, 25 adversarially verified by 3-vote panels (2/3 needed
   to kill a claim) — **20 confirmed, 5 killed**, 8 findings after dedup synthesis
   (103 agent calls total). Sources concentrate on three primary pillars: the official
   OpenSCAD User Manual / wiki / cheatsheet (authoritative, stable), Inigo Quilez's SDF
   distance-functions reference (de-facto canonical), and Curv's F-Rep design docs (Doug
   Moen — a real production F-Rep CAD tool, but describing *one* system's choices and
   partly aspirational "Future Work"). The 5 killed claims are recorded as **Guardrails**.

2. **gcad side — codebase exploration** of `/Users/matt/galacticad2`, mapping the import
   *target* (format, primitive/operator vocabulary, compile pipeline, existing work on
   `openscad-conv`).

Points marked *(engineering judgment)* — notably all calendar estimates — are
extrapolations grounded in the gcad codebase, **not** literature claims. The feasibility
verdict and the clean→hard boundary are sourced; the week/month numbers are not.

---

## 0. Bottom line

**BUILD it, phased, as a self-contained TypeScript importer** — `openscad-parser` (MIT) for
the AST + our own evaluator + mapper; no openscad-wasm, no `.csg`, no GPL at runtime. The
procedural-language half of OpenSCAD (variables, functions, modules, `for`/`if`, list
comprehensions, recursion) is a *solved-by-static-evaluation* problem — tractable because
OpenSCAD is functional, but the evaluator is work *we* own (parsing is handed to the
dependency). The genuinely hard part is a small, well-bounded set of operations where
OpenSCAD's mesh/CSG worldview doesn't fit gcad's SDF worldview — and those degrade
gracefully (skip with a clear diagnostic) rather than blocking the whole importer.

A useful importer covering the bulk of simple parametric models is **~5–7 weeks of focused
work** *(engineering judgment)*. Parsing is free (the dependency) and the SDF mapping is
mostly direct —
gcad already owns nearly every primitive the importer emits into, including
`extrude`/`lathe`/`offset`/`polygon2d` for OpenSCAD's 2D-extrusion family — so the
**OpenSCAD evaluator is the dominant cost**.

---

## 1. It's an in-memory import, not a pipeline

"Import OpenSCAD" is a single on-demand action, identical in shape to any other gcad
document creation: read the `.scad` text → convert **in memory** → open a **new untitled
document** holding gcad DSL source → the user saves it as `.gcad` like everything else.
There is no persistent intermediate file and no standing pipeline. `.csg` (below) is at
most an **in-memory string**, never written to disk.

The conversion has exactly two responsibilities:

1. **Evaluate** the OpenSCAD program — resolve variables, expand modules/functions, unroll
   `for`/`if`/comprehensions/recursion — down to a flat tree of literal geometry +
   transforms. OpenSCAD is functional (immutable compile-time variables, pure
   expression-functions, action-modules), so this is *static evaluation*, not interpreting
   mutable runtime state. [OpenSCAD manual]
2. **Map** that flat tree to gcad's primitive/operator vocabulary and **emit gcad DSL
   text** — which reuses gcad's entire existing stack (Monaco editor, source-parser,
   transpile → build → WGSL → mesh). The importer is a text-producing function; everything
   downstream is already built.

### Decision: self-contained TS build; openscad-wasm kept only as a test-time image oracle

The importer has **zero runtime and zero grammar dependency** on OpenSCAD: we evaluate the
language ourselves (so no GPL openscad-wasm in the product), and `openscad-parser` *is* the
parser (so the old "openscad-wasm as a grammar reference for hand-writing a parser" role is
moot — dropped).

We **do keep openscad-wasm for one thing: a dev/test geometry oracle** — render a `.scad`
in OpenSCAD, render our imported `.gcad`, and image-compare (gcad already has the SSIM /
pixel-diff tooling for exactly this). `openscad-parser` can't fill this role — it never
evaluates geometry. The oracle runs only in tests; it never ships.

So the import is a **self-contained TS build**: parse `.scad` to AST (via the
`openscad-parser` dependency) → statically evaluate → map → emit `.gcad` text. No wasm, no
`.csg` at runtime, no GPL. The work splits very unevenly:

| Stage | Difficulty | Notes |
|---|---|---|
| Parse `.scad` → AST | **~free** | `openscad-parser` (MIT) — see below; we write none of this |
| Static **evaluate** (modules, functions, scoping, `$fn`, `for`/`if`, comprehensions, recursion unroll) | **High** | The bulk of the effort and the bug surface |
| Map flat tree → gcad nodes + emit text | **Medium** | §2–§3; the SDF paradigm gap lives here |

With parsing handed off, **the evaluator is essentially all there is to build** (plus the
mapper). Don't let the easy stage distract from it.

### Parser: depend on `openscad-parser` (MIT) — decided

We use **`alufers/openscad-parser`** (npm `openscad-parser`, MIT, ~0.6.3/2024) as a
dependency and write no parser of our own. Its `parse()` returns a full AST rooted at
`ScadFile`, and its `ASTVisitor` exposes ~33 visit methods covering the entire construct
set — module/function declarations, instantiations, `if`/`else`, assignments,
binary/unary/ternary/call/vector/range/`let`/lookup expressions, and all the
list-comprehension nodes (`lcFor`/`lcEach`/`lcIf`/`lcLet`/`lcForC`). That is exactly the walk
surface the evaluator needs. It is deliberately **syntax-only** (no evaluation) — perfect,
since evaluation is ours to own.

Bonus the owner called out: it gives **real parse-error reporting for free** (`line:col`
diagnostics), which is genuinely useful while developing the evaluator/mapper against messy
real-world `.scad`.

Caveats: it's a small/niche project (~18 stars) — but MIT means we can **vendor or fork** it
if maintenance lapses, with no relicensing friction. Before leaning on it hard, smoke-test
its AST against a few feature-heavy `.scad` files (deep comprehensions, recursion,
`$`-variables) to confirm coverage.

**The catch (independent of parser choice):** the evaluated tree is **not** pure
primitives+booleans — high-level nodes (`hull`, `minkowski`, `linear_extrude`,
`rotate_extrude`, `polyhedron`, `import`, `projection`, `surface`) survive evaluation. The
*language* gap closes here; the *geometry-paradigm* gap (§3) lands on the mapper. (See
Guardrail G1.)

---

## 2. What maps cleanly (the easy, exact core)

OpenSCAD's CSG core has exact closed-form SDF equivalents, and gcad already has all of
them. Inigo Quilez's reference labels sphere/box/rounded-box/cylinder/cone/torus/plane as
"exact and true SDFs." PySdfScad already demonstrates the OpenSCAD-primitive→SDF mapping
end-to-end.

| OpenSCAD | gcad target | Notes |
|---|---|---|
| `cube` / `sphere` / `cylinder` / `cone` | `box` / `sphere` / `cylinder` / `cone` | Exact SDFs |
| `union` / `difference` / `intersection` | `union` / `subtract` / `intersect` *(no blend radius)* | **Sharp booleans map 1:1.** OpenSCAD has no smooth-blend concept, so emit plain min/max — exactly the *exact-field* case. The "smooth blend is only approximate / non-associative" caveat does **not** bite on import, because OpenSCAD never asks for one. |
| `translate` / `rotate` / `scale` / `mirror` / `multmatrix` | `.shift` / `rotate` / `scale` / general affine | gcad `Rotate` is Euler-degrees; decompose `multmatrix` or apply a general affine at the node |
| `color` | (drop) | No SDF effect |

**The one asterisk:** SDF subtraction/intersection produce a distance *bound*, not an exact
interior field — the zero-isosurface (geometry) is correct, but true-distance reads away
from the surface degrade. gcad's engine already lives with this; it is not import-specific.
(See Guardrails G2/G4: the boolean+transform set is *not* a trivial clean 1:1 — this
asterisk is why.)

---

## 3. What's hard or impossible (a gradient, not a checklist)

The research explicitly **refuted** the tidy idea that the hard ops are a fixed enumerable
list (Guardrail G3). Treat this as a difficulty gradient:

- **`polyhedron` + `import(STL/OFF/…)` — the real wall.** Arbitrary triangle soup has no
  clean closed-form SDF; the *sign* is mathematically ill-defined for the
  non-manifold/self-intersecting meshes typical of real models (Xu & Barbic, USC, GI 2014).
  The only path is a **lossy sampled voxel / 3D-texture SDF** via a separate mesh-to-SDF
  pass (BVH/winding-number/offset-manifold methods). **gcad has no such primitive today** —
  this is net-new engine work, not mapping. Curv's design doc is blunt: "meshes are
  probably the worst possible representation for getting geometric data into Curv."

- **`hull()` and `minkowski()` — defer / approximate / skip.** Curv (production F-Rep CAD)
  characterizes both as "difficult/expensive to implement in F-Rep" — global combinatorial
  ops that mismatch local field evaluation. **But the dominant special case is cheap:**
  `minkowski(sphere)` rounding == SDF offset/round, which gcad's native `.round(r)` can
  absorb (see §4, Phase 2.5).

- **2D-derived ops — Phase 2, and gcad is well-positioned.** `linear_extrude` /
  `rotate_extrude` / `offset` / `text` / `projection` need 2D-SDF + extrusion infra. **gcad
  already has `polygon2d`, `extrude` (with `.twist`), `loft`, `lathe`, and `offset`** — so
  `linear_extrude → extrude`, `rotate_extrude → lathe`, `offset(r) → offset` are mostly
  mapping, not new engine work. Only `text()` (needs font→outline→2D-SDF) and
  `projection()` are genuinely missing. Note: OpenSCAD's `offset` picks rounded(`r`) vs
  sharp(`delta`/`chamfer`) by an **explicit user flag** — honor that flag by selecting the
  SDF field behavior; don't infer it.

---

## 4. Phased effort *(engineering judgment — not sourced)*

Estimates assume a strong solo dev fluent in this codebase, leveraging existing gcad infra.

| Phase | Scope | Real-world coverage | Effort |
|---|---|---|---|
| **0 — Integrate parser** | `npm i openscad-parser`; wire `parse()` → AST; AST-coverage smoke test on feature-heavy `.scad`; stand up the openscad-wasm image-comparison oracle (test-only) | — | ~2–3 days |
| **1 — Evaluator + CSG core** | Static eval: variables, expressions, modules (+`children`), functions, `for`/`if`, `$fn`, recursion unroll. Map cube/sphere/cylinder/cone + transforms + union/difference/intersection; drop `color`. Emit `.gcad` text. **The dominant phase.** | High for simple parametric parts (boxes, brackets, spacers, enclosures) | 2–4 weeks |
| **2 — 2D + extrusion + comprehensions** | List comprehensions in the evaluator; square/circle/polygon → `polygon2d`; `linear_extrude`(+twist) → `extrude`; `rotate_extrude` → `lathe`; `offset(r)` → `offset` | Most functional/printed parts | 1–2 weeks |
| **2.5 — Idiom recognition** *(optional, high ROI)* | Detect `hull(spheres-at-corners)` / `minkowski(sphere)` → gcad native `.round(r)` | Unlocks `.round(r)` for common rounding idioms | ~1 week |
| **3 — Mesh wall** | `polyhedron`/`import` via **new** voxel mesh-to-SDF primitive; general `hull`/`minkowski` | The long tail | Weeks–months (separate project) — or **skip with a clear "unsupported" diagnostic** |

**A useful importer = Phase 0+1+2 ≈ 5–7 weeks**, the evaluator (Phase 1) dominating now that
parsing is a dependency. Phase 3 is a different beast (new engine primitive + sampling
pipeline) and deserves its own go/no-go.

---

## 5. Open decisions / questions

**Resolved:** *Architecture* — self-contained TS import (in-memory, produces a new `.gcad`
doc). *Parser* — depend on `openscad-parser` (MIT); no parser of our own. *openscad-wasm* —
kept only as a dev/test image-comparison oracle (no grammar/runtime role); never shipped.
Remaining open items:

1. **Failure mode for unsupported nodes.** Decide now: skip-with-warning, placeholder
   bounding box, or hard-fail. A loud, specific diagnostic ("`minkowski` at line N
   unsupported") beats silent wrong geometry.
2. **Coverage data gap (de-risks the whole ROI).** Neither investigation produced hard
   numbers on how often real `.scad` files need polyhedron/hull/minkowski vs. the Phase-1
   core. A ~1-day measurement pass over a Thingiverse `.scad` sample (HuggingFace
   `redcathode/thingiverse-openscad` dataset exists; OpenSCAD also ships
   `statistics-scripts`) would quantify Phase-1 coverage before committing to Phases 2–3.
3. **Phase-3 mesh-to-SDF method**, *if* pursued: offset-manifold signing (Xu–Barbic),
   winding-number BVH, or precomputed voxel/KTX 3D-texture — and the grid-resolution /
   memory budget that gives acceptable fidelity in gcad's runtime.

---

## 6. Guardrails — claims the verifiers KILLED (do not act on these)

- ✗ **G1 — "`.csg` bakes all transforms into one `multmatrix` 4×4 node."** Killed 1–2.
  `.csg` *preserves* `group()` and named-ish structure and, crucially, high-level nodes
  (`hull`, `minkowski`, `linear_extrude`, `polyhedron`, …). Plan for those surviving nodes.
- ✗ **G2 — "OpenSCAD's boolean+transform set is a clean trivial 1:1 to SDF."** Killed 0–3.
  Geometry maps; *interior distance fields* of difference/intersection are bounds, not
  exact. True 1:1 only at the zero-isosurface.
- ✗ **G3 — "The hard ops are a fixed enumerable list (offset/hull/minkowski/extrude/…)."**
  Killed 0–3. It's a difficulty gradient, not a checklist — judge each node by whether it
  needs global combinatorics or sampled fields, not by membership in a list.
- ✗ **G4 — "union=min, difference=max(-a,b), intersection=max(a,b) — booleans solved."**
  Killed 1–2. The *formulas* are right for the surface; they do not yield exact distance
  fields, and don't capture blends. Don't treat the boolean half as "done."
- ✗ **G5 — "exact/mitred/approximate field taxonomy is THE core constraint."** Killed 1–2.
  Real but overstated as the *core* constraint; for *import* it mostly matters only when
  honoring OpenSCAD's `offset` rounded-vs-sharp flag.

---

## 7. Sources (verified, primary)

- OpenSCAD User Manual — The OpenSCAD Language; User-Defined Functions and Modules; List
  Comprehensions — `en.wikibooks.org/wiki/OpenSCAD_User_Manual/*`
- OpenSCAD wiki — CSG File Format — `github.com/openscad/openscad/wiki/CSG-File-Format`
- OpenSCAD cheatsheet — `openscad.org/cheatsheet/`
- openscad-wasm — `github.com/openscad/openscad-wasm`; tree-sitter-openscad —
  `github.com/openscad/tree-sitter-openscad`
- openscad-parser (TS) — `npmjs.com/package/openscad-parser`, `github.com/alufers/openscad-parser`
- Inigo Quilez — Distance Functions — `iquilezles.org/articles/distfunctions/`
- Curv design docs — Future_Work.rst; Distance_Field_Operations.rst —
  `github.com/curv3d/curv/blob/master/docs/shapes/`
- Xu & Barbic — Signed Distance Fields from triangle meshes —
  `viterbi-web.usc.edu/~jbarbic/signedDistanceField/`
- hob3l (SCAD flattening notes) — `github.com/moehriegitt/hob3l`
- PySdfScad (OpenSCAD→fogleman/sdf) — `github.com/traverseda/PySdfScad`
- Thingiverse OpenSCAD corpus — `huggingface.co/datasets/redcathode/thingiverse-openscad`;
  OpenSCAD `statistics-scripts` — `github.com/openscad/statistics-scripts`

## Appendix — gcad import target (from codebase exploration)

- **Format:** `.gcad` = TS/JS fluent-API DSL text. Authored in Monaco; transpiled →
  executed → builds a `Node` tree → compiled to WGSL SDF → meshed.
  Key paths: `src/scene/cad-types-decl.mts` (DSL API surface), `src/scene/base.mts` +
  `src/scene/scene.mts` (Node/SceneInfo), `src/cad-transpile.mts`,
  `src/render-worker.mts` (execute), `src/fs/file-picker.mts` (`.gcad` I/O).
- **Primitives:** sphere, box, cylinder, cone, torus, capsule, hexPrism, disc, blob, plane,
  threadedRod, polygon2d. **Booleans:** union/subtract/intersect (+ blend modes
  round/chamfer/soft/stairs/columns), pipe, seam, morph, engrave/groove/tongue, knurl.
  **Transforms:** translate/rotate/scale, repeatPolar. **Modifiers:** shell, offset,
  elongate, twist, bend, taper. **2D→3D:** extrude (+twist), loft, lathe.
- **No `hull` / `minkowski`** primitive exists — the §3 wall.
- **Emit target = source text** (§1): import produces a new in-memory document, saved as
  `.gcad` like any other; reuses the full editor/compile stack.
- **`openscad-conv` branch:** placeholder at time of writing — no parser/import logic in the
  working tree.
