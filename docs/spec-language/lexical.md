# Lexical layer

The lexer turns a document into lines and each line into tokens. It knows nothing about
parts, features, or kinds. Its only language-specific knowledge is the list of function
words and reserved phrases at the end of this file.

## Lines

| Rule | Detail |
|---|---|
| Statement terminator | end of line |
| Continuation | a line whose last token is `,` continues on the next non-blank line |
| Comment | `--` to end of line; ignored, may follow a statement |
| Condition | `, only if …` or `, unless …` at the end of an attachment statement; the comma and the keyword together introduce it (grammar.md, `Condition`) |
| Blank line | ignored |
| Indentation | measured in leading spaces; tabs are an error |
| Column 0 | belongs to the scene, or is a `part` header |
| Indented | belongs to the most recent `part` header |
| Deeper indentation | only meaningful after a `for each … :` header (see grammar.md) |

Example:

```
the stud   is a male thread, dia = 29, pitch = pitch,   -- continues
           height = 2 * pitch + 0.5 mm
```

## Tokens

Longer patterns are tried first. Whitespace separates tokens except where a pattern says
"no space".

| Token | Pattern | Examples | Notes |
|---|---|---|---|
| `Integer` | `[0-9]+` | `4`, `72` | |
| `Decimal` | `[0-9]+\.[0-9]+` or `\.[0-9]+` or `[0-9]+` | `0.3`, `.3`, `28` | an `Integer` is also a `Decimal` where a number is expected |
| `Fraction` | `[0-9]+/[0-9]+` | `1/4`, `3/8` | value only; not a thread |
| `Inch` | `Decimal"` no space | `2"`, `.5"` | the `"` is an inch mark only directly after a digit |
| `Unit` | one of `mm` `cm` `m` `in` `inch` `inches` `deg` `°` `rad` | `0.5 mm`, `45 deg` | attaches to the preceding number in the expression layer |
| `Count` | `Integer` + `X` no space, or `Integer` + `×` | `4X`, `4 ×` | drawing-note repetition count |
| `Thread` | `[0-9]+/[0-9]+-[0-9]+ (UNC\|UNF\|UNEF)(-[0-9][AB])?` or `[0-9.]+-[0-9]+ (UNC\|UNF)(-[0-9][AB])?` or `M[0-9]+(\.[0-9]+)?x[0-9]+(\.[0-9]+)?(-[0-9][gHh])?` | `1/4-20 UNC-2B`, `M8x1.25-6H` | one token; the space before the series is part of the pattern |
| `FeatureId` | `E[0-9]+` or `F[0-9]+` | `E3`, `F1` | raw catalog id; content word otherwise |
| `AxisName` | `X` `Y` `Z` as a whole word | `along Z` | Z is up |
| `Cross` | `x` or `×` between two numbers or as a whole word inside a value | `10x6x4`, `10 x 6 x 4` | the triple separator; `x` is a function word |
| `QuotedName` | `"[^"\n]+"` | `"top of the line"` | any characters except quote and newline; see Names |
| `Text` | same pattern as `QuotedName` | `"MADE IN"` | which one it is depends on the slot; the lexer emits one `Quoted` token |
| `Symbol` | one of `, ( ) = + - * / ^ < > <= >= /= ≤ ≥ ≠ :` | | |
| `Word` | `[A-Za-z][A-Za-z0-9_-]*` | `pocket`, `M8`, `case`, `dia` | classified as `FunctionWord` if in the list below, else `ContentWord`; no apostrophe, so a possessive (`lid's`) is a lexical error |

Number-bearing tokens (`Integer`, `Decimal`, `Fraction`, `Inch`, `Count`, `Thread`,
`FeatureId`) never form part of a bare name. A kind phrase ends at the comma that
precedes its first argument: `a cylinder, dia = 32`. There are no dimension words and
no symbolic prefixes; every size is a named argument, and the parameter names of the
built-in kinds (`dia`, `radius`, `height`, `pitch`, `size`, …) are ordinary content
words, so a parameter of a part may use any of them too.

## Names

A bare name is one or more `ContentWord`s. It ends at the first function word,
number-bearing token, symbol, or end of line. A quoted name is a single `Quoted` token
and may contain anything except a quote or newline.

| Rule | Detail |
|---|---|
| Case | names are compared case-insensitively and displayed as first written |
| Duplicates | two names in one scope that differ only in case are an error |
| Function words | not allowed in a bare name; use quotes: `"top of the line"` |
| Numbers | not allowed as a standalone word in a bare name (`8 mm nut` needs quotes); allowed inside a word (`M8 nut` is fine) |
| Reserved phrases | a part may not be named with a built-in kind phrase or a prefix of one (`thread`, `male thread`, `box`) |
| Plurals | a bare kind after a count may be plural; the binder singularizes the last word (`segments` → `segment`). Quoted names are never singularized |
| Quotes at declaration | optional; the `part` header owns the whole line so it never needs them. The binder warns when a part name contains a function word so the author learns that references must be quoted |

Examples:

```
part Pill Case Segment                         -- bare, three words
part top of the line                           -- legal header; references must be quoted
the base is a pill case segment                -- bare reference, case-folded
the base is a "Top Of The Line"                -- quoted reference, case-folded
the stack is 3 pill case segments, stacked along Z  -- plural, singularized by the binder
the stack is 3 "top of the line", stacked along Z   -- quoted names do not pluralize
```

Rejected:

```
the base is a top of the line                  -- error: "of" ends the name; did you mean "top of the line"?
the base is a 8 mm nut                         -- error: a name cannot start with a number; quote it
```

## Function words

These words can never be part of a bare name. They are the whole of the parser's fixed
vocabulary; everything else is a content word.

| Group | Words |
|---|---|
| Determiners | `the` `a` `an` `its` `each` `every` `all` |
| Copulas and verbs | `is` `are` `has` |
| Prepositions | `of` `on` `from` `with` `to` `through` `about` `at` `along` `by` `except` |
| Connectives | `and` `or` `not` `if` `only` `unless` |
| Sections and headers | `part` `given` `where` `require` `datum` `units` `use` `for` |
| Classifier words | `face` `faces` `edge` `edges` `corner` `ground` |
| Attachment words | `attachments` `attaches` `attach` `subtracts` `subtract` `facing` `aligns` `positioned` `aimed` `default` `sunk` `proud` `slid` `turned` `plus` `defaults` `outward` `midway` `between` `meets` |
| Pattern words | `centered` `stacked` `spaced` `equally` `circle` `joined` `x` |
| Treatment words | `fillet` `chamfer` `blend` `round` `soft` `knurled` `engraved` `hollowed` `open` `broken` `twisted` `tapered` |
| Assertion words | `clears` `fits` `do` `does` `touch` |
| Quantifier and order words | `first` `last` `least` `most` |
| Boolean literals | `yes` `no` `true` `false` |
| Axis letters | `X` `Y` `Z` |
| Units | `mm` `cm` `m` `in` `inch` `inches` `deg` `rad` |
| Expression words | `sqrt` `sin` `cos` `tan` `atan` `min` `max` `abs` |

Default attachment words (`top`, `bottom`, `left`, `right`, `front`, `back`, `center`,
`side`, `outside`, `inside`, `floor`, `axis`; the set is the default table in
templates.md, Attachment kinds) are content words, resolved by the binder. The face
words, plus `up` and `down`, are relative directions after `facing`, `aligns with`, and
`aimed at` when they appear bare, without `the` or `its` (`facing up`, `aimed at front`);
the global directions are `+X` `-X` `+Y` `-Y` `+Z` `-Z`. Default attachment words may
appear inside a name (`top flange`) but a feature or attachment may not be named exactly
one of them. The attachment kind words `surface`, `plane`, `point`, `axis` are positional
(they start an attachment declaration) and are also content words, so `mount plane` and
`riser axis` are legal names; `edge` is a classifier word, so an attachment named
`inner edge` must be quoted. Parameter and template words such as `dia`, `spacing`, and
`ridges` are content words that the template matcher compares literally.

## Reserved phrases

Built-in kind phrases are made of content words but are reserved as whole phrases. A
part may not be named with one of them or with a prefix of one. The list is the Kinds
table in [templates.md](templates.md#kinds).

`cylinder` `box` `sphere` `cone` `capsule` `torus` `disc` `hex prism` `bore`
`hole` `holes` `pocket` `slot` `male thread` `female thread` `extrusion` `revolution`
`loft`
