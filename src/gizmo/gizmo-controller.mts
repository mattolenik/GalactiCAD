/**
 * Transform-gizmo interaction controller (main thread).
 *
 * Responsibilities:
 *  - Placement: store the gizmo's world anchor + the world→local linear inverse,
 *    and push visibility/anchor/highlight to the render worker.
 *  - Hover: project each handle's world geometry to canvas CSS pixels and find
 *    the nearest to the pointer, driving the shader's hover highlight.
 *  - Translate drag: pointerdown on an axis arrow starts an axis-locked drag;
 *    each move converts the screen delta to a world offset along that axis,
 *    converts it into the node's local frame, and previews it live in the worker
 *    (no shader recompile). Pointer-up reports the delta so the source `.shift`
 *    can be written.
 *
 * Projection mirrors `SDFRenderer.#updatePivotCursor`; the on-screen scale
 * matches the shader's `scale = sizePx * 2*zoom / res.y` (framebuffer height) so
 * the grabbable regions line up with the drawn gizmo. Geometry constants are
 * shared with the overlay via `gizmo-geometry.mts`.
 */

import { Mat4x4f } from "../vecmat/matrix.mjs"
import { type Vec2f, type Vec3f, vec3 } from "../vecmat/vector.mjs"
import { applyMat3 } from "./world-transform.mjs"
import {
    GIZMO_AXES,
    GIZMO_CENTER_GAP,
    GIZMO_DEFAULT_SIZE_PX,
    GIZMO_RING_RADIUS,
    GIZMO_TIP,
    gizmoArrowHandle,
    gizmoHandleParts,
    gizmoRingHandle,
} from "./gizmo-geometry.mjs"

export interface GizmoHost {
    requestRender(): void
    /** Push gizmo visibility/anchor/highlight to the render worker (`setGizmo`). */
    postGizmo(state: { visible: boolean; center?: [number, number, number]; hoverHandle?: number; activeHandle?: number }): void
    /** Gizmo drag lifecycle messages to the worker (live preview). */
    gizmoBegin(nodeId: number): void
    gizmoPreview(translate: [number, number, number]): void
    gizmoEnd(): void
    /** A node's current local translation (primitive `pos` / `Translate` delta), or null. */
    getNodeTranslation(nodeId: number): [number, number, number] | null
    /** Drag committed: write the source `.shift`. `final` = base + delta (absolute), `delta` = local delta. */
    onTranslateComplete(nodeId: number, final: [number, number, number], delta: [number, number, number]): void
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

interface DragState {
    handle: number
    axis: number
    startX: number
    startY: number
    baseCenter: [number, number, number]
    base: [number, number, number]
}

export class GizmoController {
    #host: GizmoHost
    #center: [number, number, number] | null = null
    /** Row-major 3×3 mapping a world delta into the node's local frame. */
    #invLinear: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    #nodeId = 0
    #sizePx = GIZMO_DEFAULT_SIZE_PX
    #hoverHandle = -1
    #shown = false
    #drag: DragState | null = null

    constructor(host: GizmoHost) {
        this.#host = host
    }

    get shown(): boolean {
        return this.#shown
    }
    get dragging(): boolean {
        return this.#drag !== null
    }

    /** Show the gizmo anchored at a world center (re-call to re-anchor). */
    show(center: [number, number, number], invLinear: number[], nodeId: number): void {
        this.#center = center
        this.#invLinear = invLinear
        this.#nodeId = nodeId
        this.#shown = true
        this.#hoverHandle = -1
        this.#host.postGizmo({ visible: true, center })
        this.#host.requestRender()
    }

    /** Hide the gizmo. No-op when already hidden. */
    hide(): void {
        this.#drag = null
        if (!this.#shown) return
        this.#shown = false
        this.#center = null
        this.#hoverHandle = -1
        this.#host.postGizmo({ visible: false })
        this.#host.requestRender()
    }

    /**
     * Hover hit-test on pointer move (when not dragging). Returns true when the
     * pointer is over a handle (so the caller can set a grab cursor). Updates the
     * worker's hover highlight only when the hovered handle changes.
     */
    handlePointerMove(clientX: number, clientY: number): boolean {
        if (!this.#shown || !this.#center || this.#drag) return false
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

    /**
     * Start a drag if the pointer is over a handle. Returns true if a drag began
     * (caller should suppress the camera). Only axis arrows (translate) drag for
     * now; rotation rings are recognized but not yet draggable.
     */
    handlePointerDown(clientX: number, clientY: number): boolean {
        if (!this.#shown || !this.#center) return false
        const rect = this.#host.canvas.getBoundingClientRect()
        const handle = this.#hitTest(clientX - rect.left, clientY - rect.top)
        if (handle < 0) return false
        const { axis, isRing } = gizmoHandleParts(handle)
        if (isRing) return false // rotation drag not implemented yet
        const base = this.#host.getNodeTranslation(this.#nodeId)
        if (!base) return false // can't live-edit this node's translation
        this.#drag = {
            handle,
            axis,
            startX: clientX,
            startY: clientY,
            baseCenter: [...this.#center],
            base,
        }
        this.#hoverHandle = handle
        this.#host.postGizmo({ visible: true, hoverHandle: handle, activeHandle: handle })
        this.#host.gizmoBegin(this.#nodeId)
        this.#host.requestRender()
        return true
    }

    /** Continue an active drag. Returns true while dragging (caller suppresses camera). */
    handleDragMove(clientX: number, clientY: number): boolean {
        const drag = this.#drag
        if (!drag) return false
        const worldDelta = this.#axisWorldDelta(drag.axis, clientX - drag.startX, clientY - drag.startY)
        const localDelta = applyMat3(this.#invLinear, worldDelta)
        this.#host.gizmoPreview(localDelta)
        // Move the gizmo with the object.
        this.#center = [drag.baseCenter[0] + worldDelta[0], drag.baseCenter[1] + worldDelta[1], drag.baseCenter[2] + worldDelta[2]]
        this.#host.postGizmo({ visible: true, center: this.#center, hoverHandle: drag.handle, activeHandle: drag.handle })
        this.#host.requestRender()
        return true
    }

    /** Finish an active drag, reporting the committed delta. Returns true if a drag ended. */
    handlePointerUp(clientX: number, clientY: number): boolean {
        const drag = this.#drag
        if (!drag) return false
        const worldDelta = this.#axisWorldDelta(drag.axis, clientX - drag.startX, clientY - drag.startY)
        const delta = applyMat3(this.#invLinear, worldDelta)
        const final: [number, number, number] = [drag.base[0] + delta[0], drag.base[1] + delta[1], drag.base[2] + delta[2]]
        this.#drag = null
        this.#host.gizmoEnd()
        this.#host.postGizmo({ visible: true, center: this.#center ?? drag.baseCenter, hoverHandle: -1, activeHandle: -1 })
        const moved = Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]) > 1e-9
        if (moved) this.#host.onTranslateComplete(this.#nodeId, final, delta)
        this.#host.requestRender()
        return true
    }

    /** Cancel an active drag without committing (Escape). */
    cancelDrag(): void {
        if (!this.#drag) return
        const center = this.#drag.baseCenter
        this.#drag = null
        this.#host.gizmoPreview([0, 0, 0]) // revert preview to base
        this.#host.gizmoEnd()
        this.#center = center
        this.#host.postGizmo({ visible: true, center, hoverHandle: -1, activeHandle: -1 })
        this.#host.requestRender()
    }

    /**
     * Convert a screen-space drag (CSS px) into a world-space offset locked to
     * `axis` (0/1/2). Mirrors `PushPullController.handlePointerMove`: project the
     * world axis onto screen, then invert the orthographic pixels↔world mapping.
     */
    #axisWorldDelta(axis: number, dxPx: number, dyPx: number): [number, number, number] {
        const u = GIZMO_AXES[axis]!
        const m = this.#host.controls.viewTransform.data
        // viewTransform columns are the camera basis in world; project the axis.
        const dotRight = m[0]! * u[0] + m[1]! * u[1] + m[2]! * u[2]
        const dotUp = m[4]! * u[0] + m[5]! * u[1] + m[6]! * u[2]
        const snx = dotRight
        const sny = -dotUp // screen Y is flipped vs camera up
        const snLenSq = snx * snx + sny * sny
        if (snLenSq < 1e-12) return [0, 0, 0] // axis points at/away from camera
        const worldPerPixel = (this.#host.controls.zoom * 2) / Math.max(1, this.#host.canvas.clientHeight)
        const t = ((dxPx * snx + dyPx * sny) * worldPerPixel) / snLenSq
        return [u[0] * t, u[1] * t, u[2] * t]
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

/** Distance from point (px,py) to segment a→b. */
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
