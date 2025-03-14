import { Vec3 } from "./vecmat/vector.mjs"

export class OrbitControls {
    canvas: HTMLCanvasElement
    pivot: Vec3
    radius: number
    theta: number // azimuth angle
    phi: number // elevation angle
    isDragging: boolean = false
    lastX: number = 0
    lastY: number = 0
    sensitivity: number = 0.005
    zoomSensitivity: number = 0.05
    minRadius: number = 1
    maxRadius: number = 100
    cameraPosition: Vec3

    constructor(canvas: HTMLCanvasElement, pivot: Vec3, radius: number, initialTheta: number = 0, initialPhi: number = 0) {
        this.canvas = canvas
        this.pivot = pivot
        this.radius = radius
        this.theta = initialTheta
        this.phi = initialPhi
        this.cameraPosition = new Vec3([0, 0, 0])
        this.initEvents()
    }

    private initEvents() {
        this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this))
        this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this))
        document.addEventListener("mouseup", this.onMouseUp.bind(this))
        this.canvas.addEventListener("wheel", this.onWheel.bind(this))
    }

    private onMouseDown(e: MouseEvent) {
        this.isDragging = true
        this.lastX = e.clientX
        this.lastY = e.clientY
    }

    private onMouseMove(e: MouseEvent) {
        if (!this.isDragging) return

        const deltaX = e.clientX - this.lastX
        const deltaY = e.clientY - this.lastY
        this.lastX = e.clientX
        this.lastY = e.clientY

        this.theta += deltaX * this.sensitivity
        this.phi -= deltaY * this.sensitivity

        // Clamp phi to avoid flipping at the poles.
        const maxPhi = Math.PI / 2 - 0.01
        const minPhi = -Math.PI / 2 + 0.01
        this.phi = Math.max(minPhi, Math.min(maxPhi, this.phi))
    }

    private onMouseUp(_: MouseEvent) {
        this.isDragging = false
    }

    private onWheel(e: WheelEvent) {
        console.log(1)
        e.preventDefault()
        this.radius += e.deltaY * this.zoomSensitivity
        this.radius = Math.max(this.minRadius, Math.min(this.maxRadius, this.radius))
    }

    updateCamera() {
        this.cameraPosition.x = this.pivot.x + this.radius * Math.cos(this.phi) * Math.sin(this.theta)
        this.cameraPosition.y = this.pivot.y + this.radius * Math.sin(this.phi)
        this.cameraPosition.z = this.pivot.z + this.radius * Math.cos(this.phi) * Math.cos(this.theta)
    }
}
