import { clamped } from "../math.mjs"
import { LocalStorage } from "../storage/storage.mjs"
import { lookAt, Mat4x4f } from "../vecmat/matrix.mjs"
import { vec2, Vec2f, vec3, Vec3f } from "../vecmat/vector.mjs"
import { PinchZoomController } from "./pinchzoom-controller.mjs"
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
    #ls: LocalStorage
    #pivot: Vec3f
    #host: CameraHost
    cameraPosition = new Vec3f()
    viewTransform = new Mat4x4f()

    #rotation: Quaternion = new Quaternion(1, 0, 0, 0) // identity quaternion

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
    #hasDragged: boolean = false
    #rotateSensitivity: number = 0.005
    #panSensitivity: number = 0.1
    #cameraTranslation: Vec3f = new Vec3f()
    #zoomController: PinchZoomController
    onChange?: (state: CameraState) => void
    onSelect?: (screenPos: Vec2f, shiftKey: boolean) => void

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
        // Initialize rotation from Euler angles (for backward compatibility)
        this.#rotation = Quaternion.fromEuler(initialPhi, initialTheta, 0, "YXZ")

        this.#initEvents()
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
        this.#updateTransforms(emit)
    }

    #initEvents() {
        this.#host.canvas.addEventListener("pointerdown", this.#onPointerDown.bind(this))
        this.#host.canvas.addEventListener("pointermove", this.#onPointerMove.bind(this))
        this.#host.canvas.addEventListener("pointerup", this.#onPointerUp.bind(this))
        this.#host.canvas.addEventListener("pointercancel", this.#onPointerUp.bind(this))
        this.#host.canvas.addEventListener("pointerleave", this.#onPointerUp.bind(this))
        this.#host.canvas.addEventListener("click", this.#onClick.bind(this))
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
            this.#rotation = Quaternion.fromEuler(-Math.PI, -Math.PI, 0, "YXZ")
        } else if (e.code === "Digit2") {
            this.#rotation = Quaternion.fromEuler(-Math.PI, 0, 0, "YXZ")
        } else if (e.code === "Digit3") {
            this.#rotation = Quaternion.fromEuler(0, Math.PI / 2, 0, "YXZ")
        } else if (e.code === "Digit4") {
            this.#rotation = Quaternion.fromEuler(0, -Math.PI / 2, 0, "YXZ")
        } else if (e.code === "Digit5") {
            this.#rotation = Quaternion.fromEuler(-Math.PI / 2, Math.PI, 0, "YXZ")
        } else if (e.code === "Digit6") {
            this.#rotation = Quaternion.fromEuler(Math.PI / 2, Math.PI, 0, "YXZ")
        } else if (e.code === "Backquote") {
            this.#rotation = Quaternion.fromEuler(-Math.PI / 8, (5 / 4) * Math.PI, 0, "YXZ")
            this.#cameraTranslation = new Vec3f()
        } else {
            return
        }
        e.preventDefault()
        this.#updateTransforms()
    }

    #onClick(e: MouseEvent) {
        // Only handle left clicks, and only if we didn't drag
        if (e.button === 0 && !this.#hasDragged) {
            this.onSelect?.(vec2(e.clientX, e.clientY), e.shiftKey)
        }
    }

    #onPointerDown(e: PointerEvent) {
        if (e.button === 0) {
            // Left click: start rotation drag
            this.#dragMode = "rotate"
            this.isDragging = true
            this.#hasDragged = false
            this.#last = vec2(e.clientX, e.clientY)
        } else if (e.button === 1) {
            this.#dragMode = "pan"
            this.isDragging = true
            this.#hasDragged = false
            this.#last = vec2(e.clientX, e.clientY)
        } else {
            return
        }
    }

    #onPointerMove(e: PointerEvent) {
        if (!this.isDragging) return
        if (this.#zoomController.isZooming) return

        const rect = this.#host.canvas.getBoundingClientRect()
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            return
        }
        const pvec = vec2(e.clientX, e.clientY)
        this.#cursorDelta.set(pvec.subtract(this.#last))

        // Mark that we've dragged if there's any movement
        if (this.#cursorDelta.length() > 2) {
            this.#hasDragged = true
        }

        this.#last.set(pvec)

        if (this.#dragMode === "rotate") {
            // Build the current rotation matrix applied to lookAt (without translation)
            // to extract the camera's current orientation axes
            const baseView = lookAt(this.cameraPosition, this.#pivot, vec3(0, 1, 0))
            const rotationMatrix = this.#quaternionToMatrix(this.#rotation)
            const rotatedView = rotationMatrix.multiply(baseView)

            // Extract camera orientation vectors from the rotated view matrix
            // Column 0 (indices 0,1,2): camera's right vector in world space
            // Column 1 (indices 4,5,6): camera's up vector in world space
            const viewData = rotatedView.data
            const cameraRight = vec3(viewData[0], viewData[1], viewData[2]).normalize()
            const cameraUp = vec3(viewData[4], viewData[5], viewData[6]).normalize()

            // Arcball rotation: rotate object as if held in your hand (trackball style)
            // Key insight: rotations should be applied in the object's local space
            // When you drag right: rotate around the camera's up axis (screen vertical)
            // When you drag down: rotate around the camera's right axis (screen horizontal)
            //
            // For trackball feel: dragging right rotates the object right (clockwise around vertical)
            // The rotation axis is in world space but aligned with screen orientation
            const horizontalAngle = this.#cursorDelta.x * this.#rotateSensitivity
            const horizontalRotation = Quaternion.fromAxisAngle([cameraUp.x, cameraUp.y, cameraUp.z], horizontalAngle)

            const verticalAngle = this.#cursorDelta.y * this.#rotateSensitivity
            const verticalRotation = Quaternion.fromAxisAngle([cameraRight.x, cameraRight.y, cameraRight.z], verticalAngle)

            // Apply rotations: for trackball, we apply them in object-local order
            // This means: currentRotation * horizontalRotation * verticalRotation
            // The rotations accumulate in the object's local coordinate system
            this.#rotation = this.#rotation.mul(horizontalRotation).mul(verticalRotation).normalize()
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

        this.#updateTransforms()
    }

    #onPointerUp(e: PointerEvent) {
        // Reset drag state (but keep #hasDragged until next pointerdown so click handler can check it)
        if (e.button === 0 || e.button === 1 || this.isDragging) {
            this.isDragging = false
            this.#dragMode = null
            this.#saveCameraState(true)
        }
    }

    #computeCameraPosition(): Vec3f {
        return this.#pivot.add(vec3(0, 0, 1))
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
        // Save quaternion as string (quaternion library supports string serialization)
        const q = this.#rotation.toVector()
        this.#ls.setItem("camera.rotation", `${q[0]},${q[1]},${q[2]},${q[3]}`)
    }

    #loadCameraState(): void {
        this.cameraPosition = this.#ls.getVec3f("camera.position")
        this.#cameraTranslation = this.#ls.getVec3f("camera.translation")
        this.zoom = this.#ls.getFloat("camera.zoom") ?? 20
        this.#zoomController.setZoom(this.zoom, false)

        // Try to load quaternion, fall back to Euler angles for backward compatibility
        const rotationStr = this.#ls.getItem("camera.rotation")
        if (rotationStr) {
            const [w, x, y, z] = rotationStr.split(",").map(Number)
            this.#rotation = new Quaternion(w, x, y, z).normalize()
        } else {
            // Backward compatibility: load old Euler angles and convert to quaternion
            const sceneRotX = this.#ls.getFloat("camera.sceneRotX") ?? Math.PI / 2
            const sceneRotY = this.#ls.getFloat("camera.sceneRotY") ?? Math.PI / 2
            this.#rotation = Quaternion.fromEuler(sceneRotX, sceneRotY, 0, "YXZ")
        }
        this.#updateTransforms()
    }
}
