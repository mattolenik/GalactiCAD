/**
 * Shared transform-gizmo geometry constants + handle encoding.
 *
 * Imported by BOTH the GPU overlay (`gizmo-overlay.mts`, which builds the
 * instance buffers the shader draws) and the main-thread hit-tester
 * (`gizmo-controller.mts`), so the drawn gizmo and the grabbable regions can
 * never drift apart. Geometry is in unit "gizmo-local" space: 1.0 ==
 * `GIZMO_DEFAULT_SIZE_WORLD` world units (see `gizmo_overlay.wgsl`).
 */

/** Axis shaft starts this far from the center. 0 → the three shaft tails meet
 * at the hub (no gap), converging with the planar-handle corner. */
export const GIZMO_CENTER_GAP = 0
/**
 * Reference point ALONG the shaft used only to derive the arrowhead's screen
 * direction (tip − back). The shaft instance is authored out to {@link GIZMO_TIP},
 * but the line vertex shader trims its far end back by the arrowhead's fixed pixel
 * length, so the tail meets the BACK of the head at every zoom (no gap, no overlap
 * into the cone).
 */
export const GIZMO_SHAFT_END = 0.82
/** Arrowhead tip + shaft end (also the far end used for arrow hit-testing). */
export const GIZMO_TIP = 1.25
/** Rotation-ring radius. */
export const GIZMO_RING_RADIUS = 0.8
/**
 * Planar-translation handles: a square in each pair-of-axes plane, near the hub.
 * Each square spans `[GIZMO_PLANE_OFFSET, GIZMO_PLANE_OFFSET + GIZMO_PLANE_SIZE]`
 * along both of its component axes. The offset insets the inner corner off the
 * center so the square clears the axis shafts by a small gap (~2× the shaft line
 * width at the reference zoom — the gizmo is a fixed WORLD size while the line is
 * a fixed pixel width, so the gap drifts a little with zoom). The outer extent
 * stays well inside {@link GIZMO_RING_RADIUS}.
 */
export const GIZMO_PLANE_OFFSET = 0.06
export const GIZMO_PLANE_SIZE = 0.45
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
 * Handle id encoding (matches `gizmo_overlay.wgsl`'s `metaHandle`): arrows are
 * 0..2, rings 3..5, planes 6..8 — i.e. `axis + kind*3` with kind 0/1/2. For
 * rings and planes the `axis` is the axis the ring/plane is PERPENDICULAR to
 * (so plane `axis` spans the other two axes).
 */
export type GizmoHandleKind = "arrow" | "ring" | "plane"
export function gizmoArrowHandle(axis: number): number {
    return axis
}
export function gizmoRingHandle(axis: number): number {
    return axis + 3
}
export function gizmoPlaneHandle(axis: number): number {
    return axis + 6
}
/** Decompose a handle id into its `axis` and `kind`. */
export function gizmoHandleParts(handle: number): { axis: number; kind: GizmoHandleKind } {
    const kind: GizmoHandleKind = handle >= 6 ? "plane" : handle >= 3 ? "ring" : "arrow"
    return { axis: handle % 3, kind }
}
