/**
 * Transform-gizmo interaction controller (main thread).
 *
 * Rendering: the gizmo is drawn on the MAIN THREAD into a transparent 2D canvas
 * layered over the (worker-owned) WebGPU canvas — NOT in a worker render pass.
 * Hover/active highlight and live drag therefore redraw a handful of Canvas2D
 * paths (~1 ms) instead of forcing a full scene raymarch in the worker; the
 * scene is only re-rendered when the dragged object actually moves. Rings are
 * smooth analytic curves (projected + stroked) rather than tessellated quads.
 *
 * Responsibilities:
 *  - Placement: store the gizmo's world anchor, the world→local linear inverse
 *    (for translate), and the object's world orientation (for the local rings).
 *  - Hover: project each handle's world geometry to canvas CSS pixels, find the
 *    nearest, and highlight it.
 *  - Translate drag (arrows): axis-locked, world-space; previewed live in the
 *    worker (no recompile); writes `.shift` on release.
 *  - Planar translate drag (corner squares): locked to a world plane (the two
 *    component axes); the dragged point follows the cursor's ray∩plane. Shares
 *    the translate preview + `.shift` write-back.
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
    GIZMO_DEFAULT_SIZE_WORLD,
    GIZMO_PLANE_OFFSET,
    GIZMO_PLANE_SIZE,
    GIZMO_RING_RADIUS,
    GIZMO_TIP,
    gizmoArrowHandle,
    gizmoHandleParts,
    gizmoPlaneHandle,
    gizmoRingHandle,
} from "./gizmo-geometry.mjs"

export interface GizmoHost {
    requestRender(): void
    /** Transparent 2D overlay canvas (device-pixel backing store, layered over
     * the WebGPU canvas) the controller draws the gizmo into on the main thread.
     * Sized by the host on resize. */
    readonly gizmoCanvas: HTMLCanvasElement
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
}

/** Pointer-proximity thresholds (canvas CSS pixels). */
const ARROW_HIT_PX = 9
const RING_HIT_PX = 8
/** Samples per ring for hit-testing (independent of the overlay's draw tessellation). */
const RING_SAMPLES = 32

/** Draw sizes in DEVICE pixels (match the old WGSL overlay so the on-screen look
 * is unchanged): shaft/ring stroke width, arrowhead length + half-width. */
const LINE_WIDTH_PX = 2.5
const HEAD_LEN_PX = 14
const HEAD_HALF_WIDTH_PX = 6
/** Ring tessellation for DRAWING — high enough that the projected ellipse reads
 * as a smooth curve (Canvas2D AA + round joins do the rest). */
const RING_DRAW_SAMPLES = 96

/** Highlight state of a handle, mirroring the old shader's `handleState`. */
const HL = { None: 0, Hover: 1, Active: 2 } as const
type Hl = (typeof HL)[keyof typeof HL]
function handleHl(handleId: number, hover: number, active: number): Hl {
    if (handleId === active) return HL.Active
    if (handleId === hover) return HL.Hover
    return HL.None
}

/** Per-axis base color (X red, Y green, Z blue) — matches `axisColor` in the shader. */
const AXIS_RGB: ReadonlyArray<readonly [number, number, number]> = [
    [0.92, 0.26, 0.30],
    [0.40, 0.82, 0.36],
    [0.30, 0.52, 0.95],
]
/** Plane color = clamped additive blend of its two component axes (YZ cyan, XZ magenta, XY yellow). */
function planeRgb(axis: number): [number, number, number] {
    const a = AXIS_RGB[(axis + 1) % 3]!
    const b = AXIS_RGB[(axis + 2) % 3]!
    return [Math.min(1, a[0] + b[0]), Math.min(1, a[1] + b[1]), Math.min(1, a[2] + b[2])]
}
function mixWhite(c: readonly [number, number, number], t: number): [number, number, number] {
    return [c[0] + (1 - c[0]) * t, c[1] + (1 - c[1]) * t, c[2] + (1 - c[2]) * t]
}
function rgbCss(c: readonly [number, number, number], alpha = 1): string {
    const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255)
    return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}
/** Line/arrowhead color for a highlight state: active → yellow, hover → toward white. */
function lineCss(base: readonly [number, number, number], hl: Hl): string {
    if (hl === HL.Active) return rgbCss([1.0, 0.85, 0.10])
    return rgbCss(hl === HL.Hover ? mixWhite(base, 0.4) : base)
}
/** Translucent plane fill for a highlight state (matches `planeFragmentMain`). */
function planeCss(axis: number, hl: Hl): string {
    const base = planeRgb(axis)
    if (hl === HL.Active) return rgbCss(mixWhite(base, 0.45), 0.85)
    if (hl === HL.Hover) return rgbCss(mixWhite(base, 0.30), 0.7)
    return rgbCss(base, 0.4)
}

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

interface PlaneDrag {
    kind: "plane"
    handle: number
    /** Axis the plane is perpendicular to (its world normal). */
    axis: number
    normal: Vec3
    /** World point where the drag-start ray pierced the plane (cursor anchor). */
    startHit: Vec3
    baseCenter: Vec3
    /** The node's local translation at drag start. */
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
    #sizeWorld = GIZMO_DEFAULT_SIZE_WORLD
    #hoverHandle = -1
    #shown = false
    #drag: TranslateDrag | RotateDrag | PlaneDrag | null = null
    /** Lazily-fetched 2D context of the overlay canvas. */
    #ctx: CanvasRenderingContext2D | null = null

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
        this.#redraw()
    }

    /** Hide the gizmo. No-op when already hidden. */
    hide(): void {
        this.#drag = null
        if (!this.#shown) return
        this.#shown = false
        this.#center = null
        this.#hoverHandle = -1
        this.#redraw() // clears the overlay (now hidden) — no scene re-render needed
    }

    /** Redraw the overlay so it tracks the camera. Called from the host's render
     * loop each frame the scene is (re)rendered; no-op when hidden. */
    draw(): void {
        this.#redraw()
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
            this.#redraw() // overlay-only: recolor a few paths, NOT a scene raymarch
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
        const { axis, kind } = gizmoHandleParts(handle)

        if (kind === "ring") {
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
        } else if (kind === "plane") {
            // Planar translate: lock to the world plane ⊥ this axis. Anchor the drag
            // to where the start ray pierces that plane; subsequent moves track the
            // cursor's hit so the grabbed point stays under the pointer.
            const normal: Vec3 = [...GIZMO_AXES[axis]!]
            const startHit = this.#planeHit(cssX, cssY, this.#center, normal)
            if (!startHit) return false
            const base = this.#host.getNodeTranslation(this.#nodeId)
            if (!base) return false
            this.#drag = { kind: "plane", handle, axis, normal, startHit, baseCenter: [...this.#center], base }
            this.#host.gizmoBegin(this.#nodeId, "translate")
        } else {
            const base = this.#host.getNodeTranslation(this.#nodeId)
            if (!base) return false
            this.#drag = { kind: "translate", handle, axis, startX: clientX, startY: clientY, baseCenter: [...this.#center], base }
            this.#host.gizmoBegin(this.#nodeId, "translate")
        }
        this.#hoverHandle = handle
        this.#redraw() // active-handle highlight; the object hasn't moved yet
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
            this.#redraw()
            this.#host.requestRender() // object moved → re-render the scene
            return true
        }
        if (drag.kind === "plane") {
            // World delta = (current ray∩plane) − (start ray∩plane); lies in the plane.
            const hit = this.#planeHit(clientX - rect.left, clientY - rect.top, drag.baseCenter, drag.normal)
            if (hit) {
                const worldDelta = sub(hit, drag.startHit)
                this.#host.gizmoPreview({ translate: applyMat3(this.#invLinear, worldDelta) })
                this.#center = [drag.baseCenter[0] + worldDelta[0], drag.baseCenter[1] + worldDelta[1], drag.baseCenter[2] + worldDelta[2]]
                this.#redraw()
                this.#host.requestRender() // object moved → re-render the scene
            }
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
        // Live spin: set the rotate node's Euler = base ∘ delta (body-frame), and
        // track the rings to the same orientation so the whole gizmo follows the
        // spun object (mirrors how a translate drag tracks `#center`). Without this
        // the rings linger at the pre-rotation pose and visibly snap into place
        // when the debounced source-edit rebuild finally re-anchors the gizmo.
        if (drag.rotateNodeId > 0) {
            this.#host.gizmoPreview({ rotate: this.#composedEuler(drag) })
            this.#redraw() // rings track the spin (uses #followOrient while dragging)
            this.#host.requestRender() // object spun → re-render the scene
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

    /**
     * World orientation of the gizmo rings after the drag's body-frame delta:
     * `#orient` (the object's world orientation at drag start, already including
     * its base rotation) post-multiplied by the local-axis delta. This equals the
     * spun object's world orientation, so the rings stay glued to it during a live
     * spin and hold the final pose through the rebuild.
     */
    #followOrient(drag: RotateDrag): number[] {
        const deg = (drag.accumAngle * 180) / Math.PI
        return matMul3(this.#orient, eulerToFwd(drag.axis === 0 ? deg : 0, drag.axis === 1 ? deg : 0, drag.axis === 2 ? deg : 0))
    }

    /** Finish an active drag, reporting the committed transform. */
    handlePointerUp(clientX: number, clientY: number): boolean {
        const drag = this.#drag
        if (!drag) return false
        this.#drag = null
        if (drag.kind === "translate" || drag.kind === "plane") {
            let worldDelta: Vec3
            if (drag.kind === "translate") {
                worldDelta = this.#axisWorldDelta(drag.axis, clientX - drag.startX, clientY - drag.startY)
            } else {
                const rect = this.#host.canvas.getBoundingClientRect()
                const hit = this.#planeHit(clientX - rect.left, clientY - rect.top, drag.baseCenter, drag.normal)
                worldDelta = hit
                    ? sub(hit, drag.startHit)
                    : sub(this.#center ?? drag.baseCenter, drag.baseCenter)
            }
            const delta = applyMat3(this.#invLinear, worldDelta)
            const final: Vec3 = [drag.base[0] + delta[0], drag.base[1] + delta[1], drag.base[2] + delta[2]]
            this.#host.gizmoEnd()
            if (Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]) > 1e-9) {
                this.#host.onTranslateComplete(this.#nodeId, final, delta)
            }
        } else {
            if (drag.rotateNodeId > 0) {
                // Pin the rings to the final spun orientation so the gizmo stays on
                // the object while the (debounced) source-edit rebuild is in flight,
                // instead of flashing back to the pre-rotation pose and snapping
                // into place when the rebuild re-anchors it.
                this.#orient = this.#followOrient(drag)
                this.#host.gizmoEnd()
            }
            const deg = (drag.accumAngle * 180) / Math.PI
            if (Math.abs(deg) > 1e-4) this.#host.onRotateComplete(this.#nodeId, drag.axis, deg)
        }
        this.#redraw()
        this.#host.requestRender()
        return true
    }

    /** Cancel an active drag without committing (Escape). */
    cancelDrag(): void {
        const drag = this.#drag
        if (!drag) return
        this.#drag = null
        if (drag.kind === "translate" || drag.kind === "plane") {
            this.#host.gizmoPreview({ translate: [0, 0, 0] }) // revert preview to base
            this.#host.gizmoEnd()
            this.#center = drag.baseCenter
        } else if (drag.rotateNodeId > 0) {
            this.#host.gizmoPreview({ rotate: drag.baseEuler }) // revert preview to base
            this.#host.gizmoEnd()
        }
        // `#orient`/`#center` are back at the base (never mutated mid-drag), and
        // `#drag` is now null, so the redraw snaps the rings/handles to neutral.
        this.#redraw()
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
        const hit = this.#planeHit(cssX, cssY, center, n)
        if (!hit) return null
        const w = sub(hit, center)
        return Math.atan2(dot(w, v), dot(w, u))
    }

    /**
     * World point where the view ray through (cssX, cssY) pierces the plane
     * through `center` with unit normal `n`. Null if the ray is parallel to it.
     */
    #planeHit(cssX: number, cssY: number, center: Vec3, n: Vec3): Vec3 | null {
        const ray = this.#screenRay(cssX, cssY)
        if (!ray) return null
        const denom = dot(ray.dir, n)
        if (Math.abs(denom) < 1e-6) return null
        const t = dot(sub(center, ray.origin), n) / denom
        return [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t]
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

    /** Nearest handle (0..8) under the canvas CSS-pixel point, or -1. */
    #hitTest(cssX: number, cssY: number): number {
        const center = this.#center
        if (!center) return -1
        const canvas = this.#host.canvas
        const cssW = canvas.clientWidth
        const cssH = canvas.clientHeight
        const zoom = this.#host.controls.zoom
        if (cssW <= 0 || cssH <= 0 || zoom <= 0) return -1

        const invCam = new Mat4x4f(new Float32Array(this.#host.controls.viewTransform.data)).inverse()
        // Fixed WORLD size — matches the shader's `gizmoScale()` (`gizmo.sizeWorld`),
        // so the grabbable regions track the drawn gizmo at every zoom.
        const scale = this.#sizeWorld
        const project = (p: Vec3): ScreenPt | null => this.#project(invCam, p, cssW, cssH, zoom)

        // Planes take priority over arrows/rings: their filled quads sit in the
        // diagonal gaps near the hub, so a hit there is unambiguous. Pick the
        // nearest-centroid plane when projected quads overlap.
        const off = GIZMO_PLANE_OFFSET * scale
        const size = GIZMO_PLANE_SIZE * scale
        let bestPlane = -1
        let bestPlaneDist = Infinity
        for (let axis = 0; axis < 3; axis++) {
            const e0 = GIZMO_AXES[(axis + 1) % 3]!
            const e1 = GIZMO_AXES[(axis + 2) % 3]!
            const c0 = project(planeCorner(center, e0, e1, off, off))
            const c1 = project(planeCorner(center, e0, e1, off + size, off))
            const c2 = project(planeCorner(center, e0, e1, off + size, off + size))
            const c3 = project(planeCorner(center, e0, e1, off, off + size))
            if (c0 && c1 && c2 && c3 && pointInQuad(cssX, cssY, c0, c1, c2, c3)) {
                const cx = (c0.x + c1.x + c2.x + c3.x) / 4
                const cy = (c0.y + c1.y + c2.y + c3.y) / 4
                const d = Math.hypot(cssX - cx, cssY - cy)
                if (d < bestPlaneDist) {
                    bestPlane = gizmoPlaneHandle(axis)
                    bestPlaneDist = d
                }
            }
        }
        if (bestPlane >= 0) return bestPlane

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

    /** 2D context of the overlay canvas (lazily fetched, then cached). */
    #context(): CanvasRenderingContext2D | null {
        if (!this.#ctx) this.#ctx = this.#host.gizmoCanvas.getContext("2d")
        return this.#ctx
    }

    /**
     * Draw the entire gizmo into the overlay canvas (clears first). A few dozen
     * Canvas2D paths on the main thread — never touches the scene raymarch. The
     * backing store is device pixels; `#project` yields CSS px, scaled by `dpr`.
     * Order: translucent plane fills, then rings, then shafts, then arrowheads.
     */
    #redraw(): void {
        const cv = this.#host.gizmoCanvas
        const ctx = this.#context()
        if (!ctx) return
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, cv.width, cv.height)
        const center = this.#center
        if (!this.#shown || !center) return
        const canvas = this.#host.canvas
        const cssW = canvas.clientWidth
        const cssH = canvas.clientHeight
        const zoom = this.#host.controls.zoom
        if (cssW <= 0 || cssH <= 0 || zoom <= 0 || cv.width <= 0) return
        const dpr = cv.width / cssW // overlay backing is device px; project gives CSS px
        const invCam = new Mat4x4f(new Float32Array(this.#host.controls.viewTransform.data)).inverse()
        const scale = this.#sizeWorld
        const proj = (p: Vec3): ScreenPt | null => {
            const s = this.#project(invCam, p, cssW, cssH, zoom)
            return s ? { x: s.x * dpr, y: s.y * dpr } : null
        }
        const drag = this.#drag
        const active = drag?.handle ?? -1
        const hover = this.#hoverHandle
        // Rings follow a live rotate spin, the same orientation #followOrient pins on release.
        const orient = drag && drag.kind === "rotate" && drag.rotateNodeId > 0 ? this.#followOrient(drag) : this.#orient
        ctx.lineJoin = "round"
        ctx.lineCap = "round"

        // 1) Plane quads — translucent fills, beneath the shafts/heads.
        const off = GIZMO_PLANE_OFFSET * scale
        const size = GIZMO_PLANE_SIZE * scale
        for (let axis = 0; axis < 3; axis++) {
            const e0 = GIZMO_AXES[(axis + 1) % 3]!
            const e1 = GIZMO_AXES[(axis + 2) % 3]!
            const c0 = proj(planeCorner(center, e0, e1, off, off))
            const c1 = proj(planeCorner(center, e0, e1, off + size, off))
            const c2 = proj(planeCorner(center, e0, e1, off + size, off + size))
            const c3 = proj(planeCorner(center, e0, e1, off, off + size))
            if (!c0 || !c1 || !c2 || !c3) continue
            ctx.beginPath()
            ctx.moveTo(c0.x, c0.y)
            ctx.lineTo(c1.x, c1.y)
            ctx.lineTo(c2.x, c2.y)
            ctx.lineTo(c3.x, c3.y)
            ctx.closePath()
            ctx.fillStyle = planeCss(axis, handleHl(gizmoPlaneHandle(axis), hover, active))
            ctx.fill()
        }

        // 2) Rotation rings — smooth oriented circles (projected ellipses).
        const r = GIZMO_RING_RADIUS * scale
        ctx.lineWidth = LINE_WIDTH_PX
        for (let axis = 0; axis < 3; axis++) {
            const e0 = matColumn(orient, (axis + 1) % 3)
            const e1 = matColumn(orient, (axis + 2) % 3)
            ctx.beginPath()
            let started = false
            for (let s = 0; s <= RING_DRAW_SAMPLES; s++) {
                const pt = proj(ringPoint(center, e0, e1, (s / RING_DRAW_SAMPLES) * Math.PI * 2, r))
                if (!pt) {
                    started = false
                    continue
                }
                if (started) ctx.lineTo(pt.x, pt.y)
                else {
                    ctx.moveTo(pt.x, pt.y)
                    started = true
                }
            }
            ctx.strokeStyle = lineCss(AXIS_RGB[axis]!, handleHl(gizmoRingHandle(axis), hover, active))
            ctx.stroke()
        }

        // 3) Arrow shafts + heads (world-aligned). Trim the shaft to the head base
        // in screen space so the body meets the arrowhead with no gap or overlap.
        for (let axis = 0; axis < 3; axis++) {
            const u = GIZMO_AXES[axis]!
            const startPt = proj(addScaled(center, u, GIZMO_CENTER_GAP * scale))
            const tipPt = proj(addScaled(center, u, GIZMO_TIP * scale))
            if (!startPt || !tipPt) continue
            let dx = tipPt.x - startPt.x
            let dy = tipPt.y - startPt.y
            const len = Math.hypot(dx, dy) || 1
            dx /= len
            dy /= len
            const trim = Math.min(HEAD_LEN_PX, len)
            const baseX = tipPt.x - dx * trim
            const baseY = tipPt.y - dy * trim
            const nx = -dy
            const ny = dx
            const col = lineCss(AXIS_RGB[axis]!, handleHl(gizmoArrowHandle(axis), hover, active))
            ctx.strokeStyle = col
            ctx.lineWidth = LINE_WIDTH_PX
            ctx.beginPath()
            ctx.moveTo(startPt.x, startPt.y)
            ctx.lineTo(baseX, baseY)
            ctx.stroke()
            ctx.fillStyle = col
            ctx.beginPath()
            ctx.moveTo(tipPt.x, tipPt.y)
            ctx.lineTo(baseX + nx * HEAD_HALF_WIDTH_PX, baseY + ny * HEAD_HALF_WIDTH_PX)
            ctx.lineTo(baseX - nx * HEAD_HALF_WIDTH_PX, baseY - ny * HEAD_HALF_WIDTH_PX)
            ctx.closePath()
            ctx.fill()
        }
    }
}

function addScaled(c: Vec3, u: readonly number[], s: number): Vec3 {
    return [c[0] + u[0]! * s, c[1] + u[1]! * s, c[2] + u[2]! * s]
}

/** Corner `c + e0*s0 + e1*s1` of a plane quad spanned by axes `e0`/`e1`. */
function planeCorner(c: Vec3, e0: readonly number[], e1: readonly number[], s0: number, s1: number): Vec3 {
    return [
        c[0] + e0[0]! * s0 + e1[0]! * s1,
        c[1] + e0[1]! * s0 + e1[1]! * s1,
        c[2] + e0[2]! * s0 + e1[2]! * s1,
    ]
}

/** Is (px,py) inside the convex quad a→b→c→d? Consistent cross-product sign. */
function pointInQuad(px: number, py: number, a: ScreenPt, b: ScreenPt, c: ScreenPt, d: ScreenPt): boolean {
    const pts = [a, b, c, d]
    let sign = 0
    for (let i = 0; i < 4; i++) {
        const p0 = pts[i]!
        const p1 = pts[(i + 1) % 4]!
        const cross = (p1.x - p0.x) * (py - p0.y) - (p1.y - p0.y) * (px - p0.x)
        if (cross !== 0) {
            const s = cross > 0 ? 1 : -1
            if (sign === 0) sign = s
            else if (s !== sign) return false
        }
    }
    return true
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
