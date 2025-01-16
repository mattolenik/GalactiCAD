import { ShaderProgram } from "./shaderprogram.mjs"
import sdfFragmentShader from "./shaders/sdf_fragment.glsl"
import sdfVertexShader from "./shaders/sdf_vertex.glsl"

export class SDFRenderer {
    private canvas: HTMLCanvasElement
    private gl: WebGL2RenderingContext
    private program!: WebGLProgram

    // Buffers
    private positionBuffer: WebGLBuffer
    private positionLoc!: number

    // Uniforms
    private resolutionLoc!: WebGLUniformLocation
    private timeLoc!: WebGLUniformLocation
    private cameraLoc!: WebGLUniformLocation
    private forwardLoc!: WebGLUniformLocation
    private rightLoc!: WebGLUniformLocation
    private upLoc!: WebGLUniformLocation

    // Animation
    private startTime: number
    private requestId: number | null = null

    // Camera spherical parameters
    private radius = 5
    private target = [0, 0, 0]
    private theta = 0
    private phi = Math.PI * 0.5

    // Speeds
    private rotateSpeed = 0.005
    private zoomSpeed = 0.1
    private panSpeed = 1.0

    // Mouse state
    private isRotating = false
    private isPanning = false
    private lastMouseX = 0
    private lastMouseY = 0

    private shaderProgram: ShaderProgram

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas

        const gl = this.canvas.getContext("webgl2")
        if (!gl) throw new Error("Browser must support WebGL2")
        this.gl = gl

        this.shaderProgram = new ShaderProgram(this.gl)
        this.reloadShaders(this.color)

        // Full-screen quad
        this.positionBuffer = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
        gl.enableVertexAttribArray(this.positionLoc)
        gl.vertexAttribPointer(this.positionLoc, 2, gl.FLOAT, false, 0, 0)

        this.onResize()
        window.addEventListener("resize", () => this.onResize())

        // Disable context menu on right-click
        this.canvas.addEventListener("contextmenu", (e) => e.preventDefault())

        this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e))
        this.canvas.addEventListener("mousemove", (e) => this.onMouseMove(e))
        this.canvas.addEventListener("mouseup", () => this.resetMouse())
        this.canvas.addEventListener("mouseleave", () => this.resetMouse())

        this.canvas.addEventListener("wheel", (e) => this.onWheel(e), {
            passive: false,
        })

        this.startTime = performance.now()
        this.renderLoop = this.renderLoop.bind(this)
        this.requestId = requestAnimationFrame(this.renderLoop)
    }

    private color = "vec3(0.2f, 0.8f, 0.4f)"

    public reloadShaders(color: string) {
        console.log("reloading shaders")
        this.program = this.shaderProgram.reload(sdfVertexShader, sdfFragmentShader.replace(this.color, color))
        this.color = color

        this.positionLoc = this.gl.getAttribLocation(this.program, "aPosition")
        this.resolutionLoc = this.gl.getUniformLocation(this.program, "uResolution")!
        this.timeLoc = this.gl.getUniformLocation(this.program, "uTime")!
        this.cameraLoc = this.gl.getUniformLocation(this.program, "uCamera")!
        this.forwardLoc = this.gl.getUniformLocation(this.program, "uForward")!
        this.rightLoc = this.gl.getUniformLocation(this.program, "uRight")!
        this.upLoc = this.gl.getUniformLocation(this.program, "uUp")!
    }

    private onMouseDown(e: MouseEvent) {
        e.preventDefault()
        this.lastMouseX = e.clientX
        this.lastMouseY = e.clientY
        if (e.button === 2) {
            // Right-click => pan
            this.isPanning = true
            this.isRotating = false
        } else if (e.button === 0) {
            // Left-click => rotate
            this.isRotating = true
            this.isPanning = false
        }
    }

    private resetMouse() {
        this.isRotating = false
        this.isPanning = false
    }

    private onMouseMove(e: MouseEvent) {
        if (!this.isRotating && !this.isPanning) return

        const dx = e.clientX - this.lastMouseX
        const dy = e.clientY - this.lastMouseY
        this.lastMouseX = e.clientX
        this.lastMouseY = e.clientY

        if (this.isRotating) {
            this.theta -= dx * this.rotateSpeed
            this.phi -= dy * this.rotateSpeed
            const EPS = 0.001
            if (this.phi < EPS) this.phi = EPS
            if (this.phi > Math.PI - EPS) this.phi = Math.PI - EPS
        } else if (this.isPanning) {
            // One-to-one pan
            const fov = 1.0 // ~57 degrees
            const w = this.canvas.width
            const h = this.canvas.height
            const aspect = w / h

            // Size of view plane at current radius
            const viewPlaneHeight = 2.0 * Math.tan(fov * 0.5) * this.radius
            const viewPlaneWidth = viewPlaneHeight * aspect

            // Pixel -> world
            const worldMoveX = (dx / w) * viewPlaneWidth
            // Invert the sign for dy so up is up:
            const worldMoveY = -(dy / h) * viewPlaneHeight

            const camPos = this.getCameraPosition()
            const forward = this.normalize([this.target[0] - camPos[0], this.target[1] - camPos[1], this.target[2] - camPos[2]])
            const right = this.normalize(this.cross(forward, [0, 1, 0]))
            const up = this.normalize(this.cross(right, forward))

            this.target[0] -= (right[0] * worldMoveX + up[0] * worldMoveY) * this.panSpeed
            this.target[1] -= (right[1] * worldMoveX + up[1] * worldMoveY) * this.panSpeed
            this.target[2] -= (right[2] * worldMoveX + up[2] * worldMoveY) * this.panSpeed
        }
    }

    private onWheel(e: WheelEvent) {
        e.preventDefault()
        const delta = e.deltaY > 0 ? 1 : -1
        this.radius *= 1 + delta * this.zoomSpeed
        if (this.radius < 0.2) this.radius = 0.2
    }

    private onResize() {
        this.canvas.width = window.innerWidth
        this.canvas.height = window.innerHeight
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    }

    private renderLoop(now: number) {
        const gl = this.gl
        const time = (now - this.startTime) * 0.001

        gl.uniform2f(this.resolutionLoc, this.canvas.width, this.canvas.height)
        gl.uniform1f(this.timeLoc, time)

        // Spherical -> Cartesian
        const camPos = this.getCameraPosition()
        gl.uniform3f(this.cameraLoc, camPos[0], camPos[1], camPos[2])

        // forward, right, up
        const forward = this.normalize([this.target[0] - camPos[0], this.target[1] - camPos[1], this.target[2] - camPos[2]])
        const right = this.normalize(this.cross(forward, [0, 1, 0]))
        const up = this.normalize(this.cross(right, forward))

        gl.uniform3f(this.forwardLoc, forward[0], forward[1], forward[2])
        gl.uniform3f(this.rightLoc, right[0], right[1], right[2])
        gl.uniform3f(this.upLoc, up[0], up[1], up[2])

        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLES, 0, 6)

        this.requestId = requestAnimationFrame(this.renderLoop)
    }

    public dispose() {
        if (this.requestId) cancelAnimationFrame(this.requestId)
        if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas)
    }

    private getCameraPosition(): [number, number, number] {
        const sinPhi = Math.sin(this.phi)
        const x = this.target[0] + this.radius * sinPhi * Math.cos(this.theta)
        const y = this.target[1] + this.radius * Math.cos(this.phi)
        const z = this.target[2] + this.radius * sinPhi * Math.sin(this.theta)
        return [x, y, z]
    }

    private normalize(v: number[]): number[] {
        const len = Math.hypot(v[0], v[1], v[2])
        if (len < 1e-8) return [0, 0, 0]
        return [v[0] / len, v[1] / len, v[2] / len]
    }

    private cross(a: number[], b: number[]): number[] {
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    }

    private createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
        const vs = this.createShader(gl, gl.VERTEX_SHADER, vsSrc)
        const fs = this.createShader(gl, gl.FRAGMENT_SHADER, fsSrc)
        const prog = gl.createProgram()!
        gl.attachShader(prog, vs)
        gl.attachShader(prog, fs)
        gl.linkProgram(prog)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(prog)
            gl.deleteProgram(prog)
            throw new Error("Link error: " + info)
        }
        gl.deleteShader(vs)
        gl.deleteShader(fs)
        return prog
    }

    private createShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
        const sh = gl.createShader(type)!
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(sh)
            gl.deleteShader(sh)
            throw new Error("Compile error: " + info)
        }
        return sh
    }
}
