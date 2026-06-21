/**
 * Transform-gizmo interaction controller (main thread).
 *
 * Responsibilities:
 *  - Placement: store the gizmo's world anchor, the world→local linear inverse
 *    (for translate), and the object's world orientation (for the local rings),
 *    and push visibility/anchor/highlight to the render worker.
 *  - Hover: project each handle's world geometry to canvas CSS pixels, find the
 *    nearest, and drive the shader's hover highlight.
 *  - Translate drag (arrows): axis-locked, world-space; previewed live in the
 *    worker (no recompile); writes `.shift` on release.
 *  - Rotate drag (rings): rotation about the object's LOCAL axis (the ring's
 *    world plane), reported on release so a pre-shift `.rotate` is written.
 *    (Live spin is layered on later.)
 */

import { Mat4x4f } from "../vecmat/matrix.mjs"
import { type Vec2f, type Vec3f, vec3 } from "../vecmat/vector.mjs"
import { applyMat3 } from "./world-transform.mjs"
import { matColumn, eulerToFwd, fwdToEuler, matMul3 } from "./rotation.mjs"
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
    postGizmo(state: {
        visible: boolean
        center?: [number, number, number]
        hoverHandle?: number
        activeHandle?: number
        orient?: number[]
    }): void
    /** Gizmo drag lifecycle messages to the worker (live preview). For rotate,
     * `nodeId` is the Rotate node and `rotate` sets its Euler absolutely. */
    gizmoBegin(nodeId: number, kind: "translate" | "rotate"): void
    gizmoPreview(p: { translate?: [number, number, number]; rotate?: [number, number, number] }): void
    gizmoEnd(): void
    /** A node's current local translation (primitive `pos` / `Translate` delta), or null. */
    getNodeTranslation(nodeId: number): [number, number, number] | null
    /** Translate committed: `final` = base + delta (absolute), `delta` = local delta. */
    onTranslateComplete(nodeId: number, final: [number, number, number], delta: [number, number, number]): void
    /** Rotate committed: a local rotation of `angleDeg` about local `axis` (0/1/2). */
    onRotateComplete(nodeId: number, axis: number, angleDeg: number): void
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
type Vec3 = [number, number, number]

interface TranslateDrag {
    kind: "translate"
    handle: number
    axis: number
    startX: number
    startY: number
    baseCenter: Vec3
    base: Vec3
}

interface RotateDrag {
    kind: "rotate"
    handle: number
    axis: number
    /** Ring world frame: normal + two in-plane basis vectors (unit). */
    normal: Vec3
    u: Vec3
    v: Vec3
    lastAngle: number
    accumAngle: number
    /** Pre-shift Rotate node to live-mutate (0 = none → commit on release only). */
    rotateNodeId: number
    /** That rotate's Euler at drag start, for body-frame composition. */
    baseEuler: Vec3
}

export class GizmoController {
    #host: GizmoHost
    #center: Vec3 | null = null
    /** Row-major 3×3 mapping a world delta into the node's local frame (translate). */
    #invLinear: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    /** Column-major 3×3 world orientation of the object's local frame (rings). */
    #orient: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    #nodeId = 0
    /** Pre-shift Rotate node id (0 = none) + its Euler, from the last placement query. */
    #rotateNodeId = 0
    #rotateBaseEuler: Vec3 = [0, 0, 0]
    #sizePx = GIZMO_DEFAULT_SIZE_PX
    #hoverHandle = -1
    #shown = false
    #drag: TranslateDrag | RotateDrag | null = null

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
    show(center: Vec3, invLinear: number[], orient: number[], nodeId: number, rotateNodeId = 0, rotateEuler: Vec3 = [0, 0, 0]): void {
        this.#center = center
        this.#invLinear = invLinear
        this.#orient = orient
        this.#nodeId = nodeId
        this.#rotateNodeId = rotateNodeId
        this.#rotateBaseEuler = rotateEuler
        this.#shown = true
        this.#hoverHandle = -1
        this.#host.postGizmo({ visible: true, center, orient })
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
     * pointer is over a handle (so the caller can set a grab cursor).
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
     * (caller should suppress the camera). Arrows → translate; rings → rotate.
     */
    handlePointerDown(clientX: number, clientY: number): boolean {
        if (!this.#shown || !this.#center) return false
        const rect = this.#host.canvas.getBoundingClientRect()
        const cssX = clientX - rect.left
        const cssY = clientY - rect.top
        const handle = this.#hitTest(cssX, cssY)
        if (handle < 0) return false
        const { axis, isRing } = gizmoHandleParts(handle)

        if (isRing) {
            // Ring world frame: normal + in-plane basis from the oriented local axes.
            const normal = norm(matColumn(this.#orient, axis))
            const u = norm(matColumn(this.#orient, (axis + 1) % 3))
            const v = norm(matColumn(this.#orient, (axis + 2) % 3))
            const a = this.#ringAngle(cssX, cssY, this.#center, normal, u, v)
            this.#drag = {
                kind: "rotate", handle, axis, normal, u, v, lastAngle: a ?? 0, accumAngle: 0,
                rotateNodeId: this.#rotateNodeId, baseEuler: this.#rotateBaseEuler,
            }
            // Live spin only when a pre-shift rotate node already exists.
            if (this.#rotateNodeId > 0) this.#host.gizmoBegin(this.#rotateNodeId, "rotate")
        } else {
            const base = this.#host.getNodeTranslation(this.#nodeId)
            if (!base) return false
            this.#drag = { kind: "translate", handle, axis, startX: clientX, startY: clientY, baseCenter: [...this.#center], base }
            this.#host.gizmoBegin(this.#nodeId, "translate")
        }
        this.#hoverHandle = handle
        this.#host.postGizmo({ visible: true, hoverHandle: handle, activeHandle: handle })
        this.#host.requestRender()
        return true
    }

    /** Continue an active drag. Returns true while dragging. */
    handleDragMove(clientX: number, clientY: number): boolean {
        const drag = this.#drag
        if (!drag) return false
        const rect = this.#host.canvas.getBoundingClientRect()
        if (drag.kind === "translate") {
            const worldDelta = this.#axisWorldDelta(drag.axis, clientX - drag.startX, clientY - drag.startY)
            const localDelta = applyMat3(this.#invLinear, worldDelta)
            this.#host.gizmoPreview({ translate: localDelta })
            this.#center = [drag.baseCenter[0] + worldDelta[0], drag.baseCenter[1] + worldDelta[1], drag.baseCenter[2] + worldDelta[2]]
            this.#host.postGizmo({ visible: true, center: this.#center, hoverHandle: drag.handle, activeHandle: drag.handle })
            this.#host.requestRender()
            return true
        }
        // Rotate: accumulate the swept angle in the ring plane (continuous).
        const a = this.#ringAngle(clientX - rect.left, clientY - rect.top, this.#center!, drag.normal, drag.u, drag.v)
        if (a !== null) {
            let d = a - drag.lastAngle
            while (d > Math.PI) d -= 2 * Math.PI
            while (d < -Math.PI) d += 2 * Math.PI
            drag.accumAngle += d
            drag.lastAngle = a
        }
        // Live spin: set the rotate node's Euler = base ∘ delta (body-frame).
        if (drag.rotateNodeId > 0) {
            this.#host.gizmoPreview({ rotate: this.#composedEuler(drag) })
            this.#host.requestRender()
        }
        return true
    }

    /** Body-frame composition of a rotate drag's delta onto its base Euler. */
    #composedEuler(drag: RotateDrag): Vec3 {
        const deg = (drag.accumAngle * 180) / Math.PI
        const delta: Vec3 = [drag.axis === 0 ? deg : 0, drag.axis === 1 ? deg : 0, drag.axis === 2 ? deg : 0]
        const fwd = matMul3(eulerToFwd(drag.baseEuler[0], drag.baseEuler[1], drag.baseEuler[2]), eulerToFwd(delta[0], delta[1], delta[2]))
        return fwdToEuler(fwd)
    }

    /** Finish an active drag, reporting the committed transform. */
    handlePointerUp(clientX: number, clientY: number): boolean {
        const drag = this.#drag
        if (!drag) return false
        this.#drag = null
        if (drag.kind === "translate") {
            const worldDelta = this.#axisWorldDelta(drag.axis, clientX - drag.startX, clientY - drag.startY)
            const delta = applyMat3(this.#invLinear, worldDelta)
            const final: Vec3 = [drag.base[0] + delta[0], drag.base[1] + delta[1], drag.base[2] + delta[2]]
            this.#host.gizmoEnd()
            this.#host.postGizmo({ visible: true, center: this.#center ?? drag.baseCenter, hoverHandle: -1, activeHandle: -1 })
            if (Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]) > 1e-9) {
                this.#host.onTranslateComplete(this.#nodeId, final, delta)
            }
        } else {
            if (drag.rotateNodeId > 0) this.#host.gizmoEnd()
            this.#host.postGizmo({ visible: true, hoverHandle: -1, activeHandle: -1 })
            const deg = (drag.accumAngle * 180) / Math.PI
            if (Math.abs(deg) > 1e-4) this.#host.onRotateComplete(this.#nodeId, drag.axis, deg)
        }
        this.#host.requestRender()
        return true
    }

    /** Cancel an active drag without committing (Escape). */
    cancelDrag(): void {
        const drag = this.#drag
        if (!drag) return
        this.#drag = null
        if (drag.kind === "translate") {
            this.#host.gizmoPreview({ translate: [0, 0, 0] }) // revert preview to base
            this.#host.gizmoEnd()
            this.#center = drag.baseCenter
            this.#host.postGizmo({ visible: true, center: drag.baseCenter, hoverHandle: -1, activeHandle: -1 })
        } else {
            if (drag.rotateNodeId > 0) {
                this.#host.gizmoPreview({ rotate: drag.baseEuler }) // revert preview to base
                this.#host.gizmoEnd()
            }
            this.#host.postGizmo({ visible: true, hoverHandle: -1, activeHandle: -1 })
        }
        this.#host.requestRender()
    }

    /** Convert a screen-space drag (CSS px) into a world offset locked to `axis`. */
    #axisWorldDelta(axis: number, dxPx: number, dyPx: number): Vec3 {
        const u = GIZMO_AXES[axis]!
        const m = this.#host.controls.viewTransform.data
        const dotRight = m[0]! * u[0] + m[1]! * u[1] + m[2]! * u[2]
        const dotUp = m[4]! * u[0] + m[5]! * u[1] + m[6]! * u[2]
        const snx = dotRight
        const sny = -dotUp
        const snLenSq = snx * snx + sny * sny
        if (snLenSq < 1e-12) return [0, 0, 0]
        const worldPerPixel = (this.#host.controls.zoom * 2) / Math.max(1, this.#host.canvas.clientHeight)
        const t = ((dxPx * snx + dyPx * sny) * worldPerPixel) / snLenSq
        return [u[0] * t, u[1] * t, u[2] * t]
    }

    /**
     * Angle (radians) of the pointer around the gizmo center, within the ring's
     * world plane (through `center`, normal `n`, basis `u`/`v`). Returns null if
     * the view ray is parallel to the plane.
     */
    #ringAngle(cssX: number, cssY: number, center: Vec3, n: Vec3, u: Vec3, v: Vec3): number | null {
        const ray = this.#screenRay(cssX, cssY)
        if (!ray) return null
        const denom = dot(ray.dir, n)
        if (Math.abs(denom) < 1e-6) return null
        const t = dot(sub(center, ray.origin), n) / denom
        const hit: Vec3 = [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t]
        const w = sub(hit, center)
        return Math.atan2(dot(w, v), dot(w, u))
    }

    /** Orthographic world-space ray (origin + dir) through a canvas CSS pixel. */
    #screenRay(cssX: number, cssY: number): { origin: Vec3; dir: Vec3 } | null {
        const canvas = this.#host.canvas
        const cssW = canvas.clientWidth
        const cssH = canvas.clientHeight
        const zoom = this.#host.controls.zoom
        if (cssW <= 0 || cssH <= 0 || zoom <= 0) return null
        const aspect = cssW / cssH
        const camPos = this.#host.controls.cameraPosition
        const uvX = cssX / cssW
        const uvY = 1 - cssY / cssH
        const pCamX = (uvX - this.#host.viewCenter.x) * aspect * 2 * zoom + camPos.x
        const pCamY = (uvY - this.#host.viewCenter.y) * 2 * zoom + camPos.y
        const m = new Mat4x4f(new Float32Array(this.#host.controls.viewTransform.data))
        const o = m.transformPoint(vec3(pCamX, pCamY, 0))
        const d = this.#host.controls.viewTransform.data
        // Camera forward into the scene = -column2 (per push-pull projection notes).
        const dir = norm([-d[8]!, -d[9]!, -d[10]!])
        return { origin: [o.x, o.y, o.z], dir }
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
        const scale = (this.#sizePx * 2 * zoom) / fullH
        const project = (p: Vec3): ScreenPt | null => this.#project(invCam, p, cssW, cssH, zoom)

        let best = -1
        let bestDist = Infinity

        for (let axis = 0; axis < 3; axis++) {
            const u = GIZMO_AXES[axis]!
            // Arrow: world-aligned segment CENTER_GAP → TIP.
            const a0 = project(addScaled(center, u, GIZMO_CENTER_GAP * scale))
            const a1 = project(addScaled(center, u, GIZMO_TIP * scale))
            if (a0 && a1) {
                const d = distToSegment(cssX, cssY, a0, a1)
                if (d < ARROW_HIT_PX && d < bestDist) {
                    best = gizmoArrowHandle(axis)
                    bestDist = d
                }
            }
            // Ring: oriented circle in the object's local plane ⊥ axis.
            const e0 = matColumn(this.#orient, (axis + 1) % 3)
            const e1 = matColumn(this.#orient, (axis + 2) % 3)
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
    #project(invCam: Mat4x4f, [wx, wy, wz]: Vec3, cssW: number, cssH: number, zoom: number): ScreenPt | null {
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

function addScaled(c: Vec3, u: readonly number[], s: number): Vec3 {
    return [c[0] + u[0]! * s, c[1] + u[1]! * s, c[2] + u[2]! * s]
}

function ringPoint(c: Vec3, e0: readonly number[], e1: readonly number[], theta: number, r: number): Vec3 {
    const cs = Math.cos(theta) * r
    const sn = Math.sin(theta) * r
    return [c[0] + e0[0]! * cs + e1[0]! * sn, c[1] + e0[1]! * cs + e1[1]! * sn, c[2] + e0[2]! * cs + e1[2]! * sn]
}

function distToSegment(px: number, py: number, a: ScreenPt, b: ScreenPt): number {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function norm(a: readonly [number, number, number]): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
}
