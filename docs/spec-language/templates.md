# Templates

The closed vocabularies of the language: built-in kinds, predicate templates (the
`where` sentences), assertion templates (the `require` sentences), and pattern clauses.
Each row is one template with typed slots. The parser matches a template by its leading
words after the subject; the binder checks slot types and resolves names.

Adding a row here is adding a feature to the language. Keep the tables short: Kuhn's
measure of a language's simplicity is the number of pages needed to describe it.

## Slot types

| Slot | Accepts | Defined in |
|---|---|---|
| `<name>` | bare or quoted name | lexical.md |
| `<subject>` | `the <name>` | grammar.md |
| `<ref>` | `Reference` (entity chain) | grammar.md |
| `<face>` | `FaceRef` | grammar.md |
| `<edges>` | `EdgeList` | grammar.md |
| `<axis>` | `X`, `Y`, `Z`, or a datum axis | grammar.md |
| `<len>` | `Quantity`, a length expression; bare numbers take the file unit | expressions.md |
| `<dia>` | `Ø` + `Primary` | grammar.md |
| `<r>` | `R` + `Primary` (radius, no space) | grammar.md |
| `<size>` | `<r>` or a bare `Primary` (chamfer distance) | grammar.md |
| `<angle>` | expression, degrees by default | expressions.md |
| `<count>` | integer, name, or parenthesized expression | grammar.md |
| `<expr>` | any expression; in a condition it must be boolean | expressions.md |
| `<text>` | quoted string | lexical.md |
| `<blend>` | `round blend R<r>`, `soft blend R<r>`, `chamfer blend <size>` | grammar.md |

## Kinds

What may follow `is a`, `is an`, or `are <count>`. A declared part name is also a kind.
The dimension column lists the dimensions each kind accepts, in any order; required ones
are marked. The API column is the scene node the binder emits.

| Kind phrase | Dimensions | Cuts? | API |
|---|---|---|---|
| `cylinder` | `Ø` or `R` (req), `<len> tall` (req) | no | cylinder |
| `box` | `<a> x <b> x <c>` or `<len> wide`, `<len> deep`, `<len> tall` (all req) | no | box |
| `sphere` | `Ø` or `R` (req) | no | sphere |
| `cone` | `Ø` or `R` bottom (req), `Ø` or `R` top (`to Ø<d>`), `<len> tall` (req) | no | cone |
| `capsule` | `Ø` or `R` (req), `<len> long` (req) | no | capsule |
| `torus` | `Ø` ring (req), `R` tube (req) | no | torus |
| `disc` | `Ø` or `R` (req), `<len> thick` | no | disc |
| `hex prism` | `<len> across` (flats, req), `<len> tall` (req) | no | hexprism |
| `male thread` | `Ø<d> x <pitch>` (req), `<len> tall` (req) | no | threaded_rod |
| `female thread` | `Ø<d> x <pitch>` (req), `<len> deep` or `through` (req) | yes | threaded_rod female, subtract |
| `bore` | `Ø` or `R` (req), `<len> deep` or `through` (req) | yes | cylinder, subtract |
| `hole` / `holes` | `Ø` or `R` (req), `<len> deep` or `through` (req) | yes | cylinder, subtract |
| `pocket` | `<a> x <b>`, `<len> deep` (req) | yes | box, subtract |
| `slot` | `<len> wide`, `<len> long`, `<len> deep` (req) | yes | capsule, subtract |
| `extrusion of <ref>` | `<len> tall` (req) | no | extrude |
| `revolution of <ref>` | `<angle>` optional | no | lathe |
| `loft from <ref> to <ref>` | `<len> tall` (req) | no | loft |

Thread profiles: `male thread` and `female thread` accept a profile word before the
kind, `iso male thread`, `acme male thread`; default is the sinusoidal profile. A
`Thread` token (`1/4-20 UNC-2B`, `M8x1.25`) may replace `Ø<d> x <pitch>` and fixes
diameter, pitch, and internal/external in one token.

Examples:

```
the base    is a cylinder Ø32, 28 tall
the stud    is a male thread Ø29 x 1.5, 3.5 tall
the socket  is a female thread M8x1.25, 12 deep, entering from the top face of the boss
the tab     is a box 30 x 20 x 5
the body    is an extrusion of the outline, 40 tall
```

## Predicate templates

Sentences under `where` (or directly among declarations). Every template starts with a
subject; the parser decides on the verb word after it.

| Template | Slots | Example | Produces |
|---|---|---|---|
| `<subject> has fillet <r> on <edges>` | | `the pocket has fillet R1 on its bottom edge` | fillet on catalog edges |
| `<subject> has chamfer <size> on <edges>` | | `the base has chamfer 0.3 on its top and bottom edges` | chamfer on catalog edges |
| `<subject> has fillet <r> on all edges` | | `the tab has fillet R0.5 on all edges` | fillet, every edge |
| `<subject> has all edges broken <size>` | | `the base has all edges broken 0.2` | chamfer, every edge (drawing note BREAK ALL EDGES) |
| `<subject> is joined to <ref> with a <blend>` | | `the stud is joined to the base with a round blend R0.5` | blended union |
| `<subject> is cut from <ref>` | | `the notch is cut from the base` | subtract |
| `<subject> is added to <ref>` | | `the gusset is added to the base` | union |
| `<subject> is knurled on <face> with <count> straight ridges <r>, <len> long` | | `the base is knurled on its outside with 72 straight ridges R0.3, 27 long` | knurl (repeat_polar of ridge) |
| `<subject> is hollowed to <len> walls, open on <face>` | | `the cup is hollowed to 1.2 walls, open on its top face` | shell |
| `<subject> is engraved with <text> on <face>, <len> deep` | | `the lid is engraved with "MADE IN" on its top face, 0.3 deep` | engrave |
| `<subject> is twisted <angle> about <axis>` | | `the column is twisted 30 about Y` | twist |
| `<subject> is tapered to <dia> at <face>` | | `the pin is tapered to Ø4 at its top face` | taper |
| `<subject> exists only if <expr>` / `<subject> exist only if <expr>` | | `the vents exist only if vented` | conditional feature |

Rejected:

```
the pocket has a fillet of 1 on the bottom     -- error: nearest template is
                                                --   "<subject> has fillet R<r> on <edges>"
the stud is blended into the base R0.5         -- error: nearest template is
                                                --   "<subject> is joined to <ref> with a <blend>"
```

## Assertion templates

Sentences under `require`. Either a plain comparison of expressions or one of these.
They are checked by the binder against the built geometry and reported, never used to
solve for anything.

| Template | Example | Checks |
|---|---|---|
| `<expr> <comparison> <expr>` | `wall >= 1.2 mm` | expression |
| `<ref> is at least <len> thick` | `the floor of the pocket is at least 3 mm thick` | minimum material between two faces |
| `<ref> is at most <len> thick` | `the flange is at most 4 thick` | maximum material |
| `<ref> clears <ref> by <len>` | `the stud clears the socket by 0.2` | radial or axial clearance |
| `<ref> fits inside <ref>` | `the stack fits inside the tube` | bounding containment |
| `<ref> does not touch <ref>` | `the vents do not touch the cavity` | no intersection |

## Pattern templates

Clauses on counted declarations (`are <count> …`). Exactly one pattern per
declaration. The count comes from the declaration; the pattern gives placement.

| Template | Example | API |
|---|---|---|
| `equally spaced on a <dia> bolt circle` (`about <axis>`)? | `equally spaced on a Ø10 bolt circle` | repeat_polar, N = count |
| `every <angle> about <axis>` | `every 60 about Y` | repeat_polar |
| `<len> apart along <axis>` | `12 apart along X` | linear repeat |
| `stacked along <axis>` | `stacked along Y` | linear repeat, step = height |
| `at <vector> and <vector> …` | `at (0,0,0) and (20,0,0) and (40,0,0)` | explicit copies; count must match |

Drawing-note form: a `Count` token before the kind is accepted in place of `are <count>`,
so `the vents are 4X Ø1.5 holes through the floor, equally spaced on a Ø10 bolt circle`
parses the same as the sentence form.
