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

/** Options for union / subtract / intersect with optional smooth blending. */
declare type BlendOptions = {
    /** Blend radius. Larger values create smoother transitions. */
    r?: number;
    /**
     * Blend mode (default: 'round').
     * - 'round'   — smooth rounded blend
     * - 'chamfer' — flat chamfered edge
     * - 'soft'    — softer falloff than round
     * - 'columns' — columnar / pillar-shaped blend
     * - 'stairs'  — stepped staircase blend
     */
    mode?: 'round' | 'chamfer' | 'soft' | 'columns' | 'stairs';
    /** Number of steps, used with 'stairs' and 'columns' modes. */
    n?: number;
};

/**
 * Boolean union of two or more shapes, with optional smooth blending.
 * @example union({r: 5, mode: "chamfer"}, sphere({r:1}), box({size:[1,1,1]}))
 * @example union(sphere({r:1}), box({size:[1,1,1]}))
 */
declare function union(opts: BlendOptions, ...parts: Node[]): Union;
declare function union(...parts: Node[]): Union;

/**
 * Boolean subtraction. Subtracts each subsequent shape from the first.
 * @example subtract({r: 1}, box({size:[2,2,2]}), sphere({r:1.2}))
 */
declare function subtract(opts: BlendOptions, ...parts: Node[]): Subtract;
declare function subtract(...parts: Node[]): Subtract;

/**
 * Boolean intersection of two shapes.
 * @example intersect({r: 1.5}, sphere({r:1.5}), box({size:[2,2,2]}))
 */
declare function intersect(opts: BlendOptions, lh: Node, rh: Node): Intersect;
declare function intersect(lh: Node, rh: Node): Intersect;

/**
 * Pipe blend between two shapes.
 * @example pipe({r: 0.5}, sphere({r:1}), box({size:[1,1,1]}))
 */
declare function pipe(opts: { r: number }, lh: Node, rh: Node): Pipe;

/**
 * Engrave one shape into another.
 * @example engrave({r: 1.5}, base, pattern)
 */
declare function engrave(opts: { r: number }, base: Node, pattern: Node): Engrave;

/**
 * Groove operation.
 * @example groove({ra: 1, rb: 0.5}, base, pattern)
 */
declare function groove(opts: { ra: number; rb: number }, base: Node, pattern: Node): Groove;

/**
 * Tongue operation.
 * @example tongue({ra: 1, rb: 0.5}, base, pattern)
 */
declare function tongue(opts: { ra: number; rb: number }, base: Node, pattern: Node): Tongue;

/**
 * Hard seam between two shapes.
 * @example seam({r: 0.5}, lh, rh)
 */
declare function seam(opts: { r: number }, lh: Node, rh: Node): Seam;

/**
 * Smooth morph (interpolation) between two shapes.
 * @param opts.t Blend factor 0..1 (0 = lh, 1 = rh).
 * @example morph({t: 0.25}, sphere({r:1}), box({size:[1,1,1]}))
 */
declare function morph(opts: { t: number }, lh: Node, rh: Node): Morph;

/**
 * Sphere primitive. pos defaults to [0,0,0].
 * @example sphere({pos: [1,2,3], r: 5})
 * @example sphere({r: 1})
 */
declare function sphere(opts: { pos?: Vec3; r?: number; d?: number }): Sphere;

/**
 * Axis-aligned box. pos defaults to [0,0,0].
 * @example box({size: [2, 2, 2]})
 */
declare function box(opts: { pos?: Vec3; size: Vec3 }): Box;

/**
 * Cylinder aligned to the Y-axis. pos defaults to [0,0,0].
 * @example cylinder({r: 1, h: 3})
 */
declare function cylinder(opts: { pos?: Vec3; r?: number; d?: number; h: number }): Cylinder;

/**
 * Cone aligned to the Y-axis. pos defaults to [0,0,0].
 * @example cone({r: 1, h: 2})
 */
declare function cone(opts: { pos?: Vec3; r?: number; d?: number; h: number }): Cone;

/**
 * Torus lying in the XZ plane. pos defaults to [0,0,0].
 * @example torus({sr: 0.25, lr: 1})
 */
declare function torus(opts: { pos?: Vec3; sr: number; lr: number }): Torus;

/**
 * Capsule (cylinder with hemispherical caps) aligned to the Y-axis. pos defaults to [0,0,0].
 * @example capsule({r: 0.5, c: 2})
 */
declare function capsule(opts: { pos?: Vec3; r?: number; d?: number; c: number }): Capsule;

/**
 * Infinite plane. pos defaults to [0,0,0].
 * @example plane({n: [0, 1, 0]})
 */
declare function plane(opts: { pos?: Vec3; n: Vec3; dist?: number }): PlaneNode;

/**
 * Hexagonal prism aligned to the Y-axis. pos defaults to [0,0,0].
 * @example hexprism({r: 1, h: 2})
 */
declare function hexprism(opts: { pos?: Vec3; r?: number; d?: number; h: number }): HexPrism;

/**
 * Flat disc lying in the XZ plane. pos defaults to [0,0,0].
 * @example disc({r: 1.5})
 */
declare function disc(opts: { pos?: Vec3; r?: number; d?: number }): Disc;

/**
 * Blobby / metaball primitive. pos defaults to [0,0,0].
 * @example blob()
 * @example blob({pos: [0, 0, 0]})
 */
declare function blob(opts?: { pos?: Vec3 }): Blob;

/**
 * Rotate a child node.
 * @example rotate({rot: [0, 45, 0]}, box({size:[1,2,1]}))
 */
declare function rotate(opts: { rot: Vec3 }, child: Node): Rotate;

/**
 * Hollow shell of a shape.
 * @example shell({t: 0.1}, sphere({r:2}))
 */
declare function shell(opts: { t: number }, child: Node): Shell;

/**
 * Offset a shape outward (positive) or inward (negative).
 * @example offset({amount: 0.5}, box({size:[3,3,3]}))
 */
declare function offset(opts: { amount: number }, child: Node): Offset;

/**
 * Elongate a shape by stretching it along an axis.
 * @example elongate({h: [0, 4, 0]}, sphere({r:3}))
 */
declare function elongate(opts: { h: Vec3 }, child: Node): Elongate;

/**
 * Twist a shape around the Y-axis.
 * @example twist({rate: 0.4}, box({size:[3,8,3]}))
 */
declare function twist(opts: { rate: number }, child: Node): Twist;

/**
 * Bend a shape.
 * @example bend({amount: 0.1}, child)
 */
declare function bend(opts: { amount: number }, child: Node): Bend;

/**
 * Taper a shape (scale cross-section linearly along the Y-axis).
 * @example taper({ratio: 0.5, height: 8}, child)
 */
declare function taper(opts: { ratio: number; height: number }, child: Node): Taper;

/**
 * 2-D polygon defined by a list of [x, y] vertices.
 * @param vertices Array of [x, y] coordinate pairs.
 * @example polygon2d([[0,0],[1,0],[0.5,1]])
 */
declare function polygon2d(vertices: [number, number][]): Polygon2D;

/**
 * Extrude a Polygon2D profile into a 3-D solid along the Y-axis. pos defaults to [0,0,0].
 * @example extrude({ profile: polygon2d([...]), h: 5, t: 22 })
 */
declare function extrude(opts: { pos?: Vec3; profile: Polygon2D; h: number; t?: number }): Extrude;

/**
 * Loft between two or more Polygon2D profiles along the Y-axis. pos defaults to [0,0,0].
 * @example loft({ sections: [sq, tri], h: 8 })
 */
declare function loft(opts: { pos?: Vec3; sections: Polygon2D[]; h: number }): Loft;

/**
 * Revolve a Polygon2D profile around the Y-axis (lathe / surface of revolution). pos defaults to [0,0,0].
 * @example lathe({ profile: polygon2d([...]) })
 */
declare function lathe(opts: { pos?: Vec3; profile: Polygon2D }): Lathe;
`
