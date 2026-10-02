# gcad spec language: grammar documentation

Status: design draft, 2026-09-23. Z-up. Documents the syntax of the spec-style CAD language
(Proposal C of `docs/research/cad-spec-dsl-proposals-2026-09-09.md`, revised so that parts
are types, the scene is an unnamed part, and names may be multi-word and quoted).
Nothing here is implemented yet.

The grammar is documented in four layers, one file each. The split follows the parser
design: a hand-written recursive descent parser over a small lexer, with all name
resolution deferred to a separate binding pass that is *not* described here.

| File | Layer | Notation |
|---|---|---|
| [lexical.md](lexical.md) | Tokens, function words, reserved phrases, name rules | Token table with patterns |
| [grammar.md](grammar.md) | Sentence shapes: document, parts, declarations, attachment clauses and declarations, references | W3C-style EBNF |
| [templates.md](templates.md) | Closed vocabularies with typed slots: kinds, attachment kinds and defaults, predicates, assertions, patterns | Template tables |
| [expressions.md](expressions.md) | Arithmetic, units, comparisons, booleans | Precedence table |

## Notation legend

The EBNF is the W3C flavour used by the XML and Go specifications:

| Form | Meaning |
|---|---|
| `Name ::= …` | production |
| `"word"` | literal, matched case-insensitively |
| `A B` | sequence |
| `A \| B` | alternatives, tried top to bottom |
| `A?` `A*` `A+` | optional, zero-or-more, one-or-more |
| `( … )` | grouping |
| `-- text` | comment on the rule; the language uses the same marker for comments |
| `decides on: …` | the token the parser looks at to choose between alternatives |

Templates use `<slot>` for a typed slot; slot types are defined once in
[templates.md](templates.md#slot-types). Lexical patterns are regular expressions.

## How the grammar maps to the parser

Each EBNF production corresponds to one parse function of the same name. A reader who
wants to know how `AttachmentStatement` is parsed opens `parseAttachmentStatement`. The `decides on` notes are
the lookahead each function performs before committing to an alternative; there is no
backtracking beyond that lookahead except where a rule says so explicitly.

The parser never consults a symbol table. Names are runs of content words (or a quoted
string) and are bound to parts, features, parameters, and built-in kinds by a later pass.
This is why parts may be declared after they are used and why the grammar fits in four
short files.

## Examples and conformance

Every example sentence in these files is intended to become a row of a conformance corpus
(`docs/spec-language/corpus/`, not yet created) with its expected parse tree, so that the
documentation is checked against the parser. Near-miss examples marked *rejected* are
part of the corpus too, with the expected error.

Railroad diagrams for the recursive rules (`Reference`, `AttachmentRef`, `Expression`)
can be generated from `grammar.md` with the bottlecaps RR generator, which accepts this
EBNF dialect directly. They are not checked in.
