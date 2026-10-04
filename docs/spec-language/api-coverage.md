# API coverage

What the JavaScript scene API (`src/scene/cad-types-decl.mts`) provides, which of it
the spec language covers, and a proposed sentence for each gap. Every proposal keeps
the existing rules: named arguments after a comma, placement only in the attachments
section, predicates under `where`, Z-up, `--` comments. A proposal is not decided until
it moves into grammar.md or templates.md; this file is the backlog.

Status column: **covered** (in the four grammar files), **proposed** (syntax below,
not yet decided), **API gap** (the spec says it but the API cannot do it yet).

## Primitives

| API | Spec today | Status | Proposal |
|---|---|---|---|
| `sphere.radius` | `sphere` | covered | |
| `box(l, w, h)` | `box` | covered | |
| `cylinder.radius.height` | `cylinder` | covered | |
| `cone.radius.height` | `cone`, with `top dia` | API gap | `top dia` needs a truncated cone in the API; until then `top dia` other than 0 is a binder error |
| `torus.smallRadius.largeRadius` | `torus`, `dia` and `tube dia` | covered | |
| `capsule.radius.cylinderLength` | `capsule` | covered | |
| `hexprism.radius.height` | `hex prism`, `across flats` | covered | binder converts across-flats to radius |
| `disc.radius` | `disc`, with `thickness` | API gap | API disc has no thickness; emit a cylinder when `thickness` is given |
| `threaded_rod` | `male thread`, `female thread` | covered | |
| `threaded_rod.left`, `.hand(LEFT)` | — | proposed | `hand = left` argument (default `right`) |
| `.threadAngle(deg)` | — | proposed | `flank angle = 30` argument |
| `.depth(d)` (explicit amplitude) | — | proposed | `thread depth = 0.9` argument; overrides the pitch-derived depth |
| `.female(play)` | `female thread` | proposed | `play = 0.1` argument on `female thread` |
| `plane.normal.dist` (half-space) | — | proposed | kind `half space`, `normal = 0 x 0 x 1`, `offset = 5`; cuts with `subtracts from`. Also a predicate `<subject> is trimmed at <plane>` for the common case (intersect with a datum or `plane` attachment) |
| `blob()` | — | proposed | kind `blob`, no parameters |
| `polygon2d(...)` | `profile` slot says "a sketch reference" | **proposed, blocking** | kind `sketch` with a `points` argument, see Sketches below |
| `path2d(...)` beziers | — | **proposed, blocking** | `curve to … via …` inside a sketch, see Sketches below |
| `extrude.profile.height.twist` | `extrusion`; `is twisted` | covered | |
| `loft.sections(a, b, c, …)` | `loft`, `from`, `to` | proposed | add `via = the mid, the neck` for intermediate sections, in order |
| `lathe.profile` | `revolution`, with `angle` | API gap | API lathe is always 360°; `angle` other than 360 is a binder error until the API has a sweep |

### Sketches

A sketch is a 2D profile declared like any other kind. Points are 2-vectors; straight
segments are implied between consecutive points; the outline closes itself.

```
the outline is a sketch, points = (0, 0) (20, 0) (20, 10) (0, 10)
the lip     is a sketch, points = (0, 0) (20, 0) curve to (20, 10) via (24, 3) (24, 8) (0, 10)
the body    is an extrusion, profile = the outline, height = 40
the bell    is a revolution, profile = the lip
```

- `curve to <point> via <point>` is a quadratic bezier from the previous point; `via`
  with two points is cubic. `curve` becomes a function word; `to` and `via` are already
  function words or become one.
- Sketch points may use parameters: `(od / 2, 0)`.
- Grammar additions: `Vector2 ::= "(" Expression "," Expression ")"`,
  `Points ::= (Vector2 | "curve to" Vector2 "via" Vector2 Vector2?)+`, and `Points` as a
  `Value` alternative, legal only for `points`.

## Booleans and blends

| API | Spec today | Status | Proposal |
|---|---|---|---|
| `union(...)` | `attaches to` | covered | |
| `subtract(base, ...)` | `subtracts from` | covered | |
| `intersect(a, b)` | — | proposed | `AttachVerb` gains `"intersects with" \| "intersect with"`: `the blank intersects with the mold, with its center positioned at the center of the mold` |
| `.round(r)` `.soft(r)` `.chamfer(r)` on any boolean | `is joined to <ref> with a <blend>` (union only) | proposed | a statement modifier `, blended round 0.5` on `attaches to`, `subtracts from`, and `intersects with`; retire the `is joined to` predicate so the blend sits on the statement that creates the seam |
| `.columns(r, n)` `.stairs(r, n)` | — | proposed | `<blend>` gains `columns <len>` and `stairs <len>`, each with an optional `, steps = <count>` |
| `union(...).round(r)` over a whole part | — | proposed | an attachments item `default blend is round 0.1`; statements without `, blended` use it; `, hard` opts out |
| `seam(a, b).radius(r)` | — | proposed | blend kind `seam <len>` in the same slot: `, blended seam 0.3` |
| `pipe(a, b).radius(r)` (weld bead) | — | proposed | predicate `<subject> is welded to <ref> with a bead <len>` |
| `morph(a, b).t(t)` | — | proposed | kind `morph`, `from = the ball, to = the cube, t = 0.5` (references as values are already legal) |
| `groove(base).pattern(p).radii(ra, rb)` | — | proposed | predicate `<subject> has a groove of <ref>, radii = <len> x <len>` |
| `tongue(base).pattern(p).radii(ra, rb)` | — | proposed | predicate `<subject> has a tongue of <ref>, radii = <len> x <len>` |
| `engrave(base).pattern(p).radius(r)` | `is engraved with <text> on <face>, depth = <len>` | proposed + API gap | widen the slot to `<text> \| <ref>` so any shape can be engraved; `<text>` stays an API gap until there is a text primitive |
| `knurl(base).offset(o).pattern(p, teeth)` | `is knurled on <face>, ridges = …` | covered | binder builds the ridge cutter and polar repeat |

## Unary modifiers

| API | Spec today | Status | Proposal |
|---|---|---|---|
| `shell(t, node)` | `is hollowed, wall = <len>, open on <face>` | covered + API gap | `open on` is binder composition: shell, then subtract a box over the face; or add an opening to the API shell |
| `offset(amount, node)` | — | proposed | `<subject> is offset by <len>` (negative shrinks) |
| `elongate(hx, hy, hz, node)` | — | proposed | `<subject> is stretched by <triple>` |
| `twist(rate, node)` | `is twisted <angle> about <axis>` | covered | API twists about the up axis only; `about` other than `Z` is a binder error for now |
| `bend(amount, node)` | — | proposed | `<subject> is bent <angle> about <axis>` |
| `taper(ratio, height, node)` | `is tapered at <face>, dia = <len>` | covered | |
| `scale(sx, sy, sz, node)` | — | proposed | `<subject> is scaled by <triple>`; uniform: `is scaled by 2` |
| `repeatPolar(count, node)` | pattern templates | covered | |
| `rotate`, `translate`, `.shift` | attachments | covered by design | no placement outside the attachments section |
| `.clone()` | parts as types | covered by design | |

### Applying a modifier to more than one feature

In JavaScript a modifier wraps any subtree: `shell(1.2, union(a, b))`. A predicate's
subject is one declared name, so two things are missing.

- **The part itself.** Proposal: the reserved subject `the whole`, legal only inside a
  part, meaning the part's finished geometry: `the whole is hollowed, wall = 1.2`,
  `the whole is twisted 30 about Z`. `whole` becomes a function word.
- **A named subset.** Proposal: kind `group`, `members = the body and the arm`
  (a reference list as a value). A group is a subject for predicates and a peer in the
  attachments section; it adds no geometry of its own.
- **Order.** Proposal: predicates apply to a subject in document order, each wrapping
  the result of the previous, so `is twisted` then `is tapered` differs from the
  reverse, exactly as the JavaScript chain does.

## Expressions

| API | Spec today | Status | Proposal |
|---|---|---|---|
| `Math.sqrt sin cos tan atan min max abs` | same | covered | |
| `Math.atan2 floor ceil round`, `Math.PI` | — | proposed | add `atan2`, `floor`, `ceil`, `round`, and the constant `pi` to the function words; `round` already is one and the expression context disambiguates it from `round blend` |
| `cond ? a : b` | `, only if` on attachments only | proposed | conditional value `height = 10 if vented else 5`; `else` returns as a function word |
| `let x = …` | `given` only | proposed | `let` section for derived values, see the part-parameters proposal (not yet in the docs) |
| `console.log` | — | not needed | |

## Spec features the API cannot back yet

- `cone` with `top dia`, `disc` with `thickness`, `revolution` with `angle`: see above.
- `require` assertions (`is at least <len> thick`, `clears <ref> by <len>`): need a
  measurement pass over the built geometry; nothing in the API measures.
- `edge E3`, `face F1`: the feature catalog that assigns stable ids exists on the
  filcham branch, not here.
- Fillet and chamfer on arbitrary catalog edges: this branch has them only on cylinder
  and threaded-rod rims (`TOP`, `BOTTOM`), and not on boxes.
- Text engraving: no text primitive.

## Mapping notes

- The API is Y-up (`TOP | BOTTOM` flags, `repeatPolar` about +Y, twist about Y). The
  spec is Z-up. The binder swaps axes when emitting nodes; `height` in the spec is the
  API's `h` along Y.
- Half-height conventions (a cylinder's center is bottom plus half its height) are
  hidden by attachments: the spec never writes a center.
- Multi-operand smooth unions blend the two nearest children per sample and are not
  associative (see docs/smooth_union_ordering.md). `default blend` over a whole part
  therefore means one n-ary blended union, not a chain of pairwise ones.
