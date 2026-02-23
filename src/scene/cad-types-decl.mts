/**
 * TypeScript type declarations for the GalacticAD CAD scripting API.
 * Injected into the Monaco editor as ambient global declarations so the
 * TypeScript language service provides completions and type-checking for
 * the factory functions that are passed as parameters to user code.
 */
export const CAD_TYPES_DECL = `
/** A 3D position or vector, given as a tuple [x, y, z]. */
declare type Vec3 = [number, number, number];

/** Blend mode for smooth CSG operations. */
declare type BlendMode = 'round' | 'chamfer' | 'soft' | 'columns' | 'stairs';

/** A mutable 3D vector with named components. Returned on node .pos and .size properties. */
declare class Vec3f {
    x: number;
    y: number;
    z: number;
}

// ---------------------------------------------------------------------------
// Base node class
// ---------------------------------------------------------------------------

/** Base class for all scene nodes. */
declare class Node {}

// ---------------------------------------------------------------------------
// Primitive shapes
// ---------------------------------------------------------------------------

/** A sphere. */
declare class Sphere extends Node {
    /** Position. */
    pos: Vec3f;
    /** Radius. */
    r: number;
    /** Diameter (alias for 2*r). */
    d: number;
}

/** An axis-aligned box. */
declare class Box extends Node {
    /** Position. */
    pos: Vec3f;
    /** Size as [length, width, height]. */
    size: Vec3f;
    /** Length (size.x). */
    l: number;
    /** Width (size.y). */
    w: number;
    /** Height (size.z). */
    h: number;
}

/** A cylinder. */
declare class Cylinder extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    h: number;
}

/** A cone. */
declare class Cone extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    h: number;
}

/** A torus. */
declare class Torus extends Node {
    pos: Vec3f;
    /** Small (tube) radius. */
    sr: number;
    /** Large (ring) radius. */
    lr: number;
}

/** A capsule (cylinder with hemispherical caps). */
declare class Capsule extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    /** Cylinder length between cap centres. */
    c: number;
}

/** An infinite plane. */
declare class PlaneNode extends Node {
    pos: Vec3f;
    /** Unit normal. */
    normal: Vec3f;
    dist: number;
}

/** A hexagonal prism. */
declare class HexPrism extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    h: number;
}

/** A flat disc. */
declare class Disc extends Node {
    pos: Vec3f;
    r: number;
    d: number;
}

/** A blobby / metaball primitive. */
declare class Blob extends Node {
    pos: Vec3f;
}

// ---------------------------------------------------------------------------
// 2-D primitive
// ---------------------------------------------------------------------------

/** A 2-D polygon defined by a list of [x, y] vertices. */
declare class Polygon2D {
    vertices: [number, number][];
}

// ---------------------------------------------------------------------------
// CSG / combinator nodes
// ---------------------------------------------------------------------------

/** A group of nodes. */
declare class Group extends Node {
    children: Node[];
}

/** Boolean union of two or more shapes. */
declare class Union extends Node {}

/** Boolean subtraction. */
declare class Subtract extends Node {}

/** Boolean intersection. */
declare class Intersect extends Node {}

/** Pipe blend between two shapes. */
declare class Pipe extends Node {}

/** Engrave one shape into another. */
declare class Engrave extends Node {}

/** Groove operation. */
declare class Groove extends Node {}

/** Tongue operation. */
declare class Tongue extends Node {}

/** Hard seam between two shapes. */
declare class Seam extends Node {}

/** Smooth morph between two shapes. */
declare class Morph extends Node {}

// ---------------------------------------------------------------------------
// Unary modifier nodes
// ---------------------------------------------------------------------------

/** Hollow shell of a shape. */
declare class Shell extends Node {}

/** Uniform outward / inward offset. */
declare class Offset extends Node {}

/** Elongate a shape along an axis. */
declare class Elongate extends Node {}

/** Twist a shape around the Y-axis. */
declare class Twist extends Node {}

/** Bend a shape. */
declare class Bend extends Node {}

/** Taper a shape. */
declare class Taper extends Node {}

/** Rotate a child node. */
declare class Rotate extends Node {}

// ---------------------------------------------------------------------------
// 2-D → 3-D operations
// ---------------------------------------------------------------------------

/** Extrude a Polygon2D into a 3-D solid. */
declare class Extrude extends Node {}

/** Loft between two or more Polygon2D profiles. */
declare class Loft extends Node {}

/** Revolve a Polygon2D around the Y-axis (lathe). */
declare class Lathe extends Node {}

// ---------------------------------------------------------------------------
// Factory function declarations
// (passed as named parameters to user code — declared as globals here)
// ---------------------------------------------------------------------------

/**
 * Group several nodes together without a CSG operation.
 * @example group(sphere([0,0,0], {r:1}), box([2,0,0], [1,1,1]))
 */
declare function group(...nodes: Node[]): Group;

/** Options for union / subtract / intersect with optional smooth blending. */
declare type BlendOptions = { r?: number; mode?: BlendMode; n?: number };

/**
 * Boolean union of two or more shapes, with optional smooth blending.
 * @example union(sphere([0,0,0], {r:1}), box([2,0,0], [1,1,1]))
 * @example union({r: 0.5}, sphere([0,0,0], {r:1}), box([2,0,0], [1,1,1]))
 */
declare function union(opts: BlendOptions, ...parts: Node[]): Union;
declare function union(radius: number, ...parts: Node[]): Union;
declare function union(...parts: Node[]): Union;

/**
 * Boolean subtraction. Subtracts each subsequent shape from the first.
 * @example subtract(box([0,0,0], [2,2,2]), sphere([0,0,0], {r:1.2}))
 */
declare function subtract(opts: BlendOptions, ...parts: Node[]): Subtract;
declare function subtract(radius: number, ...parts: Node[]): Subtract;
declare function subtract(...parts: Node[]): Subtract;

/**
 * Boolean intersection of two shapes.
 * @example intersect(sphere([0,0,0], {r:1.5}), box([0,0,0], [2,2,2]))
 */
declare function intersect(opts: BlendOptions, lh: Node, rh: Node): Intersect;
declare function intersect(lh: Node, rh: Node): Intersect;

/**
 * Pipe blend between two shapes.
 * @param radius Blend radius.
 */
declare function pipe(lh: Node, rh: Node, radius: number): Pipe;

/**
 * Engrave one shape into another.
 * @param radius Blend radius.
 */
declare function engrave(lh: Node, rh: Node, radius: number): Engrave;

/**
 * Groove operation.
 * @param ra Outer blend radius.
 * @param rb Inner blend radius.
 */
declare function groove(lh: Node, rh: Node, ra: number, rb: number): Groove;

/**
 * Tongue operation.
 * @param ra Outer blend radius.
 * @param rb Inner blend radius.
 */
declare function tongue(lh: Node, rh: Node, ra: number, rb: number): Tongue;

/**
 * Hard seam between two shapes.
 * @param radius Seam radius.
 */
declare function seam(lh: Node, rh: Node, radius: number): Seam;

/**
 * Smooth morph (interpolation) between two shapes.
 * @param t Blend factor 0..1 (0 = lh, 1 = rh).
 */
declare function morph(t: number, lh: Node, rh: Node): Morph;

/**
 * Sphere primitive.
 * @param pos Centre position [x, y, z].
 * @param opts Radius (r) or diameter (d).
 * @example sphere([0, 0, 0], { r: 1 })
 */
declare function sphere(pos: Vec3, opts: { r?: number; d?: number }): Sphere;

/**
 * Axis-aligned box.
 * @param pos Centre position [x, y, z].
 * @param size Dimensions [length, width, height].
 * @example box([0, 0, 0], [2, 2, 2])
 */
declare function box(pos: Vec3, size: Vec3): Box;

/**
 * Cylinder aligned to the Y-axis.
 * @param pos Centre position [x, y, z].
 * @param opts Radius (r) or diameter (d), and height (h).
 * @example cylinder([0, 0, 0], { r: 1, h: 3 })
 */
declare function cylinder(pos: Vec3, opts: { r?: number; d?: number; h: number }): Cylinder;

/**
 * Cone aligned to the Y-axis.
 * @param pos Centre position [x, y, z].
 * @param opts Radius (r) or diameter (d) at the base, and height (h).
 * @example cone([0, 0, 0], { r: 1, h: 2 })
 */
declare function cone(pos: Vec3, opts: { r?: number; d?: number; h: number }): Cone;

/**
 * Torus lying in the XZ plane.
 * @param pos Centre position [x, y, z].
 * @param opts Small (tube) radius sr and large (ring) radius lr.
 * @example torus([0, 0, 0], { sr: 0.25, lr: 1 })
 */
declare function torus(pos: Vec3, opts: { sr: number; lr: number }): Torus;

/**
 * Capsule (cylinder with hemispherical caps) aligned to the Y-axis.
 * @param pos Centre position [x, y, z].
 * @param opts Radius (r) or diameter (d), and cylinder length (c).
 * @example capsule([0, 0, 0], { r: 0.5, c: 2 })
 */
declare function capsule(pos: Vec3, opts: { r?: number; d?: number; c: number }): Capsule;

/**
 * Infinite plane.
 * @param pos A point on the plane [x, y, z].
 * @param opts Normal vector (n) and optional signed distance (dist).
 * @example plane([0, 0, 0], { n: [0, 1, 0] })
 */
declare function plane(pos: Vec3, opts: { n: Vec3; dist?: number }): PlaneNode;

/**
 * Hexagonal prism aligned to the Y-axis.
 * @param pos Centre position [x, y, z].
 * @param opts Radius (r) or diameter (d), and height (h).
 * @example hexprism([0, 0, 0], { r: 1, h: 2 })
 */
declare function hexprism(pos: Vec3, opts: { r?: number; d?: number; h: number }): HexPrism;

/**
 * Flat disc lying in the XZ plane.
 * @param pos Centre position [x, y, z].
 * @param opts Radius (r) or diameter (d).
 * @example disc([0, 0, 0], { r: 1.5 })
 */
declare function disc(pos: Vec3, opts: { r?: number; d?: number }): Disc;

/**
 * Blobby / metaball primitive.
 * @param pos Centre position [x, y, z].
 * @example blob([0, 0, 0])
 */
declare function blob(pos: Vec3): Blob;

/**
 * Rotate a child node.
 * @param rotation Euler angles in degrees [rx, ry, rz].
 * @param child The node to rotate.
 * @example rotate([0, 45, 0], box([0,0,0], [1,2,1]))
 */
declare function rotate(rotation: Vec3, child: Node): Rotate;

/**
 * Hollow shell of a shape.
 * @param thickness Wall thickness.
 * @param child The node to shell.
 * @example shell(0.1, sphere([0,0,0], {r:2}))
 */
declare function shell(thickness: number, child: Node): Shell;

/**
 * Offset a shape outward (positive) or inward (negative).
 * @param amount Offset distance.
 * @param child The node to offset.
 */
declare function offset(amount: number, child: Node): Offset;

/**
 * Elongate a shape by stretching it along an axis.
 * @param h Extension amounts [hx, hy, hz].
 * @param child The node to elongate.
 */
declare function elongate(h: Vec3, child: Node): Elongate;

/**
 * Twist a shape around the Y-axis.
 * @param rate Twist rate in degrees per unit.
 * @param child The node to twist.
 */
declare function twist(rate: number, child: Node): Twist;

/**
 * Bend a shape.
 * @param amount Bend amount.
 * @param child The node to bend.
 */
declare function bend(amount: number, child: Node): Bend;

/**
 * Taper a shape (scale cross-section linearly along the Y-axis).
 * @param ratio Scale at the top relative to the bottom (e.g. 0 = sharp point).
 * @param height Height over which to apply the taper.
 * @param child The node to taper.
 */
declare function taper(ratio: number, height: number, child: Node): Taper;

/**
 * 2-D polygon defined by a list of [x, y] vertices.
 * @param vertices Array of [x, y] coordinate pairs.
 * @example polygon2d([[0,0],[1,0],[0.5,1]])
 */
declare function polygon2d(vertices: [number, number][]): Polygon2D;

/**
 * Extrude a Polygon2D profile into a 3-D solid along the Y-axis.
 * @example extrude(polygon2d([...]), { h: 5 })
 * @example extrude([0,0,0], polygon2d([...]), { h: 5 })
 */
declare function extrude(child: Polygon2D, opts: { h: number; t?: number }): Extrude;
declare function extrude(pos: Vec3, child: Polygon2D, opts: { h: number; t?: number }): Extrude;

/**
 * Loft between two or more Polygon2D profiles along the Y-axis.
 * @example loft(polygon2d([...]), polygon2d([...]), { h: 5 })
 * @example loft([0,0,0], polygon2d([...]), polygon2d([...]), { h: 5 })
 */
declare function loft(...profilesAndOpts: (Polygon2D | { h: number } | Vec3)[]): Loft;

/**
 * Revolve a Polygon2D profile around the Y-axis (lathe / surface of revolution).
 * @example lathe(polygon2d([...]))
 * @example lathe([0,0,0], polygon2d([...]))
 */
declare function lathe(child: Polygon2D): Lathe;
declare function lathe(pos: Vec3, child: Polygon2D): Lathe;
`
