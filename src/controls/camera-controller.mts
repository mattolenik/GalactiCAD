import { Subject } from "rxjs"
import { fromEvent } from "rxjs"
import { SettingsManager, type CameraSettings } from "../storage/settings.mjs"
import { lookAt, Mat4x4f } from "../vecmat/matrix.mjs"
import { vec2, Vec2f, vec3, Vec3f } from "../vecmat/vector.mjs"
import { PinchZoomController } from "./pinchzoom-controller.mjs"
import { Trackball, type TrackballRotationMethod } from "./trackball.mjs"
import type { Subscription } from "rxjs"
// @ts-ignore - quaternion library type definitions have issues
import Quaternion from "quaternion"

/** Must match `RAY_ORIGIN_DEPTH` in preview.wgsl / `computeRayOrigin` at optical center */
const PREVIEW_RAY_ORIGIN_DEPTH = 300

/** Reference dolly distance (orbit stand-off): orthographic half-height is proportional. */
export const DOLLY_REF = 50
/** Orthographic half-height in world units when `dollyDistance === DOLLY_REF`. */
export const ORTHO_HALF_REF = 40

/** Legacy ortho half-height range [0.2, 250] maps to dolly via {@link dollyFromOrthoHalf}. */
const DOLLY_MIN = DOLLY_REF * (0.2 / ORTHO_HALF_REF)
const DOLLY_MAX = DOLLY_REF * (250 / ORTHO_HALF_REF)

/** WGSL `camera.zoom`: orthographic half-height derived from dolly distance. */
export function orthoHalfFromDolly(dollyDistance: number): number {
    return ORTHO_HALF_REF * (dollyDistance / DOLLY_REF)
}

/** Inverse of {@link orthoHalfFromDolly}; used for migrating saved ortho `zoom`. */
export function dollyFromOrthoHalf(orthoHalf: number): number {
    return DOLLY_REF * (orthoHalf / ORTHO_HALF_REF)
}

export interface CameraHost extends HTMLElement {
    canvas: HTMLCanvasElement
}

export interface CameraState {
    rotation: [number, number, number, number] // quaternion [w, x, y, z]
    /** Stand-off dolly distance; WGSL ortho half-height is {@link orthoHalfFromDolly}(dollyDistance). */
    dollyDistance: number
    translation: Vec3f
    /** Scene-space orbit / look-at pivot (defaults to origin when omitted for older callers). */
    pivot?: Vec3f
}

/** At/above this dolly distance → pan uses full linear world-per-CSS-pixel scale. */
const PAN_DOLLY_REF = DOLLY_REF
/** When close in (small dolly), pan speed scales up by up to this fraction (sqrt easing). */
const PAN_DOLLY_IN_BOOST = 0.34


export class CameraController {
    #settings: SettingsManager
    #pivot: Vec3f
    #host: CameraHost
    #documentName: string | null = null
    cameraPosition = new Vec3f()
    viewTransform = new Mat4x4f()

    #rotation: Quaternion = new Quaternion(1, 0, 0, 0) // identity quaternion

    /** Stand-off dolly distance; wheel adjusts this; WGSL gets {@link orthoHalfFromDolly}. */
    #dollyDistance = DOLLY_REF

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
    #rotateSensitivity: number = 0.005
    #cameraTranslation: Vec3f = new Vec3f()
    #zoomController: PinchZoomController
    #trackball: Trackball
    #isSyncing = false
    #tabsElement: EventTarget | null = null
    #tabChangeSub: Subscription | null = null
    /** When set, camera/trackball input is limited to this screen rect (visible preview minus editor overlay). */
    #getInteractionRect?: () => DOMRect
    /** Last Cmd/Ctrl+double-click focus hit (world space); used by {@link recenterOnPoint} when refocusing. */
    #lastFocusWorld: Vec3f | null = null
    /** Optical center in [0,1] UV space (matches preview.wgsl viewCenter). Updated by host when editor overlaps view. */
    #viewCenter: Vec2f = vec2(0.5, 0.5)

    /** Emitted when camera state changes (rotate, pan, zoom). */
    readonly change$ = new Subject<CameraState>()
    /** Emitted on single click (screen position, shift, alt). */
    readonly select$ = new Subject<{ screenPos: Vec2f; shiftKey: boolean; altKey: boolean }>()
    /** Emitted on double click (screen position, modifier keys). */
    readonly doubleClick$ = new Subject<{ screenPos: Vec2f; metaKey: boolean; ctrlKey: boolean }>()
    /** Emitted on hover when not dragging (screen position, alt). */
    readonly hover$ = new Subject<{ screenPos: Vec2f; altKey: boolean }>()

    /** Orthographic half-height for WGSL (`camera.zoom`), mesh rasterization, push-pull. */
    get zoom(): number {
        return orthoHalfFromDolly(this.#dollyDistance)
    }

    constructor(
        host: CameraHost,
        pivot: Vec3f,
        initialDollyDistance: number = DOLLY_REF,
        initialTheta: number = 0,
        initialPhi: number = Math.PI / 2,
        tabsElement?: EventTarget | null,
        getInteractionRect?: () => DOMRect,
    ) {
        this.#settings = SettingsManager.instance
        this.#host = host
        this.#getInteractionRect = getInteractionRect
        this.#pivot = pivot
        this.#dollyDistance = Math.min(DOLLY_MAX, Math.max(DOLLY_MIN, initialDollyDistance))
        this.#zoomController = new PinchZoomController(host, this.#dollyDistance, getInteractionRect)
        this.#zoomController.onZoom = (dolly, cursor) => {
            const dollyOld = this.#dollyDistance
            this.#dollyDistance = Math.min(DOLLY_MAX, Math.max(DOLLY_MIN, dolly))
            this.#zoomController.setDollyDistance(this.#dollyDistance, false)
            const orthoOld = orthoHalfFromDolly(dollyOld)
            const orthoNew = orthoHalfFromDolly(this.#dollyDistance)
            const dOrtho = orthoNew - orthoOld
            if (Math.abs(dOrtho) > 1e-10 && !this.#lastFocusWorld) {
                this.#applyOrthoDeltaToCursor(dOrtho, cursor.x, cursor.y)
            }
            this.#updateTransforms()
            this.#saveCameraState()
        }
        this.#zoomController.onRotate = angleDelta => {
            if (Math.abs(angleDelta) < 1e-10) return
            const rotationMatrix = this.#quaternionToMatrix(this.#rotation)
            const forward = rotationMatrix.transformVector(vec3(0, 0, -1)).normalize()
            const twist = Quaternion.fromAxisAngle([forward.x, forward.y, forward.z], angleDelta)
            const newQ = this.#rotation.mul(twist).normalize()
            this.#applyOrbitCompensation(this.#rotation, newQ)
            this.#rotation = newQ
            // Pinch updates the camera but not the trackball (touchmove only runs for 1 touch);
            // applySceneRotation → #draw → onDraw keeps them aligned so touchend does not snap back.
            this.#trackball.applySceneRotation(this.#rotation)
            this.#updateTransforms()
        }
        // Initialize rotation from Euler angles (for backward compatibility)
        this.#rotation = Quaternion.fromEuler(initialPhi, initialTheta, 0, "YXZ")

        const rotationMethod =
            this.#settings.getGlobal().preview.cameraRotationMethod ?? "rounded_arcball"
        this.#isSyncing = true
        this.#trackball = new Trackball({
            scene: this.#host.canvas,
            getInteractionRect,
            rotationMethod,
            q: this.#rotation,
            onDraw: (q) => {
                if (this.#isSyncing) return
                this.#applyOrbitCompensation(this.#rotation, q)
                this.#rotation = q
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
            dollyDistance: this.#dollyDistance,
            translation: this.#cameraTranslation.clone(),
            pivot: this.#pivot.clone(),
        }
    }

    applyState(state: CameraState, opts: { emit?: boolean } = {}): void {
        const emit = opts.emit ?? true
        this.#rotation = new Quaternion(state.rotation[0], state.rotation[1], state.rotation[2], state.rotation[3])
        this.#dollyDistance = Math.min(DOLLY_MAX, Math.max(DOLLY_MIN, state.dollyDistance))
        this.#zoomController.setDollyDistance(this.#dollyDistance, false)
        this.#cameraTranslation = state.translation.clone()
        if (state.pivot) {
            this.#pivot = state.pivot.clone()
        }
        this.#lastFocusWorld = null
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
        if (e.code === "Digit1") {
            this.setViewFront()
        } else if (e.code === "Digit2") {
            this.setViewBack()
        } else if (e.code === "Digit3") {
            this.setViewRight()
        } else if (e.code === "Digit4") {
            this.setViewLeft()
        } else if (e.code === "Digit5") {
            this.setViewTop()
        } else if (e.code === "Digit6") {
            this.setViewBottom()
        } else if (e.code === "Backquote") {
            this.resetView()
        } else {
            return
        }
        e.preventDefault()
    }

    setViewFront(): void {
        this.#rotation = Quaternion.fromEuler(-Math.PI, -Math.PI, 0, "YXZ")
        this.#applyViewPreset()
    }

    setViewBack(): void {
        const R180_Y = Quaternion.fromAxisAngle([0, 1, 0], Math.PI)
        this.#rotation = Quaternion.fromEuler(-Math.PI, -Math.PI, 0, "YXZ").mul(R180_Y)
        this.#applyViewPreset()
    }

    setViewRight(): void {
        this.#rotation = Quaternion.fromEuler(0, Math.PI / 2, 0, "YXZ")
        this.#applyViewPreset()
    }

    setViewLeft(): void {
        const R180_Z = Quaternion.fromAxisAngle([0, 0, 1], Math.PI)
        this.#rotation = Quaternion.fromEuler(0, Math.PI / 2, 0, "YXZ").mul(R180_Z)
        this.#applyViewPreset()
    }

    setViewTop(): void {
        this.#rotation = Quaternion.fromEuler(-Math.PI / 2, Math.PI, 0, "YXZ")
        this.#applyViewPreset()
    }

    setViewBottom(): void {
        const R180_Y = Quaternion.fromAxisAngle([0, 1, 0], Math.PI)
        this.#rotation = Quaternion.fromEuler(-Math.PI / 2, Math.PI, 0, "YXZ").mul(R180_Y)
        this.#applyViewPreset()
    }

    #applyViewPreset(): void {
        this.#syncTrackball()
        this.#updateTransforms()
        this.#saveCameraState()
    }

    #onClick(e: MouseEvent) {
        // Only handle left clicks, and only if we didn't drag
        if (e.button === 0 && !this.#hasDragged && this.#isClientInInteractionRect(e.clientX, e.clientY)) {
            this.select$.next({ screenPos: vec2(e.clientX, e.clientY), shiftKey: e.shiftKey, altKey: e.altKey })
        }
    }

    #onDblClick(e: MouseEvent) {
        if (e.button === 0 && !this.#hasDragged && this.#isClientInInteractionRect(e.clientX, e.clientY)) {
            this.doubleClick$.next({ screenPos: vec2(e.clientX, e.clientY), metaKey: e.metaKey, ctrlKey: e.ctrlKey })
        }
    }

    /** Screen point must lie in the visible preview rect when one is configured (canvas can extend under the editor). */
    #isClientInInteractionRect(clientX: number, clientY: number): boolean {
        const q = this.#getInteractionRect
        if (!q) return true
        const r = q()
        return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
    }

    #onPointerDown(e: PointerEvent) {
        if (!this.#isClientInInteractionRect(e.clientX, e.clientY)) return
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
            if (this.#isClientInInteractionRect(e.clientX, e.clientY)) {
                this.hover$.next({ screenPos: vec2(e.clientX, e.clientY), altKey: e.altKey })
            }
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
            // Orthographic-style preview: visible height = 2 * zoom (see preview.wgsl pixelSizeY).
            // Base scale matches on-screen geometry (push-pull.mts worldPerPixel); below PAN_ZOOM_REF
            // apply a gentle boost so close-in panning does not feel sluggish vs. linear world lock.
            const cssH = Math.max(1, this.#host.canvas.getBoundingClientRect().height)
            const linearWorldPerCssPixel = (2 * this.zoom) / cssH
            const zNorm = Math.min(1, this.#dollyDistance / PAN_DOLLY_REF)
            const panCurve = 1 + PAN_DOLLY_IN_BOOST * (1 - Math.sqrt(zNorm))
            const worldPerCssPixel = linearWorldPerCssPixel * panCurve

            const rotationMatrix = this.#quaternionToMatrix(this.#rotation)
            const cameraRight = rotationMatrix.transformVector(vec3(1, 0, 0))
            const cameraUp = rotationMatrix.transformVector(vec3(0, 1, 0))

            this.#cameraTranslation.x -= (this.#cursorDelta.x * cameraRight.x - this.#cursorDelta.y * cameraUp.x) * worldPerCssPixel
            this.#cameraTranslation.y -= (this.#cursorDelta.x * cameraRight.y - this.#cursorDelta.y * cameraUp.y) * worldPerCssPixel
            this.#cameraTranslation.z -= (this.#cursorDelta.x * cameraRight.z - this.#cursorDelta.y * cameraUp.z) * worldPerCssPixel
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
            // Camera state is saved via rxjs debounce in SettingsManager;
            // the debounce fires once the camera stops moving.
            this.#saveCameraState()
        }
    }

    /** World-space eye: orbit standoff direction from pivot (fixed at +Z; rotation applied separately in viewTransform). */
    #computeCameraPosition(): Vec3f {
        return this.#pivot.add(vec3(0, 0, 1))
    }

    /** Reset the camera to the default view angle and centered position, with animation. */
    resetView(): void {
        this.#lastFocusWorld = null
        this.#pivot = new Vec3f()
        const targetRotation = Quaternion.fromEuler(Math.PI / 4, 0, 0, "YXZ")
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

    /**
     * Orbit center in scene space: set to the pick hit `xyz`.
     * After updating pivot, snap the hit onto the central view ray so it appears centered.
     */
    setPivotToWorldHit(hitWorld: Vec3f): void {
        this.#pivot = hitWorld.clone()
        this.#lastFocusWorld = null
        this.#syncTrackball()
        this.#updateTransforms()
        const d = this.#translationDeltaSnapWorldPointToCentralRay(hitWorld)
        if (d.length() > 1e-20) {
            this.#cameraTranslation.x += d.x
            this.#cameraTranslation.y += d.y
            this.#cameraTranslation.z += d.z
            this.#updateTransforms()
        }
        this.#saveCameraState()
    }

    /**
     * Central optical-axis ray in world space (fragment uv = viewCenter → uvAspect (0.5, 0.5) in preview.wgsl).
     * Direction matches WGSL `normalize(-camera.transform[2].xyz)` via camera −Z → world.
     */
    #worldCentralRay(): { origin: Vec3f; dir: Vec3f } {
        const ro = vec3(
            this.cameraPosition.x,
            this.cameraPosition.y,
            this.cameraPosition.z + PREVIEW_RAY_ORIGIN_DEPTH,
        )
        const origin = this.viewTransform.transformPoint(ro)
        const dirRaw = this.viewTransform.transformVector(vec3(0, 0, -1))
        if (dirRaw.length() < 1e-20) {
            return { origin, dir: vec3(0, 0, -1) }
        }
        return { origin, dir: dirRaw.normalize() }
    }

    /** World-space translation delta so `worldPoint` lies on the optical axis (matches preview center ray). */
    #translationDeltaSnapWorldPointToCentralRay(worldPoint: Vec3f): Vec3f {
        const { origin: O, dir } = this.#worldCentralRay()
        const toP = worldPoint.subtract(O)
        const tLine = toP.dot(dir)
        const Q = O.add(dir.scale(tLine))
        return worldPoint.subtract(Q)
    }

    /**
     * Pan so `worldPoint` (raymarch hit) lies on the central view ray, matching preview.wgsl.
     * If we already have a focus point, preserve Euclidean distance from ray origin O to the hit
     * so it equals the previous |O − lastFocus|; otherwise only snap the hit onto the ray.
     */
    recenterOnPoint(worldPoint: Vec3f): void {
        const { origin: O, dir } = this.#worldCentralRay()

        let delta: Vec3f
        const prevFocus = this.#lastFocusWorld
        if (prevFocus) {
            const dKeep = O.subtract(prevFocus).length()
            if (dKeep < 1e-8) {
                const toP = worldPoint.subtract(O)
                const tLine = toP.dot(dir)
                const Q = O.add(dir.scale(tLine))
                delta = worldPoint.subtract(Q)
            } else {
                const along = worldPoint.subtract(O).dot(dir)
                const sign = along >= 0 ? 1 : -1
                const tAlong = sign * dKeep
                const O_target = worldPoint.subtract(dir.scale(tAlong))
                delta = O_target.subtract(O)
            }
        } else {
            delta = this.#translationDeltaSnapWorldPointToCentralRay(worldPoint)
        }

        const targetTrans = vec3(
            this.#cameraTranslation.x + delta.x,
            this.#cameraTranslation.y + delta.y,
            this.#cameraTranslation.z + delta.z,
        )
        const hit = worldPoint.clone()
        this.#animateCameraTranslation(targetTrans, () => {
            this.#lastFocusWorld = hit
        })
    }

    #animateCameraTranslation(target: Vec3f, onComplete?: () => void): void {
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
            else {
                this.#saveCameraState()
                onComplete?.()
            }
        }
        requestAnimationFrame(step)
    }

    #quaternionToMatrix(q: Quaternion): Mat4x4f {
        // Convert quaternion to 4x4 rotation matrix
        const matrix4 = q.toMatrix4(false) // false = flat array, not 2D
        return new Mat4x4f(new Float32Array(matrix4))
    }

    #updateTransforms(emit = true) {
        this.cameraPosition = this.#computeCameraPosition()
        let view = lookAt(this.cameraPosition, this.#pivot, vec3(0, 1, 0))
        const rotationMatrix = this.#quaternionToMatrix(this.#rotation)
        view = rotationMatrix.multiply(view)
        view = Mat4x4f.translation(this.#cameraTranslation).multiply(view)
        this.viewTransform = view
        if (emit) {
            this.change$.next(this.state)
        }
    }

    /**
     * Orbit compensation: adjust #cameraTranslation so the scene-space pivot stays fixed on screen
     * when rotation changes. The visible camera transform is effectively T(translation) * R, so
     * keep the pivot's old camera-space vector and solve for the translation needed after R changes.
     */
    #applyOrbitCompensation(oldQ: Quaternion, newQ: Quaternion): void {
        const oldMat = this.#quaternionToMatrix(oldQ)
        const newMat = this.#quaternionToMatrix(newQ)
        const pivotFromTranslation = this.#pivot.subtract(this.#cameraTranslation)
        const pivotCamOld = oldMat.inverse().transformVector(pivotFromTranslation)
        const pivotWorldOld = oldMat.transformVector(pivotCamOld)
        const pivotWorldNew = newMat.transformVector(pivotCamOld)
        this.#cameraTranslation.x += pivotWorldOld.x - pivotWorldNew.x
        this.#cameraTranslation.y += pivotWorldOld.y - pivotWorldNew.y
        this.#cameraTranslation.z += pivotWorldOld.z - pivotWorldNew.z
    }

    /** Push current camera state to SettingsManager (persisted via rxjs debounce). */
    #saveCameraState(): void {
        const q = this.#rotation.toVector()
        const cam: CameraSettings = {
            position: [this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z],
            translation: [this.#cameraTranslation.x, this.#cameraTranslation.y, this.#cameraTranslation.z],
            dollyDistance: this.#dollyDistance,
            rotation: [q[0], q[1], q[2], q[3]],
            pivot: [this.#pivot.x, this.#pivot.y, this.#pivot.z],
        }
        this.#settings.setCamera(cam)
    }

    /** Load camera from current document settings. Called when scene is ready to avoid flicker. */
    loadCameraFromSettings(): void {
        this.#loadCameraState()
    }

    #loadCameraState(): void {
        const cam = this.#settings.getCamera()
        this.#lastFocusWorld = null
        const pv = cam.pivot
        this.#pivot = vec3(pv?.[0] ?? 0, pv?.[1] ?? 0, pv?.[2] ?? 0)
        this.cameraPosition = vec3(cam.position[0], cam.position[1], cam.position[2])
        this.#cameraTranslation = vec3(cam.translation[0], cam.translation[1], cam.translation[2])
        let dolly = cam.dollyDistance
        if (dolly === undefined || !Number.isFinite(dolly)) {
            const legacyZoom = cam.zoom
            dolly =
                legacyZoom !== undefined && Number.isFinite(legacyZoom)
                    ? dollyFromOrthoHalf(legacyZoom)
                    : DOLLY_REF
        }
        this.#dollyDistance = Math.min(DOLLY_MAX, Math.max(DOLLY_MIN, dolly))
        this.#zoomController.setDollyDistance(this.#dollyDistance, false)
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

    /** Set the trackball rotation method at runtime (e.g. from Settings). */
    setRotationMethod(m: TrackballRotationMethod): void {
        this.#trackball.rotationMethod = m
    }

    /**
     * Update the optical view centre (UV [0,1] x [0,1], default 0.5 x 0.5).
     * Called by the host whenever the editor overlay shifts the visible centre.
     * Must match preview.wgsl `camera.viewCenter` so zoom-to-cursor is accurate.
     */
    setViewCenter(x: number, y: number): void {
        this.#viewCenter = vec2(x, y)
    }

    /**
     * Zoom-to-cursor: shift #cameraTranslation so the world point under clientX/Y
     * stays fixed on screen after the orthographic half-height changed by `dOrtho`.
     *
     * Derivation: camera-space ray origin at cursor = (ndcX*h, ndcY*h, depth) with h = ortho half-height.
     * When h changes by dOrtho the offset shifts by (ndcX*dOrtho, ndcY*dOrtho).
     * To keep the cursor world-point fixed, translate the camera by the world-space
     * equivalent of that shift (using current view rotation columns; translation T
     * in T·lookAt does not affect columns 0-2 so viewTransform columns are valid).
     */
    #applyOrthoDeltaToCursor(dOrtho: number, clientX: number, clientY: number): void {
        const rect = this.#host.canvas.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return
        const vc = this.#viewCenter
        const aspect = rect.width / rect.height
        // Screen UV: sx in [0,1] left→right, sy in [0,1] top→bottom.
        const screenSx = (clientX - rect.left) / rect.width
        const screenSy = (clientY - rect.top) / rect.height
        // Match preview.wgsl uvAspect / computeRayOrigin (shader uv.y = 1 − screenSy).
        const ndcX = 2 * (screenSx - vc.x) * aspect
        const ndcY = 2 * (1 - screenSy - vc.y)
        // World-space compensation (d = -dOrtho: positive when zooming in / ortho half decreases).
        const d = -dOrtho
        const rotationMatrix = this.#quaternionToMatrix(this.#rotation)
        const right = rotationMatrix.transformVector(vec3(1, 0, 0))
        const up = rotationMatrix.transformVector(vec3(0, 1, 0))
        this.#cameraTranslation.x += d * (ndcX * right.x + ndcY * up.x)
        this.#cameraTranslation.y += d * (ndcX * right.y + ndcY * up.y)
        this.#cameraTranslation.z += d * (ndcX * right.z + ndcY * up.z)
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
