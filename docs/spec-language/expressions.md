# Expressions

Expressions appear in parameter definitions, dimension quantities, counts, conditions,
`with` clauses, and assertions. They are parsed by precedence climbing (a Pratt parser),
which corresponds directly to the table below; there is no ladder of `Term` and `Factor`
rules.

## Operands

```
Primary         ::= Number Unit?
                  | Fraction Unit?
                  | Inch
                  | Name
                    -- a parameter, or a bound loop variable
                  | "the" Name "of" Reference
                    -- a parameter or let value of an instance (the height of the base),
                    -- or a derived measure of a feature (the diameter of the bore)
                  | "(" Expression ")"
                  | "yes" | "no" | "true" | "false"
```

An argument value is an expression up to the next comma: `dia = od - 2 * wall`. A
triple `10 x 6 x 4` is three expressions separated by `x` and is only legal as an
argument value; `x` is a function word.

## Precedence

Highest binds tightest.

| Level | Operators | Associativity | Notes |
|---|---|---|---|
| 1 | `( … )`, function application `sqrt x` `sin a` `min a b` | | function words take one or two following `Primary`s |
| 2 | unary `-` | prefix | |
| 3 | `^` | right | power |
| 4 | `*` `/` | left | |
| 5 | `+` `-` | left | |
| 6 | `=` `/=` `<` `<=` `>` `>=` (also `≠` `≤` `≥`) | none | comparison; chaining is an error |
| 7 | `not` | prefix | |
| 8 | `and` | left | |
| 9 | `or` | left | |

`=` is comparison inside `require` and assignment at the head of a `given` item or
`with` clause; the position decides, never the parser's lookahead.

## Units

| Rule | Detail |
|---|---|
| Literal | a unit attaches to the number literal it follows: `0.5 mm`, `2 in`, `2"`, `45 deg` |
| Default | a bare number is in the file's `units` (mm unless set); angles default to degrees |
| Arithmetic | no dimensional analysis; every length converts to the file unit at the literal, so `2 in + 3` is `53.8 mm` |
| Angles | `deg`, `°`, `rad`; `rad` converts to degrees at the literal |
| Mixed | comparing a length with a bare number compares in the file unit |

This follows KCL's conclusion: unit-bearing literals, per-file default, no unit algebra
through operators.

## Examples

```
od - 2 * (wall + 1.5)              -- length, file unit
2 * pitch + 0.5 mm                 -- 0.5 mm is one literal; result in file unit
(od / 2) ^ 2 * 3.14159
sqrt (od ^ 2 + 28 ^ 2)
the height of the base + 1
wall >= 1.2 mm                     -- assertion
vented and n > 2                   -- condition
not vented
min wall 1.0
```

Rejected:

```
1 < wall < 3                        -- error: comparisons do not chain; write "1 < wall and wall < 3"
dia = 10 x 6                        -- error: dia takes a length, not a triple
```
