/**
 * Emitter: GeomIR → gcad DSL source text. Factory functions are injected globals, so we emit
 * bare calls; the document body ends in `return <expr>`. The whole tree is wrapped once in the
 * Z-up→Y-up root transform (plan §5.1, §6). Emit syntax is verified against cad-types-decl.mts.
 *
 * SCAFFOLD: single-line emit. Pretty-printing / dprint formatting (the project ships dprint)
 * and `const` hoisting for reuse are Phase 2 (plan §6).
 */

import type { Diagnostic } from "./diagnostics.mjs"
import type { GeomNode, Vec2, Vec3 } from "./geom-ir.mjs"

/**
 * OpenSCAD is Z-up, gcad is Y-up — wrap the whole import in this single root rotation
 * (plan §5.1). SIGN IS PROVISIONAL: confirm −90 vs +90 about X with the image oracle, then
 * pin it here. This is the one place to change it.
 */
const Z_UP_TO_Y_UP: Vec3 = [-90, 0, 0]

function fmtNum(n: number): string {
    if (!Number.isFinite(n)) return "0"
    if (n === 0) return "0" // also collapses -0
    const r = Math.round(n * 1e9) / 1e9 // strip float noise (e.g. 0.30000000000000004)
    return String(r)
}

function fmtVec3(v: Vec3): string {
    return `[${fmtNum(v[0])}, ${fmtNum(v[1])}, ${fmtNum(v[2])}]`
}

/**
 * gcad primitives take HALF-extents (box/cylinder/extrude sizes are half-sizes; verified in
 * src/scene/primitives/{box,cylinder,extrude}.mts). GeomIR stores real full dimensions, so the
 * emitter halves extents here. Positions (.shift) are NOT halved.
 */
function fmtHalfVec3(v: Vec3): string {
    return `[${fmtNum(v[0] / 2)}, ${fmtNum(v[1] / 2)}, ${fmtNum(v[2] / 2)}]`
}

function fmtPoly(points: Vec2[]): string {
    return `polygon2d(${points.map(([x, y]) => `[${fmtNum(x)}, ${fmtNum(y)}]`).join(", ")})`
}

function shiftSuffix(shift: Vec3): string {
    return shift[0] === 0 && shift[1] === 0 && shift[2] === 0 ? "" : `.shift(${fmtVec3(shift)})`
}

/** Emit a single GeomIR node as a gcad DSL expression. */
export function emitNode(node: GeomNode): string {
    switch (node.kind) {
        case "sphere":
            return `sphere.radius(${fmtNum(node.r)})${shiftSuffix(node.shift)}`
        case "box":
            return `box(${fmtHalfVec3(node.size)})${shiftSuffix(node.shift)}` // gcad box takes half-extents
        case "cylinder":
            return `cylinder.radius(${fmtNum(node.r)}).height(${fmtNum(node.h / 2)})${shiftSuffix(node.shift)}` // half-height
        case "extrude": {
            const twist = node.twist !== 0 ? `.twist(${fmtNum(node.twist)})` : ""
            return `extrude.profile(${fmtPoly(node.profile)}).height(${fmtNum(node.height / 2)})${twist}${shiftSuffix(node.shift)}`
        }
        case "lathe":
            return `lathe.profile(${fmtPoly(node.profile)})${shiftSuffix(node.shift)}`
        case "translate":
            return `translate(${fmtVec3(node.arg)}, ${emitNode(node.child)})`
        case "rotate":
            return `rotate(${fmtVec3(node.arg)}, ${emitNode(node.child)})`
        case "scale":
            return `scale(${fmtVec3(node.arg)}, ${emitNode(node.child)})`
        case "union":
            return `union(${node.children.map(emitNode).join(", ")})`
        case "subtract":
            return `subtract(${node.children.map(emitNode).join(", ")})`
        case "intersect":
            return `intersect(${node.children.map(emitNode).join(", ")})`
        case "circle2d":
        case "square2d":
        case "poly2d":
            return "box([0, 0, 0])" // bare 2D shape (not extruded) — flagged by convert's post-pass
        case "empty":
            return "box([0, 0, 0])" // placeholder; only reached for an empty import
    }
}

/** Emit the full document: a header listing diagnostics, then the root-corrected `return`. */
export function emitDocument(body: GeomNode, diagnostics: Diagnostic[]): string {
    const lines: string[] = []
    if (diagnostics.length > 0) {
        lines.push(`// ⚠ ${diagnostics.length} construct(s) not fully imported:`)
        for (const d of diagnostics) {
            const where = d.line > 0 ? ` (line ${d.line}:${d.col})` : ""
            lines.push(`//   - ${d.message}${where}`)
        }
        lines.push("")
    }
    if (body.kind === "empty") {
        lines.push("// (no supported geometry found)")
        lines.push(`return ${emitNode(body)}`)
    } else {
        lines.push(`return rotate(${fmtVec3(Z_UP_TO_Y_UP)}, ${emitNode(body)})`)
    }
    return lines.join("\n") + "\n"
}
