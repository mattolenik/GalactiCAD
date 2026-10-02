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
| `<axis>` | `X`, `Y`, `Z` (Z is up), or a datum or axis attachment | grammar.md |
| `<len>` | a length expression; bare numbers take the file unit | expressions.md |
| `<angle>` | expression, degrees by default | expressions.md |
| `<count>` | integer, name, or parenthesized expression | grammar.md |
| `<expr>` | any expression; in a condition it must be boolean | expressions.md |
| `<text>` | quoted string | lexical.md |
| `<triple>` | `a x b x c`, a size | grammar.md |
| `<vector>` | `(x, y, z)`, a point in part coordinates | grammar.md |
| `<blend>` | `round blend <len>`, `soft blend <len>`, `chamfer blend <len>` | grammar.md |

## Kinds

What may follow `is a`, `is an`, or `is`/`are` with a count. A declared part name is also a kind,
with its `given` names as parameters. Arguments are `, name = value` pairs in any
order; required ones are marked. Where a row lists alternatives (`dia` or `radius`)
exactly one must be given. The API column is the scene node the binder emits.

| Kind phrase | Parameters | Cuts? | API |
|---|---|---|---|
| `cylinder` | `dia` or `radius` (req), `height` (req) | no | cylinder |
| `box` | `size` (triple, x by y by z with Z up) or `width`, `depth`, `height` (req) | no | box |
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
| `pocket` | `size` (triple, x by y by depth) or `width`, `length`, `depth` (req; `depth` may be `through`) | yes | box, subtract |
| `slot` | `width`, `length`, `depth` (all req) | yes | capsule, subtract |
| `extrusion` | `profile` (a sketch reference, req), `height` (req) | no | extrude |
| `revolution` | `profile` (req), `angle` (default 360) | no | lathe |
| `loft` | `from`, `to` (sketch references, req), `height` (req) | no | loft |

Examples:

```
the base    is a cylinder, dia = 32, height = 28
the stud    is a male thread, dia = 29, pitch = 1.5, height = 3.5
the socket  is a female thread, thread = M8x1.25, depth = 12
the tab     is a box, size = 30 x 20 x 5
the plate   is a box, width = 30, depth = 20, height = 5
the body    is an extrusion, profile = the outline, height = 40
```

Every parameter of an instance can be read back as `the <parameter> of <instance>`
(expressions.md), so `the height of the base` is the argument the base was given.

## Attachment kinds

Declared in a part's `attachments` section (grammar.md, Attachment declarations) or
provided by default. Every attachment is a frame: a position, a normal, and a tangent.
An alignment uses the position and the normal; the tangent only sets the default spin
(grammar.md, Attachment statements). Every kind works with every alignment verb; the
kind says where the frame comes from and what the binder checks.

| Kind | Position | Normal | Tangent |
|---|---|---|---|
| `surface` | face center | outward normal | the part's up projected onto the face, else its front |
| `plane` | face center | normal; alignment only, no material contact implied | as surface |
| `point` | the point | its facing direction | its up |
| `axis` | base point | along the axis; two axes facing each other are concentric | derived like a part's up |
| `edge`, straight | midpoint | bisector of the two face normals | along the edge; sign rule below |
| `edge`, circular (a cylinder's rim) | circle center | the face normal | none; `at <angle>` picks a point on the rim with the bisector there |
| corner (a default `point`) | the corner | sum of the three face normals | the part's up projected, else front |

Edge tangent sign: for box and primitive edges the tangent points along the positive
part-frame axis the edge parallels (+X, +Y, or +Z); vertical edges of extrusions point
+Z; a declared `edge` attachment inherits the sign of the edge it aliases, and one built
from `where A meets B` takes A's normal crossed with B's. `turned 180` or a negative
`slid` corrects a wrong-way case.

Default attachments (present when a part declares none, or after `plus the box
defaults`):

| Name | Kind | From |
|---|---|---|
| `top` `bottom` `left` `right` `front` `back` | surface | bounding-box faces; `top` is +Z |
| `top front`, `bottom left`, … (12) | edge | bounding-box edges |
| `top front left`, … (8) | point | bounding-box corners, facing along the corner diagonal |
| `center` | point | bounding-box center, facing along the part's look vector |
| `side` (round primitives) | surface | curved side; `at <angle>` picks a point on it |
| `outside` (round primitives) | surface | synonym of `side` |
| `inside` (round cutting kinds) | surface | the cut's wall, normal toward the axis |
| `floor` (cutting kinds) | surface | the bottom face of the cut |
| `axis` (round primitives) | axis | the primitive's axis |

Every part also has a default attachment point (grammar.md, Default attachment and the
part frame): its `default` line, or else `center` with look +X and up +Z.

## Predicate templates

Sentences under `where` (or directly among declarations). Every template starts with a
subject; the parser decides on the verb word after it, and after `is` on the word that
follows (`a`/`an` or a count would make it a declaration). Placement is never a
predicate: union and subtraction are `attaches to` and `subtracts from` in the
attachments section. A treatment's single size is a
bare quantity (`fillet 1` is a radius of 1, `chamfer 0.3` a distance of 0.3); anything
with more than one value takes `, name = value` arguments.

| Template | Example | Produces |
|---|---|---|
| `<subject> has fillet <len> on <edges>` | `the pocket has fillet 1 on its bottom edge` | fillet on catalog edges |
| `<subject> has chamfer <len> on <edges>` | `the base has chamfer 0.3 on its top and bottom edges` | chamfer on catalog edges |
| `<subject> has fillet <len> on all edges` | `the tab has fillet 0.5 on all edges` | fillet, every edge |
| `<subject> has all edges broken <len>` | `the base has all edges broken 0.2` | chamfer, every edge (drawing note BREAK ALL EDGES) |
| `<subject> is joined to <ref> with a <blend>` | `the stud is joined to the base with a round blend 0.5` | blended union |
| `<subject> is knurled on <face>, ridges = <count>, ridge dia = <len>, length = <len>` | `the base is knurled on its outside, ridges = 72, ridge dia = 0.6, length = 27` | knurl (repeat_polar of ridge) |
| `<subject> is hollowed, wall = <len>, open on <face>` | `the cup is hollowed, wall = 1.2, open on its top face` | shell |
| `<subject> is engraved with <text> on <face>, depth = <len>` | `the lid is engraved with "MADE IN" on its top face, depth = 0.3` | engrave |
| `<subject> is twisted <angle> about <axis>` | `the column is twisted 30 about Z` | twist |
| `<subject> is tapered at <face>, dia = <len>` | `the pin is tapered at its top face, dia = 4` | taper |

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

Patterns lay out the elements of a counted declaration around the group's own center.
They follow the declaration's arguments; the group is then attached as one thing in
the attachments section. Exactly one pattern per counted declaration.

| Template | Example | API |
|---|---|---|
| `equally spaced on a circle with dia = <len>` (`about <axis>`)? | `the vents are 4 holes, dia = 1.5, depth = through, equally spaced on a circle with dia = 10` | repeat_polar, N = count |
| `every <angle> about <axis>` | `the ribs are 6 boxes, size = 2 x 10 x 20, every 60 about Z` | repeat_polar |
| `along <axis> with spacing = <len>` | `the slots are 3 slots, width = 4, length = 12, depth = 3, along X with spacing = 12` | linear repeat |
| `stacked along <axis>` | `the stack is n pill case segments, stacked along Z` | linear repeat, step = extent along the axis |
| `at <vector> and <vector> …` | `the posts are 3 posts, at (0,0,0) and (20,0,0) and (40,0,0)` | explicit copies; count must match |
