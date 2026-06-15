/**
 * Geometry IR: the stable tree between evaluation and emission. The evaluator produces it;
 * idiom passes (Phase 2.5) rewrite it; the emitter turns it into gcad DSL text. Keeping it
 * explicit lets eval and emit be tested independently. See implementation plan §4.
 *
 * SCAFFOLD: covers the CSG core, 2D primitives + linear/rotate extrusion. offset/shell, and an
 * explicit Unsupported node come with later phases — for now an unmappable construct is dropped
 * to `empty` and recorded as a diagnostic.
 *
 * 2D nodes (circle2d/square2d/poly2d) only exist as children of linear_extrude/rotate_extrude;
 * lowering replaces them with 3D solids. A 2D node that survives to emit is a bare-2D mistake.
 *
 * Dimensions here are REAL (full) OpenSCAD sizes/heights; the emitter applies gcad's half-extent
 * convention (box/cylinder/extrude take half-sizes). `.shift` fields are real positions (not halved).
 */

export type Vec3 = [number, number, number]
export type Vec2 = [number, number]

export type GeomNode =
    | { kind: "sphere"; r: number; shift: Vec3 }
    | { kind: "box"; size: Vec3; shift: Vec3 }
    | { kind: "cylinder"; r: number; h: number; shift: Vec3 }
    | { kind: "extrude"; profile: Vec2[]; height: number; twist: number; shift: Vec3 }
    | { kind: "lathe"; profile: Vec2[]; shift: Vec3 }
    | { kind: "translate"; arg: Vec3; child: GeomNode }
    | { kind: "rotate"; arg: Vec3; child: GeomNode }
    | { kind: "scale"; arg: Vec3; child: GeomNode }
    | { kind: "union"; children: GeomNode[] }
    | { kind: "subtract"; children: GeomNode[] }
    | { kind: "intersect"; children: GeomNode[] }
    | { kind: "circle2d"; r: number }
    | { kind: "square2d"; size: Vec2; center: boolean }
    | { kind: "poly2d"; points: Vec2[] }
    | { kind: "empty" }

/** The 2D node kinds — valid only under an extrusion (lowered away before emit). */
export function is2D(n: GeomNode): boolean {
    return n.kind === "circle2d" || n.kind === "square2d" || n.kind === "poly2d"
}

/** Does the tree still contain an un-lowered 2D node (a bare 2D shape)? */
export function containsBare2D(n: GeomNode): boolean {
    if (is2D(n)) return true
    if (n.kind === "translate" || n.kind === "rotate" || n.kind === "scale") return containsBare2D(n.child)
    if (n.kind === "union" || n.kind === "subtract" || n.kind === "intersect") return n.children.some(containsBare2D)
    return false
}

export const EMPTY: GeomNode = { kind: "empty" }

const isEmpty = (n: GeomNode): boolean => n.kind === "empty"

/**
 * Combine sibling geometry the way OpenSCAD implicitly unions the children of a transform or
 * the top level: drop empties, collapse to the single child, else wrap in a union.
 */
export function group(nodes: GeomNode[]): GeomNode {
    const kept = nodes.filter(n => !isEmpty(n))
    if (kept.length === 0) return EMPTY
    if (kept.length === 1) return kept[0]!
    return { kind: "union", children: kept }
}
