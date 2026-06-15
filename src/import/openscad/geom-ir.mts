/**
 * Geometry IR: the stable tree between evaluation and emission. The evaluator produces it;
 * idiom passes (Phase 2.5) rewrite it; the emitter turns it into gcad DSL text. Keeping it
 * explicit lets eval and emit be tested independently. See implementation plan §4.
 *
 * SCAFFOLD: covers the CSG core only (prims + affine transforms + booleans). 2D/extrude,
 * offset/shell, and an explicit Unsupported node come with later phases — for now an
 * unmappable construct is dropped to `empty` and recorded as a diagnostic.
 */

export type Vec3 = [number, number, number]

export type GeomNode =
    | { kind: "sphere"; r: number; shift: Vec3 }
    | { kind: "box"; size: Vec3; shift: Vec3 }
    | { kind: "cylinder"; r: number; h: number; shift: Vec3 }
    | { kind: "translate"; arg: Vec3; child: GeomNode }
    | { kind: "rotate"; arg: Vec3; child: GeomNode }
    | { kind: "scale"; arg: Vec3; child: GeomNode }
    | { kind: "union"; children: GeomNode[] }
    | { kind: "subtract"; children: GeomNode[] }
    | { kind: "intersect"; children: GeomNode[] }
    | { kind: "empty" }

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
