/**
 * Transform-gizmo interaction controller (main thread).
 *
 * Step 2 scope: place the gizmo (store its world anchor + push it to the
 * worker) and hover hit-testing — project each handle's world geometry to
 * canvas CSS pixels and find the one nearest the pointer, then drive the
 * shader's hover highlight. Translate/rotate dragging is layered on later.
 *
 * Projection mirrors `SDFRenderer.#updatePivotCursor` (and the worker overlay's
 * `project()`), and the on-screen scale matches the shader's
 * `scale = sizePx * 2*zoom / res.y` by using the framebuffer height — so the
 * grabbable regions line up with the drawn gizmo. Geometry constants are shared
 * with the overlay via `gizmo-geometry.mts` so the two can't drift.
 */

import { Mat4x4f } from "../vecmat/matrix.mjs"
import { type Vec2f, type Vec3f, vec3 } from "../vecmat/vector.mjs"
import {
    GIZMO_AXES,
    GIZMO_CENTER_GAP,
    GIZMO_DEFAULT_SIZE_PX,
    GIZMO_RING_RADIUS,
    GIZMO_TIP,
    gizmoArrowHandle,
    gizmoRingHandle,
} from "./gizmo-geometry.mjs"

export interface GizmoHost {
    requestRender(): void
    /** Push gizmo state to the render worker (posts a `setGizmo` message). */
    postGizmo(state: { visible: boolean; center?: [number, number, number]; hoverHandle?: number; activeHandle?: number }): void
    readonly canvas: HTMLCanvasElement
    readonly controls: {
        readonly viewTransform: { data: Float32Array }
        readonly cameraPosition: Vec3f
        readonly zoom: number
        readonly isActivelyMoving: boolean
    }
    readonly viewCenter: Vec2f
    /** Framebuffer height (device px) the overlay draws at — matches the shader's `res.y`. */
    readonly fullHeight: number
}

/** Pointer-proximity thresholds (canvas CSS pixels). */
const ARROW_HIT_PX = 9
const RING_HIT_PX = 8
/** Samples per ring for hit-testing (independent of the overlay's draw tessellation). */
const RING_SAMPLES = 32

type ScreenPt = { x: number; y: number }

export class GizmoController {
    #host: GizmoHost
    #center: [number, number, number] | null = null
    #sizePx = GIZMO_DEFAULT_SIZE_PX
    #hoverHandle = -1
    #shown = false

    constructor(host: GizmoHost) {
        this.#host = host
    }

    get shown(): boolean {
        return this.#shown
    }
    get hoverHandle(): number {
        return this.#hoverHandle
    }

    /** Show the gizmo anchored at a world center (re-call to re-anchor). */
    show(center: [number, number, number]): void {
        this.#center = center
        this.#shown = true
        this.#hoverHandle = -1
        this.#host.postGizmo({ visible: true, center })
        this.#host.requestRender()
    }

    /** Hide the gizmo. No-op when already hidden. */
    hide(): void {
        if (!this.#shown) return
        this.#shown = false
        this.#center = null
        this.#hoverHandle = -1
        this.#host.postGizmo({ visible: false })
        this.#host.requestRender()
    }

    /**
     * Hover hit-test on pointer move. Returns true when the pointer is over a
     * handle (so the caller can set a grab cursor). Updates the worker's hover
     * highlight only when the hovered handle changes.
     */
    handlePointerMove(clientX: number, clientY: number): boolean {
        if (!this.#shown || !this.#center) return false
        // Don't fight the camera: skip while orbiting/panning.
        if (this.#host.controls.isActivelyMoving) return false
        const rect = this.#host.canvas.getBoundingClientRect()
        const handle = this.#hitTest(clientX - rect.left, clientY - rect.top)
        if (handle !== this.#hoverHandle) {
            this.#hoverHandle = handle
            this.#host.postGizmo({ visible: true, hoverHandle: handle })
            this.#host.requestRender()
        }
        return handle >= 0
    }

    /** Nearest handle (0..5) under the canvas CSS-pixel point, or -1. */
    #hitTest(cssX: number, cssY: number): number {
        const center = this.#center
        if (!center) return -1
        const canvas = this.#host.canvas
        const cssW = canvas.clientWidth
        const cssH = canvas.clientHeight
        const zoom = this.#host.controls.zoom
        const fullH = this.#host.fullHeight
        if (cssW <= 0 || cssH <= 0 || zoom <= 0 || fullH <= 0) return -1

        const invCam = new Mat4x4f(new Float32Array(this.#host.controls.viewTransform.data)).inverse()
        // World units per gizmo-local unit; matches the shader's screen-constant scale.
        const scale = (this.#sizePx * 2 * zoom) / fullH
        const project = (p: [number, number, number]): ScreenPt | null =>
            this.#project(invCam, p, cssW, cssH, zoom)

        let best = -1
        let bestDist = Infinity

        for (let axis = 0; axis < 3; axis++) {
            const u = GIZMO_AXES[axis]!
            // Arrow: segment CENTER_GAP → TIP along the axis (includes the head).
            const a0 = project(addScaled(center, u, GIZMO_CENTER_GAP * scale))
            const a1 = project(addScaled(center, u, GIZMO_TIP * scale))
            if (a0 && a1) {
                const d = distToSegment(cssX, cssY, a0, a1)
                if (d < ARROW_HIT_PX && d < bestDist) {
                    best = gizmoArrowHandle(axis)
                    bestDist = d
                }
            }
            // Ring: sampled circle of radius RING_RADIUS in the plane ⊥ the axis.
            const e0 = GIZMO_AXES[(axis + 1) % 3]!
            const e1 = GIZMO_AXES[(axis + 2) % 3]!
            const r = GIZMO_RING_RADIUS * scale
            let prev = project(ringPoint(center, e0, e1, 0, r))
            for (let s = 1; s <= RING_SAMPLES; s++) {
                const cur = project(ringPoint(center, e0, e1, (s / RING_SAMPLES) * Math.PI * 2, r))
                if (prev && cur) {
                    const d = distToSegment(cssX, cssY, prev, cur)
                    if (d < RING_HIT_PX && d < bestDist) {
                        best = gizmoRingHandle(axis)
                        bestDist = d
                    }
                }
                prev = cur
            }
        }
        return best
    }

    /** World → canvas CSS pixels (mirrors `SDFRenderer.#updatePivotCursor`). */
    #project(invCam: Mat4x4f, [wx, wy, wz]: [number, number, number], cssW: number, cssH: number, zoom: number): ScreenPt | null {
        const pCam = invCam.transformPoint(vec3(wx, wy, wz))
        const aspectRt = cssW / cssH
        const camPos = this.#host.controls.cameraPosition
        const uvAspX = ((pCam.x - camPos.x) / zoom) * 0.5 + 0.5
        const uvAspY = ((pCam.y - camPos.y) / zoom) * 0.5 + 0.5
        const uvX = (uvAspX - 0.5) / aspectRt + this.#host.viewCenter.x
        const uvY = uvAspY - 0.5 + this.#host.viewCenter.y
        return { x: uvX * cssW, y: (1 - uvY) * cssH }
    }
}

function addScaled(c: readonly [number, number, number], u: readonly number[], s: number): [number, number, number] {
    return [c[0] + u[0]! * s, c[1] + u[1]! * s, c[2] + u[2]! * s]
}

function ringPoint(
    c: readonly [number, number, number],
    e0: readonly number[],
    e1: readonly number[],
    theta: number,
    r: number,
): [number, number, number] {
    const cs = Math.cos(theta) * r
    const sn = Math.sin(theta) * r
    return [c[0] + e0[0]! * cs + e1[0]! * sn, c[1] + e0[1]! * cs + e1[1]! * sn, c[2] + e0[2]! * cs + e1[2]! * sn]
}

/** Distance from point (px,py) to segment a→b, in the same units. */
function distToSegment(px: number, py: number, a: ScreenPt, b: ScreenPt): number {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const cx = a.x + t * dx
    const cy = a.y + t * dy
    return Math.hypot(px - cx, py - cy)
}
