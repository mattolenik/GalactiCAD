/**
 * Shared transform-gizmo geometry constants + handle encoding.
 *
 * Imported by BOTH the GPU overlay (`gizmo-overlay.mts`, which builds the
 * instance buffers the shader draws) and the main-thread hit-tester
 * (`gizmo-controller.mts`), so the drawn gizmo and the grabbable regions can
 * never drift apart. Geometry is in unit "gizmo-local" space: 1.0 ==
 * `GIZMO_DEFAULT_SIZE_PX` framebuffer pixels (see `gizmo_overlay.wgsl`).
 */

/** Axis shaft starts this far from the center (leaves a clear hub). */
export const GIZMO_CENTER_GAP = 0.12
/** Shaft end / arrowhead base. */
export const GIZMO_SHAFT_END = 0.82
/** Arrowhead tip (also the far end used for arrow hit-testing). */
export const GIZMO_TIP = 1.0
/** Rotation-ring radius. */
export const GIZMO_RING_RADIUS = 0.8
/** Gizmo radius in framebuffer pixels (constant on-screen size). */
export const GIZMO_DEFAULT_SIZE_PX = 90

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
