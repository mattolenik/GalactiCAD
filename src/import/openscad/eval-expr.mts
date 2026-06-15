/**
 * Expression evaluator: OpenSCAD Expression AST → Value. The functional half of OpenSCAD
 * (the geometry half lives in eval-geom). Also hosts `bindArgs`, shared with user-module calls.
 * See implementation plan §3.1–§3.2.
 *
 * Handles: literals, vectors, ranges, variable lookup, grouping, unary/binary operators
 * (incl. vector & matrix arithmetic and undef propagation), ternary, user functions, and a
 * built-in function set (scalar math + str/len/concat/norm/cross/min/max/is_*).
 * TODO (later phases): member/array indexing (`.x`/`[i]`), list comprehensions, `let`.
 */

import { type Args, parseArgs } from "./args.mjs"
import type { Ctx } from "./context.mjs"
import {
    ArrayLookupExpr,
    type AssignmentNode,
    BinaryOpExpr,
    type Expression,
    FunctionCallExpr,
    GroupingExpr,
    LcEachExpr,
    LcForCExpr,
    LcForExpr,
    LcIfExpr,
    LcLetExpr,
    LiteralExpr,
    LookupExpr,
    MemberLookupExpr,
    RangeExpr,
    TernaryExpr,
    TokenType,
    UnaryOpExpr,
    VectorExpr,
} from "./parser-imports.mjs"
import { Scope } from "./scope.mjs"
import { asNumber, rangeToNumbers, type Value, truthy, UNDEF, vec } from "./values.mjs"

function loc(node: { span: { start: { line: number; col: number } } }): [number, number] {
    return [node.span.start.line + 1, node.span.start.col + 1]
}

/** Built-in OpenSCAD scalar→scalar functions. Trig is in DEGREES. */
const BUILTIN_FN: Record<string, (a: number[]) => number> = {
    sin: a => Math.sin((a[0] ?? 0) * Math.PI / 180),
    cos: a => Math.cos((a[0] ?? 0) * Math.PI / 180),
    tan: a => Math.tan((a[0] ?? 0) * Math.PI / 180),
    asin: a => Math.asin(a[0] ?? 0) * 180 / Math.PI,
    acos: a => Math.acos(a[0] ?? 0) * 180 / Math.PI,
    atan: a => Math.atan(a[0] ?? 0) * 180 / Math.PI,
    atan2: a => Math.atan2(a[0] ?? 0, a[1] ?? 0) * 180 / Math.PI,
    abs: a => Math.abs(a[0] ?? 0),
    sign: a => Math.sign(a[0] ?? 0),
    sqrt: a => Math.sqrt(a[0] ?? 0),
    floor: a => Math.floor(a[0] ?? 0),
    ceil: a => Math.ceil(a[0] ?? 0),
    round: a => Math.round(a[0] ?? 0),
    ln: a => Math.log(a[0] ?? 0),
    log: a => Math.log10(a[0] ?? 0),
    exp: a => Math.exp(a[0] ?? 0),
    pow: a => Math.pow(a[0] ?? 0, a[1] ?? 0),
}

/** Built-in OpenSCAD functions that return a non-scalar Value (strings, lists, predicates). */
const BUILTIN_VALUE_FN: Record<string, (a: Value[]) => Value> = {
    str: a => ({ t: "str", v: a.map(scadStr).join("") }),
    len: a => {
        const x = a[0]
        if (x?.t === "vec") return { t: "num", v: x.v.length }
        if (x?.t === "str") return { t: "num", v: x.v.length }
        return UNDEF
    },
    concat: a => ({ t: "vec", v: a.flatMap(x => (x.t === "vec" ? x.v : [x])) }),
    norm: a => {
        const v = a[0] ? asNumVec(a[0]) : null
        return v ? { t: "num", v: Math.hypot(...v) } : UNDEF
    },
    cross: a => {
        const u = a[0] ? asNumVec(a[0]) : null
        const w = a[1] ? asNumVec(a[1]) : null
        if (u && w && u.length === 3 && w.length === 3) {
            return numVec([u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!])
        }
        return UNDEF
    },
    min: a => ({ t: "num", v: Math.min(...numbersOf(a)) }),
    max: a => ({ t: "num", v: Math.max(...numbersOf(a)) }),
    is_num: a => ({ t: "bool", v: a[0]?.t === "num" }),
    is_string: a => ({ t: "bool", v: a[0]?.t === "str" }),
    is_bool: a => ({ t: "bool", v: a[0]?.t === "bool" }),
    is_list: a => ({ t: "bool", v: a[0]?.t === "vec" }),
}

/**
 * Bind a call's arguments to a declaration's parameters in a fresh child of the definition
 * scope (lexical scoping). Argument expressions evaluate in the call-site scope; parameter
 * defaults evaluate in the new scope (so a default may reference earlier parameters).
 * Shared by user functions (here) and user modules (eval-geom).
 */
export function bindArgs(
    defScope: Scope,
    params: AssignmentNode[],
    callArgs: AssignmentNode[],
    callScope: Scope,
    ctx: Ctx,
): Scope {
    const { pos, named } = parseArgs(callArgs)
    const inner = new Scope(defScope)
    params.forEach((p, i) => {
        const argExpr = named.get(p.name) ?? pos[i]
        if (argExpr) inner.set(p.name, evalExpr(argExpr, callScope, ctx))
        else if (p.value) inner.set(p.name, evalExpr(p.value, inner, ctx))
        // else: parameter left unset — lookups return undef
    })
    return inner
}

export function evalExpr(expr: Expression, scope: Scope, ctx: Ctx): Value {
    if (expr instanceof LiteralExpr) {
        const v: unknown = expr.value
        if (typeof v === "number") return { t: "num", v }
        if (typeof v === "boolean") return { t: "bool", v }
        if (typeof v === "string") return { t: "str", v }
        return UNDEF // null === OpenSCAD undef
    }
    if (expr instanceof VectorExpr) {
        // Children may be plain elements or list-comprehension nodes that expand to 0..n elements.
        return vec(expr.children.flatMap(c => compElements(c, scope, ctx)))
    }
    if (expr instanceof RangeExpr) {
        const start = asNumber(evalExpr(expr.begin, scope, ctx)) ?? 0
        const end = asNumber(evalExpr(expr.end, scope, ctx)) ?? 0
        const step = expr.step ? asNumber(evalExpr(expr.step, scope, ctx)) ?? 1 : 1
        return { t: "range", start, step, end }
    }
    if (expr instanceof LookupExpr) {
        const found = scope.get(expr.name)
        if (found) return found
        const [line, col] = loc(expr)
        ctx.diag.warn(`undefined variable '${expr.name}'`, line, col)
        return UNDEF
    }
    if (expr instanceof GroupingExpr) {
        return evalExpr(expr.inner, scope, ctx)
    }
    if (expr instanceof MemberLookupExpr) {
        const base = evalExpr(expr.expr, scope, ctx)
        const idx = MEMBER_INDEX[expr.member]
        if (base.t === "vec" && idx !== undefined && idx < base.v.length) return base.v[idx]!
        return UNDEF
    }
    if (expr instanceof ArrayLookupExpr) {
        const base = evalExpr(expr.array, scope, ctx)
        const i = asNumber(evalExpr(expr.index, scope, ctx))
        if (i === undefined || !Number.isInteger(i) || i < 0) return UNDEF
        if (base.t === "vec") return i < base.v.length ? base.v[i]! : UNDEF
        if (base.t === "str") return i < base.v.length ? { t: "str", v: base.v[i]! } : UNDEF
        return UNDEF
    }
    if (expr instanceof UnaryOpExpr) {
        const r = evalExpr(expr.right, scope, ctx)
        if (expr.operation === TokenType.Bang) return { t: "bool", v: !truthy(r) }
        if (expr.operation === TokenType.Minus && r.t === "num") return { t: "num", v: -r.v }
        if (expr.operation === TokenType.Minus && r.t === "vec") {
            return vec(r.v.map(e => (e.t === "num" ? { t: "num", v: -e.v } : e)))
        }
        return r
    }
    if (expr instanceof TernaryExpr) {
        return truthy(evalExpr(expr.cond, scope, ctx))
            ? evalExpr(expr.ifExpr, scope, ctx)
            : evalExpr(expr.elseExpr, scope, ctx)
    }
    if (expr instanceof BinaryOpExpr) {
        return evalBinary(expr, scope, ctx)
    }
    if (expr instanceof FunctionCallExpr) {
        return evalCall(expr, scope, ctx)
    }
    const [line, col] = loc(expr)
    ctx.diag.warn(`unsupported expression '${expr.constructor.name}'`, line, col)
    return UNDEF
}

function evalBinary(expr: BinaryOpExpr, scope: Scope, ctx: Ctx): Value {
    const a = evalExpr(expr.left, scope, ctx)
    const b = evalExpr(expr.right, scope, ctx)
    const op = expr.operation

    // Logical + equality work across all types.
    if (op === TokenType.AND) return { t: "bool", v: truthy(a) && truthy(b) }
    if (op === TokenType.OR) return { t: "bool", v: truthy(a) || truthy(b) }
    if (op === TokenType.EqualEqual) return { t: "bool", v: valueEquals(a, b) }
    if (op === TokenType.BangEqual) return { t: "bool", v: !valueEquals(a, b) }

    // undef propagates through arithmetic/relational without a diagnostic.
    if (a.t === "undef" || b.t === "undef") return UNDEF

    // Number arithmetic & comparison.
    if (a.t === "num" && b.t === "num") {
        switch (op) {
            case TokenType.Plus:
                return { t: "num", v: a.v + b.v }
            case TokenType.Minus:
                return { t: "num", v: a.v - b.v }
            case TokenType.Star:
                return { t: "num", v: a.v * b.v }
            case TokenType.Slash:
                return { t: "num", v: a.v / b.v }
            case TokenType.Percent:
                return { t: "num", v: a.v % b.v }
            case TokenType.Caret:
                return { t: "num", v: a.v ** b.v }
            case TokenType.Less:
                return { t: "bool", v: a.v < b.v }
            case TokenType.LessEqual:
                return { t: "bool", v: a.v <= b.v }
            case TokenType.Greater:
                return { t: "bool", v: a.v > b.v }
            case TokenType.GreaterEqual:
                return { t: "bool", v: a.v >= b.v }
        }
    }

    // Element-wise vector +/- (equal length).
    if (op === TokenType.Plus || op === TokenType.Minus) {
        const av = asNumVec(a)
        const bv = asNumVec(b)
        if (av && bv && av.length === bv.length) {
            return numVec(av.map((x, i) => (op === TokenType.Plus ? x + bv[i]! : x - bv[i]!)))
        }
    }

    // Multiplication: scalar·vector, dot product, and matrix products.
    if (op === TokenType.Star) {
        if (a.t === "num" && b.t === "vec") {
            const bv = asNumVec(b)
            if (bv) return numVec(bv.map(x => a.v * x))
        }
        if (a.t === "vec" && b.t === "num") {
            const av = asNumVec(a)
            if (av) return numVec(av.map(x => x * b.v))
        }
        if (a.t === "vec" && b.t === "vec") {
            const av = asNumVec(a)
            const bv = asNumVec(b)
            const am = asMatrix(a)
            const bm = asMatrix(b)
            if (av && bv && av.length === bv.length) return { t: "num", v: dot(av, bv) } // dot product
            if (am && bv && (am[0]?.length ?? 0) === bv.length) return numVec(am.map(row => dot(row, bv))) // matrix·vector
            if (av && bm && av.length === bm.length) {
                return numVec(bm[0]!.map((_, j) => av.reduce((s, ai, i) => s + ai * bm[i]![j]!, 0))) // vector·matrix
            }
            if (am && bm && (am[0]?.length ?? 0) === bm.length) return matMat(am, bm) // matrix·matrix
        }
    }

    // Vector / scalar (element-wise).
    if (op === TokenType.Slash && a.t === "vec" && b.t === "num") {
        const av = asNumVec(a)
        if (av) return numVec(av.map(x => x / b.v))
    }

    const [line, col] = loc(expr)
    ctx.diag.warn(`unsupported operands for operator #${op}`, line, col)
    return UNDEF
}

function evalCall(expr: FunctionCallExpr, scope: Scope, ctx: Ctx): Value {
    const callee = expr.callee
    if (!(callee instanceof LookupExpr)) {
        const [line, col] = loc(expr)
        ctx.diag.warn("unsupported call expression", line, col)
        return UNDEF
    }
    const name = callee.name

    // User-defined function.
    const userFn = scope.getFunction(name)
    if (userFn) {
        const [line, col] = loc(expr)
        if (ctx.depth >= ctx.maxDepth) {
            ctx.diag.warn(`recursion limit hit in function '${name}()'`, line, col)
            return UNDEF
        }
        const inner = bindArgs(userFn.scope, userFn.decl.definitionArgs, expr.args, scope, ctx)
        ctx.depth++
        try {
            return evalExpr(userFn.decl.expr, inner, ctx)
        } finally {
            ctx.depth--
        }
    }

    // is_undef checks definedness WITHOUT warning on an undefined lookup (the whole point of it).
    if (name === "is_undef") {
        const arg = expr.args[0]?.value
        if (arg instanceof LookupExpr) {
            const found = scope.get(arg.name)
            return { t: "bool", v: found === undefined || found.t === "undef" }
        }
        return { t: "bool", v: (arg ? evalExpr(arg, scope, ctx) : UNDEF).t === "undef" }
    }

    const argv = expr.args.map(a => (a.value ? evalExpr(a.value, scope, ctx) : UNDEF))

    const vfn = BUILTIN_VALUE_FN[name]
    if (vfn) return vfn(argv)

    const fn = BUILTIN_FN[name]
    if (fn) return { t: "num", v: fn(argv.map(v => asNumber(v) ?? 0)) }

    const [line, col] = loc(expr)
    ctx.diag.warn(`unsupported function '${name}()'`, line, col)
    return UNDEF
}

// --- Value helpers ----------------------------------------------------------

/** A vec of all-number elements → number[]; null otherwise. */
function asNumVec(v: Value): number[] | null {
    if (v.t !== "vec") return null
    const out: number[] = []
    for (const e of v.v) {
        if (e.t !== "num") return null
        out.push(e.v)
    }
    return out
}

/** A vec whose elements are all number-vecs → number[][]; null otherwise (empty → null). */
function asMatrix(v: Value): number[][] | null {
    if (v.t !== "vec" || v.v.length === 0) return null
    const rows: number[][] = []
    for (const e of v.v) {
        const r = asNumVec(e)
        if (!r) return null
        rows.push(r)
    }
    return rows
}

function numVec(xs: number[]): Value {
    return { t: "vec", v: xs.map(x => ({ t: "num", v: x })) }
}

function dot(a: number[], b: number[]): number {
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
    return s
}

function matMat(a: number[][], b: number[][]): Value {
    const cols = b[0]!.length
    const inner = b.length
    const out: Value[] = a.map(row => {
        const r: number[] = []
        for (let j = 0; j < cols; j++) {
            let s = 0
            for (let p = 0; p < inner; p++) s += row[p]! * b[p]![j]!
            r.push(s)
        }
        return numVec(r)
    })
    return { t: "vec", v: out }
}

/** OpenSCAD min/max accept either a single list argument or several scalar arguments. */
function numbersOf(a: Value[]): number[] {
    if (a.length === 1 && a[0]!.t === "vec") return a[0]!.v.map(e => (e.t === "num" ? e.v : 0))
    return a.map(v => asNumber(v) ?? 0)
}

/** OpenSCAD-ish string rendering used by str(). */
function scadStr(v: Value): string {
    switch (v.t) {
        case "num":
            return String(v.v)
        case "bool":
            return v.v ? "true" : "false"
        case "str":
            return v.v
        case "vec":
            return `[${v.v.map(scadStr).join(", ")}]`
        case "range":
            return `[${v.start}:${v.step}:${v.end}]`
        case "undef":
            return "undef"
    }
}

function valueEquals(a: Value, b: Value): boolean {
    if (a.t !== b.t) return false
    if (a.t === "num" && b.t === "num") return a.v === b.v
    if (a.t === "bool" && b.t === "bool") return a.v === b.v
    if (a.t === "str" && b.t === "str") return a.v === b.v
    if (a.t === "vec" && b.t === "vec") return a.v.length === b.v.length && a.v.every((e, i) => valueEquals(e, b.v[i]!))
    if (a.t === "undef" && b.t === "undef") return true
    return false
}

const MEMBER_INDEX: Record<string, number> = { x: 0, y: 1, z: 2 }

/** Iterate a range or list value into its elements (for `for` / list comprehensions). */
function iterItems(v: Value): Value[] {
    if (v.t === "range") return rangeToNumbers(v).map(n => ({ t: "num", v: n }))
    if (v.t === "vec") return v.v
    return []
}

/**
 * Expand one vector-literal child into 0..n elements: a plain expression yields a single value;
 * list-comprehension nodes (for / each / if / let / C-for) expand. See implementation plan §3.5.
 */
function compElements(expr: Expression, scope: Scope, ctx: Ctx): Value[] {
    if (expr instanceof LcForExpr) return lcFor(expr.args, expr.expr, scope, ctx, 0)
    if (expr instanceof LcEachExpr) {
        const v = evalExpr(expr.expr, scope, ctx)
        return v.t === "vec" ? v.v : v.t === "range" ? iterItems(v) : v.t === "undef" ? [] : [v]
    }
    if (expr instanceof LcIfExpr) {
        if (truthy(evalExpr(expr.cond, scope, ctx))) return compElements(expr.ifExpr, scope, ctx)
        return expr.elseExpr ? compElements(expr.elseExpr, scope, ctx) : []
    }
    if (expr instanceof LcLetExpr) {
        const inner = scope.child()
        for (const a of expr.args) if (a.value) inner.set(a.name, evalExpr(a.value, inner, ctx))
        return compElements(expr.expr, inner, ctx)
    }
    if (expr instanceof LcForCExpr) return lcForC(expr, scope, ctx)
    return [evalExpr(expr, scope, ctx)]
}

/** `for (a=.., b=..) body` — cartesian over the bindings, accumulating the body's elements. */
function lcFor(args: AssignmentNode[], body: Expression, scope: Scope, ctx: Ctx, i: number): Value[] {
    if (i >= args.length) return compElements(body, scope, ctx)
    const a = args[i]
    if (!a?.value) return []
    const out: Value[] = []
    for (const item of iterItems(evalExpr(a.value, scope, ctx))) {
        const inner = scope.child()
        inner.set(a.name, item)
        out.push(...lcFor(args, body, inner, ctx, i + 1))
    }
    return out
}

/** C-style `for (init; cond; incr) body`, iteration-capped against runaway loops. */
function lcForC(node: LcForCExpr, scope: Scope, ctx: Ctx): Value[] {
    const sc = scope.child()
    for (const a of node.args) if (a.value) sc.set(a.name, evalExpr(a.value, sc, ctx))
    const out: Value[] = []
    let guard = 0
    while (truthy(evalExpr(node.cond, sc, ctx))) {
        if (guard++ > 1_000_000) break
        out.push(...compElements(node.expr, sc, ctx))
        for (const a of node.incrArgs) if (a.value) sc.set(a.name, evalExpr(a.value, sc, ctx))
    }
    return out
}

// Re-export for callers that only want the shared Args type alongside bindArgs.
export type { Args }
