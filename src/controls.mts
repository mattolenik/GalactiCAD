import { clamp, clampAngle } from "./math.mjs"
import * as ls from "./storage/storage.mjs"
import { lookAt, Mat4x4f } from "./vecmat/matrix.mjs"
import { vec3, Vec3f } from "./vecmat/vector.mjs"

export class CameraInfo {
    sceneTransform = new Mat4x4f()
    position = new Vec3f()
    orthoScale: number = 40
}

export class Controls {
    camera = new CameraInfo()
    canvas: HTMLCanvasElement
    pivot: Vec3f

    private _sceneRotX: number = 0
    private _sceneRotY: number = 0

    get sceneRotX() {
        return this._sceneRotX
    }
    set sceneRotX(t: number) {
        this._sceneRotX = clampAngle(t)
    }

    get sceneRotY() {
        return this._sceneRotY
    }
    set sceneRotY(t: number) {
        this._sceneRotY = clampAngle(t)
    }

    private _radius: number = 1
    get radius() {
        return this._radius
    }
    set radius(r: number) {
        this._radius = clamp(r, 2, 150)
    }

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
    cursorDelta: Vec3f = new Vec3f()

    rotateSensitivity: number = 0.005
    panSensitivity: number = 0.1
    zoomSensitivity: number = 0.05

    cameraTranslation: Vec3f = new Vec3f()
    lastCameraUpdate: number = 0

    workerInterval: NodeJS.Timeout

    constructor(canvas: HTMLCanvasElement, pivot: Vec3f, radius: number, initialTheta: number = 0, initialPhi: number = Math.PI / 2) {
        this.canvas = canvas
        this.pivot = pivot
        this.radius = radius
        this.sceneRotY = initialTheta
        this.sceneRotX = initialPhi

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
        this.updateTransforms()
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
            // this.isDragging = false
            // this.dragMode = null
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
        this.camera.orthoScale = this.radius
        this.updateTransforms()
    }

    private computeCameraPosition(): Vec3f {
        return this.pivot.add(vec3(0, 0, 1))
    }

    private updateTransforms() {
        this.camera.position = this.computeCameraPosition()
        // Use a fixed up vector (world up) for constructing the view matrix.
        let view = lookAt(this.camera.position, this.pivot, vec3(0, 1, 0))
        view = Mat4x4f.rotationX(this.sceneRotX).multiply(view)
        view = Mat4x4f.rotationY(this.sceneRotY).multiply(view)
        view = Mat4x4f.translation(this.cameraTranslation).multiply(view)
        this.camera.sceneTransform = view
    }

    saveCameraState(): void {
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
        this.updateTransforms()
    }
}
