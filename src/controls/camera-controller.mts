import { Subject } from "rxjs"
import { fromEvent } from "rxjs"
import { clamped } from "../math.mjs"
import { SettingsManager, type CameraSettings } from "../storage/settings.mjs"
import { lookAt, Mat4x4f } from "../vecmat/matrix.mjs"
import { vec2, Vec2f, vec3, Vec3f } from "../vecmat/vector.mjs"
import { PinchZoomController } from "./pinchzoom-controller.mjs"
import { Trackball } from "./trackball.mjs"
import type { Subscription } from "rxjs"
// @ts-ignore - quaternion library type definitions have issues
import Quaternion from "quaternion"

export interface CameraHost extends HTMLElement {
    canvas: HTMLCanvasElement
}

export interface CameraState {
    rotation: [number, number, number, number] // quaternion [w, x, y, z]
    zoom: number
    translation: Vec3f
}

export class CameraController {
    #settings: SettingsManager
    #pivot: Vec3f
    #host: CameraHost
    #documentName: string | null = null
    cameraPosition = new Vec3f()
    viewTransform = new Mat4x4f()

    #rotation: Quaternion = new Quaternion(1, 0, 0, 0) // identity quaternion

    @clamped(2, 250)
    accessor zoom: number = 40

    #isDragging = false
    get isDragging() {
        return this.#isDragging
    }
    set isDragging(val: boolean) {
        this.#isDragging = val
        this.#host.canvas.style.cursor = val ? "grabbing" : "auto"
    }

    /** True if the user has moved the pointer during the current drag (not just clicked). */
    get hasDragged(): boolean {
        return this.#hasDragged
    }

    /** True when the user is actively moving (dragging with movement, or zooming). Used for half-res optimization. */
    get isActivelyMoving(): boolean {
        return (this.#isDragging && this.#hasDragged) || this.#zoomController.isZooming
    }

    #last = new Vec2f()
    #cursorDelta = new Vec2f()
    #lastFocused: Element | null = null
    #primaryPointerId: number | null = null

    #dragMode: "rotate" | "pan" | null = null
    #hasDragged: boolean = false
    #dragSessionId: number = 0
    #rotateSensitivity: number = 0.005
    #panSensitivity: number = 0.1
    #cameraTranslation: Vec3f = new Vec3f()
    #zoomController: PinchZoomController
    #trackball: Trackball
    #isSyncing = false
    #tabsElement: EventTarget | null = null
    #tabChangeSub: Subscription | null = null
    /** 3D world-space point to orbit around (Cmd/Ctrl+drag). Null → standard pivot at origin. */
    #customPivot: Vec3f | null = null

    /**
     * Optional callback to query the 3D world-space position under a screen coordinate.
     * Used for Cmd/Ctrl+drag to orbit around the picked surface point.
     * Returns null if no surface is under the cursor.
     */
    pickPosAtScreen: ((clientX: number, clientY: number) => Promise<[number, number, number] | null>) | null = null

    /** Emitted when camera state changes (rotate, pan, zoom). */
    readonly change$ = new Subject<CameraState>()
    /** Emitted on single click (screen position, shift, alt). */
    readonly select$ = new Subject<{ screenPos: Vec2f; shiftKey: boolean; altKey: boolean }>()
    /** Emitted on double click (screen position, modifier keys). */
    readonly doubleClick$ = new Subject<{ screenPos: Vec2f; metaKey: boolean; ctrlKey: boolean }>()
    /** Emitted on hover when not dragging (screen position, alt). */
    readonly hover$ = new Subject<{ screenPos: Vec2f; altKey: boolean }>()

    constructor(host: CameraHost, pivot: Vec3f, radius: number, initialTheta: number = 0, initialPhi: number = Math.PI / 2, tabsElement?: EventTarget | null, getInteractionRect?: () => DOMRect) {
        this.#settings = SettingsManager.instance
        this.#host = host
        this.#pivot = pivot
        this.zoom = radius
        this.#zoomController = new PinchZoomController(host, this.zoom)
        this.#zoomController.onZoom = zoom => {
            this.zoom = zoom
            // Clamp may change the value; keep controller state aligned.
            this.#zoomController.setZoom(this.zoom, false)
            // Zoom doesn't affect viewTransform, but it *must* emit so other views stay synced.
            this.#saveCameraState()
            this.change$.next(this.state)
        }
        this.#zoomController.onRotate = angleDelta => {
            // Rotate around the axis perpendicular to the screen (camera forward direction).
            // The base view looks down -Z; apply current rotation to get world-space forward.
            const rotationMatrix = this.#quaternionToMatrix(this.#rotation)
            const forward = rotationMatrix.transformVector(vec3(0, 0, -1)).normalize()
            const twist = Quaternion.fromAxisAngle([forward.x, forward.y, forward.z], angleDelta)
            this.#rotation = this.#rotation.mul(twist).normalize()
            this.#updateTransforms()
        }
        // Initialize rotation from Euler angles (for backward compatibility)
        this.#rotation = Quaternion.fromEuler(initialPhi, initialTheta, 0, "YXZ")

        this.#isSyncing = true
        this.#trackball = new Trackball({
            scene: this.#host.canvas,
            getInteractionRect,
            rotationMethod: "rounded_arcball",
            q: this.#rotation,
            onDraw: (q) => {
                if (this.#isSyncing) return
                const prevRotation = this.#rotation
                this.#rotation = q
                if (this.#customPivot) {
                    this.#applyCustomPivotCompensation(prevRotation, q, this.#customPivot)
                }
                this.#updateTransforms()
            },
        })
        this.#isSyncing = false

        this.#initEvents()

        // Listen for tab changes if tabs element is provided
        if (tabsElement) {
            this.#tabsElement = tabsElement
            this.#tabChangeSub = fromEvent(tabsElement, "activeTabChanged").subscribe((e: Event) => {
                const customEvent = e as CustomEvent<string | undefined>
                // SettingsManager.switchDocument flushes current doc & loads the new one
                this.#documentName = customEvent.detail ?? ""
                // Camera is loaded when the scene build completes (via loadCameraFromSettings)
                // to avoid flicker from new camera + old scene
            })
        }

        this.#loadCameraState()
        this.#updateTransforms()
    }

    get state(): CameraState {
        const q = this.#rotation.toVector()
        return {
            rotation: [q[0], q[1], q[2], q[3]], // [w, x, y, z]
            zoom: this.zoom,
            translation: this.#cameraTranslation.clone(),
        }
    }

    applyState(state: CameraState, opts: { emit?: boolean } = {}): void {
        const emit = opts.emit ?? true
        this.#rotation = new Quaternion(state.rotation[0], state.rotation[1], state.rotation[2], state.rotation[3])
        this.zoom = state.zoom
        this.#zoomController.setZoom(this.zoom, false)
        this.#cameraTranslation = state.translation.clone()
        this.#syncTrackball()
        this.#updateTransforms(emit)
    }

    #initEvents() {
        this.#host.canvas.addEventListener("pointerdown", this.#onPointerDown.bind(this))
        this.#host.canvas.addEventListener("pointermove", this.#onPointerMove.bind(this))
        this.#host.canvas.addEventListener("pointerup", this.#onPointerUp.bind(this))
        this.#host.canvas.addEventListener("pointercancel", this.#onPointerUp.bind(this))
        this.#host.canvas.addEventListener("click", this.#onClick.bind(this))
        this.#host.canvas.addEventListener("dblclick", this.#onDblClick.bind(this))
        this.#host.canvas.addEventListener("contextmenu", e => e.preventDefault())
        this.#host.canvas.addEventListener("keypress", this.#onKeyPress.bind(this))
        document.addEventListener("keydown", this.#onKeyPress.bind(this), false)

        // track clicks
        document.addEventListener("click", e => {
            this.#lastFocused = e.target as Element
        })

        // track focus changes
        document.addEventListener("focusin", e => {
            this.#lastFocused = e.target as Element
        })
    }

    #onKeyPress(e: KeyboardEvent) {
        if (this.#lastFocused?.id !== this.#host.id) return
        const R180_X = Quaternion.fromAxisAngle([1, 0, 0], Math.PI)
        const R180_Y = Quaternion.fromAxisAngle([0, 1, 0], Math.PI)
        const R180_Z = Quaternion.fromAxisAngle([0, 0, 1], Math.PI)
        if (e.code === "Digit1") {
            this.#rotation = Quaternion.fromEuler(-Math.PI, -Math.PI, 0, "YXZ")
        } else if (e.code === "Digit2") {
            // Back: same as front (1) rotated 180° around Y — no vertical flip
            this.#rotation = Quaternion.fromEuler(-Math.PI, -Math.PI, 0, "YXZ").mul(R180_Y)
        } else if (e.code === "Digit3") {
            this.#rotation = Quaternion.fromEuler(0, Math.PI / 2, 0, "YXZ")
        } else if (e.code === "Digit4") {
            // Left: same as right (3) rotated 180° around Z — no vertical flip
            this.#rotation = Quaternion.fromEuler(0, Math.PI / 2, 0, "YXZ").mul(R180_Z)
        } else if (e.code === "Digit5") {
            this.#rotation = Quaternion.fromEuler(-Math.PI / 2, Math.PI, 0, "YXZ")
        } else if (e.code === "Digit6") {
            // Bottom: same as top (5) rotated 180° around Y — no vertical flip
            this.#rotation = Quaternion.fromEuler(-Math.PI / 2, Math.PI, 0, "YXZ").mul(R180_Y)
        } else if (e.code === "Backquote") {
            this.#rotation = Quaternion.fromEuler(-Math.PI / 8, (5 / 4) * Math.PI, 0, "YXZ")
            this.#cameraTranslation = new Vec3f()
        } else {
            return
        }
        e.preventDefault()
        this.#syncTrackball()
        this.#updateTransforms()
    }

    #onClick(e: MouseEvent) {
        // Only handle left clicks, and only if we didn't drag
        if (e.button === 0 && !this.#hasDragged) {
            this.select$.next({ screenPos: vec2(e.clientX, e.clientY), shiftKey: e.shiftKey, altKey: e.altKey })
        }
    }

    #onDblClick(e: MouseEvent) {
        if (e.button === 0 && !this.#hasDragged) {
            this.doubleClick$.next({ screenPos: vec2(e.clientX, e.clientY), metaKey: e.metaKey, ctrlKey: e.ctrlKey })
        }
    }

    #onPointerDown(e: PointerEvent) {
        if (e.button === 0) {
            // Left click: start rotation drag
            // When already dragging (e.g. second finger touches for pinch), don't overwrite #last
            // or we'd get a huge spurious delta when the first finger moves.
            if (!this.isDragging) {
                this.#dragMode = "rotate"
                this.#primaryPointerId = e.pointerId
                this.isDragging = true
                this.#hasDragged = false
                this.#last = vec2(e.clientX, e.clientY)
                this.#customPivot = null
                // Cmd (macOS) or Ctrl (other) — orbit around the surface point under the cursor
                if ((e.metaKey || e.ctrlKey) && this.pickPosAtScreen) {
                    const cx = e.clientX
                    const cy = e.clientY
                    const sessionId = ++this.#dragSessionId
                    this.pickPosAtScreen(cx, cy).then(pos => {
                        if (pos && this.#dragMode === "rotate" && this.#dragSessionId === sessionId) {
                            this.#customPivot = vec3(pos[0], pos[1], pos[2])
                        }
                    })
                }
            }
            this.#host.canvas.setPointerCapture(e.pointerId)
        } else if (e.button === 2) {
            if (!this.isDragging) {
                this.#dragMode = "pan"
                this.#primaryPointerId = e.pointerId
                this.isDragging = true
                this.#hasDragged = false
                this.#last = vec2(e.clientX, e.clientY)
            }
            this.#host.canvas.setPointerCapture(e.pointerId)
        } else {
            return
        }
    }

    #onPointerMove(e: PointerEvent) {
        // Check for hover events when not dragging
        if (!this.isDragging) {
            this.hover$.next({ screenPos: vec2(e.clientX, e.clientY), altKey: e.altKey })
            return
        }
        if (this.#zoomController.isZooming) return
        // Only use the primary pointer's movement; ignore the second finger when pinch starts
        if (this.#primaryPointerId !== null && e.pointerId !== this.#primaryPointerId) return

        const pvec = vec2(e.clientX, e.clientY)
        this.#cursorDelta.set(pvec.subtract(this.#last))

        // Mark that we've dragged if there's any movement
        if (this.#cursorDelta.length() > 2) {
            this.#hasDragged = true
        }

        this.#last.set(pvec)

        if (this.#dragMode === "rotate") {
            // Rotation is handled by Trackball (rounded arcball) via its onDraw callback
        } else if (this.#dragMode === "pan") {
            // Compute camera-relative pan directions based on current rotation
            const rotationMatrix = this.#quaternionToMatrix(this.#rotation)
            const cameraRight = rotationMatrix.transformVector(vec3(1, 0, 0))
            const cameraUp = rotationMatrix.transformVector(vec3(0, 1, 0))

            // Apply pan in camera-relative directions
            this.#cameraTranslation.x -= (this.#cursorDelta.x * cameraRight.x - this.#cursorDelta.y * cameraUp.x) * this.#panSensitivity
            this.#cameraTranslation.y -= (this.#cursorDelta.x * cameraRight.y - this.#cursorDelta.y * cameraUp.y) * this.#panSensitivity
            this.#cameraTranslation.z -= (this.#cursorDelta.x * cameraRight.z - this.#cursorDelta.y * cameraUp.z) * this.#panSensitivity
        }

        if (this.#dragMode !== "rotate") {
            this.#updateTransforms()
        }
    }

    #onPointerUp(e: PointerEvent) {
        // Reset drag state only when the primary pointer is released
        if (this.#primaryPointerId === e.pointerId) {
            this.#primaryPointerId = null
            this.isDragging = false
            this.#dragMode = null
            this.#customPivot = null
            // Camera state is saved via rxjs debounce in SettingsManager;
            // the debounce fires once the camera stops moving.
            this.#saveCameraState()
        }
    }

    #computeCameraPosition(): Vec3f {
        return this.#pivot.add(vec3(0, 0, 1))
    }

    /**
     * Smoothly recenter the camera so the given world-space point appears at screen center.
     *
     * In camera space: screen center = (offsetX=0, offsetY=0, depth).
     * We find P's current depth in camera space and compute the camTrans that puts P at
     * screen center at that same depth (no zoom change).
     *
     * Note: #quaternionToMatrix returns R^T (= R^{-1} for rotations) due to row-major
     * reinterpretation. R * v = rotMat.transpose().transformVector(v).
     */
    /** Reset the camera to the default view angle and centered position, with animation. */
    resetView(): void {
        const targetRotation = Quaternion.fromEuler(-Math.PI / 8, (5 / 4) * Math.PI, 0, "YXZ")
        const targetTrans = new Vec3f()
        const startRotation = this.#rotation.clone()
        const startTrans = this.#cameraTranslation.clone()
        const interpolate = startRotation.slerp(targetRotation)
        const startTime = performance.now()
        const DURATION_MS = 350

        const step = (now: number) => {
            const t = Math.min((now - startTime) / DURATION_MS, 1)
            const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
            this.#rotation = interpolate(ease)
            this.#cameraTranslation.x = startTrans.x + (targetTrans.x - startTrans.x) * ease
            this.#cameraTranslation.y = startTrans.y + (targetTrans.y - startTrans.y) * ease
            this.#cameraTranslation.z = startTrans.z + (targetTrans.z - startTrans.z) * ease
            this.#syncTrackball()
            this.#updateTransforms()
            if (t < 1) requestAnimationFrame(step)
            else this.#saveCameraState()
        }
        requestAnimationFrame(step)
    }

    recenterOnPoint(worldPoint: Vec3f): void {
        const rotMat = this.#quaternionToMatrix(this.#rotation)
        // Transform P into camera space to get its current depth (z component)
        const diff = vec3(
            worldPoint.x - this.#cameraTranslation.x,
            worldPoint.y - this.#cameraTranslation.y,
            worldPoint.z - this.#cameraTranslation.z,
        )
        // rotMat = R^{-1}, so rotMat * diff gives camera-space coordinates of (P - camTrans)
        const camSpaceP = rotMat.transformVector(diff)
        // Keep P at the same depth; zero out x,y to center it on screen
        // camTrans_new = P - R * (0, 0, camSpaceP.z)
        const rForward = rotMat.transpose().transformVector(vec3(0, 0, camSpaceP.z))
        const targetTrans = vec3(
            worldPoint.x - rForward.x,
            worldPoint.y - rForward.y,
            worldPoint.z - rForward.z,
        )
        this.#animateCameraTranslation(targetTrans)
    }

    #animateCameraTranslation(target: Vec3f): void {
        const startTrans = this.#cameraTranslation.clone()
        const startTime = performance.now()
        const DURATION_MS = 300

        const step = (now: number) => {
            const t = Math.min((now - startTime) / DURATION_MS, 1)
            // Ease in-out cubic
            const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
            this.#cameraTranslation.x = startTrans.x + (target.x - startTrans.x) * ease
            this.#cameraTranslation.y = startTrans.y + (target.y - startTrans.y) * ease
            this.#cameraTranslation.z = startTrans.z + (target.z - startTrans.z) * ease
            this.#updateTransforms()
            if (t < 1) requestAnimationFrame(step)
            else this.#saveCameraState()
        }
        requestAnimationFrame(step)
    }

    /**
     * Adjust camera translation to keep `pivot` (world-space) at the same screen position
     * after the rotation changes from `prevRotation` to `newRotation`.
     *
     * Screen XY of a world point P satisfies: P = R * (offsetX, offsetY, 100) + camTrans
     * → camTrans_new = P - R_new * R_old^{-1} * (P - camTrans_old)
     *
     * Note: #quaternionToMatrix returns R^T (= R^{-1} for rotations), so:
     *   R_old^{-1} * v  = prevMat.transformVector(v)
     *   R_new * v       = newMat.transpose().transformVector(v)
     */
    #applyCustomPivotCompensation(prevRotation: Quaternion, newRotation: Quaternion, pivot: Vec3f): void {
        const prevMat = this.#quaternionToMatrix(prevRotation)
        const newMat = this.#quaternionToMatrix(newRotation)
        const diff = vec3(
            pivot.x - this.#cameraTranslation.x,
            pivot.y - this.#cameraTranslation.y,
            pivot.z - this.#cameraTranslation.z,
        )
        // R_old^{-1} * diff
        const oldInvDiff = prevMat.transformVector(diff)
        // R_new * (R_old^{-1} * diff)
        const rotated = newMat.transpose().transformVector(oldInvDiff)
        this.#cameraTranslation.x = pivot.x - rotated.x
        this.#cameraTranslation.y = pivot.y - rotated.y
        this.#cameraTranslation.z = pivot.z - rotated.z
    }

    #quaternionToMatrix(q: Quaternion): Mat4x4f {
        // Convert quaternion to 4x4 rotation matrix
        const matrix4 = q.toMatrix4(false) // false = flat array, not 2D
        return new Mat4x4f(new Float32Array(matrix4))
    }

    #updateTransforms(emit = true) {
        this.cameraPosition = this.#computeCameraPosition()
        // Use a fixed up vector (world up) for constructing the view matrix
        let view = lookAt(this.cameraPosition, this.#pivot, vec3(0, 1, 0))
        // Apply quaternion rotation
        const rotationMatrix = this.#quaternionToMatrix(this.#rotation)
        view = rotationMatrix.multiply(view)
        view = Mat4x4f.translation(this.#cameraTranslation).multiply(view)
        this.viewTransform = view
        if (emit) {
            this.change$.next(this.state)
        }
    }

    /** Push current camera state to SettingsManager (persisted via rxjs debounce). */
    #saveCameraState(): void {
        const q = this.#rotation.toVector()
        const cam: CameraSettings = {
            position: [this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z],
            translation: [this.#cameraTranslation.x, this.#cameraTranslation.y, this.#cameraTranslation.z],
            zoom: this.zoom,
            rotation: [q[0], q[1], q[2], q[3]],
        }
        this.#settings.setCamera(cam)
    }

    /** Load camera from current document settings. Called when scene is ready to avoid flicker. */
    loadCameraFromSettings(): void {
        this.#loadCameraState()
    }

    #loadCameraState(): void {
        const cam = this.#settings.getCamera()
        this.cameraPosition = vec3(cam.position[0], cam.position[1], cam.position[2])
        this.#cameraTranslation = vec3(cam.translation[0], cam.translation[1], cam.translation[2])
        this.zoom = cam.zoom
        this.#zoomController.setZoom(this.zoom, false)
        this.#rotation = new Quaternion(cam.rotation[0], cam.rotation[1], cam.rotation[2], cam.rotation[3]).normalize()
        this.#syncTrackball()
        this.#updateTransforms()
    }

    #syncTrackball(): void {
        this.#isSyncing = true
        this.#trackball.reset()
        this.#trackball.rotate(this.#rotation)
        this.#isSyncing = false
    }

    /**
     * Clean up event listeners when the controller is destroyed.
     * Should be called when the component is no longer needed.
     */
    dispose(): void {
        this.#tabChangeSub?.unsubscribe()
        this.#tabChangeSub = null
        this.#tabsElement = null
        this.change$.complete()
        this.select$.complete()
        this.doubleClick$.complete()
        this.hover$.complete()
    }

}
