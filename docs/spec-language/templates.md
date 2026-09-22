# Templates

The closed vocabularies of the language: built-in kinds and their parameters,
attachment kinds, predicate templates (the `where` sentences), assertion templates (the
`require` sentences), and pattern phrases. Each row is one template with typed slots.
The parser matches a template by its leading words after the subject; the binder checks
slot types and resolves names.

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
| `<axis>` | `X`, `Y`, `Z`, or a datum or axis attachment | grammar.md |
| `<len>` | a length expression; bare numbers take the file unit | expressions.md |
| `<angle>` | expression, degrees by default | expressions.md |
| `<count>` | integer, name, or parenthesized expression | grammar.md |
| `<expr>` | any expression; in a condition it must be boolean | expressions.md |
| `<text>` | quoted string | lexical.md |
| `<triple>` | `a x b x c`, a size or vector | grammar.md |
| `<blend>` | `round blend <len>`, `soft blend <len>`, `chamfer blend <len>` | grammar.md |

## Kinds

What may follow `is a`, `is an`, or `are <count>`. A declared part name is also a kind,
with its `given` names as parameters. Arguments are `, name = value` pairs in any
order; required ones are marked. Where a row lists alternatives (`dia` or `radius`)
exactly one must be given. The API column is the scene node the binder emits.

| Kind phrase | Parameters | Cuts? | API |
|---|---|---|---|
| `cylinder` | `dia` or `radius` (req), `height` (req) | no | cylinder |
| `box` | `size` (triple, x by y by z with Y up) or `width`, `height`, `depth` (req) | no | box |
| `sphere` | `dia` or `radius` (req) | no | sphere |
| `cone` | `dia` or `radius` (req, bottom), `top dia` (default 0), `height` (req) | no | cone |
| `capsule` | `dia` or `radius` (req), `length` (req) | no | capsule |
| `torus` | `dia` (ring, req), `tube dia` (req) | no | torus |
| `disc` | `dia` or `radius` (req), `thickness` (req) | no | disc |
| `hex prism` | `across flats` (req), `height` (req) | no | hexprism |
| `male thread` | `dia` and `pitch`, or `thread` (a Thread token); `height` (req); `profile` = `sine`, `iso`, `acme` | no | threaded_rod |
| `female thread` | `dia` and `pitch`, or `thread`; `depth` (req, or `through`); `profile` | yes | threaded_rod female, subtract |
| `bore` | `dia` or `radius` (req), `depth` (req, or `through`) | yes | cylinder, subtract |
| `hole` / `holes` | `dia` or `radius` (req), `depth` (req, or `through`) | yes | cylinder, subtract |
| `pocket` | `size` (triple) or `width`, `depth`, `length`; `depth` (req) | yes | box, subtract |
| `slot` | `width`, `length`, `depth` (all req) | yes | capsule, subtract |
| `extrusion` | `profile` (a sketch reference, req), `height` (req) | no | extrude |
| `revolution` | `profile` (req), `angle` (default 360) | no | lathe |
| `loft` | `from`, `to` (sketch references, req), `height` (req) | no | loft |

Examples:

```
the base    is a cylinder, dia = 32, height = 28
the stud    is a male thread, dia = 29, pitch = 1.5, height = 3.5
the socket  is a female thread, thread = M8x1.25, depth = 12
the tab     is a box, size = 30 x 5 x 20
the plate   is a box, width = 30, height = 5, depth = 20
the body    is an extrusion, profile = the outline, height = 40
```

Every parameter of an instance can be read back as `the <parameter> of <instance>`
(expressions.md), so `the height of the base` is the argument the base was given.

## Attachment kinds

Declared in a part's `attachments` section (grammar.md, Attachment declarations) or
provided by default. The verb column is what a subject may use against an attachment of
that kind; the modifier column is the free parameter or adjustment each accepts.

| Kind | What it is | Verbs | Modifiers |
|---|---|---|---|
| `surface` | a whole face with its outward normal | `on`, `into`, `at` | `sunk`, `proud`, `toward`, `inset`, `turned`, `facing` |
| `plane` | the infinite plane through a face; alignment only, no contact | `flush with` | `<len> from`, `turned` |
| `point` | a frame: position, facing, up | `at`, `snapped to` | `turned`, `facing`, `up along` |
| `axis` | a line, for concentric fits | `in` | `<len> in`, `<len> along`, `turned` |
| `edge` | a line segment on the part | `along`, `centered on` | `<len> along`, `facing` |

Kind compatibility is checked by the binder before geometry is built: the subject's
attachment (`its stem`) and the target's (`the riser line of …`) must be the same kind,
except that a `point` may be placed `at` a surface and a surface subject may sit `on` a
default surface such as `top`. Mismatch error: "stem of the gauge is an axis; top flange
of the manifold is a surface".

Default attachments (present when a part declares none, or after `plus the box
defaults`):

| Name | Kind | From |
|---|---|---|
| `top` `bottom` `left` `right` `front` `back` | surface | bounding-box faces |
| `top front`, `bottom left`, … (12) | edge | bounding-box edges |
| `top front left`, … (8) | point | bounding-box corners, facing along the corner diagonal |
| `center` | point | bounding-box center, facing up |
| `side` (round primitives) | surface | curved side; `at <angle>` picks a point on it |
| `axis` (round primitives) | axis | the primitive's axis |

## Predicate templates

Sentences under `where` (or directly among declarations). Every template starts with a
subject; the parser decides on the verb word after it. A treatment's single size is a
bare quantity (`fillet 1` is a radius of 1, `chamfer 0.3` a distance of 0.3); anything
with more than one value takes `, name = value` arguments.

| Template | Example | Produces |
|---|---|---|
| `<subject> has fillet <len> on <edges>` | `the pocket has fillet 1 on its bottom edge` | fillet on catalog edges |
| `<subject> has chamfer <len> on <edges>` | `the base has chamfer 0.3 on its top and bottom edges` | chamfer on catalog edges |
| `<subject> has fillet <len> on all edges` | `the tab has fillet 0.5 on all edges` | fillet, every edge |
| `<subject> has all edges broken <len>` | `the base has all edges broken 0.2` | chamfer, every edge (drawing note BREAK ALL EDGES) |
| `<subject> is joined to <ref> with a <blend>` | `the stud is joined to the base with a round blend 0.5` | blended union |
| `<subject> is cut from <ref>` | `the notch is cut from the base` | subtract |
| `<subject> is added to <ref>` | `the gusset is added to the base` | union |
| `<subject> is knurled on <face>, ridges = <count>, ridge dia = <len>, length = <len>` | `the base is knurled on its outside, ridges = 72, ridge dia = 0.6, length = 27` | knurl (repeat_polar of ridge) |
| `<subject> is hollowed, wall = <len>, open on <face>` | `the cup is hollowed, wall = 1.2, open on its top face` | shell |
| `<subject> is engraved with <text> on <face>, depth = <len>` | `the lid is engraved with "MADE IN" on its top face, depth = 0.3` | engrave |
| `<subject> is twisted <angle> about <axis>` | `the column is twisted 30 about Y` | twist |
| `<subject> is tapered at <face>, dia = <len>` | `the pin is tapered at its top face, dia = 4` | taper |
| `<subject> exists only if <expr>` / `<subject> exist only if <expr>` | `the vents exist only if vented` | conditional feature |

Rejected:

```
the pocket has a fillet of 1 on the bottom     -- error: nearest template is
                                                --   "<subject> has fillet <len> on <edges>"
the stud is blended into the base 0.5          -- error: nearest template is
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

Patterns place the elements of a counted declaration. They appear in the attachments
section, after the verb phrase of an attachment statement or as a statement of their
own. Exactly one pattern per counted subject. Arguments after a pattern phrase belong
to the pattern.

| Template | Example | API |
|---|---|---|
| `equally spaced on a bolt circle, dia = <len>` (`about <axis>`)? | `the vents into the floor of the pocket, equally spaced on a bolt circle, dia = 10` | repeat_polar, N = count |
| `every <angle> about <axis>` | `the ribs on the side of the hub, every 60 about Y` | repeat_polar |
| `along <axis>, spacing = <len>` | `the slots into the top of the rail, along X, spacing = 12` | linear repeat |
| `stacked along <axis>` | `the stack stacked along Y` | linear repeat, step = height |
| `at <vector> and <vector> …` | `the posts at (0,0,0) and (20,0,0) and (40,0,0)` | explicit copies; count must match |
