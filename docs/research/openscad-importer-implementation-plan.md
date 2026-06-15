# OpenSCAD → gcad Importer: Implementation Plan

*Concrete build plan for the importer scoped in
[`openscad-importer-feasibility.md`](./openscad-importer-feasibility.md). Grounded in the
actual gcad DSL surface, the document/import wiring, and the `openscad-parser` AST. Read the
feasibility note first for the build/skip rationale and the SDF paradigm boundary.*

**Status:** implementation plan · **Date:** 2026-06-15 · **Branch:** `openscad-conv`

---

## 0. Shape of the thing

"Import OpenSCAD" is an in-memory, on-demand command: pick a `.scad` file → convert → open
the result as a **new untitled document** (Monaco model, `language: "typescript"`) that the
user saves as `.gcad` like any other. No persistent intermediate, no OpenSCAD engine at
runtime. The converter is a pure function:

```
scadText ──▶ parse ──▶ evaluate ──▶ GeomIR ──▶ emit ──▶ { dsl: string, diagnostics: Diagnostic[] }
            (dep)      (ours)       (ours)     (ours)
```

- **parse** — `openscad-parser` (npm, MIT). We write none of it.
- **evaluate** — a static evaluator (the bulk of the work): runs OpenSCAD's functional
  language to a flat geometry tree. Two mutually-recursive halves — `evalExpr → Value` and
  `evalGeom → GeomNode[]`.
- **GeomIR** — our intermediate geometry tree (primitives, transforms, booleans, 2D,
  extrusions, and `Unsupported` markers). The seam where idiom-recognition and diagnostics
  live.
- **emit** — codegen from GeomIR to gcad DSL text + a diagnostics list.

Separating GeomIR from both evaluation and emission is the key structural choice: it lets us
test eval and emit independently, run idiom passes over a stable tree, and attach
source-located diagnostics for everything we can't map.

---

## 1. Module layout

Mirror the `src/export/sfcc/` convention (flat `.mts` files, `*_test.mts` tests, `node:test`,
no `index.mts` needed):

```
src/import/openscad/
├── convert.mts            # public entry: convertOpenScadToGcad(src) → {dsl, diagnostics}
├── values.mts             # Value model + OpenSCAD numeric/list semantics + operators
├── builtins-fn.mts        # built-in FUNCTIONS (sin/cos/sqrt/len/concat/…) → Value
├── eval-expr.mts          # expression evaluator (ASTVisitor<Value>)
├── eval-geom.mts          # geometry evaluator (statement dispatch by .name)
├── scope.mts              # lexical scope + $-var dynamic scope + recursion guards
├── geom-ir.mts            # GeomNode types
├── builtins-mod.mts       # built-in MODULES → GeomNode (cube/translate/union/…)
├── transforms.mts         # OpenSCAD transform args → gcad transform (the hard bits)
├── emit.mts               # GeomIR → gcad DSL text (the emit cheat-sheet, §6)
├── idioms.mts             # Phase 2.5 idiom recognition (hull-of-spheres → round, …)
├── diagnostics.mts        # Diagnostic type + collector (line:col from node.span +1)
└── *_test.mts             # unit tests + golden image-comparison tests
```

UI/integration lives outside this dir (§7).

---

## 2. Parser integration  *(Phase 0)*

`openscad-parser` 0.6.3 (MIT, zero runtime deps, ships `.d.ts`). Add to `package.json`
`dependencies`, `pnpm install`; esbuild bundles it on import. Entry:

```ts
import { CodeFile, ParsingHelper } from "openscad-parser"
const [ast, errors] = ParsingHelper.parseFile(new CodeFile("/import.scad", src))
if (errors.hasErrors()) { /* surface CodeError[].codeLocation + .message */ }
```

Facts that shape the evaluator (verified against source):

- **Root** `ScadFile { statements: Statement[] }`. Walk `statements`.
- **Only `if` has a dedicated statement node** (`IfElseStatement`). **Everything else module-ish
  is `ModuleInstantiationStmt` keyed by `.name`** — `for`, `intersection_for`, `let`,
  `assign`, all primitives, all transforms, all CSG ops, *and* user-module calls. The
  evaluator's geometry dispatch is a switch on `.name`; unknown name ⇒ user module.
- **Args** are one `AssignmentNode[]`: positional ⇒ `name === ""`, named ⇒ populated `name`;
  `value` is an unevaluated `Expression`.
- **Top-level `x = 5;`** is an `AssignmentNode` (`role = VARIABLE_DECLARATION`) in
  `ScadFile.statements`. Param defaults are `definitionArgs[i].value` (may be `null`).
- **Module body** is `ModuleInstantiationStmt.child` (single `Statement`, usually a
  `BlockStmt` whose `.children` are the real children). There is no `children()` node — the
  `children()` *call* is a `ModuleInstantiationStmt` named `"children"`.
- **Literals**: `LiteralExpr.value` is a JS `number | string | boolean | null`. ⚠️ `undef`
  is `null` (not `undefined`). Vectors ⇒ `VectorExpr.children`; ranges ⇒ `RangeExpr {begin,
  step|null, end}` (unevaluated — we compute the numeric sequence).
- **Operators** are `TokenType` enums on `BinaryOpExpr.operation` / `UnaryOpExpr.operation`
  — switch on `TokenType`, don't string-compare.
- **Comprehensions** have real nodes: `LcForExpr`, `LcForCExpr`, `LcEachExpr`, `LcIfExpr`,
  `LcLetExpr` (distinct from statement-context `for`/`let`/`if`).
- **Positions** are not stored; `node.span` recomputes from tokens. `CodeLocation.line/col`
  are **0-indexed** — add 1 for user-facing diagnostics.
- **Error recovery**: parser returns a best-effort tree with `ErrorNode`s rather than
  throwing; `visitErrorNode` must be handled, and check `errors.hasErrors()` even on a
  non-null tree. The free `line:col` parse diagnostics are a real dev win against messy files.

Visitor: implement `ASTVisitor<Value>` (31 `visit*` methods) for expressions; geometry is a
separate name-dispatch (not the visitor) since statements share `ModuleInstantiationStmt`.

---

## 3. The evaluator  *(Phase 1 — the dominant work)*

### 3.1 Value model (`values.mts`)

```ts
type Value =
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "str"; v: string }
  | { t: "vec"; v: Value[] }            // OpenSCAD lists/vectors are one type
  | { t: "range"; start: number; step: number; end: number }
  | { t: "undef" }
  | { t: "fn"; params: AssignmentNode[]; body: Expression; closure: Scope }  // function literals
```

Implement OpenSCAD's operator semantics (the fiddly parts, all verified to matter):
element-wise `+`/`-` on equal-length vectors; scalar·vector; `*` overloaded (number·number,
number·vector, vector·vector = dot, matrix·vector / matrix·matrix); `==`/`!=` deep; `%`
modulo; `&&`/`||` with OpenSCAD truthiness; `undef` propagation. Indexing `v[i]`,
`MemberLookupExpr` `.x/.y/.z` → 0/1/2.

### 3.2 Built-in functions (`builtins-fn.mts`)

A table `name → (args) => Value`. Minimum viable set: `sin cos tan asin acos atan atan2`
(**degrees**), `abs sign sqrt pow exp ln log floor ceil round`, `min max`, `len concat
lookup`, `str chr ord`, `norm cross`, `is_undef is_num is_list …`, `rands` (seedable). Trig
in degrees is a classic mismatch — get it right or every rotated model is wrong.

### 3.3 Scope & semantics (`scope.mts`)

- **Lexical scope**, `Map<string, Value>` + parent. Module/function bodies get a child scope.
- **Last-assignment-wins within a scope**: pre-scan a block's `AssignmentNode`s before
  evaluating geometry so later `x=` overrides and forward references resolve (OpenSCAD
  binds at compile time, not sequentially).
- **`$`-variables are dynamically scoped** — thread a separate `$`-frame down the call chain
  (`$fn`, `$fa`, `$fs`, `$t`, `$children`, `$preview`). `$t` defaults 0.
- **Recursion guards**: depth caps for function recursion and module recursion; unroll/
  evaluate rather than emit. Cap generously (OpenSCAD allows ~thousands; tail-recursion to
  1e6) but bail with a diagnostic instead of hanging.
- **`use`/`include`**: resolve the referenced file (`CodeFile.load` + re-parse). `include`
  inlines statements; `use` imports only module/function defs. File resolution relative to
  the importing file — for a single-file UI import, missing includes ⇒ diagnostic, continue.

### 3.4 Geometry evaluation (`eval-geom.mts` + `builtins-mod.mts`)

`evalGeom(stmt, scope, $frame): GeomNode[]`. Dispatch:

- **3D primitives** → GeomIR primitive nodes: `cube sphere cylinder` (+`cone` via cylinder
  r1/r2) `polyhedron`.
- **2D primitives** → 2D GeomIR: `square circle polygon` (`text` deferred).
- **Transforms** (recurse into children, wrap): `translate rotate scale mirror multmatrix
  color resize` — see §5.
- **CSG**: `union difference intersection` → boolean GeomIR; `hull minkowski render` →
  `Unsupported` (Phase 1) / idiom-handled (§4 Phase 2.5).
- **2D→3D**: `linear_extrude rotate_extrude offset projection` — see §3.5 (Phase 2).
- **Control**: `for intersection_for` (evaluate range/list, accumulate children),
  `let` (push scope), `if` via `IfElseStatement`, `BlockStmt` (flatten children).
- **`children()`** inside a user module → splice the caller's passed children (track a
  children stack per module call).
- **User modules**: look up `ModuleDeclarationStmt`, bind args (positional + named + defaults)
  into a child scope, bind `$children`, evaluate its body. Inline (no gcad-side modules).
- **`echo assert`** → evaluate for side-effects/diagnostics, emit no geometry.
- **Unknown name** with no matching declaration → `Unsupported` diagnostic.

OpenSCAD's "modules emit geometry, functions return values" split maps exactly onto
`evalGeom` vs `evalExpr`.

### 3.5 2D + extrusion (Phase 2)

`square/circle/polygon` → 2D GeomIR; `linear_extrude(h, twist, …) child` → `Extrude`;
`rotate_extrude` → `Lathe`; `offset(r|delta, chamfer)` → `Offset`. Comprehensions
(`Lc*Expr`) needed here in earnest (polygon point lists are often comprehensions).
`circle` inside `linear_extrude` is the cylinder idiom (§4).

---

## 4. GeomIR & idiom recognition

`geom-ir.mts`:

```ts
type GeomNode =
  | Prim3D   // {kind:"sphere"|"box"|"cylinder"|"cone"|..., params, fn?}
  | Prim2D   // {kind:"circle"|"square"|"polygon", params}
  | Xform     // {kind:"translate"|"rotate"|"scale"|"mirror", arg, child}
  | Bool      // {op:"union"|"subtract"|"intersect", children: GeomNode[]}
  | Extrude | Lathe | Offset | Shell | …
  | Unsupported  // {scadName, reason, span}  → becomes a diagnostic + skipped/commented
```

`$fn` policy: gcad primitives are **smooth SDFs**, so we *intentionally ignore* `$fn` on
`sphere/cylinder/circle` and emit the ideal solid (a fidelity *improvement*, but flag it once
in diagnostics so users aren't surprised faceting disappears). Keep `$fn` on the IR only
where it changes topology we must reproduce.

**Idiom recognition (`idioms.mts`, Phase 2.5)** — passes over GeomIR before emit:
- `minkowski(sphere(r), X)` and `hull()` of corner spheres/cylinders → gcad native
  `.round(r)` on the wrapped solid (the dominant rounding idiom; cheap and high-value).
- `linear_extrude(h) circle(r)` → `cylinder`. `linear_extrude(h) square([...])` → `box`.
Each idiom that fires removes an `Unsupported` and a diagnostic. Log what fired.

---

## 5. Transform translation (`transforms.mts`) — the sharp edge

Because we evaluate the AST (not pre-baked `.csg` matrices), transforms arrive named — good
for readable output, but **gcad has no arbitrary-matrix and no axis-angle transform** (only
`translate([x,y,z], n)`, `rotate([rx,ry,rz], n)` Euler-degrees, `scale([sx,sy,sz], n)`). So:

| OpenSCAD | Strategy |
|---|---|
| `translate([x,y,z])` | direct → `translate([x,y,z], child)` |
| `rotate([x,y,z])` | direct **iff** gcad's Euler order matches OpenSCAD's `Rz·Ry·Rx`; **verify against the image oracle first**, else convert |
| `rotate(a)` scalar | `rotate([0,0,a], child)` |
| `rotate(a, v)` axis-angle | no gcad axis-angle → convert axis-angle → Euler (matching gcad's convention) |
| `scale([x,y,z])` | direct (negative components = mirror, fine) |
| `mirror([x,y,z])` | axis-aligned normal → `scale` with −1 on that axis; **general plane** → reflection has no direct form → `Unsupported` (or rotate·scale(−1)·rotate decomposition, Phase 2) |
| `multmatrix(m)` | decompose to T·R·S **iff** pure (no shear/projection) → nested transforms; else `Unsupported` |
| `color(...)` | drop, pass child through |
| `resize([...])` | needs child bounding box (unknown at emit) → `Unsupported` |

⚠️ **The first thing to nail in Phase 1 is the rotate convention.** A mismatch silently
rotates every model wrong; the oracle (§8) is how you catch it. Write a `rotate`-cube
fixture day one.

### 5.1 Coordinate system (Z-up → Y-up)

OpenSCAD is **Z-up**; gcad is **Y-up** (a plan to move gcad to Z-up codebase-wide was
*dropped* — too complex, not needed — so the importer owns this). Do **not** rewrite every
coordinate — wrap the whole imported tree in **one root axis-conversion transform**: a −90°
rotation about X that maps OpenSCAD +Z → gcad +Y (a proper rotation, so chirality is
preserved — important for `mirror`/`scale(-1)`). All interior coordinates and transforms
stay in OpenSCAD space under that single root op. The emitter prepends it (§6).

Two caveats: (a) the exact sign/order depends on gcad's Euler convention — settle it with the
same oracle check as the rotate convention above; (b) ops defined relative to a specific axis
need their own reconciliation under the remap — notably `rotate_extrude` (revolves about
OpenSCAD's axis) → `lathe` (revolves about gcad's **Y**), and `twist`/`repeatPolar` (gcad
Y-based). Handle those per-op in §3.5, not via the root transform alone.

---

## 6. The emitter (`emit.mts`)

GeomIR → gcad DSL text. Factory functions are injected globals; emit bare calls. Output is
the document body (gcad wraps it as `function _(){…} return _();`), so end with `return
<expr>`. **Wrap the entire body in the root axis-conversion transform (§5.1)** —
`return rotate([-90,0,0], <tree>)` — so the whole import is Z-up→Y-up corrected in one place.
Pretty-print with indentation; optionally hoist reused subtrees to `const`s for readability
(Phase 2+). **Emit cheat-sheet (verified against `cad-types-decl.mts` + the
primitive/operator sources):**

| GeomIR | Emit |
|---|---|
| sphere | `sphere.radius(r).shift([x,y,z])` |
| box/cube | `box([x,y,z]).shift([x,y,z])` |
| cylinder | `cylinder.radius(r).height(h).shift([x,y,z])` (gcad height is full, centered) |
| cone | `cone.radius(r).height(h).shift([x,y,z])` |
| torus | `torus.smallRadius(sr).largeRadius(lr).shift([…])` |
| polygon2d | `polygon2d([[x,y],…])` |
| extrude | `extrude.profile(<poly>).height(h).twist(deg)` (**height is half**, ±h; twist in degrees) |
| lathe | `lathe.profile(<poly>)` (profile pts are (r,y); revolves around Y) |
| loft | `loft.sections([<poly>,…]).height(h)` |
| union | `union(a, b, …)` (n-ary); blend `.round(r)`/`.chamfer(r)`/`.soft(r)` |
| subtract | `subtract(base, c1, c2, …)`; blend `.round(r)`/`.chamfer(r)` (no `.soft`) |
| intersect | `intersect(a, b)`; blend `.round(r)`/`.chamfer(r)` |
| translate | `translate([x,y,z], child)` |
| rotate | `rotate([rx,ry,rz], child)` (degrees) |
| scale | `scale([sx,sy,sz], child)` |
| offset/shell/twist | `offset(amt, child)` / `shell(t, child)` / `twist(rate, child)` |

Gotchas to bake into codegen: cylinder/cone height is full & centered (OpenSCAD `cylinder`
is **not** centered by default → wrap in a `translate([0,0,h/2])` unless `center=true`);
extrude/loft `height` is **half**; vecs are always `[x,y,z]` tuples; sphere/box position is
`.shift([…])` (absolute, not additive).

`Unsupported` nodes → emit a `// UNSUPPORTED: <scadName> at <line:col> — <reason>` comment in
place and record a diagnostic; never emit silently-wrong geometry.

---

## 7. UI integration

| Step | Location | Change |
|---|---|---|
| `.scad` file picker | `src/fs/file-picker.mts` (next to `openSingleGcad`, :18) | add `openSingleScad()` — `accept: { "text/plain": [".scad"] }` |
| Import handler | `src/app.mts` (next to `#handleOpenModel`, ~:1549) | add `#handleImportOpenScad()`: pick → `convertOpenScadToGcad` → open as new doc → surface diagnostics |
| New document | `src/components/document-tabs.mts:399` `newDocument(content, "typescript", name)` | call with emitted DSL + suggested name (`foo.scad` → `foo.gcad`) |
| Menu item | `src/app.mts` `#wireMenu` (~:1504–1537) | add "Import OpenSCAD…" to the File `menuItems` array |

Diagnostics surface to the user (toast/panel) — at minimum a count + the first few
`line:col` messages, so a partial import is honest about what it dropped.

---

## 8. Testing

Two layers:

1. **Unit tests** (`*_test.mts`, `node:test` + `node:assert/strict`, `make test`): evaluator
   correctness on values/operators/scope/comprehensions/recursion; emitter output strings;
   transform conversions; each idiom. Pure, fast, no rendering.
2. **Golden image comparison** (the openscad-wasm oracle, dev/test only): for each fixture
   `.scad`, render it in OpenSCAD (offline, via openscad-wasm) → reference PNG; convert →
   `.gcad` → render via `scripts/agentcli render` → compare with `agentcli compare` (SSIM +
   pixel diff). Assert SSIM ≥ ~0.98. Fixtures + YAML testcases under
   `test/testcases/import/openscad/`, golden PNGs under `.agents/testimages/`.

Seed fixtures (smallest-first, each targets a risk): `cube`, `translate-cube`,
**`up-axis`** (an asymmetric tall shape — verifies Z-up→Y-up root transform, §5.1),
**`rotate-cube`** (Euler convention check — §5), `union/difference/intersection`, `cylinder`
(centering), `for-loop`, `module-with-children`, `function-recursion`,
`linear_extrude-polygon`, `rotate_extrude` (lathe axis — §5.1), `minkowski-rounded-box`
(idiom). Build the
oracle harness in Phase 0 so every later phase lands with a golden test.

---

## 9. Phased work breakdown

Aligns with the feasibility note (≈5–7 weeks for Phases 0–2; evaluator dominates).
*(estimates = engineering judgment, not sourced)*

**Phase 0 — Integrate & scaffold (~2–3 days).** Add `openscad-parser`; scaffold
`src/import/openscad/`; `convertOpenScadToGcad` walking skeleton; AST-coverage smoke test on
feature-heavy `.scad`; stand up the openscad-wasm image oracle + first `cube` golden.

**Phase 1 — Evaluator + CSG core (~2–4 weeks, the dominant phase).** Value model + operators
+ built-in functions; scope/`$`-vars/recursion; expression evaluator; geometry evaluator
(primitives, user modules+children, `for`/`if`, booleans); transform translation (§5, rotate
convention + Z-up→Y-up root transform §5.1 first); GeomIR; emitter for the CSG core; the
import UI (§7). Exit: simple parametric models (boxes/brackets/spacers/enclosures) import and
pass golden compares.

**Phase 2 — 2D + extrusion + comprehensions (~1–2 weeks).** 2D primitives; `linear_extrude`/
`rotate_extrude`/`offset`; list comprehensions; `multmatrix` TRS decomposition; general
`mirror`. Exit: most functional/printed parts import.

**Phase 2.5 — Idiom recognition (~1 week, optional, high ROI).** `hull`/`minkowski(sphere)`
→ `.round(r)`; `linear_extrude(circle)` → cylinder; emitter CSE/hoisting for readability.

**Phase 3 — Mesh wall (deferred; weeks–months or skip).** `polyhedron`/`import(STL)` via a
**new** voxel mesh-to-SDF gcad primitive; general `hull`/`minkowski`. Its own go/no-go — see
feasibility §3.

---

## 10. Risks & decisions

- **Rotate/Euler convention mismatch & Z-up→Y-up sign** (§5, §5.1) — highest-severity silent
  bugs (every model rotated/oriented wrong). Mitigation: `rotate-cube` + `up-axis` oracle
  fixtures in Phase 1, before anything depends on rotation/orientation.
- **Evaluator completeness vs the long tail** — the evaluator is the cost center; scope it to
  the common subset (the §8 fixtures), let `Unsupported` + diagnostics absorb the rest. Run
  the feasibility note's open **coverage measurement** (Thingiverse `.scad` sample) before
  Phase 2 to confirm where to stop.
- **`$fn` faceting disappears** (smooth SDF) — intended, but a surprise; emit a one-time
  diagnostic.
- **`use`/`include` file resolution** in a browser file-picker context — multi-file imports
  need user-granted access to siblings; Phase 1 treats missing includes as diagnostics.
- **Unsupported-node policy** — decided: comment-in-place + collected diagnostics, never
  silent. (Feasibility §5 open item, now resolved here.)
- **openscad-parser maintenance** (~18★, last release Oct 2024) — MIT, vendor/fork if it
  stalls; pin the version.

---

## 11. Appendix — key references

- gcad DSL surface: `src/scene/cad-types-decl.mts`; primitives `src/scene/primitives/`;
  operators `src/scene/operators/`.
- Doc flow: `src/fs/file-picker.mts:18`, `src/app.mts:~1504/~1549`,
  `src/components/document-tabs.mts:399/567`.
- Build/test: esbuild (`build/build.mts`, ESM), `node:test` via `make test`, `scripts/agentcli`
  (`render`/`compare`/`triangle`/`regress`), testcases `test/testcases/`.
- `openscad-parser`: `ParsingHelper.parseFile(new CodeFile(path, src)) → [ScadFile, ErrorCollector]`;
  `ASTVisitor<R>` (31 `visit*`); nodes in `ast/expressions.ts`, `ast/statements.ts`,
  `ast/AssignmentNode.ts`; `TokenType` enum for operators.
- Paradigm boundary & build/skip rationale: [`openscad-importer-feasibility.md`](./openscad-importer-feasibility.md).
