import { clamped, clampedAngle } from "../math.mjs"
import { LocalStorage } from "../storage/storage.mjs"
import { lookAt, Mat4x4f } from "../vecmat/matrix.mjs"
import { vec2, Vec2f, vec3, Vec3f } from "../vecmat/vector.mjs"
import { PinchZoomController } from "./pinchzoom-controller.mjs"

export interface CameraHost extends HTMLElement {
    canvas: HTMLCanvasElement
}

export interface CameraState {
    sceneRotX: number
    sceneRotY: number
    zoom: number
    translation: Vec3f
}

export class CameraController {
    #ls: LocalStorage
    #pivot: Vec3f
    #host: CameraHost
    cameraPosition = new Vec3f()
    viewTransform = new Mat4x4f()

    @clampedAngle
    accessor #sceneRotX: number = 0

    @clampedAngle
    accessor #sceneRotY: number = 0

    @clamped(2, 150)
    accessor zoom: number = 40

    #isDragging = false
    get isDragging() {
        return this.#isDragging
    }
    set isDragging(val: boolean) {
        this.#isDragging = val
        this.#host.canvas.style.cursor = val ? "grabbing" : "auto"
    }

    #last = new Vec2f()
    #cursorDelta = new Vec2f()
    #lastCameraSave = 0
    #lastFocused: Element | null = null

    #dragMode: "rotate" | "pan" | null = null
    #rotateSensitivity: number = 0.005
    #panSensitivity: number = 0.1
    #cameraTranslation: Vec3f = new Vec3f()
    #zoomController: PinchZoomController
    onChange?: (state: CameraState) => void
    onSelect?: (screenPos: Vec2f) => void

    constructor(host: CameraHost, pivot: Vec3f, radius: number, initialTheta: number = 0, initialPhi: number = Math.PI / 2) {
        this.#ls = LocalStorage.instance
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
            this.onChange?.(this.state)
        }
        this.#sceneRotY = initialTheta
        this.#sceneRotX = initialPhi

        this.#initEvents()
        this.#loadCameraState()
        this.#updateTransforms()
    }

    get state(): CameraState {
        return {
            sceneRotX: this.#sceneRotX,
            sceneRotY: this.#sceneRotY,
            zoom: this.zoom,
            translation: this.#cameraTranslation.clone(),
        }
    }

    applyState(state: CameraState, opts: { emit?: boolean } = {}): void {
        const emit = opts.emit ?? true
        this.#sceneRotX = state.sceneRotX
        this.#sceneRotY = state.sceneRotY
        this.zoom = state.zoom
        this.#zoomController.setZoom(this.zoom, false)
        this.#cameraTranslation = state.translation.clone()
        this.#updateTransforms(emit)
    }

    #initEvents() {
        this.#host.canvas.addEventListener("pointerdown", this.#onPointerDown.bind(this))
        this.#host.canvas.addEventListener("pointermove", this.#onPointerMove.bind(this))
        this.#host.canvas.addEventListener("pointerup", this.#onPointerUp.bind(this))
        this.#host.canvas.addEventListener("pointercancel", this.#onPointerUp.bind(this))
        this.#host.canvas.addEventListener("pointerleave", this.#onPointerUp.bind(this))
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
            this.#sceneRotX = -1 * Math.PI
            this.#sceneRotY = -1 * Math.PI
        } else if (e.code === "Digit2") {
            this.#sceneRotX = -1 * Math.PI
            this.#sceneRotY = 0
        } else if (e.code === "Digit3") {
            this.#sceneRotX = 0
            this.#sceneRotY = (1 / 2) * Math.PI
        } else if (e.code === "Digit4") {
            this.#sceneRotX = 0
            this.#sceneRotY = (-1 / 2) * Math.PI
        } else if (e.code === "Digit5") {
            this.#sceneRotX = (-1 / 2) * Math.PI
            this.#sceneRotY = 1 * Math.PI
        } else if (e.code === "Digit6") {
            this.#sceneRotX = (1 / 2) * Math.PI
            this.#sceneRotY = 1 * Math.PI
        } else if (e.code === "Backquote") {
            this.#sceneRotX = -Math.PI / 8
            this.#sceneRotY = Math.PI * (5 / 4)
            this.#cameraTranslation = new Vec3f()
        } else {
            return
        }
        e.preventDefault()
        this.#updateTransforms()
    }

    #onPointerDown(e: PointerEvent) {
        if (e.button === 0) {
            // Left click for selection
            this.onSelect?.(vec2(e.clientX, e.clientY))
            return
        } else if (e.button === 1) {
            this.#dragMode = "pan"
        } else if (e.button === 2) {
            // Right click for rotate
            this.#dragMode = "rotate"
        } else {
            return
        }
        this.isDragging = true
        this.#last = vec2(e.clientX, e.clientY)
    }

    #onPointerMove(e: PointerEvent) {
        if (!this.isDragging) return
        if (this.#zoomController.isZooming) return

        const rect = this.#host.canvas.getBoundingClientRect()
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            // this.isDragging = false
            // this.dragMode = null
            return
        }
        const pvec = vec2(e.clientX, e.clientY)
        this.#cursorDelta.set(pvec.subtract(this.#last))
        this.#last.set(pvec)

        if (this.#dragMode === "rotate") {
            this.#sceneRotY -= this.#cursorDelta.x * this.#rotateSensitivity
            this.#sceneRotX -= this.#cursorDelta.y * this.#rotateSensitivity
        } else if (this.#dragMode === "pan") {
            // Compute camera-relative pan directions based on current rotation
            const rotY = Mat4x4f.rotationY(this.#sceneRotY)
            const rotX = Mat4x4f.rotationX(this.#sceneRotX)
            const combinedRotation = rotY.multiply(rotX)

            // Camera right vector (transformed X axis)
            const cameraRight = combinedRotation.transformVector(vec3(1, 0, 0))
            // Camera up vector (transformed Y axis)
            const cameraUp = combinedRotation.transformVector(vec3(0, 1, 0))

            // Apply pan in camera-relative directions
            this.#cameraTranslation.x -= (this.#cursorDelta.x * cameraRight.x - this.#cursorDelta.y * cameraUp.x) * this.#panSensitivity
            this.#cameraTranslation.y -= (this.#cursorDelta.x * cameraRight.y - this.#cursorDelta.y * cameraUp.y) * this.#panSensitivity
            this.#cameraTranslation.z -= (this.#cursorDelta.x * cameraRight.z - this.#cursorDelta.y * cameraUp.z) * this.#panSensitivity
        }

        this.#updateTransforms()
    }

    #onPointerUp(e: PointerEvent) {
        this.isDragging = false
        this.#dragMode = null
        this.#saveCameraState(true)
    }

    // #onWheel(e: WheelEvent) {
    //     e.preventDefault()
    //     this.#radius += e.deltaY * this.#zoomSensitivity
    // }
    // this.zoom = this.#radius
    // this.#updateTransforms()

    #computeCameraPosition(): Vec3f {
        return this.#pivot.add(vec3(0, 0, 1))
    }

    #updateTransforms(emit = true) {
        this.cameraPosition = this.#computeCameraPosition()
        // Use a fixed up vector (world up) for constructing the view matrix
        let view = lookAt(this.cameraPosition, this.#pivot, vec3(0, 1, 0))
        view = Mat4x4f.rotationX(this.#sceneRotX).multiply(view)
        view = Mat4x4f.rotationY(this.#sceneRotY).multiply(view)
        view = Mat4x4f.translation(this.#cameraTranslation).multiply(view)
        this.viewTransform = view
        this.#saveCameraState()
        if (emit) {
            this.onChange?.(this.state)
        }
    }

    #saveCameraState(always = false): void {
        if (!always && Date.now() - this.#lastCameraSave < 100) {
            return
        }
        this.#lastCameraSave = Date.now()
        this.#ls.setVec3f("camera.position", this.cameraPosition)
        this.#ls.setVec3f("camera.translation", this.#cameraTranslation)
        this.#ls.setFloat("camera.zoom", this.zoom)
        this.#ls.setFloat("camera.sceneRotX", this.#sceneRotX)
        this.#ls.setFloat("camera.sceneRotY", this.#sceneRotY)
    }

    #loadCameraState(): void {
        this.cameraPosition = this.#ls.getVec3f("camera.position")
        this.#cameraTranslation = this.#ls.getVec3f("camera.translation")
        this.zoom = this.#ls.getFloat("camera.zoom") ?? 20
        this.#zoomController.setZoom(this.zoom, false)
        this.#sceneRotX = this.#ls.getFloat("camera.sceneRotX") ?? (1 / 2) * Math.PI
        this.#sceneRotY = this.#ls.getFloat("camera.sceneRotY") ?? (1 / 2) * Math.PI
        this.#updateTransforms()
    }
}
