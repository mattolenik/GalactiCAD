/**
 * Classification of gcad DSL function/method names into categories.
 *
 * These sets were extracted from source-parser.mts so they can be shared by
 * consumers (e.g. the editor's right-click "Remove" feature) without importing
 * the whole parser. They are the single source of truth for "is this word a
 * known DSL construct, and what kind?".
 */

/** Leaf shapes: they have no geometry children (removing one removes everything built on it). */
export const PRIMITIVE_FUNCTIONS = new Set([
    "sphere", "box", "cylinder", "cone", "torus", "threaded_rod", "capsule",
    "plane", "hexprism", "disc", "blob", "polygon2d", "path2d",
])

/** Composite functions: CSG operators plus rendering composites (extrude/loft/lathe/knurl). */
export const COMPOSITE_FUNCTIONS = new Set([
    "union", "subtract", "intersect", "pipe", "engrave", "groove", "tongue",
    "morph", "seam", "extrude", "loft", "lathe", "knurl",
])

/**
 * Unary modifiers in functional form. The geometry node is their LAST argument
 * (e.g. `rotate(rot, node)`, `translate(offset, node)`), so removing the head
 * unwraps to that last argument.
 */
export const MODIFIER_NAMES = new Set([
    "rotate", "translate", "scale", "shell", "offset", "elongate", "twist",
    "bend", "taper", "repeatPolar",
])

/** Union of every function-call head we recognize as a removable DSL construct. */
export const ALL_SHAPE_FUNCTIONS = new Set([
    ...PRIMITIVE_FUNCTIONS, ...COMPOSITE_FUNCTIONS, ...MODIFIER_NAMES,
])

/**
 * Heads invoked via a namespace object whose FIRST method is a required
 * constructor: every primitive (`sphere.radius(…)`, `box(…)`) plus the
 * rendering composites that build from a required profile/section
 * (`extrude.profile(…)`, `loft.sections(…)`, `lathe.profile(…)`). Removing the
 * head OR that first method removes the whole expression.
 */
export const NAMESPACE_CONSTRUCTOR_FUNCTIONS = new Set([
    ...PRIMITIVE_FUNCTIONS, "extrude", "loft", "lathe",
])

/**
 * CSG operators that act as pure pass-throughs: they have no independent visual
 * representation and should be "looked through" when resolving logical leaf calls.
 * Modifiers (rotate, shell, etc.) and rendering composites (extrude, loft, lathe)
 * are NOT in this set.
 */
export const CSG_PASSTHROUGH_FUNCTIONS = new Set([
    "union", "subtract", "intersect", "pipe", "engrave", "groove", "knurl",
    "tongue", "morph", "seam",
])

/**
 * Recognized fluent modifier method names (`node.method(...)` chained forms).
 * Curated from the `@fluent`-decorated methods across scene/primitives and
 * scene/operators so the "Remove symbol" feature can recognize a chained
 * `.method(...)` as a strippable DSL modifier without depending on the
 * dynamically-populated `styleInfo.FluentMethods` registry (which only fills in
 * once every scene module has been imported). Callers may additionally pass the
 * live registry to catch any method this static list misses.
 *
 * Note: names like `radius`/`smallRadius`/`largeRadius`/`height`/`cylinderLength`
 * appear here because they are also chainable, but when one is the FIRST method
 * after a primitive namespace (e.g. `sphere.radius(2)`) it is classified as the
 * required constructor (remove-whole) before this whitelist is consulted.
 */
export const FLUENT_MODIFIER_METHODS = new Set([
    // transforms / placement
    "shift", "rotate", "translate", "scale",
    // shape refinements
    "chamfer", "fillet", "round", "soft", "stairs", "columns", "shell", "offset",
    "elongate", "twist", "bend", "taper", "repeatPolar",
    // per-primitive sizing / config (chainable)
    "radius", "smallRadius", "largeRadius", "height", "cylinderLength", "radii",
    "depth", "pitch", "threadAngle", "hand", "female", "t",
    "withDist", "withMode", "withNormal",
    // authoring inputs
    "pattern", "profile", "sections",
])
