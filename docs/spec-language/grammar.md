# Sentence-shape grammar

W3C-style EBNF over the tokens of [lexical.md](lexical.md). Every production is one
parse function. `decides on` names the lookahead that selects an alternative. Slot
vocabularies that are tables rather than rules (kinds and their parameters, predicate
templates, patterns) are in [templates.md](templates.md); `Expression` is in
[expressions.md](expressions.md).

Two rules shape every part: a declaration says what a thing is and how big
(`the stud is a male thread, dia = 29, pitch = 1.5, height = 3.5`), and the
`attachments` section says where it goes (`the stud on the top of the base, sunk 0.5`).
There is no placement information in a declaration.

## Document and parts

A document is the scene plus zero or more parts. The scene is every column-0 line that
is not a `part` header; a part is a `part` header plus the indented lines after it.
Parts are types: a part name used after `a`, `an`, or a count instantiates the part.
Parts may be declared in any order and after their first use.

```
Document        ::= Line*
                    -- column-0 statements form the Scene; each PartHeader starts a Part
Scene           ::= Statement*
Part            ::= PartHeader Statement*
                    -- Statements indented under the header; any indentation, kept consistent
PartHeader      ::= "part" Name
```

Example:

```
part Pill Case Lid
  given od = 32, pitch = 1.5
  the cap    is a cylinder, dia = od, height = 8
  the socket is a female thread, dia = 29, pitch = pitch, depth = 4
  where the cap has fillet 1 on its top edge
  attachments
    the cap    on the ground
    the socket into the bottom of the cap

given n = 3
the stack is n pill case segments
the lid   is a pill case lid
attachments
  the stack stacked along Y
  the lid   on the stud of the last segment of the stack
```

## Statements

```
Statement       ::= UnitsStatement
                  | UseStatement
                  | SectionHeader
                  | ParameterDefinition
                  | DatumDeclaration
                  | Declaration
                  | Predicate
                  | Assertion
                  | AttachmentsSection
                  | ForEach
                    -- decides on the first token: "units", "use", a section word, "datum",
                    -- "attachments", "for"; otherwise "the"/Quoted starts a Declaration or
                    -- Predicate (decided at the verb, see below); a Name followed by "="
                    -- is a ParameterDefinition; anything else is an Assertion

UnitsStatement  ::= "units" Unit
                    -- default unit for bare numbers in this part or scene; default mm
UseStatement    ::= "use" Quoted
                    -- imports the parts of another document; reserved, not yet specified
```

### Sections

Section headers group statements for the reader and tell the parser which statement
kinds to expect. `given`, `require`, and `attachments` items are only legal under their
headers. `where` is optional: predicates are also accepted directly among declarations.
The conventional order is `given`, declarations, `where`, `attachments`, `require`;
a header may be repeated. A declaration under `attachments` is an error ("declarations
go before the attachments section").

```
SectionHeader   ::= "given"   ParameterDefinition?
                  | "where"   Predicate?
                  | "require" Assertion?
                    -- the first item may share the header's line
                    -- "attachments" is AttachmentsSection below
```

### Parameters and datums

```
ParameterDefinition ::= Name "=" Expression ("," Name "=" Expression)*
                        -- under "given" only; within a part these are the part's
                        -- parameters with defaults, overridable by an Argument at use

DatumDeclaration ::= "datum" Name "is" DatumSpec
DatumSpec        ::= AttachmentRef
                   | "the plane" AxisName "=" Expression
                   | "the" AxisName "axis" ("through" Reference)?
```

Examples:

```
given od = 32, wall = 1.5, pitch = 1.5, vented = yes
given
  od   = 32
  wall = 1.5
datum A is the bottom of the base
datum mid plane is the plane Y = 14
```

### Declarations

A declaration names a feature (inside a part) or an instance (in the scene) and gives
its kind and arguments. Singular declarations use `is a`; counted declarations use
`are` and a count. Every kind, built-in or part, takes its arguments the same way:
`, name = value` pairs after the kind. The parameter names of the built-in kinds are in
templates.md; a part's are its `given` names.

```
Declaration     ::= Subject ("is a" | "is an") Kind Arguments? Condition?
                  | Subject "are" Count Kind Arguments? Condition?
                    -- decides on "is"/"are"; a Subject followed by any other verb
                    -- is a Predicate

Subject         ::= "the" Name
Kind            ::= Name
                    -- a run of content words ending at the comma; bound later to a
                    -- built-in kind or a part name
Count           ::= Integer | Name | "(" Expression ")"
Arguments       ::= ("," Argument)+
Argument        ::= Name "=" Value
                    -- decides on: after a ",", Name followed by "=" is an Argument;
                    -- "only if" is the Condition; anything else is an error here
Value           ::= Triple | Expression | "through" | Thread | Quoted
Triple          ::= Expression "x" Expression ("x" Expression)?
                    -- 10 x 6 x 4 or 10x6x4; a size is x by y by z with Y up
Condition       ::= "," "only if" Expression
```

Examples:

```
the base   is a cylinder, dia = od, height = 28
the stud   is a male thread, dia = 29, pitch = 1.5, height = 3.5
the pocket is a bore, dia = od - 2 * (wall + 1.5), depth = 17
the tab    is a box, size = 10 x 6 x 4
the plate  is a box, width = 30, height = 5, depth = 20
the socket is a female thread, thread = M8x1.25, depth = 12
the vents  are 4 holes, dia = 1.5, depth = through, only if vented
the lid    is a pill case lid, od = 40, vented = no
the riser  is a pipe stub, length = run / 2
```

The comma before the first argument is required: the kind phrase is a run of content
words and the comma is what ends it. Arguments may come in any order; a missing
required argument, an unknown name, or a value of the wrong kind (a boolean for a
length) is an error from the binder, which also suggests the nearest name.

Rejected:

```
the base is cylinder, dia = 32               -- error: expected "a" or "an" after "is"
the base is a cylinder dia = 32              -- error: "cylinder dia" is not a kind; write "a cylinder, dia = 32"
the base is a cylinder, 32 dia               -- error: arguments are name = value; write "dia = 32"
the base is a cylinder, dia = 32, on the top of the stand
                                             -- error: placement belongs in the attachments section
```

### Attachments section

The `attachments` section holds every placement in a part or scene, and the part's
attachment interface. Three kinds of item: an attachment statement (where a declared
thing goes), an attachment declaration (a named attachment this part exposes), and
`plus the box defaults`.

```
AttachmentsSection  ::= "attachments" (AttachItem | NEWLINE AttachItem+)
AttachItem          ::= AttachmentStatement | AttachmentDecl | "plus the box defaults"
                        -- decides on the first word: "the"/Quoted → statement;
                        -- surface/plane/point/axis/edge → declaration; "plus" → defaults
```

#### Attachment statements

```
AttachmentStatement ::= Subject ("by its" Name)? AttachVerb AttachmentRef Modifier* ("," Pattern)?
                      | Subject "at" Vector Modifier*
                      | Subject Quantity Direction Reference Modifier*
                      | Subject "rotated" Angle "about" Axis
                      | Subject Pattern
                        -- "by its <name>" is the subject's own attachment; default: its bottom
AttachVerb          ::= "on" | "into" | "at" | "snapped to" | "flush with" | "in" | "along"
                        -- which verbs a kind accepts: templates.md, Attachment kinds
Modifier            ::= "," ("sunk" | "proud" | "inset") Quantity
                      | "," "toward" AttachmentRef
                      | "," "turned" Angle
                      | "," "facing" Direction
                      | "," "up along" (Axis | AttachmentRef)
                      | "," Quantity ("in" | "along" | "from" AttachmentRef)
                        -- the free parameter of an axis, edge, or plane attachment
Direction           ::= "to the right of" | "to the left of" | "above" | "below"
                      | "in front of" | "behind" | "up" | "down" | "out" | "in"
                      | ("+" | "-")? AxisName
Pattern             ::= see templates.md, Pattern templates
```

Attachment verbs in one line each: `on` puts the subject's attachment against the
target's and orients it to the target's normal; `into` is the same for cutters (cutting
kinds accept only `into`); `at` moves without orienting; `snapped to` mates two points
including their frames; `flush with` aligns to a plane without contact; `in` fits an
axis concentrically; `along` slides along an edge. A positive kind with no statement
sits at its part's origin; a cutting kind (bore, hole, pocket, slot, female thread)
with no statement is an error. A counted subject carries its pattern here, after the
verb phrase, or as a statement of its own when it has no target.

Examples:

```
attachments
  the stud   on the top of the base, sunk 0.5
  the pocket into the top of the stud
  the cavity into the bottom of the base
  the lug    by its back on the right of the base, toward the top front edge, inset 2, turned 90
  the bump   at the side of the base at 162°, sunk 1
  the vents  into the floor of the pocket, equally spaced on a bolt circle, dia = 10
  the valve  by its inlet on the top flange of the manifold, turned 45
  the gauge  by its stem in the riser line of the manifold, 12 in
  the cover  by its bottom flush with the mount plane of the manifold
  the pin    at the corner index of the manifold
  the big one 60 to the right of the stack
  the stack  stacked along Y
```

Rejected:

```
  the gauge by its stem on the top flange of the manifold
        -- error: stem of the gauge is an axis; top flange of the manifold is a surface; use "in"
  the pocket into the top of the stud, sunk 1
        -- error: "sunk" has no meaning for a cutter
  the stud is a male thread, dia = 29          -- error: declarations go before the attachments section
```

#### Attachment declarations

A part's attachments are its interface. They are declared by aliasing or constructing
from the attachments of the part's constituents (primitive faces, or a sub-part's own
declared attachments). Every definition may use the part's `given` parameters, so an
instance with its own arguments gets its own attachment geometry. Attachment kinds and
their verbs are in templates.md.

```
AttachmentDecl     ::= AttachKind Name "is" AttachDef ("," FrameModifier)*
AttachKind         ::= "surface" | "plane" | "point" | "axis" | "edge"
                       -- positional words, not reserved; a name may contain them
AttachDef          ::= AttachmentRef                                -- alias
                     | "the plane of" AttachmentRef                 -- plane through a surface
                     | "on" AttachmentRef "," Locating              -- point within a surface
                     | "at" Vector                                  -- point in part coordinates
                     | "where" AttachmentRef "meets" AttachmentRef  -- axis or edge with a surface
                     | "midway between" AttachmentRef "and" AttachmentRef
                     | Quantity "outward from" AttachmentRef
Locating           ::= Quantity "from" AttachmentRef "and" Quantity "from" AttachmentRef
                     | Quantity "up" ("," Quantity "from" AttachmentRef)?
                     | "centered"
FrameModifier      ::= "facing" Direction | "up along" (Axis | AttachmentRef)
```

The declared kind must match what the definition yields (a `surface` may not alias an
edge); the binder checks this. Declared names may not reuse the default attachment
words (`top`, `bottom`, `left`, `right`, `front`, `back`, `center`, `side`) but may
contain them (`top flange`). Surfaces are whole faces; there are no surface regions.

Example:

```
part Pipe Stub
  given od = 20, wall = 2, length = 40
  the tube is a cylinder, dia = od, height = length
  the bore is a bore, dia = od - 2 * wall, depth = through
  attachments
    the bore into the top of the tube
    surface end  is the top of the tube
    surface root is the bottom of the tube
    axis    line is the axis of the tube

part Junction
  given run = 60, index inset = 4
  the body   is a box, size = run x 24 x 24
  the riser  is a pipe stub
  the branch is a pipe stub, length = 25
  the flange is a disc, dia = 36, thickness = 4
  the foot   is a box, size = 30 x 6 x 24

  attachments
    the riser  by its root on the top of the body
    the branch by its root on the back of the body
    the flange by its bottom on the end of the riser
    the foot   by its top on the bottom of the body

    surface top flange   is the top of the flange
    surface base mount   is the bottom of the foot
    surface back mount   is the back of the body, up along Y
    plane   mount plane  is the plane of the back of the body
    axis    riser line   is the line of the riser                 -- a sub-part's attachment
    point   corner index is on the top of the body, index inset from its front edge and index inset from its left edge
    edge    grip         is the top front edge of the body
    plus the box defaults
```

Defaults: a part that declares no attachments gets the box set from its bounding box
(`top`, `bottom`, `left`, `right`, `front`, `back`, `center`, the 12 edges, the 8
corners). A part that declares any gets only those unless it says `plus the box
defaults`. Primitives always have their catalog set (a cylinder's `side` and `axis`, an
extrusion's named side faces). Reaching inside a part with an `of` chain still resolves
but the binder flags it as reaching through the interface.

### Predicates and assertions

```
Predicate       ::= Subject PredicateTemplate
                    -- PredicateTemplate: templates.md, Predicate templates
Assertion       ::= Expression Comparison Expression
                  | AssertionTemplate
                    -- under "require" only; AssertionTemplate: templates.md
```

### Loops

`for each` is the only block statement. Its body is the following lines indented more
deeply than the `for each` line; the body ends at the first line back at or above that
indentation. The bound name is a number parameter inside the body. A loop may appear in
the declarations or in the attachments section, and its body is checked against the
section it is in.

```
ForEach         ::= "for each" Name "from" Expression "to" Expression ":" Block
Block           ::= Statement+
                    -- indented deeper than the "for each" line
```

Example:

```
for each i from 1 to n:
  the rib i is a box, size = 2 x 20 x 10
attachments
  for each i from 1 to n:
    the rib i at (0, 0, i * 6)
```

Prefer a pattern when one fits; loops are for the engineer's register.

## References

A reference names an entity, an attachment, a face, or an edge. Entities chain with
`of` from the innermost outward: `the stud of the lid`, `the top edge of the stud of
the lid`. The chain is right-recursive; there are no possessives (`the lid's stud` is
rejected). Words such as `top`, `front`, `center`, `side` are ordinary content words;
the binder resolves them as default attachments, so `the top of X`, `the top face of X`
and `the top front edge of X` are all one grammatical shape: a name run, an optional
classifier, and an `of` chain.

```
Reference       ::= RefHead ("of" Reference)?
RefHead         ::= "the" Name
                  | Quoted
                  | "its" Name
                    -- "its" = "of the current Subject"
                  | "the" ("first" | "last") Name
                    -- element of a counted declaration
                  | Name Integer
                    -- element by index: segment 2 of the stack

AttachmentRef   ::= ("the" | "its") Name Classifier? ("of" Reference)? ("at" Angle)?
                  | "the ground"
                  | ("face" | "edge") FeatureId ("of" Reference)?
                    -- Name resolves, in order, to: a declared attachment of the referenced
                    -- part; a default attachment word or pair/triple (top, top front,
                    -- top front left); a feature. "at" Angle parameterizes a round side.
Classifier      ::= "face" | "edge" | "corner"

FaceRef         ::= AttachmentRef        -- must resolve to a surface
EdgeRef         ::= ("the" | "its") Name ("and" Name)* ("edge" | "edges") ("of" Reference)?
                  | "edge" FeatureId ("of" Reference)?
                  | ("all" | "every") "edges"? "of" Reference ("except" EdgeList)?
                  | "edges from" Reference
                    -- lineage: edges that came from that feature after booleans
EdgeList        ::= EdgeRef ("and" EdgeRef)*

Axis            ::= AxisName | AttachmentRef
                    -- a datum axis or an axis attachment by name
Vector          ::= "(" Expression "," Expression "," Expression ")"
Angle           ::= Expression
                    -- degrees unless a unit is given
```

Examples:

```
the top of the base
the top face of the base
its bottom edge
its top and bottom edges
the top front left corner of the body
the side of the base at 162°
the top flange of the manifold
the riser line of the manifold
every edge of the stud except its bottom edge
edge E3 of the stud
edges from the pocket
the stud of the last segment of the stack
```

Rejected:

```
the base's top edge                      -- error: possessive; write "the top edge of the base"
the top of the top                       -- error: "top" is not a feature of this part
```

## Name

```
Name            ::= Quoted | ContentWord+
                    -- ends at the first function word, number-bearing token, symbol,
                    -- or end of line; see lexical.md, Names
```
