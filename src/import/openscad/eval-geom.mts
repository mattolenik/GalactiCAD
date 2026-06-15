/**
 * Geometry evaluator: OpenSCAD statements → GeomIR. Statement dispatch is a switch on
 * ModuleInstantiationStmt.name (only `if` has its own node). See implementation plan §3.4.
 *
 * Handles: assignments, the CSG core (cube/sphere/cylinder, translate/rotate/scale,
 * union/difference/intersection, color), `for`, `if`, and USER-DEFINED modules & functions
 * (declarations are hoisted; calls bind args + support `children()`/`$children`, depth-guarded).
 *
 * TODO (later phases): use/include resolution, 2D + extrude, mirror/multmatrix, hull/minkowski.
 * Unmapped constructs drop to empty + a diagnostic.
 */

import { type Args, parseArgs } from "./args.mjs"
import type { Ctx } from "./context.mjs"
import { bindArgs, evalExpr } from "./eval-expr.mjs"
import { EMPTY, type GeomNode, group, type Vec3 } from "./geom-ir.mjs"
import {
    AssignmentNode,
    BlockStmt,
    type Expression,
    FunctionDeclarationStmt,
    IfElseStatement,
    IncludeStmt,
    ModuleDeclarationStmt,
    ModuleInstantiationStmt,
    type Statement,
    UseStmt,
} from "./parser-imports.mjs"
import { type ModuleDef, Scope } from "./scope.mjs"
import { asNumber, asNumberArray, rangeToNumbers, truthy, type Value } from "./values.mjs"

function loc(node: { span: { start: { line: number; col: number } } }): [number, number] {
    return [node.span.start.line + 1, node.span.start.col + 1]
}

/** A parameter may be passed by name or position; named wins (matching OpenSCAD). */
function pick(args: Args, idx: number, name: string): Expression | undefined {
    return args.named.get(name) ?? args.pos[idx]
}

function pickNum(args: Args, idx: number, name: string, scope: Scope, ctx: Ctx): number | undefined {
    const e = pick(args, idx, name)
    return e ? asNumber(evalExpr(e, scope, ctx)) : undefined
}

function pickBool(args: Args, idx: number, name: string, scope: Scope, ctx: Ctx): boolean {
    const e = pick(args, idx, name)
    return e ? truthy(evalExpr(e, scope, ctx)) : false
}

/** Read a vec3 argument; a scalar broadcasts to all three components. undefined if absent/unusable. */
function pickVec3(args: Args, idx: number, name: string, scope: Scope, ctx: Ctx): Vec3 | undefined {
    const e = pick(args, idx, name)
    if (!e) return undefined
    const v = evalExpr(e, scope, ctx)
    if (v.t === "num") return [v.v, v.v, v.v]
    const arr = asNumberArray(v)
    if (arr && arr.length >= 3) return [arr[0]!, arr[1]!, arr[2]!]
    if (arr && arr.length === 2) return [arr[0]!, arr[1]!, 0]
    return undefined
}

/** Evaluate a list of statements: hoist declarations, bind assignments, then evaluate geometry. */
export function evalStatements(stmts: Statement[], scope: Scope, ctx: Ctx): GeomNode[] {
    hoistDecls(stmts, scope, ctx) // pass 1 (descends into use/include for forward refs)
    // pass 2 — bind variable assignments (last wins; forward refs mostly resolve)
    for (const s of stmts) {
        if (s instanceof AssignmentNode && s.value) scope.set(s.name, evalExpr(s.value, scope, ctx))
    }
    // pass 3 — geometry, in source order; `include` inlines, `use` contributes nothing here
    const out: GeomNode[] = []
    for (const s of stmts) {
        if (s instanceof ModuleInstantiationStmt) out.push(evalModule(s, scope, ctx))
        else if (s instanceof IfElseStatement) out.push(evalIf(s, scope, ctx))
        else if (s instanceof IncludeStmt) out.push(...expandInclude(s, scope, ctx))
    }
    return out
}

/** Pass 1: hoist module/function declarations, descending into use/include targets (cycle-guarded). */
function hoistDecls(stmts: Statement[], scope: Scope, ctx: Ctx): void {
    for (const s of stmts) {
        if (s instanceof ModuleDeclarationStmt) scope.setModule(s.name, { decl: s, scope })
        else if (s instanceof FunctionDeclarationStmt) scope.setFunction(s.name, { decl: s, scope })
        else if (s instanceof UseStmt || s instanceof IncludeStmt) {
            const ast = ctx.includes.get(s.filename)
            if (!ast) {
                ctx.diag.warn(`could not resolve ${s instanceof IncludeStmt ? "include" : "use"} <${s.filename}>`, ...loc(s))
            } else if (!ctx.hoisted.has(s.filename)) {
                ctx.hoisted.add(s.filename)
                hoistDecls(ast.statements, scope, ctx)
            }
        }
    }
}

/** Pass 3 for `include`: inline the file's variables + geometry into the current scope (deduped). */
function expandInclude(stmt: IncludeStmt, scope: Scope, ctx: Ctx): GeomNode[] {
    const ast = ctx.includes.get(stmt.filename)
    if (!ast || ctx.expanded.has(stmt.filename)) return []
    ctx.expanded.add(stmt.filename)
    return evalStatements(ast.statements, scope, ctx)
}

/** Children of a transform/CSG node: a brace block, a single chained statement, or none. */
function evalChildren(stmt: ModuleInstantiationStmt, scope: Scope, ctx: Ctx): GeomNode[] {
    const child = stmt.child
    if (!child) return []
    const inner = scope.child()
    if (child instanceof BlockStmt) return evalStatements(child.children, inner, ctx)
    return evalStatements([child], inner, ctx)
}

function evalIf(stmt: IfElseStatement, scope: Scope, ctx: Ctx): GeomNode {
    const branch = truthy(evalExpr(stmt.cond, scope, ctx)) ? stmt.thenBranch : stmt.elseBranch
    if (!branch) return EMPTY
    return group(evalStatements([branch], scope.child(), ctx))
}

function evalModule(stmt: ModuleInstantiationStmt, scope: Scope, ctx: Ctx): GeomNode {
    const args = parseArgs(stmt.args)
    const [line, col] = loc(stmt)

    switch (stmt.name) {
        case "cube": {
            let size: Vec3 = [1, 1, 1]
            const sv = pick(args, 0, "size")
            if (sv) {
                const v = evalExpr(sv, scope, ctx)
                if (v.t === "num") size = [v.v, v.v, v.v]
                else {
                    const arr = asNumberArray(v, 3)
                    if (arr) size = [arr[0]!, arr[1]!, arr[2]!]
                    else ctx.diag.warn("cube: unsupported size argument", line, col)
                }
            }
            const center = pickBool(args, 1, "center", scope, ctx)
            const shift: Vec3 = center ? [0, 0, 0] : [size[0] / 2, size[1] / 2, size[2] / 2]
            return { kind: "box", size, shift }
        }
        case "sphere": {
            const d = pickNum(args, -1, "d", scope, ctx)
            const r = d !== undefined ? d / 2 : pickNum(args, 0, "r", scope, ctx) ?? 1
            return { kind: "sphere", r, shift: [0, 0, 0] }
        }
        case "cylinder": {
            const h = pickNum(args, 0, "h", scope, ctx) ?? 1
            const r1 = pickNum(args, -1, "r1", scope, ctx)
            const r2 = pickNum(args, -1, "r2", scope, ctx)
            if (r1 !== undefined && r2 !== undefined && r1 !== r2) {
                ctx.diag.warn("cylinder: frustum (r1 != r2) not yet supported", line, col)
                return EMPTY
            }
            const d = pickNum(args, -1, "d", scope, ctx)
            const r = r1 ?? r2 ?? (d !== undefined ? d / 2 : pickNum(args, 1, "r", scope, ctx) ?? 1)
            const center = pickBool(args, 2, "center", scope, ctx)
            const shift: Vec3 = center ? [0, 0, 0] : [0, 0, h / 2]
            return { kind: "cylinder", r, h, shift }
        }
        case "translate": {
            const v = pickVec3(args, 0, "v", scope, ctx) ?? [0, 0, 0]
            return wrap({ kind: "translate", arg: v, child: EMPTY }, evalChildren(stmt, scope, ctx))
        }
        case "rotate": {
            const a = pick(args, 0, "a")
            const v = a ? evalExpr(a, scope, ctx) : undefined
            let euler: Vec3 | undefined
            if (v?.t === "num") euler = [0, 0, v.v] // scalar rotate spins about Z
            else euler = pickVec3(args, 0, "a", scope, ctx)
            if (pick(args, 1, "v")) {
                ctx.diag.warn("rotate: axis-angle form (a, v) not yet supported", line, col)
                return EMPTY
            }
            return wrap({ kind: "rotate", arg: euler ?? [0, 0, 0], child: EMPTY }, evalChildren(stmt, scope, ctx))
        }
        case "scale": {
            const v = pickVec3(args, 0, "v", scope, ctx) ?? [1, 1, 1]
            return wrap({ kind: "scale", arg: v, child: EMPTY }, evalChildren(stmt, scope, ctx))
        }
        case "union":
            return group(evalChildren(stmt, scope, ctx))
        case "difference": {
            const kids = evalChildren(stmt, scope, ctx).filter(n => n.kind !== "empty")
            if (kids.length === 0) return EMPTY
            if (kids.length === 1) return kids[0]!
            return { kind: "subtract", children: kids }
        }
        case "intersection": {
            const kids = evalChildren(stmt, scope, ctx).filter(n => n.kind !== "empty")
            if (kids.length === 0) return EMPTY
            if (kids.length === 1) return kids[0]!
            return { kind: "intersect", children: kids }
        }
        case "color":
        case "group":
            return group(evalChildren(stmt, scope, ctx))
        case "for":
            return evalFor(stmt, scope, ctx)
        case "children":
            return evalChildrenRef(args, scope, ctx)
        default: {
            const mod = scope.getModule(stmt.name)
            if (mod) return evalUserModule(mod, stmt, scope, ctx)
            ctx.diag.warn(`unsupported module '${stmt.name}()'`, line, col)
            return EMPTY
        }
    }
}

/** `children()` → all of the current module's children; `children(i)` → the i-th. */
function evalChildrenRef(args: Args, scope: Scope, ctx: Ctx): GeomNode {
    const kids = scope.getChildren() ?? []
    const idxExpr = args.pos[0]
    if (idxExpr) {
        const i = asNumber(evalExpr(idxExpr, scope, ctx))
        if (i !== undefined && Number.isInteger(i) && i >= 0 && i < kids.length) return kids[i]!
        return EMPTY
    }
    return group(kids)
}

/** Invoke a user-defined module: bind args (lexically), expose children, evaluate its body. */
function evalUserModule(def: ModuleDef, stmt: ModuleInstantiationStmt, callScope: Scope, ctx: Ctx): GeomNode {
    if (ctx.depth >= ctx.maxDepth) {
        ctx.diag.warn(`recursion limit hit in module '${stmt.name}()'`, ...loc(stmt))
        return EMPTY
    }
    const children = evalChildren(stmt, callScope, ctx)
    const inner = bindArgs(def.scope, def.decl.definitionArgs, stmt.args, callScope, ctx)
    inner.moduleChildren = children
    inner.set("$children", { t: "num", v: children.length })
    ctx.depth++
    try {
        const body = def.decl.stmt
        const stmts = body instanceof BlockStmt ? body.children : [body]
        return group(evalStatements(stmts, inner, ctx))
    } finally {
        ctx.depth--
    }
}

/** Attach evaluated children (implicitly unioned) to a single-child transform node. */
function wrap(node: { kind: "translate" | "rotate" | "scale"; arg: Vec3; child: GeomNode }, children: GeomNode[]): GeomNode {
    const child = group(children)
    if (child.kind === "empty") return EMPTY
    return { ...node, child }
}

function evalFor(stmt: ModuleInstantiationStmt, scope: Scope, ctx: Ctx): GeomNode {
    if (stmt.args.length !== 1) {
        ctx.diag.warn("for: only a single loop variable is supported in the scaffold", ...loc(stmt))
    }
    const a = stmt.args[0]
    if (!a || !a.value) return EMPTY
    const domain = evalExpr(a.value, scope, ctx)
    const items: Value[] = domain.t === "range"
        ? rangeToNumbers(domain).map(n => ({ t: "num", v: n }))
        : domain.t === "vec"
        ? domain.v
        : []
    const acc: GeomNode[] = []
    for (const item of items) {
        const iter = scope.child()
        iter.set(a.name, item)
        acc.push(...evalChildren(stmt, iter, ctx))
    }
    return group(acc)
}
