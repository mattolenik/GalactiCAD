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

/** Intersection/subtract blend types (no soft). */
declare type IntersectionType = 'round' | 'chamfer' | 'columns' | 'stairs';

/** Union blend types (includes soft). */
declare type UnionType = IntersectionType | 'soft';

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
declare class Node {
    /** Shift the base primitive's position. Works through modifier chains (twist, taper, etc.). */
    shift(v: Vec3): Node;
    rotate(rot: Vec3): Rotate;
    shell(t: number): Shell;
    offset(amount: number): Offset;
    elongate(h: Vec3): Elongate;
    twist(rate: number): Twist;
    bend(amount: number): Bend;
    taper(ratio: number, height: number): Taper;
}

// ---------------------------------------------------------------------------
// Primitive shapes
// ---------------------------------------------------------------------------

/** A sphere. sphere.radius(r).shift(v).taper(ratio, height) etc. */
declare class Sphere extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    shift(v: Vec3): Sphere;
    rotate(rot: Vec3): Sphere;
    shell(t: number): Sphere;
    offset(amount: number): Sphere;
    elongate(h: Vec3): Sphere;
    twist(rate: number): Sphere;
    bend(amount: number): Sphere;
    taper(ratio: number, height: number): Sphere;
}

/** An axis-aligned box. box(size).shift(v) or box(l, w, h).shift(v) */
declare class Box extends Node {
    /** Position. */
    pos: Vec3f;
    /** Size as [length, width, height]. */
    size: Vec3f;
    shift(v: Vec3): Box;
}

/** Create a box. box(size: Vec3) or box(l: number, w: number, h: number). Chain with .shift(v). */
declare function box(size: Vec3): Box;
declare function box(l: number, w: number, h: number): Box;

/** A cylinder. cylinder.radius(r).height(h).shift(v) */
declare class Cylinder extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    h: number;
    height(h: number): Cylinder;
    shift(v: Vec3): Cylinder;
}

/** A cone. cone.radius(r).height(h).shift(v) */
declare class Cone extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    h: number;
    height(h: number): Cone;
    shift(v: Vec3): Cone;
}

/** A torus. torus.smallRadius(sr).largeRadius(lr).shift(v) */
declare class Torus extends Node {
    pos: Vec3f;
    sr: number;
    lr: number;
    smallRadius(sr: number): Torus;
    largeRadius(lr: number): Torus;
    shift(v: Vec3): Torus;
}

/** A capsule. capsule.radius(r).cylinderLength(c).shift(v) */
declare class Capsule extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    c: number;
    radius(r: number): Capsule;
    cylinderLength(c: number): Capsule;
    shift(v: Vec3): Capsule;
}

/** An infinite plane. plane.normal(n).shift(v) or plane.dist(d).shift(v) */
declare class PlaneNode extends Node {
    pos: Vec3f;
    normal: Vec3f;
    dist: number;
    withNormal(n: Vec3): PlaneNode;
    withDist(d: number): PlaneNode;
    shift(v: Vec3): PlaneNode;
}

/** A hexagonal prism. hexprism.radius(r).height(h).shift(v) */
declare class HexPrism extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    h: number;
    radius(r: number): HexPrism;
    height(h: number): HexPrism;
    shift(v: Vec3): HexPrism;
}

/** A flat disc. disc.radius(r).shift(v) */
declare class Disc extends Node {
    pos: Vec3f;
    r: number;
    d: number;
    shift(v: Vec3): Disc;
}

/** A blobby / metaball primitive. blob().shift(v) */
declare class Blob extends Node {
    pos: Vec3f;
    shift(v: Vec3): Blob;
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

/** Boolean union of two or more shapes. union(a, b, c).round(1) */
declare class Union extends Node {
    radius?: number;
    mode?: UnionType;
    n?: number;
    round(r: number): Union;
    chamfer(r: number): Union;
    soft(r: number): Union;
    stairs(r: number, n?: number): Union;
    columns(r: number, n?: number): Union;
    withMode(t: UnionType): Union;
}

/** Boolean subtraction. subtract(base, b, c).round(1) */
declare class Subtract extends Node {
    radius: number;
    mode?: IntersectionType;
    n?: number;
    round(r: number): Subtract;
    chamfer(r: number): Subtract;
    stairs(r: number, n?: number): Subtract;
    columns(r: number, n?: number): Subtract;
    withMode(t: IntersectionType): Subtract;
}

/** Boolean intersection. intersect(lh, rh).round(1) */
declare class Intersect extends Node {
    radius: number;
    mode?: IntersectionType;
    n?: number;
    round(r: number): Intersect;
    chamfer(r: number): Intersect;
    stairs(r: number, n?: number): Intersect;
    columns(r: number, n?: number): Intersect;
    withMode(t: IntersectionType): Intersect;
}

/** Pipe blend between two shapes. pipe(lh, rh).radius(r) */
declare class Pipe extends Node {
    radius(r: number): Pipe;
}

/** Engrave one shape into another. engrave(base).pattern(pattern).radius(r) */
declare class Engrave extends Node {
    radius(r: number): Engrave;
}

/** Groove operation. groove(base).pattern(pattern).radii(ra, rb) */
declare class Groove extends Node {
    radii(ra: number, rb: number): Groove;
}

/** Tongue operation. tongue(base).pattern(pattern).radii(ra, rb) */
declare class Tongue extends Node {
    radii(ra: number, rb: number): Tongue;
}

/** Hard seam between two shapes. seam(lh, rh).radius(r) */
declare class Seam extends Node {
    radius(r: number): Seam;
}

/** Smooth morph between two shapes. morph(lh, rh).t(t) */
declare class Morph extends Node {
    t(t: number): Morph;
}

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
declare class Extrude extends Node {
    height(n: number): Extrude;
    twist(degrees: number): Extrude;
    shift(v: Vec3): Extrude;
}

/** Loft between two or more Polygon2D profiles. */
declare class Loft extends Node {
    height(n: number): Loft;
    shift(v: Vec3): Loft;
    rotate(rot: Vec3): Loft;
    shell(t: number): Loft;
    offset(amount: number): Loft;
    elongate(h: Vec3): Loft;
    twist(rate: number): Loft;
    bend(amount: number): Loft;
    taper(ratio: number, height: number): Loft;
}

/** Revolve a Polygon2D around the Y-axis (lathe). */
declare class Lathe extends Node {
    shift(v: Vec3): Lathe;
    rotate(rot: Vec3): Lathe;
    shell(t: number): Lathe;
    offset(amount: number): Lathe;
    elongate(h: Vec3): Lathe;
    twist(rate: number): Lathe;
    bend(amount: number): Lathe;
    taper(ratio: number, height: number): Lathe;
}

// ---------------------------------------------------------------------------
// Factory function declarations
// (passed as named parameters to user code — declared as globals here)
// ---------------------------------------------------------------------------

/**
 * Boolean union of two or more shapes.
 * @example union(sphere.radius(1), box([1,1,1])).round(1)
 */
declare function union(...parts: Node[]): Union;

/**
 * Boolean subtraction. subtract(base, ...parts).round(1)
 * @example subtract(box([2,2,2]), sphere.radius(1.2)).round(1)
 */
declare function subtract(base: Node, ...parts: Node[]): Subtract;

/**
 * Boolean intersection of two shapes.
 * @example intersect(sphere.radius(1.5), box([2,2,2])).round(1)
 */
declare function intersect(lh: Node, rh: Node): Intersect;

/**
 * Pipe blend between two shapes.
 * @example pipe(sphere.radius(1), box([1,1,1])).radius(0.5)
 */
declare function pipe(lh: Node, rh: Node): Pipe;

/**
 * Engrave one shape into another.
 * @example engrave(box([6,6,6])).pattern(sphere.radius(4)).radius(1.5)
 */
declare function engrave(base: Node): { pattern(pattern: Node): Engrave };

/**
 * Groove operation.
 * @example groove(base).pattern(pattern).radii(1, 0.5)
 */
declare function groove(base: Node): { pattern(pattern: Node): Groove };

/**
 * Tongue operation.
 * @example tongue(base).pattern(pattern).radii(1, 0.5)
 */
declare function tongue(base: Node): { pattern(pattern: Node): Tongue };

/**
 * Hard seam between two shapes.
 * @example seam(lh, rh).radius(0.5)
 */
declare function seam(lh: Node, rh: Node): Seam;

/**
 * Smooth morph (interpolation) between two shapes. t is blend factor 0..1.
 * @example morph(sphere.radius(1), box([1,1,1])).t(0.25)
 */
declare function morph(lh: Node, rh: Node): Morph;

/**
 * Sphere primitive. sphere.radius(r).shift(v)
 */
declare const sphere: { radius(r: number): Sphere };

/**
 * Axis-aligned box. box(size).shift(v) or box(l, w, h).shift(v)
 */
declare const box: { size(s: Vec3): Box };

/**
 * Cylinder aligned to the Y-axis. cylinder.radius(r).height(h).shift(v)
 */
declare const cylinder: { radius(r: number): Cylinder };

/**
 * Cone aligned to the Y-axis. cone.radius(r).height(h).shift(v)
 */
declare const cone: { radius(r: number): Cone };

/**
 * Torus lying in the XZ plane. torus.smallRadius(sr).largeRadius(lr).shift(v)
 */
declare const torus: { smallRadius(sr: number): Torus; largeRadius(lr: number): Torus };

/**
 * Capsule. capsule.radius(r).cylinderLength(c).shift(v)
 */
declare const capsule: { radius(r: number): Capsule; cylinderLength(c: number): Capsule };

/**
 * Infinite plane. plane.normal(n).shift(v) or plane.dist(d).shift(v)
 */
declare const plane: { normal(n: Vec3): PlaneNode; dist(d?: number): PlaneNode };

/**
 * Hexagonal prism. hexprism.radius(r).height(h).shift(v)
 */
declare const hexprism: { radius(r: number): HexPrism; height(h: number): HexPrism };

/**
 * Flat disc. disc.radius(r).shift(v)
 */
declare const disc: { radius(r: number): Disc };

/**
 * Blobby / metaball primitive. blob().shift(v)
 */
declare function blob(): Blob;

/**
 * 2-D polygon defined by a list of [x, y] vertices.
 * @param vertices Array of [x, y] coordinate pairs.
 * @example polygon2d([[0,0],[1,0],[0.5,1]])
 */
declare function polygon2d(vertices: [number, number][]): Polygon2D;

/**
 * Extrude a Polygon2D profile. extrude.profile(p).height(n).twist(deg).shift(v)
 */
declare const extrude: { profile(p: Polygon2D): Extrude };

/**
 * Loft between two or more Polygon2D profiles. loft.sections([...]).height(n).shift(v)
 */
declare const loft: { sections(s: Polygon2D[]): Loft };

/**
 * Revolve a Polygon2D profile around the Y-axis. lathe.profile(p).shift(v)
 */
declare const lathe: { profile(p: Polygon2D): Lathe };
`
