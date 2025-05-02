import { clamped, clampedAngle } from "./math.mjs"
import { PreviewWindow } from "./preview-window.mjs"
import { locallyStored, LocalStorage } from "./storage/storage.mjs"
import { lookAt, Mat4x4f } from "./vecmat/matrix.mjs"
import { vec2, Vec2f, vec3, Vec3f } from "./vecmat/vector.mjs"

export class Controls {
    #ls: LocalStorage
    #preview: PreviewWindow
    pivot: Vec3f
    sceneTransform = new Mat4x4f()
    cameraPosition = new Vec3f()
    orthoScale: number = 40

    @clampedAngle
    accessor sceneRotX: number = 0

    @clampedAngle
    //@locallyStored(ls, "camera.sceneRotY", 0)
    accessor sceneRotY: number = 0

    @clamped(2, 150)
    accessor radius: number = 1

    #isDragging = false
    get isDragging() {
        return this.#isDragging
    }
    set isDragging(val: boolean) {
        this.#isDragging = val
        this.#preview.canvas.style.cursor = val ? "grabbing" : "auto"
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

    constructor(preview: PreviewWindow, pivot: Vec3f, radius: number, initialTheta: number = 0, initialPhi: number = Math.PI / 2) {
        this.#ls = LocalStorage.instance
        this.#preview = preview
        this.pivot = pivot
        this.radius = radius
        this.sceneRotY = initialTheta
        this.sceneRotX = initialPhi

        this.#initEvents()
        this.loadCameraState()
        this.#updateTransforms()
    }

    #initEvents() {
        this.#preview.canvas.addEventListener("pointerdown", this.#onPointerDown.bind(this))
        this.#preview.canvas.addEventListener("pointermove", this.#onPointerMove.bind(this))
        this.#preview.canvas.addEventListener("pointerup", this.#onPointerUp.bind(this))
        this.#preview.canvas.addEventListener("pointercancel", this.#onPointerUp.bind(this))
        this.#preview.canvas.addEventListener("pointerleave", this.#onPointerUp.bind(this))
        this.#preview.canvas.addEventListener("wheel", this.#onWheel.bind(this))
        this.#preview.canvas.addEventListener("contextmenu", e => e.preventDefault())
        this.#preview.canvas.addEventListener("keypress", this.#onKeyPress.bind(this))
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
        if (this.#lastFocused!.id !== this.#preview.id) return
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

        const rect = this.#preview.canvas.getBoundingClientRect()
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
        this.orthoScale = this.radius
        this.#updateTransforms()
    }

    #computeCameraPosition(): Vec3f {
        return this.pivot.add(vec3(0, 0, 1))
    }

    #updateTransforms() {
        this.cameraPosition = this.#computeCameraPosition()
        // Use a fixed up vector (world up) for constructing the view matrix.
        let view = lookAt(this.cameraPosition, this.pivot, vec3(0, 1, 0))
        view = Mat4x4f.rotationX(this.sceneRotX).multiply(view)
        view = Mat4x4f.rotationY(this.sceneRotY).multiply(view)
        view = Mat4x4f.translation(this.cameraTranslation).multiply(view)
        this.sceneTransform = view
        this.saveCameraState()
    }

    saveCameraState(always = false): void {
        if (!always && Date.now() - this.#lastCameraSave < 100) {
            return
        }
        this.#lastCameraSave = Date.now()
        this.#ls.setVec3f("camera.position", this.cameraPosition)
        this.#ls.setVec3f("camera.translation", this.cameraTranslation)
        this.#ls.setVec3f("camera.pivot", this.pivot)
        this.#ls.setFloat("camera.orthoScale", this.orthoScale)
        this.#ls.setFloat("camera.sceneRotX", this.sceneRotX)
        this.#ls.setFloat("camera.sceneRotY", this.sceneRotY)
    }

    loadCameraState(): void {
        this.cameraPosition = this.#ls.getVec3f("camera.position")
        this.cameraTranslation = this.#ls.getVec3f("camera.translation")
        this.pivot = this.#ls.getVec3f("camera.pivot")
        this.orthoScale = this.#ls.getFloat("camera.orthoScale") ?? 20
        this.sceneRotX = this.#ls.getFloat("camera.sceneRotX") ?? (1 / 2) * Math.PI
        this.sceneRotY = this.#ls.getFloat("camera.sceneRotY") ?? (1 / 2) * Math.PI
        this.#updateTransforms()
    }
}
