/**
 * Shared transform-gizmo geometry constants + handle encoding.
 *
 * Imported by BOTH the GPU overlay (`gizmo-overlay.mts`, which builds the
 * instance buffers the shader draws) and the main-thread hit-tester
 * (`gizmo-controller.mts`), so the drawn gizmo and the grabbable regions can
 * never drift apart. Geometry is in unit "gizmo-local" space: 1.0 ==
 * `GIZMO_DEFAULT_SIZE_WORLD` world units (see `gizmo_overlay.wgsl`).
 */

/** Axis shaft starts this far from the center (leaves a clear hub). */
export const GIZMO_CENTER_GAP = 0.12
/** Shaft end / arrowhead base. */
export const GIZMO_SHAFT_END = 0.82
/** Arrowhead tip (also the far end used for arrow hit-testing). */
export const GIZMO_TIP = 1.0
/** Rotation-ring radius. */
export const GIZMO_RING_RADIUS = 0.8
/**
 * Gizmo radius in WORLD units (local unit 1.0 == this many world units). The
 * gizmo is anchored to the object and a fixed world size, so it scales with
 * zoom (grows on screen as you zoom in) and is identical for every object,
 * rather than a constant on-screen pixel size. ~20% of the default view height
 * (`2 * ORTHO_HALF_REF == 80` world units) at the reference zoom — chosen to
 * roughly match the previous on-screen footprint. Arrowheads + line widths stay
 * a constant pixel size (they're sized in the shader's pixel space), so the
 * gizmo's "ink" remains crisp/grabbable at any zoom while its extent tracks the
 * scene.
 */
export const GIZMO_DEFAULT_SIZE_WORLD = 8

/** Unit axis directions, indexed by axis id (0 = X, 1 = Y, 2 = Z). */
export const GIZMO_AXES: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
]

/**
 * Handle id encoding (matches `gizmo_overlay.wgsl`'s `metaHandle`):
 * arrows are 0..2, rings are 3..5 — i.e. `axis + kind*3`.
 */
export function gizmoArrowHandle(axis: number): number {
    return axis
}
export function gizmoRingHandle(axis: number): number {
    return axis + 3
}
/** Decompose a handle id into `{ axis, isRing }`. */
export function gizmoHandleParts(handle: number): { axis: number; isRing: boolean } {
    return { axis: handle % 3, isRing: handle >= 3 }
}
