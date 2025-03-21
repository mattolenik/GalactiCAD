import * as ls from "./storage/storage.mjs"
import { lookAt, Mat4x4f } from "./vecmat/matrix.mjs"
import { vec3, Vec3f } from "./vecmat/vector.mjs"

export class Controls {
    canvas: HTMLCanvasElement
    pivot: Vec3f
    radius: number
    sceneRotY: number
    sceneRotX: number

    _isDragging = false
    get isDragging() {
        return this._isDragging
    }
    set isDragging(val: boolean) {
        this._isDragging = val
        this.canvas.style.cursor = val ? "grabbing" : "auto"
    }

    dragMode: "rotate" | "pan" | null = null
    lastX: number = 0
    lastY: number = 0
    cursorDelta: Vec3f

    rotateSensitivity: number = 0.005
    panSensitivity: number = 0.1
    zoomSensitivity: number = 0.05
    orthoZoom: number = 40

    minRadius: number = 10
    maxRadius: number = 100

    sceneTransform: Mat4x4f
    cameraPosition: Vec3f
    cameraTranslation: Vec3f
    lastCameraUpdate: number = 0

    workerInterval: NodeJS.Timeout

    constructor(canvas: HTMLCanvasElement, pivot: Vec3f, radius: number, initialTheta: number = 0, initialPhi: number = Math.PI / 2) {
        this.canvas = canvas
        this.pivot = pivot
        this.radius = radius
        this.sceneRotY = initialTheta
        this.sceneRotX = initialPhi
        this.cursorDelta = Vec3f.zero

        this.sceneTransform = new Mat4x4f(new Float32Array(16))

        this.cameraPosition = Vec3f.zero
        this.cameraTranslation = Vec3f.zero

        this.initEvents()
        this.loadCameraState()
        this.updateTransforms()
        this.workerInterval = setInterval(() => this.saveCameraState(), 500)
    }

    private initEvents() {
        this.canvas.addEventListener("pointerdown", this.onPointerDown.bind(this))
        this.canvas.addEventListener("pointermove", this.onPointerMove.bind(this))
        this.canvas.addEventListener("pointerup", this.onPointerUp.bind(this))
        this.canvas.addEventListener("pointercancel", this.onPointerUp.bind(this))
        this.canvas.addEventListener("pointerleave", this.onPointerLeave.bind(this))
        this.canvas.addEventListener("wheel", this.onWheel.bind(this))
        this.canvas.addEventListener("contextmenu", e => e.preventDefault())
        this.canvas.addEventListener("keypress", this.onKeyPress.bind(this))
        document.addEventListener("keydown", this.onKeyPress.bind(this), false)
    }

    private onKeyPress(e: KeyboardEvent) {
        console.log(e)
        if (e.key >= "1" && e.key <= "6") {
            e.preventDefault()

            if (e.key === "1") {
                this.sceneRotX = -1 * Math.PI
                this.sceneRotY = -1 * Math.PI
            }
            if (e.key === "2") {
                this.sceneRotX = -1 * Math.PI
                this.sceneRotY = 0
            }
            if (e.key === "3") {
                this.sceneRotX = 0
                this.sceneRotY = (1 / 2) * Math.PI
            }
            if (e.key === "4") {
                this.sceneRotX = 0
                this.sceneRotY = (-1 / 2) * Math.PI
            }
            if (e.key === "5") {
                this.sceneRotX = (-1 / 2) * Math.PI
                this.sceneRotY = 1 * Math.PI
            }
            if (e.key === "6") {
                this.sceneRotX = (1 / 2) * Math.PI
                this.sceneRotY = 1 * Math.PI
            }
            this.updateTransforms()
        }
    }

    private onPointerDown(e: PointerEvent) {
        e.preventDefault()
        if (e.button === 0) {
            this.dragMode = "rotate"
        } else if (e.button === 2) {
            this.dragMode = "pan"
        } else {
            return
        }
        this.isDragging = true
        this.lastX = e.clientX
        this.lastY = e.clientY
    }

    private onPointerMove(e: PointerEvent) {
        if (!this.isDragging) return

        const rect = this.canvas.getBoundingClientRect()
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            this.isDragging = false
            this.dragMode = null
            return
        }

        this.cursorDelta.x = e.clientX - this.lastX
        this.cursorDelta.y = e.clientY - this.lastY
        this.lastX = e.clientX
        this.lastY = e.clientY

        if (this.dragMode === "rotate") {
            this.sceneRotY -= this.cursorDelta.x * this.rotateSensitivity
            this.sceneRotX -= this.cursorDelta.y * this.rotateSensitivity
        } else if (this.dragMode === "pan") {
            this.cameraTranslation.x -= this.cursorDelta.x * this.panSensitivity
            this.cameraTranslation.y += this.cursorDelta.y * this.panSensitivity
        }

        this.updateTransforms()
    }

    private onPointerUp(e: PointerEvent) {
        this.isDragging = false
        this.dragMode = null
    }

    private onPointerLeave(e: PointerEvent) {
        this.isDragging = false
        this.dragMode = null
    }

    private onWheel(e: WheelEvent) {
        e.preventDefault()
        this.radius += e.deltaY * this.zoomSensitivity
        this.orthoZoom += e.deltaY * this.zoomSensitivity
        this.radius = clamp(this.radius, this.minRadius, this.maxRadius)
        this.updateTransforms()
    }

    private computeCameraPosition(): Vec3f {
        return this.pivot.add(vec3(0, 0, 1))
    }

    // Updates the scene transform matrices.
    // The view matrix is computed as if the camera were orbiting the pivot.
    // The scene transform is the inverse of that view matrix.
    private updateTransforms() {
        this.cameraPosition = this.computeCameraPosition()
        // Use a fixed up vector (world up) for constructing the view matrix.
        const up = new Vec3f([0, 1, 0])
        let view = lookAt(this.cameraPosition, this.pivot, up)
        view = Mat4x4f.rotationX(this.sceneRotX).multiply(view)
        view = Mat4x4f.rotationY(this.sceneRotY).multiply(view)
        view = Mat4x4f.translation(this.cameraTranslation).multiply(view)
        this.sceneTransform = view
    }

    // Call this method to save the current camera state.
    saveCameraState(): void {
        ls.setVec3f("camera.position", this.cameraPosition)
        ls.setVec3f("camera.translation", this.cameraTranslation)
        ls.setVec3f("camera.pivot", this.pivot)
        ls.setFloat("camera.orthoZoom", this.orthoZoom)
        ls.setFloat("camera.sceneRotX", this.sceneRotX)
        ls.setFloat("camera.sceneRotY", this.sceneRotY)
    }

    // Call this method on initialization to restore the camera state.
    loadCameraState(): void {
        this.cameraPosition = ls.getVec3f("camera.position") ?? Vec3f.zero
        this.cameraTranslation = ls.getVec3f("camera.translation") ?? Vec3f.zero
        this.pivot = ls.getVec3f("camera.pivot") ?? Vec3f.zero
        this.orthoZoom = ls.getFloat("camera.orthoZoom") ?? 10
        this.sceneRotX = ls.getFloat("camera.sceneRotX") ?? 10
        this.sceneRotY = ls.getFloat("camera.sceneRotY") ?? 10
        this.updateTransforms()
    }
}
function clamp(x: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, x))
}
