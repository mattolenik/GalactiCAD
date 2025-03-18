import { Vec3f } from "./vecmat/vector.mjs"
import { Mat4x4f } from "./vecmat/matrix.mjs"

export class OrbitControls {
    canvas: HTMLCanvasElement
    // Orbit parameters:
    pivot: Vec3f // The point to orbit around (camera target)
    radius: number
    theta: number // Horizontal angle in radians
    phi: number // Vertical angle in radians

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
    sceneTransform: Mat4x4f
    // invSceneTransform: the view matrix (inverse of sceneTransform)
    invSceneTransform: Mat4x4f

    // Stored camera position computed from orbit parameters.
    cameraPosition: Vec3f
    lastCameraUpdate: number = 0

    workerInterval: NodeJS.Timeout

    constructor(canvas: HTMLCanvasElement, pivot: Vec3f, radius: number, initialTheta: number = 0, initialPhi: number = Math.PI / 2) {
        this.canvas = canvas
        this.pivot = pivot
        this.radius = radius
        this.theta = initialTheta
        this.phi = initialPhi

        // Initialize matrices (assumed to be identity/dummy initially).
        this.sceneTransform = new Mat4x4f(new Float32Array(16))
        this.invSceneTransform = new Mat4x4f(new Float32Array(16))

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
            this.theta += deltaX * this.rotateSensitivity
            this.phi -= deltaY * this.rotateSensitivity
            // Full 360° orbit is allowed; no clamping here.
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

    // Computes the camera position based on the current orbit parameters.
    private computeCameraPosition(): Vec3f {
        // Standard spherical-to-Cartesian conversion:
        // x = radius * sin(phi) * sin(theta)
        // y = radius * cos(phi)
        // z = radius * sin(phi) * cos(theta)
        const sinPhi = Math.sin(this.phi)
        const cosPhi = Math.cos(this.phi)
        const sinTheta = Math.sin(this.theta)
        const cosTheta = Math.cos(this.theta)
        const x = this.radius * sinPhi * sinTheta
        const y = this.radius * cosPhi
        const z = this.radius * sinPhi * cosTheta
        return this.pivot.add(new Vec3f([x, y, z]))
    }

    // Updates the scene transform matrices.
    // The view matrix is computed as if the camera were orbiting the pivot.
    // The scene transform is the inverse of that view matrix.
    private updateTransforms() {
        const camPos = this.computeCameraPosition()
        // Use a fixed up vector (world up) for constructing the view matrix.
        const up = new Vec3f([0, 1, 0])
        const view = lookAt(camPos, this.pivot, up)
        // The scene transform is the inverse of the view matrix.
        this.sceneTransform = view.inverse()
        this.invSceneTransform = view
        // Store the computed camera position.
        this.cameraPosition = camPos
    }

    // Call this method to save the current camera state.
    saveCameraState(): void {
        localStorage.setItem("camera.position", this.cameraPosition.toStorage())
        localStorage.setItem("camera.pivot", this.pivot.toStorage())
        localStorage.setItem("camera.radius", this.radius.toString())
        localStorage.setItem("camera.theta", this.theta.toString())
        localStorage.setItem("camera.phi", this.phi.toString())
    }

    // Call this method on initialization to restore the camera state.
    loadCameraState(): void {
        this.cameraPosition = Vec3f.fromStorage(localStorage.getItem("camera.position"))
        this.pivot = Vec3f.fromStorage(localStorage.getItem("camera.pivot"))
        this.radius = parseFloat(localStorage.getItem("camera.radius") || "10")
        this.theta = parseFloat(localStorage.getItem("camera.theta") || "10")
        this.phi = parseFloat(localStorage.getItem("camera.phi") || "10")
        this.updateTransforms()
    }
}

// Helper: Compute a LookAt matrix in column-major order.
// Returns a Mat4x4f representing the view matrix.
function lookAt(eye: Vec3f, center: Vec3f, up: Vec3f): Mat4x4f {
    const f = center.subtract(eye).normalize() // forward
    const s = f.cross(up).normalize() // side/right
    const u = s.cross(f) // recalculated up

    const m = new Float32Array(16)
    // Column 0
    m[0] = s.x
    m[1] = u.x
    m[2] = -f.x
    m[3] = 0
    // Column 1
    m[4] = s.y
    m[5] = u.y
    m[6] = -f.y
    m[7] = 0
    // Column 2
    m[8] = s.z
    m[9] = u.z
    m[10] = -f.z
    m[11] = 0
    // Column 3
    m[12] = -s.dot(eye)
    m[13] = -u.dot(eye)
    m[14] = f.dot(eye)
    m[15] = 1

    return new Mat4x4f(m)
}

function clamp(x: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, x))
}
