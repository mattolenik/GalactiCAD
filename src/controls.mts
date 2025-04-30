import { clamp, clampAngle } from "./math.mjs"
import * as ls from "./storage/storage.mjs"
import { lookAt, Mat4x4f } from "./vecmat/matrix.mjs"
import { vec2, Vec2f, vec3, Vec3f } from "./vecmat/vector.mjs"

export class CameraInfo {
    sceneTransform = new Mat4x4f()
    position = new Vec3f()
    orthoScale: number = 40
}

export class Controls {
    camera = new CameraInfo()
    canvas: HTMLCanvasElement
    pivot: Vec3f

    #sceneRotX: number = 0
    get sceneRotX() {
        return this.#sceneRotX
    }
    set sceneRotX(t: number) {
        this.#sceneRotX = clampAngle(t)
    }

    #sceneRotY: number = 0
    get sceneRotY() {
        return this.#sceneRotY
    }
    set sceneRotY(t: number) {
        this.#sceneRotY = clampAngle(t)
    }

    #radius: number = 1
    get radius() {
        return this.#radius
    }
    set radius(r: number) {
        this.#radius = clamp(r, 2, 150)
    }

    #isDragging = false
    get isDragging() {
        return this.#isDragging
    }
    set isDragging(val: boolean) {
        this.#isDragging = val
        this.canvas.style.cursor = val ? "grabbing" : "auto"
    }

    #last = new Vec2f()
    #cursorDelta = new Vec2f()
    #lastCameraSave = 0
    #lastFocused: Element | null = null

    dragMode: "rotate" | "pan" | null = null
    rotateSensitivity: number = 0.005
    panSensitivity: number = 0.1
    zoomSensitivity: number = 0.05
    cameraTranslation: Vec3f = new Vec3f()

    constructor(canvas: HTMLCanvasElement, pivot: Vec3f, radius: number, initialTheta: number = 0, initialPhi: number = Math.PI / 2) {
        this.canvas = canvas
        this.pivot = pivot
        this.radius = radius
        this.sceneRotY = initialTheta
        this.sceneRotX = initialPhi

        this.#initEvents()
        this.loadCameraState()
        this.#updateTransforms()
    }

    #initEvents() {
        this.canvas.addEventListener("pointerdown", this.#onPointerDown.bind(this))
        this.canvas.addEventListener("pointermove", this.#onPointerMove.bind(this))
        this.canvas.addEventListener("pointerup", this.#onPointerUp.bind(this))
        this.canvas.addEventListener("pointercancel", this.#onPointerUp.bind(this))
        this.canvas.addEventListener("pointerleave", this.#onPointerUp.bind(this))
        this.canvas.addEventListener("wheel", this.#onWheel.bind(this))
        this.canvas.addEventListener("contextmenu", e => e.preventDefault())
        this.canvas.addEventListener("keypress", this.#onKeyPress.bind(this))
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
        if (this.#lastFocused?.id !== this.canvas.id) return
        console.log(e)
        if (e.code === "Digit1") {
            this.sceneRotX = -1 * Math.PI
            this.sceneRotY = -1 * Math.PI
        }
        if (e.code === "Digit2") {
            this.sceneRotX = -1 * Math.PI
            this.sceneRotY = 0
        }
        if (e.code === "Digit3") {
            this.sceneRotX = 0
            this.sceneRotY = (1 / 2) * Math.PI
        }
        if (e.code === "Digit4") {
            this.sceneRotX = 0
            this.sceneRotY = (-1 / 2) * Math.PI
        }
        if (e.code === "Digit5") {
            this.sceneRotX = (-1 / 2) * Math.PI
            this.sceneRotY = 1 * Math.PI
        }
        if (e.code === "Digit6") {
            this.sceneRotX = (1 / 2) * Math.PI
            this.sceneRotY = 1 * Math.PI
        }
        if (e.code === "Backquote") {
            this.sceneRotX = -Math.PI / 8
            this.sceneRotY = Math.PI * (5 / 4)
            this.cameraTranslation = new Vec3f()
        }
        e.preventDefault()
        this.#updateTransforms()
    }

    #onPointerDown(e: PointerEvent) {
        e.preventDefault()
        if (e.button === 0) {
            this.dragMode = "rotate"
        } else if (e.button === 2) {
            this.dragMode = "pan"
        } else {
            return
        }
        this.isDragging = true
        this.#last = vec2(e.clientX, e.clientY)
    }

    #onPointerMove(e: PointerEvent) {
        if (!this.isDragging) return

        const rect = this.canvas.getBoundingClientRect()
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            // this.isDragging = false
            // this.dragMode = null
            return
        }
        const pvec = vec2(e.clientX, e.clientY)
        this.#cursorDelta.set(pvec.subtract(this.#last))
        this.#last.set(pvec)

        if (this.dragMode === "rotate") {
            this.sceneRotY -= this.#cursorDelta.x * this.rotateSensitivity
            this.sceneRotX -= this.#cursorDelta.y * this.rotateSensitivity
        } else if (this.dragMode === "pan") {
            this.cameraTranslation.x -= this.#cursorDelta.x * this.panSensitivity
            this.cameraTranslation.y += this.#cursorDelta.y * this.panSensitivity
        }

        this.#updateTransforms()
    }

    #onPointerUp(e: PointerEvent) {
        this.isDragging = false
        this.dragMode = null
        this.saveCameraState(true)
    }

    #onWheel(e: WheelEvent) {
        e.preventDefault()
        this.radius += e.deltaY * this.zoomSensitivity
        this.camera.orthoScale = this.radius
        this.#updateTransforms()
    }

    #computeCameraPosition(): Vec3f {
        return this.pivot.add(vec3(0, 0, 1))
    }

    #updateTransforms() {
        this.camera.position = this.#computeCameraPosition()
        // Use a fixed up vector (world up) for constructing the view matrix.
        let view = lookAt(this.camera.position, this.pivot, vec3(0, 1, 0))
        view = Mat4x4f.rotationX(this.sceneRotX).multiply(view)
        view = Mat4x4f.rotationY(this.sceneRotY).multiply(view)
        view = Mat4x4f.translation(this.cameraTranslation).multiply(view)
        this.camera.sceneTransform = view
        this.saveCameraState()
    }

    saveCameraState(always = false): void {
        if (!always && Date.now() - this.#lastCameraSave < 100) {
            return
        }
        this.#lastCameraSave = Date.now()
        ls.setVec3f("camera.position", this.camera.position)
        ls.setVec3f("camera.translation", this.cameraTranslation)
        ls.setVec3f("camera.pivot", this.pivot)
        ls.setFloat("camera.orthoScale", this.camera.orthoScale)
        ls.setFloat("camera.sceneRotX", this.sceneRotX)
        ls.setFloat("camera.sceneRotY", this.sceneRotY)
    }

    loadCameraState(): void {
        this.camera.position = ls.getVec3f("camera.position")
        this.cameraTranslation = ls.getVec3f("camera.translation")
        this.pivot = ls.getVec3f("camera.pivot")
        this.camera.orthoScale = ls.getFloat("camera.orthoScale") ?? 20
        this.sceneRotX = ls.getFloat("camera.sceneRotX") ?? (1 / 2) * Math.PI
        this.sceneRotY = ls.getFloat("camera.sceneRotY") ?? (1 / 2) * Math.PI
        this.#updateTransforms()
    }
}
