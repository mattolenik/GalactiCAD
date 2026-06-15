/**
 * Expression evaluator: OpenSCAD Expression AST → Value. The functional half of OpenSCAD
 * (the geometry half lives in eval-geom). See implementation plan §3.1–§3.2.
 *
 * SCAFFOLD: literals, vectors, ranges, variable lookup, grouping, the common unary/binary
 * operators, ternary, and a small built-in math function set. Member/array indexing, list
 * comprehensions, user functions, and `let` are TODO (dropped to undef + a diagnostic).
 */

import {
    BinaryOpExpr,
    type Expression,
    FunctionCallExpr,
    GroupingExpr,
    LiteralExpr,
    LookupExpr,
    RangeExpr,
    TernaryExpr,
    TokenType,
    UnaryOpExpr,
    VectorExpr,
} from "./parser-imports.mjs"
import type { Diagnostics } from "./diagnostics.mjs"
import type { Scope } from "./scope.mjs"
import { asNumber, type Value, truthy, UNDEF, vec } from "./values.mjs"

function loc(node: { span: { start: { line: number; col: number } } }): [number, number] {
    return [node.span.start.line + 1, node.span.start.col + 1]
}

/** Built-in OpenSCAD functions over scalars. Trig is in DEGREES. */
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
    min: a => Math.min(...a),
    max: a => Math.max(...a),
}

export function evalExpr(expr: Expression, scope: Scope, diag: Diagnostics): Value {
    if (expr instanceof LiteralExpr) {
        const v: unknown = expr.value
        if (typeof v === "number") return { t: "num", v }
        if (typeof v === "boolean") return { t: "bool", v }
        if (typeof v === "string") return { t: "str", v }
        return UNDEF // null === OpenSCAD undef
    }
    if (expr instanceof VectorExpr) {
        return vec(expr.children.map(c => evalExpr(c, scope, diag)))
    }
    if (expr instanceof RangeExpr) {
        const start = asNumber(evalExpr(expr.begin, scope, diag)) ?? 0
        const end = asNumber(evalExpr(expr.end, scope, diag)) ?? 0
        const step = expr.step ? asNumber(evalExpr(expr.step, scope, diag)) ?? 1 : 1
        return { t: "range", start, step, end }
    }
    if (expr instanceof LookupExpr) {
        const found = scope.get(expr.name)
        if (found) return found
        const [line, col] = loc(expr)
        diag.warn(`undefined variable '${expr.name}'`, line, col)
        return UNDEF
    }
    if (expr instanceof GroupingExpr) {
        return evalExpr(expr.inner, scope, diag)
    }
    if (expr instanceof UnaryOpExpr) {
        const r = evalExpr(expr.right, scope, diag)
        if (expr.operation === TokenType.Bang) return { t: "bool", v: !truthy(r) }
        if (expr.operation === TokenType.Minus && r.t === "num") return { t: "num", v: -r.v }
        if (expr.operation === TokenType.Minus && r.t === "vec") {
            return vec(r.v.map(e => (e.t === "num" ? { t: "num", v: -e.v } : e)))
        }
        return r
    }
    if (expr instanceof TernaryExpr) {
        return truthy(evalExpr(expr.cond, scope, diag))
            ? evalExpr(expr.ifExpr, scope, diag)
            : evalExpr(expr.elseExpr, scope, diag)
    }
    if (expr instanceof BinaryOpExpr) {
        return evalBinary(expr, scope, diag)
    }
    if (expr instanceof FunctionCallExpr) {
        return evalCall(expr, scope, diag)
    }
    const [line, col] = loc(expr)
    diag.warn(`unsupported expression '${expr.constructor.name}'`, line, col)
    return UNDEF
}

function evalBinary(expr: BinaryOpExpr, scope: Scope, diag: Diagnostics): Value {
    const a = evalExpr(expr.left, scope, diag)
    const b = evalExpr(expr.right, scope, diag)
    const op = expr.operation

    // Logical operators short-circuit on truthiness.
    if (op === TokenType.AND) return { t: "bool", v: truthy(a) && truthy(b) }
    if (op === TokenType.OR) return { t: "bool", v: truthy(a) || truthy(b) }
    if (op === TokenType.EqualEqual) return { t: "bool", v: valueEquals(a, b) }
    if (op === TokenType.BangEqual) return { t: "bool", v: !valueEquals(a, b) }

    // Element-wise vector +/- and scalar * vector.
    if ((op === TokenType.Plus || op === TokenType.Minus) && a.t === "vec" && b.t === "vec" && a.v.length === b.v.length) {
        const f = op === TokenType.Plus ? (x: number, y: number) => x + y : (x: number, y: number) => x - y
        return vec(a.v.map((e, i) => zipNum(e, b.v[i]!, f)))
    }
    if (op === TokenType.Star && a.t === "num" && b.t === "vec") return vec(b.v.map(e => zipNum({ t: "num", v: a.v }, e, (x, y) => x * y)))
    if (op === TokenType.Star && a.t === "vec" && b.t === "num") return vec(a.v.map(e => zipNum(e, { t: "num", v: b.v }, (x, y) => x * y)))

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

    const [line, col] = loc(expr)
    diag.warn(`unsupported operands for operator #${op}`, line, col)
    return UNDEF
}

function evalCall(expr: FunctionCallExpr, scope: Scope, diag: Diagnostics): Value {
    const callee = expr.callee
    if (callee instanceof LookupExpr) {
        const fn = BUILTIN_FN[callee.name]
        if (fn) {
            const nums = expr.args.map(a => (a.value ? asNumber(evalExpr(a.value, scope, diag)) ?? 0 : 0))
            return { t: "num", v: fn(nums) }
        }
        const [line, col] = loc(expr)
        diag.warn(`unsupported function '${callee.name}()' (user functions not yet implemented)`, line, col)
        return UNDEF
    }
    const [line, col] = loc(expr)
    diag.warn("unsupported call expression", line, col)
    return UNDEF
}

function zipNum(a: Value, b: Value, f: (x: number, y: number) => number): Value {
    if (a.t === "num" && b.t === "num") return { t: "num", v: f(a.v, b.v) }
    return UNDEF
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
