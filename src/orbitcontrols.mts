import { vec2, Vec2, Vec3 } from "./vecmat/vector.mjs"

export class OrbitControls {
    canvas: HTMLCanvasElement
    radius: number
    theta: number // azimuth angle
    phi: number // elevation angle
    isDragging: boolean = false
    dragMode: "rotate" | "pan" | null = null
    lastX: number = 0
    lastY: number = 0
    sensitivity: number = 0.005
    zoomSensitivity: number = 0.05
    panSensitivity: number = 0.05
    minRadius: number = 1
    maxRadius: number = 100
    ortho: Vec2 = vec2(1, 12)
    minOrthoScale = 2
    maxOrthoScale = 50
    cameraPosition: Vec3
    cameraTarget: Vec3

    constructor(canvas: HTMLCanvasElement, cameraTarget: Vec3, radius: number, initialTheta: number = 0, initialPhi: number = 0) {
        this.canvas = canvas
        this.cameraTarget = cameraTarget
        this.radius = radius
        this.theta = initialTheta
        this.phi = initialPhi
        this.cameraPosition = new Vec3([0, 0, 0])
        this.initEvents()
    }

    private initEvents() {
        this.canvas.addEventListener("pointerdown", this.onPointerDown.bind(this))
        this.canvas.addEventListener("pointermove", this.onPointerMove.bind(this))
        this.canvas.addEventListener("pointerup", this.onPointerUp.bind(this))
        this.canvas.addEventListener("pointercancel", this.onPointerUp.bind(this))
        this.canvas.addEventListener("pointerleave", this.onPointerLeave.bind(this))
        this.canvas.addEventListener("wheel", this.onWheel.bind(this))
        // Prevent context menu on right click.
        this.canvas.addEventListener("contextmenu", (e) => e.preventDefault())
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

        const deltaX = e.clientX - this.lastX
        const deltaY = e.clientY - this.lastY
        this.lastX = e.clientX
        this.lastY = e.clientY

        if (this.dragMode === "rotate") {
            this.theta += deltaX * this.sensitivity
            this.phi -= deltaY * this.sensitivity

            // Clamp phi to avoid flipping.
            const maxPhi = Math.PI / 2 - 0.01
            const minPhi = -Math.PI / 2 + 0.01
            this.phi = Math.max(minPhi, Math.min(maxPhi, this.phi))
        } else if (this.dragMode === "pan") {
            // Calculate the forward vector from cameraPosition to cameraTarget.
            const forward = this.cameraTarget.subtract(this.cameraPosition).normalize()
            const worldUp = new Vec3([0, 1, 0])
            const right = forward.cross(worldUp).normalize()

            const panOffset = new Vec3([
                right.x * (-deltaX * this.panSensitivity) + worldUp.x * (deltaY * this.panSensitivity),
                right.y * (-deltaX * this.panSensitivity) + worldUp.y * (deltaY * this.panSensitivity),
                right.z * (-deltaX * this.panSensitivity) + worldUp.z * (deltaY * this.panSensitivity),
            ])
            this.cameraPosition = this.cameraPosition.add(panOffset)
            this.cameraTarget = this.cameraTarget.add(panOffset)
        }
    }

    private onPointerUp(e: PointerEvent) {
        this.isDragging = false
        this.dragMode = null
    }

    private onPointerLeave(e: PointerEvent) {
        // When the pointer leaves the canvas, abort any dragging.
        if (this.isDragging) {
            this.isDragging = false
            this.dragMode = null
        }
    }

    private onWheel(e: WheelEvent) {
        e.preventDefault()
        this.radius += e.deltaY * this.zoomSensitivity
        this.radius = clamp(this.radius, this.minRadius, this.maxRadius)
        this.ortho.y += e.deltaY * this.zoomSensitivity
        this.ortho.y = clamp(this.ortho.y, this.minOrthoScale, this.maxOrthoScale)
    }

    updateCamera() {
        this.cameraPosition.x = this.cameraTarget.x + this.radius * Math.cos(this.phi) * Math.sin(this.theta)
        this.cameraPosition.y = this.cameraTarget.y + this.radius * Math.sin(this.phi)
        this.cameraPosition.z = this.cameraTarget.z + this.radius * Math.cos(this.phi) * Math.cos(this.theta)
    }
}

function clamp(x: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, x))
}
