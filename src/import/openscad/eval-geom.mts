/**
 * Geometry evaluator: OpenSCAD statements → GeomIR. Statement dispatch is a switch on
 * ModuleInstantiationStmt.name (only `if` has its own node). See implementation plan §3.4.
 *
 * SCAFFOLD: covers assignments, the CSG core (cube/sphere/cylinder, translate/rotate/scale,
 * union/difference/intersection, color), `for`, and `if`. User modules/functions, 2D + extrude,
 * mirror/multmatrix, hull/minkowski, etc. are dropped to empty + a diagnostic (TODO per phase).
 */

import {
    AssignmentNode,
    BlockStmt,
    type Expression,
    IfElseStatement,
    ModuleInstantiationStmt,
    type Statement,
    UseStmt,
} from "./parser-imports.mjs"
import type { Diagnostics } from "./diagnostics.mjs"
import { evalExpr } from "./eval-expr.mjs"
import { EMPTY, type GeomNode, group, type Vec3 } from "./geom-ir.mjs"
import { Scope } from "./scope.mjs"
import { asNumber, asNumberArray, rangeToNumbers, truthy, type Value } from "./values.mjs"

function loc(node: { span: { start: { line: number; col: number } } }): [number, number] {
    return [node.span.start.line + 1, node.span.start.col + 1]
}

interface Args {
    pos: Expression[]
    named: Map<string, Expression>
}

function parseArgs(args: AssignmentNode[]): Args {
    const pos: Expression[] = []
    const named = new Map<string, Expression>()
    for (const a of args) {
        if (!a.value) continue
        if (a.name === "") pos.push(a.value)
        else named.set(a.name, a.value)
    }
    return { pos, named }
}

/** A parameter may be passed by name or position; named wins (matching OpenSCAD). */
function pick(args: Args, idx: number, name: string): Expression | undefined {
    return args.named.get(name) ?? args.pos[idx]
}

function pickNum(args: Args, idx: number, name: string, scope: Scope, diag: Diagnostics): number | undefined {
    const e = pick(args, idx, name)
    return e ? asNumber(evalExpr(e, scope, diag)) : undefined
}

function pickBool(args: Args, idx: number, name: string, scope: Scope, diag: Diagnostics): boolean {
    const e = pick(args, idx, name)
    return e ? truthy(evalExpr(e, scope, diag)) : false
}

/** Read a vec3 argument; a scalar broadcasts to all three components. undefined if absent/unusable. */
function pickVec3(args: Args, idx: number, name: string, scope: Scope, diag: Diagnostics): Vec3 | undefined {
    const e = pick(args, idx, name)
    if (!e) return undefined
    const v = evalExpr(e, scope, diag)
    if (v.t === "num") return [v.v, v.v, v.v]
    const arr = asNumberArray(v)
    if (arr && arr.length >= 3) return [arr[0]!, arr[1]!, arr[2]!]
    if (arr && arr.length === 2) return [arr[0]!, arr[1]!, 0]
    return undefined
}

/** Evaluate a list of statements: pre-bind assignments, then evaluate geometry. */
export function evalStatements(stmts: Statement[], scope: Scope, diag: Diagnostics): GeomNode[] {
    for (const s of stmts) {
        // AssignmentNode is a statement at the top level / inside blocks (role VARIABLE_DECLARATION).
        // Pre-bound before geometry so later assignments win and forward refs mostly resolve.
        if (s instanceof AssignmentNode && s.value) scope.set(s.name, evalExpr(s.value, scope, diag))
    }
    const out: GeomNode[] = []
    for (const s of stmts) {
        if (s instanceof ModuleInstantiationStmt) out.push(evalModule(s, scope, diag))
        else if (s instanceof IfElseStatement) out.push(evalIf(s, scope, diag))
        else if (s instanceof UseStmt) diag.warn(`'use <${s.filename}>' not yet resolved`, ...loc(s))
        // assignments handled above; NoopStmt / declarations ignored for now
    }
    return out
}

/** Children of a transform/CSG node: a brace block, a single chained statement, or none. */
function evalChildren(stmt: ModuleInstantiationStmt, scope: Scope, diag: Diagnostics): GeomNode[] {
    const child = stmt.child
    if (!child) return []
    const inner = scope.child()
    if (child instanceof BlockStmt) return evalStatements(child.children, inner, diag)
    return evalStatements([child], inner, diag)
}

function evalIf(stmt: IfElseStatement, scope: Scope, diag: Diagnostics): GeomNode {
    const branch = truthy(evalExpr(stmt.cond, scope, diag)) ? stmt.thenBranch : stmt.elseBranch
    if (!branch) return EMPTY
    return group(evalStatements([branch], scope.child(), diag))
}

function evalModule(stmt: ModuleInstantiationStmt, scope: Scope, diag: Diagnostics): GeomNode {
    const args = parseArgs(stmt.args)
    const [line, col] = loc(stmt)

    switch (stmt.name) {
        case "cube": {
            let size: Vec3 = [1, 1, 1]
            const sv = pick(args, 0, "size")
            if (sv) {
                const v = evalExpr(sv, scope, diag)
                if (v.t === "num") size = [v.v, v.v, v.v]
                else {
                    const arr = asNumberArray(v, 3)
                    if (arr) size = [arr[0]!, arr[1]!, arr[2]!]
                    else diag.warn("cube: unsupported size argument", line, col)
                }
            }
            const center = pickBool(args, 1, "center", scope, diag)
            const shift: Vec3 = center ? [0, 0, 0] : [size[0] / 2, size[1] / 2, size[2] / 2]
            return { kind: "box", size, shift }
        }
        case "sphere": {
            const d = pickNum(args, -1, "d", scope, diag)
            const r = d !== undefined ? d / 2 : pickNum(args, 0, "r", scope, diag) ?? 1
            return { kind: "sphere", r, shift: [0, 0, 0] }
        }
        case "cylinder": {
            const h = pickNum(args, 0, "h", scope, diag) ?? 1
            const r1 = pickNum(args, -1, "r1", scope, diag)
            const r2 = pickNum(args, -1, "r2", scope, diag)
            if (r1 !== undefined && r2 !== undefined && r1 !== r2) {
                diag.warn("cylinder: frustum (r1 != r2) not yet supported", line, col)
                return EMPTY
            }
            const d = pickNum(args, -1, "d", scope, diag)
            const r = r1 ?? r2 ?? (d !== undefined ? d / 2 : pickNum(args, 1, "r", scope, diag) ?? 1)
            const center = pickBool(args, 2, "center", scope, diag)
            const shift: Vec3 = center ? [0, 0, 0] : [0, 0, h / 2]
            return { kind: "cylinder", r, h, shift }
        }
        case "translate": {
            const v = pickVec3(args, 0, "v", scope, diag) ?? [0, 0, 0]
            return wrap({ kind: "translate", arg: v, child: EMPTY }, evalChildren(stmt, scope, diag))
        }
        case "rotate": {
            const a = pick(args, 0, "a")
            const v = a ? evalExpr(a, scope, diag) : undefined
            let euler: Vec3 | undefined
            if (v?.t === "num") euler = [0, 0, v.v] // scalar rotate spins about Z
            else euler = pickVec3(args, 0, "a", scope, diag)
            if (pick(args, 1, "v")) {
                diag.warn("rotate: axis-angle form (a, v) not yet supported", line, col)
                return EMPTY
            }
            return wrap({ kind: "rotate", arg: euler ?? [0, 0, 0], child: EMPTY }, evalChildren(stmt, scope, diag))
        }
        case "scale": {
            const v = pickVec3(args, 0, "v", scope, diag) ?? [1, 1, 1]
            return wrap({ kind: "scale", arg: v, child: EMPTY }, evalChildren(stmt, scope, diag))
        }
        case "union":
            return group(evalChildren(stmt, scope, diag))
        case "difference": {
            const kids = evalChildren(stmt, scope, diag).filter(n => n.kind !== "empty")
            if (kids.length === 0) return EMPTY
            if (kids.length === 1) return kids[0]!
            return { kind: "subtract", children: kids }
        }
        case "intersection": {
            const kids = evalChildren(stmt, scope, diag).filter(n => n.kind !== "empty")
            if (kids.length === 0) return EMPTY
            if (kids.length === 1) return kids[0]!
            return { kind: "intersect", children: kids }
        }
        case "color":
        case "group":
            return group(evalChildren(stmt, scope, diag))
        case "for":
            return evalFor(stmt, scope, diag)
        default:
            diag.warn(`unsupported module '${stmt.name}()'`, line, col)
            return EMPTY
    }
}

/** Attach evaluated children (implicitly unioned) to a single-child transform node. */
function wrap(node: { kind: "translate" | "rotate" | "scale"; arg: Vec3; child: GeomNode }, children: GeomNode[]): GeomNode {
    const child = group(children)
    if (child.kind === "empty") return EMPTY
    return { ...node, child }
}

function evalFor(stmt: ModuleInstantiationStmt, scope: Scope, diag: Diagnostics): GeomNode {
    if (stmt.args.length !== 1) {
        diag.warn("for: only a single loop variable is supported in the scaffold", ...loc(stmt))
    }
    const a = stmt.args[0]
    if (!a || !a.value) return EMPTY
    const domain = evalExpr(a.value, scope, diag)
    const items: Value[] = domain.t === "range"
        ? rangeToNumbers(domain).map(n => ({ t: "num", v: n }))
        : domain.t === "vec"
        ? domain.v
        : []
    const acc: GeomNode[] = []
    for (const item of items) {
        const iter = scope.child()
        iter.set(a.name, item)
        acc.push(...evalChildren(stmt, iter, diag))
    }
    return group(acc)
}
