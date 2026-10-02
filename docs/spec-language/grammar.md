# Sentence-shape grammar

W3C-style EBNF over the tokens of [lexical.md](lexical.md). Every production is one
parse function. `decides on` names the lookahead that selects an alternative. Slot
vocabularies that are tables rather than rules (kinds and their parameters, predicate
templates, patterns) are in [templates.md](templates.md); `Expression` is in
[expressions.md](expressions.md).

Two rules shape every part: a declaration says what a thing is and how big
(`the stud is a male thread, dia = 29, pitch = 1.5, height = 3.5`), and the
`attachments` section says what it attaches to and how
(`the stud attaches to the base, with its bottom facing the top of the base`). There
is no placement information in a declaration. The language is Z-up: `top` is the +Z
face and `height` runs along Z.

## Document and parts

A document is the scene plus zero or more parts. The scene is every column-0 line that
is not a `part` header; a part is a `part` header plus the indented lines after it.
Parts are types: a part name used after `a`, `an`, or a count instantiates the part.
Parts may be declared in any order and after their first use.

```
Document        ::= Line*
                    -- Line: lexical.md, Lines. Column-0 statements form the Scene;
                    -- each PartHeader starts a Part
Scene           ::= Statement*
Part            ::= PartHeader Statement*
                    -- Statements indented under the header; any indentation, kept consistent
PartHeader      ::= "part" Name
                    -- the header owns the rest of the line, so the name may contain
                    -- function words; references to such a name must be quoted
```

Example:

```
part Pill Case Lid
  given od = 32, pitch = 1.5
  the cap    is a cylinder, dia = od, height = 8
  the socket is a female thread, dia = 29, pitch = pitch, depth = 4
  where the cap has fillet 1 on its top edge
  attachments
    the socket subtracts from the cap, with its bottom positioned at the bottom of the cap
    default is the bottom of the cap

given n = 3
the stack is n pill case segments, stacked along Z
the lid   is a pill case lid
attachments
  the lid attaches to the stack, with its socket facing the stud top of the last segment
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
                    -- "attachments", "for"; a Name followed by "=" is a ParameterDefinition;
                    -- "the" starts a Declaration or Predicate (decided at the verb, see
                    -- below), or under "require" an AssertionTemplate; anything else is
                    -- an Assertion

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
datum mid plane is the plane Z = 14
```

### Declarations

A declaration names a feature (inside a part) or an instance (in the scene) and gives
its kind, its arguments, and, for a counted declaration, its pattern. Singular
declarations use `is a`; counted declarations use `is` or `are` and a count
(`the vents are 4 holes`, `the stack is 3 segments`). Every kind,
built-in or part, takes its arguments the same way: `, name = value` pairs after the
kind. The parameter names of the built-in kinds are in templates.md; a part's are its
`given` names.

```
Declaration     ::= Subject ("is a" | "is an") Kind Arguments?
                  | Subject ("is" | "are") Count Kind Arguments? ("," Pattern)?
                    -- decides on the word after "is"/"are": "a"/"an" is a singular
                    -- declaration, a Count a counted one; anything else ("is joined",
                    -- "is knurled", "has fillet") makes the sentence a Predicate

Subject         ::= "the" Name
Kind            ::= Name
                    -- a run of content words ending at the comma; bound later to a
                    -- built-in kind or a part name
Count           ::= Integer | Name | "(" Expression ")"
                    -- a Name count is a single word; the Kind starts at the next word
Arguments       ::= ("," Argument)+
Argument        ::= Name "=" Value
                    -- decides on: after a ",", Name followed by "=" is an Argument;
                    -- a pattern word starts the Pattern; anything else is an error here
Value           ::= Triple | Expression | Reference | "through" | Thread | Quoted
                    -- Reference for sketch-valued parameters (profile = the outline)
Triple          ::= Expression "x" Expression ("x" Expression)?
                    -- 10 x 6 x 4 or 10x6x4; a size is x by y by z with Z up
Pattern         ::= see templates.md, Pattern templates
```

Examples:

```
the base   is a cylinder, dia = od, height = 28
the stud   is a male thread, dia = 29, pitch = 1.5, height = 3.5
the pocket is a bore, dia = od - 2 * (wall + 1.5), depth = 17
the tab    is a box, size = 10 x 4 x 6
the plate  is a box, width = 30, depth = 20, height = 5
the socket is a female thread, thread = M8x1.25, depth = 12
the vents  are 4 holes, dia = 1.5, depth = through, equally spaced on a circle with dia = 10
the lid    is a pill case lid, od = 40, vented = no
the riser  is a pipe stub, length = run / 2
```

The comma before the first argument is required: the kind phrase is a run of content
words and the comma is what ends it. Arguments may come in any order; a missing
required argument, an unknown name, or a value of the wrong kind (a boolean for a
length) is an error from the binder, which also suggests the nearest name. A counted
declaration's pattern lays its elements out around the group's own center; the group
is then attached as one thing.

Rejected:

```
the base is cylinder, dia = 32               -- error: expected "a" or "an" after "is"
the base is a cylinder dia = 32              -- error: "cylinder dia" is not a kind; write "a cylinder, dia = 32"
the base is a cylinder, 32 dia               -- error: arguments are name = value; write "dia = 32"
the base is a cylinder, dia = 32, on the top of the stand
                                             -- error: placement belongs in the attachments section
```

### Attachments section

The `attachments` section holds every attachment in a part or scene, the part's
attachment interface, and the part's default attachment. Four kinds of item.

```
AttachmentsSection  ::= "attachments" (AttachItem | NEWLINE AttachItem+)
AttachItem          ::= AttachmentStatement | AttachmentDecl | DefaultDecl | "plus the box defaults"
                        -- decides on the first word: "the" → statement;
                        -- surface/plane/point/axis/edge → declaration; "default" → default;
                        -- "plus" → box defaults
```

#### Attachment statements

An attachment statement names two peers: the subject and the thing it attaches to.
Both are declared in the current part or scene. Anything deeper, the subject's
subparts or the target's, is reached only inside the `with` refinement. To attach
something to a subpart as such, write the statement in the part that owns the subpart.

```
AttachmentStatement ::= Subject AttachVerb Reference WithClause? Modifier* Condition?
AttachVerb          ::= "attaches to" | "attach to"          -- union
                      | "subtracts from" | "subtract from"   -- subtraction
                        -- attach/attaches and subtract/subtracts are synonyms; the
                        -- singular and plural forms are not enforced
WithClause          ::= "," "with" Alignment ("and" Alignment)*
Alignment           ::= AttachmentRef AlignVerb (AttachmentRef | Direction)
                        -- AttachmentRef: References below. Left side is on the subject;
                        -- right side is on the target, a direction, or (after "aimed
                        -- at") anything in scope
AlignVerb           ::= "facing"        -- positions coincide, vectors anti-parallel
                      | "aligns with"   -- positions coincide, vectors parallel
                      | "positioned at" -- positions coincide, orientation untouched
                      | "aimed at"      -- vector points toward the target's position;
                                        --   position must already be fixed
Direction           ::= ("+" | "-") AxisName                      -- global
                      | "front" | "back" | "left" | "right" | "up" | "down"
                                                                  -- relative to the subject
Modifier            ::= "," ("sunk" | "proud" | "slid") Quantity
                      | "," "turned" Angle
Condition           ::= "," ("only if" | "unless") Expression
```

Rules:

- **Resolution.** On the left of an alignment verb, `its` means the subject and a bare
  `the X` is the subject's subpart or interface. On the right, `its` means the target;
  a bare name resolves in order to the target's declared interface, then the target's
  subparts, then peers in the current scope; when more than one matches, the reference
  must be qualified (`the top of the flange of the manifold`). `of` chains may go
  arbitrarily deep. A name with no attachment point given (`its inlet`) means that
  subpart's default attachment point (see Default attachment below).
- **Degrees of freedom.** Alignments apply left to right, and each one constrains only
  the degrees of freedom still free. `facing` and `aligns with` fix position and the
  normal, and set the spin so the two tangents line up; that spin is a default, which a
  later `aimed at` or a `turned` overrides. `positioned at` fixes position only and
  ignores both vectors; `aimed at` fixes spin only and requires the position to be fixed
  already. A `facing` after a `positioned at` finds the position taken and aligns the
  normal only. An alignment with nothing left to constrain is an error. After all
  alignments, `turned` spins the subject about the first alignment's normal, `sunk` and
  `proud` move it along that normal, and `slid` moves it along the target attachment's
  tangent (negative slides the other way).
- **No `with`.** The subject's default attachment point faces the target's default
  attachment point.
- **No statement.** A positive kind sits at its part's origin in its default pose. A
  cutting kind (bore, hole, pocket, slot, female thread) with no statement is an error;
  it must `subtract from` something. `attaches to` on a cutting kind is an error.
- **Condition.** `, only if <expr>` or `, unless <expr>` makes the whole statement, and therefore the
  subject's presence in the part, conditional.

Examples:

```
attachments
  the stud   attaches to the base, with its bottom facing the top of the base, sunk 0.5
  the cavity subtracts from the base, with its bottom positioned at the bottom of the base
  the pocket subtracts from the stud, with its top positioned at the top of the stud
  the vents  subtract from the base, with its center positioned at the floor of the pocket, only if vented
  the lug    attaches to the base, with its back facing the side of the base at 90° and its top aimed at +Z
  the valve  attaches to the manifold, with its inlet facing the top flange and its front aimed at the pump
  the gauge  attaches to the manifold, with its stem facing the end of the riser, sunk 12
  the label  attaches to the manifold, with the bottom right corner of its plate positioned at the top left corner of the flange
  the cover  attaches to the manifold, with its bottom aligns with the mount plane, proud 0.5
  the pump   attaches to the manifold, with its foot positioned at the base mount, turned 90
  the bracket attaches to the body, with its bottom facing the top front edge of the body           -- tilted into the corner
  the pin    attaches to the lid, with its axis aligns with the back top edge of the lid, slid 10   -- hinge pin along the edge
  the trim   attaches to the panel, with its lip aligns with the top front edge of the panel     -- lip: an edge the Trim part declares
  the strip  attaches to the body, with its bottom front edge positioned at the top front edge of the body and its bottom facing the top of the body
  the cap    attaches to the box, with its bottom back left corner positioned at the top back left corner of the box and its bottom facing the top of the box
  the big one attaches to the stack                          -- default point facing default point
```

Rejected:

```
  the valve attaches to the flange of the manifold
        -- error: attach to a peer; to attach to the flange itself, do it inside the Junction part
  the valve attaches to the manifold, with its front aimed at the pump
        -- error: "aimed at" needs the position fixed first; add a facing or positioned alignment
  the pocket attaches to the stud, with its top positioned at the top of the stud
        -- error: a bore must "subtract from"
  the pocket subtracts from the stud, with its top positioned at the top of the stud, sunk 1
        -- error: "sunk" has no meaning for a subtraction
  the trim attaches to the panel, with its lip aligns with the front edge of the panel
        -- error: "front edge" names four edges of a box; write a pair such as "top front edge"
```

#### Attachment declarations

A part's attachments are its interface. They are declared by aliasing or constructing
from the attachments of the part's constituents (primitive faces, or a sub-part's own
declared attachments). Every definition may use the part's `given` parameters, so an
instance with its own arguments gets its own attachment geometry. Attachment kinds are
in templates.md; each is a frame, a position with a normal and a tangent, which is all
an alignment needs.

```
AttachmentDecl     ::= AttachKind Name "is" AttachDef ("," FrameModifier)*
AttachKind         ::= "surface" | "plane" | "point" | "axis" | "edge"
                       -- decides on the first word; surface/plane/point/axis are
                       -- content words used positionally, edge is a function word
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
                       -- "facing" overrides the normal, "up along" the tangent
```

The declared kind must match what the definition yields (a `surface` may not alias an
edge); the binder checks this. Declared names may not reuse a default attachment
word (`top`, `side`, `axis`, …; the list is in lexical.md, Function words) but may
contain them (`top flange`). Surfaces are whole faces; there are no surface regions.

#### Default attachment and the part frame

```
DefaultDecl        ::= "default is" AttachmentRef ("," "turned" Angle)?
```

Every part and primitive has a default attachment point, used when a statement has no
`with` and when a subpart is named without an attachment point (`its inlet`). Without a
`default` line it is the bounding-box center with a look vector of +X and an up vector
of +Z in the part's authored frame. A `default` line makes it the named attachment: its
position, and its vector as the look vector. The up vector is derived, never written:
take the shortest-arc rotation that carries +X onto the look vector and apply it to +Z.
If the look is exactly -X, the rotation is a half turn about Z, so up stays +Z.
`turned` then spins the up vector about the look.

The relative directions used in alignments come from that frame: `front` is the look
vector, `back` its opposite, `up` and `down` the up vector and its opposite, `right`
is front × up and `left` its opposite. With the defaults, left is +Y and right is -Y.

Example:

```
part Pipe Stub
  given od = 20, wall = 2, length = 40
  the tube is a cylinder, dia = od, height = length
  the bore is a bore, dia = od - 2 * wall, depth = through
  attachments
    the bore subtracts from the tube, with its center positioned at the center of the tube
    surface end  is the top of the tube
    surface root is the bottom of the tube
    axis    line is the axis of the tube
    default is the root

part Junction
  given run = 60, index inset = 4
  the body   is a box, size = run x 24 x 24
  the riser  is a pipe stub
  the branch is a pipe stub, length = 25
  the flange is a disc, dia = 36, thickness = 4
  the foot   is a box, size = 30 x 24 x 6

  attachments
    the riser  attaches to the body, with its root facing the top of the body
    the branch attaches to the body, with its root facing the back of the body
    the flange attaches to the riser, with its bottom facing the end of the riser
    the foot   attaches to the body, with its top facing the bottom of the body

    surface top flange   is the top of the flange
    surface base mount   is the bottom of the foot
    surface back mount   is the back of the body
    plane   mount plane  is the plane of the back of the body
    axis    riser line   is the line of the riser                 -- a sub-part's attachment
    point   corner index is on the top of the body, index inset from its top front edge and index inset from its top left edge
    edge    grip         is the top front edge of the body
    default is the base mount
    plus the box defaults
```

Defaults: a part that declares no attachments gets the box set from its bounding box
(`top`, `bottom`, `left`, `right`, `front`, `back`, `center`, the 12 edges, the 8
corners). A part that declares any gets only those unless it says `plus the box
defaults`. Primitives always have their catalog set (a cylinder's `side` and `axis`, an
extrusion's named side faces). Reaching inside a part with an `of` chain is normal in
alignments; it is what the `with` clause is for.

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
  the rib i is a box, size = 2 x 10 x 20
attachments
  for each i from 1 to n:
    the rib i attaches to the plate, with its bottom facing the top of the plate, turned i * 30
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
                    -- Name may be quoted: the "top of the line"
                  | "its" Name
                    -- "its" = "of the subject" on the left of an alignment verb and in
                    -- predicates; "of the target" on the right of an alignment verb
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
                  | ("all" | "every") ("edge" | "edges")? "of" Reference ("except" EdgeList)?
                  | "edges from" Reference
                    -- lineage: edges that came from that feature after booleans
EdgeList        ::= EdgeRef ("and" EdgeRef)*
                    -- a default box edge is always named by a pair (top front, back left);
                    -- a single word such as "front edge" is an error listing the candidates

Axis            ::= AxisName | AttachmentRef
                    -- a datum axis or an axis attachment by name
Vector          ::= "(" Expression "," Expression "," Expression ")"
Angle           ::= Expression
                    -- degrees unless a unit is given
Quantity        ::= Expression
                    -- a length; a bare number takes the file unit
Comparison      ::= "=" | "/=" | "<" | "<=" | ">" | ">=" | "≠" | "≤" | "≥"
                    -- expressions.md, precedence level 6
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
the stud top of the last segment of the stack
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
