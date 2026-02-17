/**
 * A virtual trackball controller for 3D rotations, with multiple rotation methods.
 * Requires https://github.com/rawify/Quaternion.js
 * Author: @scottshambaugh
 * License: MIT
 */
// @ts-ignore - quaternion library type definitions have issues
import Quaternion from "quaternion"

export type TrackballRotationMethod =
    | "azel"
    | "trackball"
    | "trackball_no_precession"
    | "shoemake"
    | "sphere"
    | "bell"
    | "rounded_arcball"

export interface TrackballOptions {
    /** The DOM element that will contain the trackball */
    scene: HTMLElement
    /** Optional rect for interaction (e.g. visible area when editor overlays). Uses scene.getBoundingClientRect() when omitted. */
    getInteractionRect?: () => DOMRect
    /** The rotation method to use */
    rotationMethod?: TrackballRotationMethod
    /** Callback function called when trackball is rotated */
    onDraw?: (this: Trackball, q: Quaternion) => void
    /** Whether to clamp elevation rotation */
    clampElevation?: boolean
    /** Border size in pixels */
    border?: number
    /** Size of the trackball relative to container */
    ballsize?: number
    /** Initial rotation quaternion */
    q?: Quaternion
    /** Whether to invert X rotation */
    invertX?: boolean
    /** Whether to invert Y rotation */
    invertY?: boolean
    /** Speed of rotation */
    speed?: number
}

type TrackballOptionsInput =
    | (Partial<TrackballOptions> & { nodeType?: never })
    | { nodeType: unknown; scene?: never }

interface DragState {
    startVector: [number, number, number]
    startPosition: [number, number]
    box: DOMRect
}

export class Trackball {
    #q0: Quaternion
    #q: Quaternion
    #azimuth = 0
    #elevation = 0
    #roll = 0
    #azimuth_start = 0
    #elevation_start = 0
    #roll_start = 0
    #drag: DragState | null = null
    #isUpdatePending = false
    #lastMousePosition: { clientX: number; clientY: number } | null = null
    #opts: Required<
        Omit<TrackballOptions, "scene" | "rotationMethod" | "q" | "getInteractionRect">
    > & {
        scene: HTMLElement
        getInteractionRect?: () => DOMRect
        rotationMethod?: TrackballRotationMethod
    }

    /**
     * Constructs a new Trackball instance.
     */
    constructor(opts: TrackballOptionsInput = {}) {
        let resolvedOpts = opts as Partial<TrackballOptions> & {
            nodeType?: unknown
        }
        if (resolvedOpts.nodeType) {
            resolvedOpts = { scene: opts as unknown as HTMLElement }
        }
        if (typeof resolvedOpts.scene === "string") {
            resolvedOpts.scene = document.querySelector(
                resolvedOpts.scene
            ) as HTMLElement
        }

        const {
            scene,
            getInteractionRect,
            rotationMethod,
            onDraw = () => {},
            clampElevation = false,
            border = 0,
            ballsize = 0.75,
            q = Quaternion.ONE,
            invertX = false,
            invertY = false,
            speed = 1,
        } = resolvedOpts

        this.#opts = {
            scene: scene!,
            getInteractionRect,
            rotationMethod,
            onDraw,
            clampElevation,
            border,
            ballsize,
            invertX,
            invertY,
            speed,
        }

        // Core state initialization
        this.#q0 = this.#q = q

        if (this.#opts.rotationMethod === "rounded_arcball") {
            ;(this.#opts as { border: number }).border = 0.5
        }

        this.#initEventListeners()
        this.#draw()
    }

    /**
     * Rotates the trackball by a given quaternion.
     */
    rotate(quaternion: Quaternion): void {
        if (!this.#drag) {
            this.#q = this.#q0 = this.#q0.mul(quaternion)

            // Calculate azimuth and elevation from the new quaternion
            const euler = this.#q.toEuler("XYZ") // [yaw, pitch, roll]
            this.#elevation = euler[0]
            this.#azimuth = euler[1]
            this.#roll = euler[2]
            this.#azimuth_start = this.#azimuth
            this.#elevation_start = this.#elevation
            this.#roll_start = this.#roll

            this.#draw()
        }
    }

    /** Set the rotation method at runtime. */
    set rotationMethod(m: TrackballRotationMethod) {
        ;(this.#opts as { rotationMethod: TrackballRotationMethod }).rotationMethod = m
        if (m === "rounded_arcball") {
            ;(this.#opts as { border: number }).border = 0.5
        }
    }

    /**
     * Resets the trackball to its initial state.
     */
    reset(): void {
        this.#drag = null
        this.#q = this.#q0 = new Quaternion(1, 0, 0, 0)
        this.#azimuth = this.#azimuth_start = 0
        this.#elevation = this.#elevation_start = 0
        this.#roll = this.#roll_start = 0
        this.#draw()
    }

    #initEventListeners(): void {
        const scene = this.#opts.scene

        scene.addEventListener("mousedown", this.#handleMouseDown.bind(this))
        document.addEventListener("mousemove", this.#handleMouseMove.bind(this))
        document.addEventListener("mouseup", this.#handleMouseUp.bind(this))

        scene.addEventListener(
            "touchstart",
            (e: TouchEvent) => {
                e.preventDefault()
                if (e.touches.length === 1) {
                    this.#handleMouseDown(e.touches[0])
                }
            },
            { passive: false }
        )

        document.addEventListener(
            "touchmove",
            (e: TouchEvent) => {
                if (e.touches.length === 1) {
                    this.#handleMouseMove(e.touches[0])
                }
            },
            { passive: true }
        )

        document.addEventListener(
            "touchend",
            (e: TouchEvent) => {
                if (e.changedTouches.length === 1) {
                    this.#handleMouseUp(e.changedTouches[0])
                }
            },
            { passive: true }
        )
    }

    #handleMouseDown(event: MouseEvent | Touch): void {
        // Only respond to left mouse button; right/middle are used for pan
        if (event instanceof MouseEvent && event.button !== 0) return

        const box = this.#opts.getInteractionRect?.() ?? this.#opts.scene.getBoundingClientRect()

        const startVector =
            this.#project(event.clientX, event.clientY, box) ?? [0, 0, 1]
        this.#drag = {
            startVector,
            startPosition: [event.clientX, event.clientY],
            box,
        }

        this.#draw()
    }

    #handleMouseMove(event: MouseEvent | Touch): void {
        if (!this.#drag) return

        this.#lastMousePosition = {
            clientX: event.clientX,
            clientY: event.clientY,
        }

        if (!this.#isUpdatePending) {
            this.#isUpdatePending = true
            requestAnimationFrame(this.#update.bind(this))
        }
    }

    #update(): void {
        if (this.#lastMousePosition && this.#drag) {
            const { clientX, clientY } = this.#lastMousePosition

            const box = this.#drag.box
            if (this.#isInBounds(clientX, clientY, box)) {
                this.#updateRotation(clientX, clientY)
                this.#draw()
            }
        }

        this.#isUpdatePending = false
    }

    #updateRotation(clientX: number, clientY: number): void {
        const deltaX = clientX - this.#drag!.startPosition[0]
        const deltaY = clientY - this.#drag!.startPosition[1]
        if (deltaX === 0 && deltaY === 0) return

        const { rotationMethod } = this.#opts

        if (rotationMethod === "azel") {
            this.#updateAzEl(deltaX, deltaY)
        } else if (
            rotationMethod === "trackball" ||
            rotationMethod === "trackball_no_precession"
        ) {
            this.#updateTrackball(deltaX, deltaY, clientX, clientY)
        } else {
            this.#updateSphericalMethods(clientX, clientY)
        }
    }

    #updateTrackball(
        deltaX: number,
        deltaY: number,
        clientX: number,
        clientY: number
    ): void {
        const minDim = Math.min(this.#drag!.box.height, this.#drag!.box.width)
        const invertedDeltaX = this.#opts.invertX ? -deltaX : deltaX
        const invertedDeltaY = this.#opts.invertY ? -deltaY : deltaY

        const k = [
            invertedDeltaY / minDim,
            invertedDeltaX / minDim,
            0,
        ] as [number, number, number]
        const norm = Math.sqrt(k[0] * k[0] + k[1] * k[1] + k[2] * k[2])
        const theta =
            (norm * Math.PI) / 2 * this.#opts.speed

        const cosTheta = Math.cos(theta)
        const sinThetaNormalized = Math.sin(theta) / norm
        const dq = new Quaternion(
            cosTheta,
            k[0] * sinThetaNormalized,
            k[1] * sinThetaNormalized,
            k[2] * sinThetaNormalized
        )
        this.#q = dq.mul(this.#q0)

        if (this.#opts.rotationMethod === "trackball") {
            this.#q0 = this.#q
            this.#drag!.startPosition = [clientX, clientY]
        }
    }

    #updateSphericalMethods(clientX: number, clientY: number): void {
        const box = this.#drag!.box
        const invertedX = this.#opts.invertX
            ? 2 * this.#drag!.startPosition[0] - clientX
            : clientX
        const invertedY = this.#opts.invertY
            ? 2 * this.#drag!.startPosition[1] - clientY
            : clientY

        const currentVector = this.#project(invertedX, invertedY, box)
        if (!currentVector) return
        const dq = Quaternion.fromVectors(
            this.#drag!.startVector,
            currentVector
        )

        if (this.#opts.rotationMethod === "sphere") {
            this.#q = dq.mul(this.#q0)
            this.#q0 = this.#q
            this.#drag!.startVector = currentVector
            this.#drag!.startPosition = [clientX, clientY]
        } else if (
            ["shoemake", "rounded_arcball", "bell"].includes(
                this.#opts.rotationMethod ?? ""
            )
        ) {
            this.#q = dq.mul(dq.mul(this.#q0))
        }
    }

    #handleMouseUp(): void {
        if (!this.#drag) return

        this.#drag = null
        this.#q0 = this.#q
        this.#lastMousePosition = null
        this.#azimuth_start = this.#azimuth
        this.#elevation_start = this.#elevation
        this.#roll_start = this.#roll
        this.#draw()
    }

    #project(
        x: number,
        y: number,
        box: DOMRect
    ): [number, number, number] | undefined {
        const maxDim = Math.max(box.width, box.height) - 1
        const ballsize = this.#opts.ballsize
        const border = this.#opts.border
        const ra = 1 + border
        const a = border * (1 + border / 2)
        const ri = 2 / (ra + 1 / ra)

        let px = (2 * (x - box.x) - box.width - 1) / maxDim / ballsize
        let py = -(2 * (y - box.y) - box.height - 1) / maxDim / ballsize

        const dist2 = (px * px + py * py) * (ra * ra)
        const dist = Math.sqrt(dist2)

        if (
            ["sphere", "shoemake", "rounded_arcball"].includes(
                this.#opts.rotationMethod ?? ""
            )
        ) {
            if (dist < ri) {
                return [px, py, Math.sqrt(1 - dist2)]
            } else if (dist < ra) {
                const dr = ra - dist
                return [px, py, a - Math.sqrt((a + dr) * (a - dr))]
            }
            return [px, py, 0]
        } else if (this.#opts.rotationMethod === "bell") {
            if (dist < 1 / Math.sqrt(2)) {
                return [px, py, Math.sqrt(1 - dist2)]
            }
            return [px, py, 1 / (2 * dist)]
        }
        return undefined
    }

    #updateAzEl(deltaX: number, deltaY: number): void {
        const scaleX =
            Math.PI /
            Math.min(this.#drag!.box.width, this.#drag!.box.height)
        const scaleY = scaleX

        const invertedDeltaX = this.#opts.invertX ? -deltaX : deltaX
        const invertedDeltaY = this.#opts.invertY ? -deltaY : deltaY

        this.#azimuth =
            this.#azimuth_start +
            invertedDeltaX * scaleX * this.#opts.speed

        if (this.#opts.clampElevation) {
            this.#elevation = Math.max(
                -Math.PI / 2 + 0.01,
                Math.min(
                    Math.PI / 2 - 0.01,
                    this.#elevation_start +
                        invertedDeltaY * scaleY * this.#opts.speed
                )
            )
        } else {
            this.#elevation =
                this.#elevation_start +
                invertedDeltaY * scaleY * this.#opts.speed
        }

        this.#q = Quaternion.fromEuler(
            this.#elevation,
            this.#azimuth,
            this.#roll,
            "XYZ"
        )
    }

    #isInBounds(x: number, y: number, box: DOMRect): boolean {
        return (
            x >= box.left &&
            x <= box.right &&
            y >= box.top &&
            y <= box.bottom
        )
    }

    #draw(): void {
        this.#opts.onDraw.call(this, this.#q)
    }
}
