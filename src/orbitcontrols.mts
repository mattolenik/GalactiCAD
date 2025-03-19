import { vec3, Vec3f } from "./vecmat/vector.mjs"
import { lookAt, Mat4x4f } from "./vecmat/matrix.mjs"
import * as ls from "./storage/storage.mjs"

export class OrbitControls {
    canvas: HTMLCanvasElement
    // Orbit parameters:
    pivot: Vec3f // The point to orbit around (camera target)
    radius: number
    sceneRotY: number // Horizontal angle in radians
    sceneRotX: number // Vertical angle in radians

    // Interaction state:
    isDragging: boolean = false
    dragMode: "rotate" | "pan" | null = null
    lastX: number = 0
    lastY: number = 0

    // Sensitivities:
    rotateSensitivity: number = 0.005
    panSensitivity: number = 1 // 1:1 mapping with screen space (tweak as needed)
    zoomSensitivity: number = 0.05
    orthoScale: number = 40

    // Limits:
    minRadius: number = 10
    maxRadius: number = 100

    // Computed matrices:
    // sceneTransform: the transform to apply to the scene so it appears to orbit around a fixed camera.
    // invSceneTransform: the view matrix (inverse of sceneTransform)
    sceneTransform: Mat4x4f

    // Stored camera position computed from orbit parameters.
    cameraPosition: Vec3f
    lastCameraUpdate: number = 0

    workerInterval: NodeJS.Timeout

    constructor(canvas: HTMLCanvasElement, pivot: Vec3f, radius: number, initialTheta: number = 0, initialPhi: number = Math.PI / 2) {
        this.canvas = canvas
        this.pivot = pivot
        this.radius = radius
        this.sceneRotY = initialTheta
        this.sceneRotX = initialPhi

        this.sceneTransform = new Mat4x4f(new Float32Array(16))

        this.cameraPosition = new Vec3f([0, 0, 0])

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
        // Prevent context menu on right click.
        this.canvas.addEventListener("contextmenu", e => e.preventDefault())
    }

    private onPointerDown(e: PointerEvent) {
        e.preventDefault()
        if (e.button === 0) {
            this.dragMode = "rotate"
        } else if (e.button === 2) {
            this.dragMode = "pan"
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

        const deltaX = e.clientX - this.lastX
        const deltaY = e.clientY - this.lastY
        this.lastX = e.clientX
        this.lastY = e.clientY

        if (this.dragMode === "rotate") {
            this.sceneRotY += deltaX * this.rotateSensitivity
            this.sceneRotX -= deltaY * this.rotateSensitivity
        } else if (this.dragMode === "pan") {
            // Compute what the camera position would be from the current spherical coordinates.
            const camPos = this.computeCameraPosition()
            // Compute the forward vector (from camera position to pivot).
            const forward = this.pivot.subtract(camPos).normalize()
            // Use a fixed world up vector.
            const worldUp = new Vec3f([0, 1, 0])
            // Right vector: cross(worldUp, forward).
            const right = worldUp.cross(forward).normalize()
            // True up vector: cross(forward, right).
            const up = forward.cross(right).normalize()
            // Compute pan offset based on mouse delta.
            const panOffset = right.scale(-deltaX * this.panSensitivity).add(up.scale(deltaY * this.panSensitivity))
            this.pivot = this.pivot.add(panOffset)
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
        this.orthoScale += e.deltaY * this.zoomSensitivity
        this.radius = clamp(this.radius, this.minRadius, this.maxRadius)
        this.updateTransforms()
    }

    private computeCameraPosition(): Vec3f {
        return this.pivot.add(vec3(0, 0, -10))
    }

    // Updates the scene transform matrices.
    // The view matrix is computed as if the camera were orbiting the pivot.
    // The scene transform is the inverse of that view matrix.
    private updateTransforms() {
        this.cameraPosition = this.pivot.add(vec3(0, 0, 10))
        // Use a fixed up vector (world up) for constructing the view matrix.
        const up = new Vec3f([0, 1, 0])
        let view = lookAt(this.cameraPosition, this.pivot, up)
        view = Mat4x4f.rotationX(this.sceneRotX).multiply(view)
        view = Mat4x4f.rotationY(this.sceneRotY).multiply(view)
        this.sceneTransform = view
    }

    // Call this method to save the current camera state.
    saveCameraState(): void {
        ls.setVec3f("camera.position", this.cameraPosition)
        ls.setVec3f("camera.pivot", this.pivot)
        ls.setFloat("camera.radius", this.radius)
        ls.setFloat("camera.sceneRotX", this.sceneRotX)
        ls.setFloat("camera.sceneRotY", this.sceneRotY)
    }

    // Call this method on initialization to restore the camera state.
    loadCameraState(): void {
        this.cameraPosition = ls.getVec3f("camera.position") ?? Vec3f.zero
        this.pivot = ls.getVec3f("camera.pivot") ?? Vec3f.zero
        this.radius = ls.getFloat("camera.radius") || 10
        this.sceneRotY = ls.getFloat("camera.theta") || 10
        this.sceneRotX = ls.getFloat("camera.phi") || 10
        this.updateTransforms()
    }
}
function clamp(x: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, x))
}
