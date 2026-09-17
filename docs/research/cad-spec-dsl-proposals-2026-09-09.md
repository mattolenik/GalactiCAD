# A spec-style CAD language for gcad: research and five syntax proposals

Date: 2026-09-09. Scope: language design only (syntax, vocabulary, semantics). No implementation.

Method: a deep-research workflow (107 agents, 25 sources fetched, 125 claims extracted,
25 adversarially verified with 3 votes each, 22 confirmed, 3 killed). Findings marked
**[verified]** survived 3-0 verification against the source text. Material marked
**[notes]** comes from the search agents' reading notes and was not independently
verified. Material marked **[domain]** is my own domain knowledge (APT, drawing practice)
and should be checked against the standards before it becomes a keyword list.

The five proposals at the end are design work grounded in the findings, not sourced facts.

---

## 0. TL;DR

- **Word choice does not make a language natural; sentence structure does.** Kuhn's survey
  of 100 controlled natural languages rejects COBOL as a CNL precisely because it uses
  natural phrases inside an unnatural statement skeleton **[verified]**. "subtract X from
  Y" wrapped in call syntax would fail the same test.
- **Naturalness trades against precision and simplicity** (Spearman ρ −0.67 and −0.76
  across the 100 CNLs) **[verified]**. We must choose a point on that curve on purpose.
- **"Reads well, can't be written" is the documented failure of every prose-like language**:
  HyperTalk ("read-only language"), AppleScript (worse), Inform 7 (an hour for a clock),
  and Lamport's own warning about PlusCal **[verified + notes]**. The mitigation that
  worked is a small, regular "pidgin" register with fixed sentence templates (HyperTalk
  defenders, ACE, Gherkin), not open-ended English mimicry.
- **Machinists already have a controlled language**: the drawing note.
  `4X Ø6 THRU EQ SP ON Ø28 BC`, `DRILL & TAP 1/4-20 UNC-2B THRU`, `BREAK ALL SHARP EDGES
  .015 MAX`, and the traveler line `Face and turn shoulder to 42.00 dia x 15.00 long`
  **[notes/domain]**. Its grammar is count-prefix + feature + dimensions + depth + pattern +
  reference. It is precise, terse, writable, and already read fluently on the shop floor.
- **Formal methods contribute structure, not syntax**: Z schemas (named block, declaration
  part, `where` predicate part, composable) **[verified]**, quantified English-like forms over
  point-free combinators (Jackson) **[verified]**, prose that stands alone with the formal
  text as arbiter (Bowen) **[verified]**, and "state what changes, everything else stays"
  frame conditions (TLA+) **[notes]**.
- **Code-CAD lessons**: define-don't-mutate and patterns-not-loops (KCL) **[verified]**;
  first-class, queryable shape values (Curv) **[verified]**; first-class lineage-based
  references with Selectability/Smoothness/Distinguishability (PLDI 2023) **[verified]**;
  determinism as a reason to own the language (FeatureScript) **[notes]**.
- **PEG is fine for this** if we accept its rules: ordered choice must list the longer
  phrasing first ("drill and tap" before "drill"); ambiguity never surfaces, it is silently
  decided by rule order, so we need a parse corpus; left recursion (possessive chains,
  `and` lists) must be right-recursed exactly as ACE did; indentation can live in the
  grammar (Adams-Ağacan) but needs a toolkit that supports it **[verified]**.
- **Recommendation**: start from Proposal B (process plan) fused with Proposal A's callout
  sublanguage for holes/patterns/edges and Proposal C's `given`/`where` header for
  parameters and constraints. Prototype the grammar against a 50-sentence corpus before
  committing (see §8).

---

## 1. What the evidence says

### 1.1 How machinists and engineers write about parts

No claim about drawing-note vocabulary survived strict verification (the standards
themselves were not fetched), so this section is **[notes]** plus **[domain]**.

**Drawing notes have a fixed sentence shape.** Bolt circles on Eng-Tips are written
`12X 1/4-20 UNC-2B THRU / EQ SP ON Ø12.00 BC` **[notes]**. The shape is:

    [count]X  [feature spec]  [depth]  [spacing rule]  ON  [reference]

The count prefix `nX` has no whitespace, and recent ASME Y14.5 revisions prefer explicit
counts over `TYP` **[notes]**. `EQUALLY SPACED` (one hole located angularly) is
distinguished from `SPACED AS SHOWN` **[notes]**. ASME Y14.38 abbreviates it `EQLSP`; the
shop writes `EQ SP` **[notes]**.

**The lexicon is small and attaches to a dimension**: THRU, DEEP/DP, TYP, EQ SP, BC, CBORE
(⌴), CSK (⌵), SF (spotface), Ø/DIA, R, TAP, REF, MAX/MIN, A/F (across flats), UNC/UNF,
BREAK SHARP EDGES, FAO (finish all over) **[notes]**. Thread callouts are positional
tokens: `1/4-20 UNC-2B` (size, TPI, series, class, B=internal/A=external) and
`M8x1.25-6H` **[notes]**. These tokens contain slashes, dashes, and `x`, so they must be
lexed as single units.

**Travelers/route sheets are verb-first imperatives with "to" dimensions** **[notes]**:

    Op 10 Lathe: Face end (approx 3 mm). Rough turn to 52.00 dia. Finish turn to 50.00 dia.
          Face and turn shoulder to 42.00 dia x 15.00 long.
    Op 20: Reverse end, face to 200.00 length, drill 4 radial holes 7.50 dia.

The recurring devices: `Op nn` numbering, verb-first (`face`, `turn`, `drill`, `bore`,
`ream`, `tap`, `chamfer`, `break`), `to <dim>` for the target size, `<dia> x <length>
long`, `<n> holes <dia>`. This is already a process-plan DSL; it maps to CSG as
stock-minus-cuts.

**APT (1950s-60s numerically controlled part programming) [domain, not fetched]**: each
statement is a *major word* before a slash and comma-separated *minor words* after it:
`CIRCLE/CENTER, P1, RADIUS, 2.0`, `GOLFT/L1, TANTO, C1`, `FROM/SETPT`, `FEDRAT/10`,
`SPINDL/ON`. Geometry statements are declarative and named (`L1 = LINE/P1, P2`); motion
statements are imperative. APT's lesson: a keyword-headed line with a fixed slot layout
was writable by shop programmers for decades, but it reads as a code list, not prose. The
major/minor-word convention is essentially Gherkin's keyword-frame idea sixty years early.

### 1.2 Natural-language-like languages: what worked and what didn't

- **Kuhn 2014 [verified]**: CNL = a constructed language based on a natural language,
  more restrictive in lexicon/syntax/semantics, preserving most natural properties. COBOL
  is *not* one (P5 E2 N2 S3): natural phrases, formal statement structure. Across 100
  CNLs: precision/simplicity ρ 0.90, expressiveness/simplicity −0.82,
  naturalness/simplicity −0.76, precision/naturalness −0.67. Simplicity here means "pages
  needed to describe the language", i.e. our grammar size.
- **Gherkin [notes]**: P5 naturalness N4 by fixing only structuring keywords
  (Given/When/Then/And/But) and leaving step text to application-defined patterns. Its
  parser is a line-oriented scanner classifying each line by its leading keyword, plus a
  small generated grammar; step bodies are opaque. Cheap and robust.
- **ACE [verified]**: the most mature CNL with a real parser. It fixes what English leaves
  open: quantifier scope by surface order (opens at the noun phrase, extends to sentence
  end), `and` binds tighter than `or` and both are right-associative, `comma-and` /
  `comma-or` exist solely to flip precedence (punctuation as grouping in place of
  parentheses), conditionals are rigid `if … then …`, negation is a fixed multi-word form.
  Its DCG parser could not run left-recursive rules, so possessives and coordination were
  rewritten as linguistically unmotivated right-recursive "tail" rules. A PEG hits the same
  wall.
- **Inform 7 [verified + notes]**: builds a shallow annotated syntax tree first, then
  resolves assertion sentences into a world model in a later pass, and compiles phrase
  bodies later still. Meaning is deferred past parsing. The critique: reading it is
  pleasant, writing it is hard because the user's mental model is "this is English" and
  plausible sentences get rejected, violating least surprise; a periodic-condition feature
  took an experienced programmer an hour.
- **HyperTalk / AppleScript [notes]**: "notoriously a read-only language"; AppleScript
  went further into English and was harder to write. Defenders: once you see it as a
  constrained *pidgin* with regular phrasing, guessing the right form is easy, and
  constructs like `if there is a file "x" then` were discoverable by trial. Lesson: a
  small, regular register is writable; open-ended English is not.
- **PlusCal [verified]**: "Being easy to read does not necessarily make PlusCal easy to
  write. Like any powerful language, PlusCal has rules and restrictions that are not
  immediately obvious." PlusCal ships two surface syntaxes over one semantics, a prolix
  p-syntax and a compact c-syntax **[notes]**. Lamport also argues for keeping familiar
  control constructs (if/then, while) rather than novel ones.
- **Dijkstra 1978 [notes]**: English-like syntax trades precision for ambiguity and
  verbosity without making programs easier to understand. The counter-position in the
  discussion: NL-shaped syntax must still "do exactly", and the implied promise that the
  system will "understand you" is itself the source of frustration.

### 1.3 Formal specification languages: stylistic devices worth stealing

- **Z schemas [verified]**: raw mathematics does not scale for readers, so Z adds named,
  composable units with a declaration part separated from a predicate (`where`) part,
  combinable by schema operators and inclusion. Bowen credits this with making Z more
  readable than VDM. Literate style: the prose should still read if the formal parts are
  removed; on conflict, the formal text is the arbiter. Clarity beats brevity; redundancy
  is fine if it aids understanding.
- **Alloy [verified]**: Jackson found Z "Sorensen shorties" terse, elegant, and "rarely
  natural"; novices produce quantified forms (`all h: Hole | …`), so Alloy adopted them.
  Alloy is signatures + relations + named `fact` constraints; text is primary and diagrams
  are a strict subset **[notes]**. Designed to be lightweight, precise, tractable.
- **TLA+ [notes]**: a spec is a single declarative formula, "the system is X such that Y";
  refinement is implication; frame conditions (`unchanged x`) let a spec state only what
  changes.
- **B / Event-B [notes]**: refinement as the core idiom, rough-to-detailed layering.
- **What this gives a CAD spec**: a header of parameters and named datums; named feature
  blocks; a `where`/`such that` clause for constraints and invariants (`wall ≥ 1.2 mm`);
  quantified phrasing for patterns ("for each of the 4 holes", "every edge of the pocket");
  and "everything else unchanged" as the default when an operation touches one feature.

### 1.4 Code-CAD languages: lessons

- **KCL (Zoo) [verified]**: aimed at the same dual audience (mechanical engineers with
  little code + advanced programmers). Functional and effectively immutable; "variables
  are not updated or looped over"; repetition via patterns and map/reduce; immutability is
  justified by IDE features such as clicking an edge in the viewer to jump to the source
  that made it. Zoo admits the beginner/expert balance is hard and plans user testing.
  KCL units **[notes]**: unit-bearing literals (`42mm`, `2in`), per-file default units,
  and explicitly *no* full dimensional analysis through arithmetic.
- **Curv [verified]**: conceived as "a next generation redesign of OpenSCAD" because
  OpenSCAD's language was "weak and complicated": three namespaces, functions vs modules,
  lists vs groups, no shape values, no shape introspection. Goals: first-class function
  and shape values, introspection, records, design by contract with good errors, orthogonal
  design. (OpenSCAD later added function literals in 2021.01.)
- **OpenSCAD itself [notes]**: terse, no boilerplate versus JS/Python-embedded APIs, and
  non-programmers pick it up quickly; but rolling its own language made abstractions and
  packaging hard.
- **FeatureScript [notes]**: Onshape chose a new language for determinism (no I/O, time,
  randomness, unordered iteration) and efficient rollback of partial feature execution.
  Users learn its syntax in about two days; the remaining difficulty is geometry, not
  language. Also: readable units and vectors need operator overloading, which JS lacks.
- **CadQuery [notes]**: states the goal "as close as possible to how you'd describe the
  object to a human", realized as string selectors like `edges("|Z")`. The PLDI 2023
  authors call state-based selectors (CadQuery, Grasshopper) a failing camp because users
  must write geometric logic like "the highest edge parallel to X" (this specific claim
  was refuted 1-2 on sourcing detail, so treat it as their opinion).
- **Lineage-based referencing DSL (PLDI 2023) [verified]**: references should satisfy
  Selectability, Smoothness (no discontinuous jumps under parameter change), and
  Distinguishability. Query grammar: `all | from(e) | derivedFrom(e) | contains(q) | and |
  or | not | fromAll | fromAny …`, with infix `and`/`not` sugar, e.g.
  `from(r3.top) and not(fromAny(r1, r5))`. gcad's intrinsic feature catalog (E1/F3, TOP |
  BOTTOM) is already history-stable, so the language can phrase references as "the edge
  that came from the pocket's bottom" and resolve them onto the catalog.
- **AIDL (CGF 2025) [notes]**: argues imperative CAD code is poorly aligned with how LLMs
  and humans reason; proposes a hierarchical declarative language naming abstract
  components and relationships, offloading low-level geometry to a solver. Relevant if we
  want LLM-assisted authoring later.

### 1.5 PEG-specific constraints

- **Ordered choice is not commutative [verified]**: the parser commits to the first
  alternative that succeeds. `drill` listed before `drill and tap` means the latter never
  matches (prefix capture / language hiding). Every verb with an optional continuation must
  be written longest-first or with the continuation as an explicit optional clause.
- **A PEG is never ambiguous [verified]**: any string that parses has one tree. English
  word-order ambiguity therefore never shows up as a grammar conflict; it is resolved,
  possibly wrongly and silently, by rule order. Whether the PEG accepts the intended
  language is undecidable in general. We need a golden corpus of sentences with expected
  parses.
- **Left recursion [verified]**: not straightforward in PEG but doable with Medeiros-style
  extensions (adopted by CPython's pegen). Possessive chains (`the pocket's bottom edge`),
  chained `and`, and infix arithmetic all want left recursion; either use a toolkit that
  supports it or right-recurse like ACE did.
- **Indentation [verified]**: Adams-Ağacan add an indentation operator (parse `p` at
  greater/equal indentation than the enclosing block) and an alignment operator; the lexer
  only emits NEWLINE. The alignment operator cannot be desugared into plain PEG, so the
  toolkit must support it (Haskell `indentation` package does; check pest/peggy/ohm).
- **Numbers and units**: `1/4-20 UNC-2B`, `M8x1.25`, `Ø.257`, `2"`, `0.5 mm`, `28 long`
  all need dedicated lexical rules that fire before general identifier/number rules, plus a
  keyword-boundary predicate (`!identChar`) so `in` the unit and `in` the preposition do
  not collide.
- **Two-layer design [verified via Inform 7]**: keep the PEG shallow (statement shapes and
  noun phrases) and bind nouns to features, datums, and units in a semantic pass that
  produces the error messages. This keeps the grammar small enough to reason about.

---

## 2. Design principles shared by all proposals

1. **Pidgin, not English.** A small register with fixed sentence templates. Every template
   is documented on one page. If a sentence is not in the templates, it is rejected with a
   message that names the nearest template (Curv's design-by-contract goal).
2. **Nouns are first-class, immutable, named.** `the base`, `the stud`, `the pocket` are
   shape values. Nothing is mutated; later statements *refine* a named thing and yield a
   new state under the same name, which the UI can round-trip to feature IDs (KCL's
   argument).
3. **Patterns, not loops, for geometry.** `4 holes … equally spaced on Ø10 bolt circle`.
   General `for each … :` exists for the engineer, but the machinist never needs it.
4. **Units on literals, default unit per file, no dimensional algebra** (KCL). `wall is
   1.5 mm`, `bore is od - 2 * wall`. Bare numbers take the file default.
5. **Named features and datums, referenced by noun phrase.** `the top edge of the base`,
   `the bottom of the pocket`, `every edge of the stud except its bottom`, resolved onto the
   intrinsic feature catalog; raw IDs (`edge E3`) remain a legal fallback and the UI can
   insert either.
6. **Scope by surface order, grouping by punctuation** (ACE). Commas and line breaks
   separate clauses; there are no parentheses for grouping outside arithmetic.
7. **Formal text is the arbiter; prose is allowed.** Comments and free text after `--` or
   in a `note:` are never parsed. Redundant restatement is legal where it aids reading.
8. **Deterministic, total, order-independent where possible.** Declarations can appear in
   any order (spec style); operation sequences are ordered (process-plan style). Each
   proposal picks one and says so.

---

## 3. The benchmark part

Every proposal models the same stackable pill-case segment (mm, Y up), matching the
existing `pillcase.gcad` sample in spirit:

| Item | Value |
|---|---|
| Base | cylinder Ø32, 28 tall, bottom on y = 0 |
| Base edges | chamfer 0.3 top and bottom |
| Outside | straight knurl, 72 ridges, ridge R0.3, ridge length = base height − 1 |
| Stud | male thread Ø29, pitch 1.5, 3.5 tall, on the top face, top edge fillet 0.8 |
| Stud-to-base joint | round blend R0.5 |
| Cavity | female thread Ø29, pitch 1.5, 4 deep, from the bottom face |
| Pocket | Ø26, 17 deep, from the top of the stud, bottom edge fillet R1 |
| Vents | if vented: 4× Ø1.5 through the floor, equally spaced on Ø10 bolt circle |
| Parameters | od = 32, wall = 1.5, pitch = 1.5, vented = yes |
| Derived | pocket dia = od − 2·(wall + 1.5); stud height = 2·pitch + 0.5 |

Each sample shows: variables, an expression with units, a pattern or loop, a
conditional, an edge treatment on a named feature, and a blended boolean.

---

## 4. Proposal A: Shop-note style ("the drawing note is the language")

**Idea.** Every statement is a drawing callout. Uppercase is conventional but not
required. Keywords are the ASME/shop abbreviations spelled out or abbreviated (both
accepted, normalized in the semantic pass). Grammar: one callout per line, count prefix
optional, keyword-headed, dimension tokens carry their own prefix (Ø, R, ×, DEEP, THRU).
Structure is flat; hierarchy comes from `FROM <face>` and `ON <feature>` clauses.

```
PART PILL CASE SEGMENT            UNITS MM
OD = 32   WALL = 1.5   PITCH = 1.5   VENTED = YES
POCKET DIA = OD - 2 * (WALL + 1.5)
STUD HT = 2 * PITCH + 0.5 MM

BASE:   ROUND Ø(OD) X 28 LG, BOTTOM ON Y0
        CHAMFER .3 TOP & BOTTOM EDGES
        KNURL OD, 72 RIDGES R.3, (28 - 1) LG

STUD:   THREAD Ø29 X (PITCH) PITCH, STUD HT LG, ON TOP FACE OF BASE
        FILLET R.8 TOP EDGE
        BLEND R.5 TO BASE

CAVITY: THREAD Ø29 X (PITCH) PITCH, 4 DP, FROM BOTTOM FACE OF BASE, INTERNAL
POCKET: BORE Ø(POCKET DIA) X 17 DP FROM TOP FACE OF STUD
        FILLET R1 BOTTOM EDGE

IF VENTED:
VENTS:  4X Ø1.5 THRU FLOOR OF POCKET, EQ SP ON Ø10 BC
```

**Grammar sketch.**

    Callout   <- Count? Feature Dims (',' Clause)*
    Count     <- Int 'X' !Ident
    Feature   <- 'ROUND' / 'THREAD' / 'BORE' / 'POCKET' / 'HOLE' / 'CHAMFER' / 'FILLET' / 'KNURL' / 'BLEND'
    Dims      <- Dim ('X' Dim)*
    Dim       <- 'Ø' Num / 'R' Num / Num ('LG' / 'DP' / 'DEEP' / 'THRU' / 'PITCH' / 'RIDGES')?
    Clause    <- 'FROM' Face / 'ON' Face / 'EQ SP ON' Dim 'BC' / 'TO' Name / 'INTERNAL' / 'TOP & BOTTOM EDGES' / …
    Num       <- '(' Expr ')' / Fraction / Decimal Unit?

Expressions inside dimension slots are parenthesized on purpose: `Ø(OD)` reads like a
drawing reference and keeps the number lexer unambiguous.

**Pros.** Highest precision and lowest grammar size (Kuhn's P5/S-high corner). Machinists
can write it on day one because they already write it. Every line is one feature, so
feature IDs and UI labels map trivially. Trivially PEG-parseable: line-oriented,
keyword-headed, no recursion beyond arithmetic.

**Cons.** Naturalness is low (Kuhn N2-N3): it reads like a note block, not prose, and the
user asked for something that does not "look like code". Uppercase telegraphese is hostile
to engineers who want sentences and to anyone composing longer assemblies. Additive
features (the stud) are awkward in a lexicon built for cuts. Conditionals and loops feel
bolted on. Little room for datums or assemblies.

**Fit for gcad API.** Direct: ROUND→cylinder, THREAD→threaded_rod (INTERNAL→female),
BORE/HOLE→subtract cylinder, KNURL→knurl, BLEND→blended union, FILLET/CHAMFER with
TOP/BOTTOM edges → feature IDs.

---

## 5. Proposal B: Process-plan / traveler style ("say it the way the traveler says it")

**Idea.** The program is an ordered sequence of operations on named stock, exactly like a
route sheet. Verb-first imperative sentences, `to Ø32` for target dimensions,
`x 28 long`, `n deep`, `through`. Each operation is numbered (optionally) and can be
named (`as the pocket`). Additive operations are `add` / `weld on`. Stock is declared
first. Sequencing is the semantics: later ops act on the result of earlier ones, which is
precisely CSG-as-machining.

```
part: pill case segment
units: mm
given od = 32, wall = 1.5, pitch = 1.5, vented = yes
let pocket dia = od - 2 * (wall + 1.5)
let stud height = 2 * pitch + 0.5 mm

stock: round bar Ø od, 28 long, standing on Y0, as the base

op 10  chamfer 0.3 the top and bottom edges of the base
op 20  knurl the outside of the base, 72 straight ridges R0.3, 27 long
op 30  add a threaded stud Ø29 pitch pitch, stud height long, on the top face of the base,
       as the stud, blended round R0.5
op 40  fillet R0.8 the top edge of the stud
op 50  tap Ø29 pitch pitch, 4 deep, from the bottom face of the base, as the cavity
op 60  bore Ø pocket dia, 17 deep, from the top face of the stud, as the pocket
op 70  fillet R1 the bottom edge of the pocket
op 80  if vented: drill 4 holes Ø1.5 through the floor of the pocket,
       equally spaced on a Ø10 bolt circle, as the vents
```

**Grammar sketch.**

    Op        <- ('op' Int)? Verb Object? DimList? Clause* ('as' NounPhrase)?
    Verb      <- 'drill and tap' / 'drill' / 'tap' / 'bore' / 'ream' / 'turn' / 'face' / 'chamfer' / 'fillet' / 'break' / 'knurl' / 'add' / 'cut' / 'weld on' / 'shell' / 'engrave'
    Object    <- Count Noun / 'a' Noun / 'the' NounPhrase
    Clause    <- ',' ( 'from' Face / 'on' Face / 'through' Face / 'equally spaced on a' Dim 'bolt circle' / 'blended' Blend / 'as' NounPhrase )
    Face      <- ('the')? ('top' / 'bottom' / 'outside' / 'floor' / 'side') ('face' / 'edge' / 'edges')? 'of' NounPhrase

Note the longest-first order in `Verb` (ordered choice). Clauses are comma-separated,
and each clause opens with its own keyword, so word order inside a sentence is fixed but
clause order is free (ACE's surface-order rule applied to a comma list).

**Pros.** This is how the shop floor actually talks and writes; verified route-sheet
sentences fit the grammar unchanged. Ordered semantics equals CSG evaluation order, so the
mapping to `subtract`/`union` is mechanical and the numbered ops give stable, human-legible
feature identities (op 60 = the pocket). Naturalness is high without leaving the pidgin
register. Conditionals read as a traveler's "if vented" note. Engineers get variables and
expressions in the `given`/`let` header.

**Cons.** Sequence is also the trap: reordering ops changes the part, and machinists may
expect operation order to be a manufacturing convenience rather than geometry semantics.
Additive features (`add a threaded stud`) are less idiomatic than cuts. Assemblies,
symmetry, and multi-body work are not native. Verb inventory must be curated tightly or
the "which verb is legal here" problem (PlusCal's non-obvious rules) appears.

**Fit for gcad API.** stock→primitive; cut verbs→subtract; add→union (with `blended`
→ round/soft/chamfer blend radius); `as`→named node; face phrases→feature catalog.

---

## 6. Proposal C: Spec / formal-methods style ("the part is X such that Y")

**Idea.** A Z-schema-shaped document: a header with `given` (parameters), `datums`, then a
set of named declarations `X is a …` in any order, then a `where` block of constraints
and refinements, and `require` invariants that the checker verifies. Declarations are
unordered and referentially transparent (spec, not program). Relationships between
features use a small set of relational verbs: `is a`, `sits on`, `is cut into`, `is
joined to … with`, `has`. Repetition is set-builder: `4 holes h such that …` or the
shorthand pattern phrase.

```
part PillCaseSegment
  units mm

  given
    od     = 32
    wall   = 1.5
    pitch  = 1.5
    vented = yes

  datums
    Base plane   is the plane Y = 0
    Axis         is the Y axis through the origin

  the base    is a cylinder Ø od, 28 tall, standing on Base plane
  the stud    is a male thread Ø29 x pitch, 2 * pitch + 0.5 mm tall, standing on the top face of the base
  the cavity  is a female thread Ø29 x pitch, 4 deep, entering from the bottom face of the base
  the pocket  is a bore Ø(od - 2 * (wall + 1.5)), 17 deep, entering from the top face of the stud
  the vents   are 4 holes Ø1.5 through the floor of the pocket, equally spaced on a Ø10 bolt circle about Axis

  where
    the base has chamfer 0.3 on its top and bottom edges
    the base is knurled on its outside with 72 straight ridges R0.3, 27 long
    the stud is joined to the base with a round blend R0.5
    the stud has fillet R0.8 on its top edge
    the pocket has fillet R1 on its bottom edge
    the vents exist only if vented

  require
    wall >= 1.2 mm                                   -- minimum printable wall
    the floor of the pocket is at least 3 mm thick
```

**Grammar sketch.**

    Part      <- 'part' Name Section*
    Section   <- Given / Datums / Decl+ / Where / Require
    Decl      <- Subject ('is a' / 'is an' / 'are') Kind DimList Placement?
    Subject   <- 'the' Name / Name
    Placement <- ',' ('standing on' / 'entering from' / 'through' / 'about') Ref
    Where     <- 'where' (Subject Predicate)+
    Predicate <- 'has' Treatment 'on' EdgeRef / 'is joined to' Subject 'with a' Blend / 'is knurled …' / 'exist only if' Expr
    Require   <- 'require' (Expr / Assertion)+

Every sentence begins with a subject noun phrase and a relational verb from a closed list,
so the PEG dispatches on the verb; the subject is a bounded noun phrase (no left recursion
if possessives are written `the top edge of the base` rather than `the base's top edge`).

**Pros.** Closest to Bowen/Jackson: names, declaration part, `where` predicate part,
named invariants that the tool can check and report. Order-independent, so the UI can
insert or reorder declarations freely and feature identity is by name, not sequence. Reads
as a specification an engineer would sign off. Refinement is natural: a `where` clause can
be added without touching the declaration. Best place for tolerances and DFM rules later.

**Cons.** Engineers will like it; machinists may find "is joined to … with a round blend"
abstract compared with "weld on / blend". The `where` block separates a feature's
treatment from its declaration, which is the Z reading-model but scatters one feature
across two places. Relational verbs must be few or the read-only trap opens (which verb
phrases are legal after `the stud`?). Unordered semantics needs a dependency solver and
clear rules for "which body does this cut apply to".

**Fit for gcad API.** Declarations build primitives; `where` predicates attach fillet/
chamfer/knurl/blends; `require` compiles to checks over the feature catalog and bounds.

---

## 7. Proposal D: Feature-tree / datum style ("the browser tree as text")

**Idea.** Indentation-structured like the feature browser in Fusion/Onshape/SolidWorks.
A body is a tree; `on <face|datum>:` opens a scope whose children are features placed on
that face; treatments nest under the feature they modify. Feature names are the line's
leading noun. No verbs beyond a small fixed set of feature kinds; adjectives and trailing
clauses carry parameters. Indentation is parsed directly in the grammar (Adams-Ağacan).

```
part Pill case segment (mm)
  parameters
    od 32,  wall 1.5,  pitch 1.5,  vented yes
    pocket dia  = od - 2 * (wall + 1.5)
    stud height = 2 * pitch + 0.5 mm

  body Base: cylinder Ø od, 28 tall, on Y0
    chamfer 0.3: top edge, bottom edge
    knurl outside: 72 straight ridges R0.3, 27 long

    on top face:
      boss Stud: thread Ø29 pitch pitch, stud height tall, blend round R0.5
        fillet R0.8: top edge
        on top face:
          pocket Pocket: Ø pocket dia, 17 deep
            fillet R1: bottom edge
            if vented, on floor:
              holes Vents: 4 × Ø1.5 through, equally spaced on Ø10 bolt circle

    on bottom face:
      tapped hole Cavity: Ø29 pitch pitch, 4 deep
```

**Grammar sketch (indentation-aware).**

    Body      <- 'body' Name ':' Kind DimList NEWLINE Block
    Block     <- (Feature / Treatment / Scope)^>   -- children at greater indentation
    Scope     <- ('if' Expr ',')? 'on' Face ':' NEWLINE Block
    Feature   <- FeatureKind Name? ':' DimList Clause* NEWLINE Block?
    Treatment <- ('fillet' / 'chamfer') Num ':' EdgeList NEWLINE
    EdgeList  <- EdgeRef (',' EdgeRef)*

**Pros.** Matches the mental model of every parametric-CAD user (engineers) and shows the
containment relationships that flat styles hide: what lives on which face. Feature names
are unique tree paths (`Base/Stud/Pocket`), which is a clean identity model for the UI.
Edge treatments sit under the feature they belong to. Compact: no verbs, no sentences.

**Cons.** It is the least sentence-like of the five; whitespace as syntax reads as code to
a machinist and is a known source of "why won't it parse" errors. Colons and indentation
are structural punctuation the user wanted to avoid. Indentation-sensitive PEG needs a
toolkit with the alignment operator or a NEWLINE/INDENT preprocessing pass (which is what
most tools actually do). Deep nesting hides the process order that machinists think in.
Blended booleans are a trailing clause, less visible than in B or C.

**Fit for gcad API.** Tree = scene graph; `on <face>` = placement onto the parent's face
via the feature catalog; boss = union, pocket/holes/tapped hole = subtract.

---

## 8. Proposal E: Literate controlled-English style ("read it aloud")

**Idea.** Full sentences with determiners, ending in periods, in the ACE register: fixed
templates, surface-order scope, `and` tighter than `or`, comma to regroup, rigid
`if … then …`. Possessives are allowed only as `the X of Y` (right-recursive). Definitions
are `The base is a cylinder 32 across and 28 tall.` Operations are imperatives addressed
to the tool. This is deliberately the most natural point on Kuhn's curve, included to show
where the read-only risk lives.

```
This is a pill case segment, in millimetres.

Let od be 32, wall be 1.5, pitch be 1.5, and vented be yes.
Let the pocket diameter be od minus 2 times (wall plus 1.5).
Let the stud height be 2 times pitch plus 0.5 mm.

The base is a cylinder od across and 28 tall that stands on the ground plane.
Chamfer the top edge and the bottom edge of the base by 0.3.
Knurl the outside of the base with 72 straight ridges of radius 0.3 that are 27 long.

The stud is a threaded boss 29 across with a pitch of pitch and the stud height tall.
It stands on the top face of the base and is blended into the base with a round of radius 0.5.
Fillet the top edge of the stud by 0.8.

The cavity is a threaded hole 29 across with a pitch of pitch that enters the bottom face of the base 4 deep.
The pocket is a bore of the pocket diameter that enters the top face of the stud 17 deep.
Fillet the bottom edge of the pocket by 1.

If vented then the vents are 4 holes 1.5 across through the floor of the pocket,
equally spaced on a bolt circle 10 across.
```

**Grammar sketch.**

    Sentence  <- (Definition / Command / Conditional) '.'
    Definition<- Subject 'is' Article KindPhrase Modifier* ('that' RelClause)?
    Command   <- Verb Object ('by' Num / 'with' With)? (',' / 'and' Command)*
    Conditional <- 'If' Expr 'then' (Definition / Command)
    Object    <- 'the' Part 'of' Subject ('and' Object)?      -- right-recursive, no possessive
    Expr      <- Term (('plus' / 'minus') Term)* …               -- words for operators, symbols allowed too

**Pros.** Highest naturalness (N4-N5); it can be read to a colleague over the phone. Prose
and spec are the same text, which is Bowen's literate ideal taken literally. Discoverable:
`there is a`-style guessability. Good fit for LLM-assisted authoring (AIDL direction).

**Cons.** Every documented failure mode applies: users will write plausible English that
is not in the templates (Inform 7's least-surprise violation), sentences grow long, and
precision drops (Kuhn's −0.67). Anaphora (`It stands on …`) needs a semantic pass with
its own rules. Numbers in words vs symbols create two spellings for everything. Hardest
PEG: relative clauses, coordination, and `of`-chains must all be right-recursed by hand,
and rule order silently decides readings like `Fillet the top edge of the stud and the
pocket`. Slowest to write for machinists, who would rather write `FILLET R.8 TOP EDGE`.

**Fit for gcad API.** Same as C after the semantic pass; the cost is entirely in the front
end.

---

## 9. Comparison

| | A Shop note | B Process plan | C Spec / where | D Feature tree | E Literate English |
|---|---|---|---|---|---|
| Kuhn naturalness (est.) | N2–N3 | N3–N4 | N3–N4 | N2 | N4–N5 |
| Precision / grammar size | best | good | good | good | worst |
| Machinist writability | best | best | fair | fair | poor |
| Engineer writability | fair | good | best | best | fair |
| Readability to a non-author | fair | best | good | good (tree) | best |
| Read-only risk (Inform/HyperTalk) | low | low–med | medium | low | high |
| PEG difficulty | trivial | low | low–med | medium (indent) | high |
| Semantics | ordered | ordered | unordered, solved | tree, ordered within scope | unordered + anaphora |
| Feature identity | line/name | op number + name | name | tree path | name |
| Additive features | awkward | ok (`add`) | natural | natural (`boss`) | natural |
| Loops / conditionals | bolted on | traveler-like `if` | `exist only if`, set-builder | `if … on:` scope | `If … then` |
| Constraints / DFM checks | no | no | native (`require`) | no | possible |
| Looks like code? | note block | no | mildly (blocks) | yes (indent, colons) | no |
| Maps to gcad API | direct | direct | via solver | direct | via semantic pass |

---

## 10. Cross-cutting recommendations

### 10.1 The "reads well, hard to write" risk

Every prose-like language in the record failed here except the ones that stayed a small
pidgin. Mitigations, in priority order:

1. **A one-page template card.** Each statement kind has exactly one canonical shape;
   synonyms are normalized (`DP`/`deep`/`DEEP`, `EQ SP`/`equally spaced`) but the shape is
   fixed. This is Gherkin's keyword-frame trick and HyperTalk defenders' "pidgin" insight.
2. **Longest-first verb table and a golden corpus.** Because PEG never reports ambiguity,
   a corpus of ~50 sentences with expected parses is the only way to know the grammar
   accepts the intended language (Ford's undecidability result).
3. **Errors name the nearest template.** "Did you mean: `fillet R<num> the <edge> of
   <feature>`". Curv's design-by-contract goal; Inform 7's failure is the counterexample.
4. **UI insertion.** Alt-click on an edge inserts `the top edge of the stud` (or `edge E3
   of the stud`) at the cursor. This kills most of the writing problem for references,
   which is the hardest part (PLDI 2023).
5. **Two surface syntaxes over one semantics is acceptable** (PlusCal's p- and
   c-syntax): A's callout for holes and patterns can be embedded verbatim inside B or C.

### 10.2 Keyword choice

- Prefer shop verbs and drawing words: drill, tap, bore, ream, turn, face, chamfer, fillet,
  break (edges), knurl, thread, boss, pocket, slot, through, deep, bolt circle, equally
  spaced, across flats, counterbore, countersink. Accept the ASME abbreviations as
  synonyms. Verify the final list against ASME Y14.38 and Y14.5 (not fetched in this
  research).
- Avoid programmer words in the geometry register: no `union`, `subtract`, `intersect`,
  `translate`, `return`. Say `add`/`join`, `cut`/`remove`, `common to`, `move`/`at`.
- Keep programming words for programming: `given`, `let`, `if … then`, `for each`,
  `where`, `require`. Machinists never need `for each`; engineers get it.
- Blends: `blended round R0.5`, `blended soft R2`, `blended chamfer 1`. These map 1:1 to
  the existing operators.

### 10.3 Units, numbers, fractions, threads

- Per-file default (`units mm`), unit suffixes on literals (`0.5 mm`, `2 in`, `2"`),
  no dimensional analysis through arithmetic (KCL's conclusion). Mixed-unit arithmetic
  converts to the file default.
- Lex as single tokens, before identifiers: `Ø<num>`, `R<num>`, `<num>"`, fractions
  `1/4`, thread designators `1/4-20 UNC-2B` and `M8x1.25-6H`, counts `4X` / `4 ×`.
- Expressions in a dimension slot: allow bare identifiers (`Ø od`) and parenthesized
  arithmetic (`Ø(od - 2 * wall)`). Parentheses are permitted here because drawings already
  use them for reference dims; they never appear at statement level.

### 10.4 Referencing named features and datums

- Nouns, not IDs, as the primary form: `the top edge of the base`, `the bottom edge of the
  pocket`, `the floor of the pocket`, `every edge of the stud except its bottom edge`.
  These resolve onto the intrinsic feature catalog (E1/F3, TOP | BOTTOM), which already
  satisfies Smoothness because it is a pure function of the primitive.
- Borrow the PLDI 2023 query vocabulary as English: `edges from the pocket`, `edges
  derived from the base`, `… and not from the stud`. This gives Selectability and
  Distinguishability for edges born from booleans.
- Raw IDs stay legal (`edge E3 of the stud`) for the UI round-trip and for the cases where
  no noun is natural.
- Datums as named nouns: `datum A is the bottom face of the base`, then `from datum A`.
  This is the drawing's datum frame and Z's named-entity style at once.

### 10.5 Loops and conditionals

- Patterns first: `4 holes … equally spaced on a Ø10 bolt circle`, `6 ribs every 60°
  about the axis`, `3 slots 12 apart along X`. These map to repeat_polar and linear
  patterns.
- `for each` only in the engineer's register, with a bound variable and a body of the
  same statements: `for each i from 1 to n: …`. Immutable, KCL-style; no counters.
- Conditionals as feature existence (`the vents exist only if vented`) or as a scope
  prefix (`if vented: …`). Both are one template each.

---

## 11. Open questions and next steps

1. **Corpus first.** Collect ~50 real drawing notes and traveler lines (the research did
   not fetch a statistically meaningful corpus) and ~20 engineer-style sentences; write the
   expected parse for each. This drives the verb table and the longest-first ordering.
2. **APT and Y14.38 check.** Pull the APT major/minor-word list and the Y14.38 abbreviation
   table directly; the research did not verify either.
3. **Choose the toolkit by two features**: left-recursion support (Medeiros-style, as in
   pegen) and indentation operators if D is in play. Otherwise right-recurse like ACE and
   pre-lex NEWLINE/INDENT.
4. **Prototype the hybrid**: B's operation sentences + A's callouts for holes/patterns/edges
   + C's `given`/`where`/`require` header. Write the pill case, mechwarrior, and a bracket
   in it and count rejected sentences per author.
5. **Decide ordered vs unordered semantics** early; it is the biggest fork (B/D vs C/E).
6. **Reference resolution semantics**: define precisely how `the top edge of the stud`
   resolves after the pocket cuts through it (lineage: edges *derived from* the stud's top).

---

## 12. Sources

Verified (3-0 in adversarial verification):

1. Kuhn, T. "A Survey and Classification of Controlled Natural Languages", Computational Linguistics 40(1), 2014. https://attempto.ifi.uzh.ch/site/pubs/papers/kuhn2014cl.pdf
2. Bowen, J. "Formal Specification and Documentation using Z", 1996/2003. https://people.eecs.ku.edu/~saiedian/812/Lectures/Z/Z-Books/Bowen-formal-specs-Z.pdf
3. Barden, Stepney, Cooper. "Z in Practice", 1994, preface. https://www-users.york.ac.uk/~ss44/bib/ss/zip/preface.htm
4. Jackson, D. "Alloy: A New Object Modelling Notation". https://people.csail.mit.edu/dnj/publications/alloy.pdf
5. Lamport, L. "The PlusCal Algorithm Language", ICTAC 2009. https://lamport.azurewebsites.net/pubs/pluscal.pdf
6. Zoo. "Introducing KCL", 2025. https://zoo.dev/research/introducing-kcl
7. Zoo. KCL book, map/reduce. https://zoo.dev/docs/kcl-book/map_reduce.html
8. Moen, D. Curv KWLUG talk outline. https://github.com/curv3d/curv/blob/master/ideas/talks/kwlug/KWLug.rst
9. OpenSCAD 2021.01 release notes. https://github.com/openscad/openscad/releases/tag/openscad-2021.01
10. Cascaval, Bodik, Schulz. "A Lineage-Based Referencing DSL for Computer-Aided Design", PLDI 2023. https://dl.acm.org/doi/10.1145/3591223
11. PEP 617, New PEG parser for CPython. https://peps.python.org/pep-0617/
12. Nestra, H. "Grammars for Indentation-Sensitive Parsing", MFCS 2017. https://drops.dagstuhl.de/opus/volltexte/2017/8078/pdf/LIPIcs-MFCS-2017-45.pdf
13. Ford, B. "Parsing Expression Grammars", POPL 2004. https://www.inf.puc-rio.br/~roberto/docs/peg.pdf
14. pest book, PEG chapter. https://pest.rs/book/grammars/peg.html
15. Adams, Ağacan. "Indentation-Sensitive Parsing for Parsec", Haskell 2014. https://osa1.net/papers/indentation-sensitive-parsec.pdf
16. Hoefler, S. "The Syntax of Attempto Controlled English", 2004. https://attempto.ifi.uzh.ch/site/pubs/papers/hoefler2004theSyntax.pdf
17. ACE construction rules and nutshell. https://attempto.ifi.uzh.ch/site/docs/ace_constructionrules.html
18. Nelson, G. Inform compiler structure. https://ganelson.github.io/inform/structure.html

Agent notes, not independently verified:

19. Eng-Tips, "Calling out bolt circles". https://www.eng-tips.com/threads/calling-out-bolt-circles.92010/
20. Eng-Tips, "Meaning of Equally Spaced when no GD&T applied". https://www.eng-tips.com/threads/meaning-of-quot-equally-spaced-quot-when-no-gd-amp-t-applied.376628/
21. Process planning / route sheet example. https://msvs-dei.vlabs.ac.in/mem103/Unit5lesson4.html
22. Wikipedia, Engineering drawing abbreviations and symbols (claim of Y14.38 codification refuted 0-3 for sourcing). https://en.wikipedia.org/wiki/Engineering_drawing_abbreviations_and_symbols
23. RivCut, drawing callouts guide. https://www.rivcut.com/blog/drawing-callouts-guide
24. CocoaDev, HyperTalk. https://cocoadev.github.io/HyperTalk/
25. Dorophone, "On Inform 7, Natural Language Programming and the Principle of Least Surprise". https://procyonic.org/blog/on-inform-7-natural-language-programming-and-the-principle-of-least-surprise/
26. Onshape forum, "Why Onshape defines a new program language, FeatureScript?". https://forum.onshape.com/discussion/6875/
27. CadHub, "Curated Code CAD". https://learn.cadhub.xyz/blog/curated-code-cad/
28. Cameron, N. "KCL part 1: units". https://www.ncameron.org/blog/kcl-part-1-units/
29. AIDL, "A Solver-Aided Hierarchical Language for LLM-Driven CAD Design", CGF 2025. https://arxiv.org/pdf/2502.09819
30. Wayne, H. "Formal Specification Languages". https://buttondown.com/hillelwayne/archive/formal-specification-languages/
31. Pressler, R. "TLA+ in Practice and Theory, Part 1". https://pron.github.io/posts/tlaplus_part1
32. cucumber/gherkin parser. https://github.com/cucumber/gherkin
33. Lobsters discussion of Dijkstra, "On the foolishness of natural language programming". https://lobste.rs/s/lcfs1n/

Domain knowledge, not fetched: APT part-programming syntax (IIT Research Institute, APT Part Programming, 1967); ASME Y14.5 / Y14.38 conventions.
