# Sentence-shape grammar

W3C-style EBNF over the tokens of [lexical.md](lexical.md). Every production is one
parse function. `decides on` names the lookahead that selects an alternative. Slot
vocabularies that are tables rather than rules (kinds, predicate templates, patterns)
are in [templates.md](templates.md); `Expression` is in [expressions.md](expressions.md).

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
  the cap    is a cylinder Ø od, 8 tall, standing on the ground
  the socket is a female thread Ø29 x pitch, 4 deep, entering from the bottom face of the cap
  where the cap has fillet R1 on its top edge

given n = 3
the stack is n pill case segments stacked along Y
the lid   is a pill case lid, seated on the stud of the last segment of the stack
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
                  | ForEach
                    -- decides on the first token: "units", "use", a section word, "datum",
                    -- "for"; otherwise "the"/Quoted starts a Declaration or Predicate
                    -- (decided at the verb, see below); a Name followed by "=" is a
                    -- ParameterDefinition; anything else is an Assertion

UnitsStatement  ::= "units" Unit
                    -- default unit for bare numbers in this part or scene; default mm
UseStatement    ::= "use" Quoted
                    -- imports the parts of another document; reserved, not yet specified
```

### Sections

Section headers group statements for the reader and tell the parser which statement
kinds to expect. `given` items and `require` items are only legal under their headers.
`where` is optional: predicates are also accepted directly among declarations.

```
SectionHeader   ::= "given"   ParameterDefinition?
                  | "where"   Predicate?
                  | "require" Assertion?
                    -- the first item may share the header's line
```

### Parameters and datums

```
ParameterDefinition ::= Name "=" Expression ("," Name "=" Expression)*
                        -- under "given" only; within a part these are the part's
                        -- parameters with defaults, overridable by a WithClause

DatumDeclaration ::= "datum" Name "is" DatumSpec
DatumSpec        ::= FaceRef
                   | "the plane" AxisName "=" Expression
                   | "the" AxisName "axis" ("through" Reference)?
```

Examples:

```
given od = 32, wall = 1.5, pitch = 1.5, vented = yes
given
  od   = 32
  wall = 1.5
datum A is the bottom face of the base
datum mid plane is the plane Y = 14
```

### Declarations

A declaration names a feature (inside a part) or an instance (in the scene) and gives
its kind, dimensions, and clauses. Singular declarations use `is a`; counted
declarations use `are` and a count, and usually end with a pattern clause.

```
Declaration     ::= Subject ("is a" | "is an") Kind Details
                  | Subject "are" Count Kind Details
                    -- decides on "is"/"are"; a Subject followed by any other verb
                    -- is a Predicate

Subject         ::= "the" Name
Kind            ::= Name
                    -- bound later to a built-in kind (templates.md) or a part name
Count           ::= Integer | Name | "(" Expression ")"
Details         ::= DimensionList? ("," Clause)*
                    -- after each ",": decides on Ø, R, a number, or "through" not
                    -- followed by "the" → Dimension; otherwise → Clause
```

Examples:

```
the base   is a cylinder Ø od, 28 tall, standing on the ground
the pocket is a bore Ø(od - 2 * (wall + 1.5)), 17 deep, entering from the top face of the stud
the vents  are 4 holes Ø1.5 through the floor of the pocket, equally spaced on a Ø10 bolt circle
the lid    is a pill case lid, seated on the stud of the base, with od = 40, vented = no
```

Rejected:

```
the base is cylinder Ø32                 -- error: expected "a" or "an" after "is"
the base is a cylinder 32                -- error: bare number needs a dimension word (28 tall) or Ø/R
```

### Dimensions

Dimensions carry their own prefix or suffix word, so they need no separator from the
kind phrase. A bare number is never a dimension by itself.

```
DimensionList   ::= Dimension ("," Dimension)*
Dimension       ::= Dia Primary ("x" Primary)?
                    -- diameter; "x" gives a thread pitch (Ø29 x pitch)
                  | Rad Primary
                    -- radius, no space after R
                  | Quantity DimWord
                    -- 28 tall, 2 * pitch + 0.5 mm tall, 17 deep
                  | Primary "x" Primary ("x" Primary)?
                    -- box sides: 30 x 20 x 5 (wide x deep x tall)
                  | "through"
                    -- depth word for cuts; decides on: not followed by "the"/Quoted,
                    -- otherwise it is the "through" Placement
Quantity        ::= Expression
DimWord         ::= "tall" | "long" | "high" | "wide" | "deep" | "thick" | "across"
```

`Primary` is the expression layer's atom: a number with optional unit, a name, or a
parenthesized expression. `Ø od - 2 * wall` is therefore an error; write
`Ø(od - 2 * wall)`.

### Clauses

Clauses follow the dimensions, each introduced by a comma and a keyword.

```
Clause          ::= Placement | Pattern | WithClause | Condition
                    -- decides on the first word after the comma

Placement       ::= "standing on"  Reference
                  | "seated on"    Reference
                  | "entering from" Reference
                  | "through"      Reference
                  | "cut from"     Reference
                  | "added to"     Reference
                  | "joined to"    Reference "with a" Blend
                  | "centered on"  Reference
                  | "at"           Vector
                  | Quantity Direction Reference
                    -- 60 to the right of the stack
                  | "rotated" Angle "about" Axis
                  | "about" Axis
Direction       ::= "to the right of" | "to the left of" | "above" | "below"
                  | "in front of" | "behind"

Pattern         ::= see templates.md, Pattern templates
WithClause      ::= "with" Name "=" Expression ("," Name "=" Expression)*
                    -- after each ",": decides on Name "=" → another assignment,
                    -- otherwise the comma starts the next Clause
Condition       ::= "only if" Expression
Blend           ::= ("round" | "soft" | "chamfer") "blend" Size
Size            ::= Rad Primary | Primary
```

Placement semantics in one line each: `standing on` puts the bottom face on the
reference, `seated on` is the same for instances of parts, `entering from` starts a cut
at that face going inward, `through` makes a cut pass through, `cut from` and
`added to` are explicit subtract and union of an arbitrary kind, `joined to … with`
is a blended union. A positive built-in kind with no placement is added to its part;
a cutting kind (bore, hole, pocket, slot, female thread) with no placement is an error.

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
indentation. The bound name is a number parameter inside the body.

```
ForEach         ::= "for each" Name "from" Expression "to" Expression ":" Block
Block           ::= Statement+
                    -- indented deeper than the "for each" line
```

Example:

```
for each i from 1 to n:
  the rib i is a box 2 x 10 x 20, at (0, 0, i * 6)
```

Prefer a pattern clause when one fits; loops are for the engineer's register.

## References

A reference names an entity, a face, or an edge. Entities chain with `of` from the
innermost outward: `the stud of the lid`, `the top edge of the stud of the lid`.
The chain is right-recursive; there are no possessives (`the lid's stud` is rejected).

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

FaceRef         ::= ("the" | "its") FaceWord "face"? ("of" Reference)?
                  | "the ground"
                  | "face" FeatureId ("of" Reference)?
FaceWord        ::= "top" | "bottom" | "left" | "right" | "front" | "back"
                  | "outside" | "inside" | "floor"

EdgeRef         ::= ("the" | "its") EdgeSel ("edge" | "edges") ("of" Reference)?
                  | "edge" FeatureId ("of" Reference)?
                  | ("all" | "every") "edges"? "of" Reference ("except" EdgeList)?
                  | "edges from" Reference
                    -- lineage: edges that came from that feature after booleans
EdgeSel         ::= EdgeWord ("and" EdgeWord)*
                    -- its top and bottom edges
EdgeWord        ::= "top" | "bottom" | "left" | "right" | "front" | "back"
                  | "outer" | "inner"
EdgeList        ::= EdgeRef ("and" EdgeRef)*

Axis            ::= AxisName | Reference
                    -- a datum axis by name
Vector          ::= "(" Expression "," Expression "," Expression ")"
Angle           ::= Expression
                    -- degrees unless a unit is given
```

Examples:

```
the top face of the base
its bottom edge
its top and bottom edges
every edge of the stud except its bottom edge
edge E3 of the stud
edges from the pocket
the stud of the last segment of the stack
```

Rejected:

```
the base's top edge                      -- error: possessive; write "the top edge of the base"
the top of the base                      -- error: "top" needs "face" or "edge"
```

## Name

```
Name            ::= Quoted | ContentWord+
                    -- ends at the first function word, number-bearing token, symbol,
                    -- or end of line; see lexical.md, Names
```
